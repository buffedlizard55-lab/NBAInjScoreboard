import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.mjs';
import { SourceClient, urls } from '../src/sources.mjs';
import { Collector, loadSaved } from '../src/collector.mjs';
import { readFileSync } from 'node:fs';
import { GAME_ID, liveScoreboard, summary, injury, news, nbaScoreboard, nbaPbp } from './fixtures.mjs';

// Real captured ESPN payloads (see tests/real-source.test.mjs for provenance).
const realInjuries = JSON.parse(readFileSync(new URL('./real/espn-injuries-captured.json', import.meta.url), 'utf8'));
const realBox = JSON.parse(readFileSync(new URL('./real/espn-boxscore-athletes.json', import.meta.url), 'utf8'));

const NOW = Date.parse('2026-10-03T23:30:00Z');
test('source cooldown is per URL, honors HTTP failures and recovers', async () => {
  let time = NOW, calls = 0;
  const client = new SourceClient({ now: () => time, fetcher: async url => {
    calls++;
    if (url.endsWith('/bad') && calls === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '20' }) };
    return { ok: true, headers: new Headers(), text: async () => '{"events":[]}' };
  } });
  await assert.rejects(client.json('a', 'https://example.com/bad'), /HTTP 429/);
  assert.deepEqual(await client.json('b', 'https://example.com/good'), { events: [] });
  await assert.rejects(client.json('a', 'https://example.com/bad'), /Cooling down/);
  assert.equal(calls, 2);
  time += 21_000;
  assert.deepEqual(await client.json('a', 'https://example.com/bad'), { events: [] });
  assert.equal(await client.text('html', 'https://example.com/news'), '{"events":[]}');
  assert.equal(calls, 4);
});
test('today loads even when yesterday fails; delayed summary proof replays earlier report; persisted evidence survives restart', async () => {
  const dir = join(tmpdir(), `nba-test-${randomUUID()}`);
  const path = join(dir, 'state.json');
  const engineTime = () => NOW;
  const client = { json: async (_key, url) => {
    if (url === urls.scoreboard('2026-10-02')) throw new Error('Test: yesterday unavailable');
    if (url === urls.scoreboard('2026-10-03')) return liveScoreboard();
    if (url === urls.nbaScoreboard) return nbaScoreboard();
    if (url === urls.summary(GAME_ID)) return summary();
    if (url === urls.nbaPbp('0029900101')) return nbaPbp();
    if (url === urls.injuries) return injury();
    if (url === urls.news) return news();
    throw new Error(`Unexpected fixture URL: ${url}`);
  } };
  const collector = new Collector({ now: engineTime, statePath: path, client });
  try {
    await collector.scoreboardTick();
    assert.equal(collector.engine.games.size, 1);
    assert.match(collector.engine.health['ESPN previous-day scoreboard'].error, /yesterday unavailable/);
    assert.ok(collector.engine.health['ESPN scoreboard'].okAt);
    await collector.injuryTick(); // still no box-score minutes, so it must wait
    assert.equal(collector.engine.snapshot('2026-10-03').injuries.length, 0);
    await collector.gameTick(); // participation arrives; reprocess already fetched injuries
    assert.equal(collector.engine.snapshot('2026-10-03').injuries.length, 1);
    await collector.newsTick();
    assert.deepEqual(collector.engine.snapshot('2026-10-03').injuries.map(i => i.status), ['confirmed_out', 'questionable']);
    await collector.stop();
    const saved = await loadSaved(path);
    const second = new Collector({ now: engineTime, statePath: path, saved, client });
    await second.injuryTick();
    assert.equal(second.engine.snapshot('2026-10-03').injuries.length, 2);
    await second.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('pending unmatched source evidence persists across a collector restart', async () => {
  const dir = join(tmpdir(), `nba-pending-${randomUUID()}`);
  const path = join(dir, 'state.json');
  const candidate = { sourceKey: 'pending-story', publishedAt: NOW, athleteId: '1234567', name: 'Test Player',
    status: 'reported', text: 'Test Player exited with a left ankle sprain.', source: 'Test source', sourceUrl: 'https://www.espn.com/nba/story/_/id/1/test' };
  try {
    const collector = new Collector({ now: () => NOW, statePath: path, client: { json: async () => ({}) } });
    collector.pendingCandidates.set(candidate.sourceKey, { candidate, queuedAt: NOW });
    await collector.stop();
    const saved = await loadSaved(path);
    assert.equal(saved.pendingCandidates.length, 1);
    const restarted = new Collector({ now: () => NOW, statePath: path, saved, client: { json: async () => ({}) } });
    assert.equal(restarted.pendingCandidates.get(candidate.sourceKey).candidate.text, candidate.text);
    await restarted.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scoreboard outage preserves current games but suspends new alerts when its live state becomes stale', () => {
  let current = NOW;
  const engine = new Engine({ now: () => current });
  engine.scoreboard('2026-10-03', liveScoreboard());
  engine.summary(GAME_ID, summary());
  engine.source('ESPN scoreboard', 'HTTP 503');
  assert.equal(engine.health['ESPN scoreboard'].okAt, NOW);
  assert.throws(() => engine.scoreboard('2026-10-03', { events: [] }), /omitted an ongoing game/);
  assert.equal(engine.games.size, 1);
  current += 91_000;
  engine.injuriesFeed(injury());
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
  engine.scoreboard('2026-10-03', liveScoreboard());
  engine.injuriesFeed(injury());
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 1);
});
test('box-score participation survives a preseason/partial summary with no plays; PBP remains degraded', () => {
  const engine = new Engine({ now: () => NOW });
  engine.scoreboard('2026-10-03', liveScoreboard());
  const data = summary();
  delete data.plays;
  engine.summary(GAME_ID, data);
  assert.match(engine.health['ESPN play-by-play'].error, /no play-by-play/);
  engine.injuriesFeed(injury());
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 1);
});
test('multi-athlete news, non-medical rest and stale status do not create extra alerts', () => {
  const engine = new Engine({ now: () => NOW });
  engine.scoreboard('2026-10-03', liveScoreboard());
  engine.summary(GAME_ID, summary());
  const article = news({ headline: 'Test Player and Other Player injured on court' });
  article.articles[0].categories.push({ type: 'athlete', athleteId: '5555555', description: 'Other Player' });
  engine.newsFeed(article);
  engine.injuriesFeed(injury({ text: 'Test Player is out with personal reasons.' }));
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
});

test('collector pipeline: a real-shaped ESPN injury row becomes an alert in both feeds', async () => {
  const dir = join(tmpdir(), `nba-real-${randomUUID()}`);
  const path = join(dir, 'state.json');
  // Put a real captured athlete (Cade Cunningham, id 4432166) on the home team of the fixture game.
  const home = { team: { id: '2' }, statistics: realBox.statistics };
  const boxData = { header: { id: GAME_ID }, boxscore: { players: [...summary().boxscore.players, home] }, plays: summary().plays };
  const row = { ...realInjuries.injuries[0].injuries[0], date: '2026-10-03T23:12:00Z', status: 'Questionable',
    shortComment: 'Cade Cunningham is questionable to return due to a left ankle sprain.' };
  row.athlete = { ...realBox.statistics[0].athletes[0].athlete,
    links: [{ rel: ['news', 'desktop', 'athlete'], href: 'https://www.espn.com/nba/player/news/_/id/4432166/cade-cunningham' }],
    notes: { items: [{ id: '-1', type: 'news', date: row.date, headline: row.shortComment, text: row.shortComment, source: 'RotoWire',
      injury: { $ref: 'http://sports.core.api.espn.pvt/v2/sports/basketball/leagues/nba/seasons/2027/athletes/4432166/injuries/-1?lang=en&region=us' } }] } };
  const feed = { ...realInjuries, injuries: [{ id: '2', displayName: 'Boston Celtics', injuries: [row] }] };
  const client = { json: async (_key, url) => {
    if (url === urls.scoreboard('2026-10-02')) throw new Error('Test: yesterday unavailable');
    if (url === urls.scoreboard('2026-10-03')) return liveScoreboard();
    if (url === urls.summary(GAME_ID)) return boxData;
    if (url === urls.injuries) return feed;
    if (url === urls.news) return { articles: [] };
    if (url === urls.nbaScoreboard) throw new Error('Test: NBA CDN blocked');
    throw new Error(`Unexpected fixture URL: ${url}`);
  } };
  const collector = new Collector({ now: () => NOW, statePath: path, client });
  try {
    await collector.scoreboardTick();
    await collector.injuryTick();  // injuries arrive before the box score proves participation
    assert.equal(collector.engine.snapshot('2026-10-03').injuries.length, 0);
    assert.equal(collector.pendingCandidates.size, 1, 'unmatched source evidence stays queued instead of disappearing');
    await collector.gameTick();    // participation proof arrives, pending report is retried
    const state = collector.engine.snapshot('2026-10-03');
    assert.equal(collector.pendingCandidates.size, 0, 'accepted evidence leaves the retry queue');
    assert.equal(state.injuries.length, 1);
    assert.equal(state.injuries[0].athleteId, '4432166');
    assert.equal(state.injuries[0].player, 'Cade Cunningham');
    assert.equal(state.injuries[0].status, 'questionable');
    assert.match(state.injuries[0].evidence[0].source, /RotoWire/);
    assert.equal(state.feed.filter(e => e.kind === 'injury').length, 1);
    assert.equal(collector.engine.snapshot('2026-10-03').reviews.length, 0, 'replay reviews stay a separate system');
    await collector.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('per-athlete news poll finds an injury the league-wide feed never carried', async () => {
  const dir = join(tmpdir(), `nba-athlete-${randomUUID()}`);
  const path = join(dir, 'state.json');
  let athleteCalls = [];
  const story = { articles: [{ id: 22220000, published: '2026-10-03T23:20:00Z', byline: 'Example beat writer',
    headline: 'Test Player exits with left ankle sprain', description: 'Test Player left the game with a left ankle sprain.',
    links: { web: { href: 'https://www.espn.com/nba/story/_/id/22220000/example' } }, categories: [] }] };
  const client = { json: async (_key, url) => {
    if (url === urls.scoreboard('2026-10-02')) throw new Error('Test: yesterday unavailable');
    if (url === urls.scoreboard('2026-10-03')) return liveScoreboard();
    if (url === urls.summary(GAME_ID)) return summary();
    if (url === urls.injuries) return { injuries: [] };
    if (url === urls.news) return { articles: [] };
    if (url === urls.nbaScoreboard) throw new Error('Test: NBA CDN blocked');
    if (url.includes('/athletes/') && url.endsWith('/news')) { athleteCalls.push(url); return story; }
    throw new Error(`Unexpected fixture URL: ${url}`);
  } };
  const collector = new Collector({ now: () => NOW, statePath: path, client });
  try {
    await collector.scoreboardTick();
    await collector.gameTick();
    assert.equal(collector.engine.snapshot('2026-10-03').injuries.length, 0);
    await collector.athleteNewsTick();
    assert.ok(athleteCalls.length > 0, 'player news feeds were polled');
    assert.ok(athleteCalls.length <= 10, 'the batch is bounded');
    const state = collector.engine.snapshot('2026-10-03');
    assert.equal(state.injuries.length, 1);
    assert.equal(state.injuries[0].player, 'Test Player');
    assert.equal(state.injuries[0].status, 'reported');
    // Re-polling must corroborate, never duplicate.
    athleteCalls = [];
    collector.lastAthleteNews = new Map();
    await collector.athleteNewsTick();
    assert.equal(collector.engine.snapshot('2026-10-03').injuries.length, 1);
    await collector.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ESPN_ATHLETE_NEWS=0 disables the extra polling and keeps the primary sources', async () => {
  const dir = join(tmpdir(), `nba-off-${randomUUID()}`);
  const path = join(dir, 'state.json');
  let athleteCalls = 0;
  const client = { json: async (_key, url) => {
    if (url === urls.scoreboard('2026-10-02')) throw new Error('Test: yesterday unavailable');
    if (url === urls.scoreboard('2026-10-03')) return liveScoreboard();
    if (url === urls.summary(GAME_ID)) return summary();
    if (url === urls.injuries) return injury();
    if (url === urls.news) return { articles: [] };
    if (url === urls.nbaScoreboard) throw new Error('Test: NBA CDN blocked');
    if (url.includes('/athletes/')) { athleteCalls++; return { articles: [] }; }
    throw new Error(`Unexpected fixture URL: ${url}`);
  } };
  const collector = new Collector({ now: () => NOW, statePath: path, client });
  process.env.ESPN_ATHLETE_NEWS = '0';
  try {
    await collector.scoreboardTick();
    await collector.gameTick();
    await collector.injuryTick();
    await collector.athleteNewsTick();
    assert.equal(athleteCalls, 0);
    assert.equal(collector.engine.snapshot('2026-10-03').injuries.length, 1, 'the structured feed still works');
    await collector.stop();
  } finally { delete process.env.ESPN_ATHLETE_NEWS; await rm(dir, { recursive: true, force: true }); }
});
