import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.mjs';
import { SourceClient, urls } from '../src/sources.mjs';
import { Collector, loadSaved } from '../src/collector.mjs';
import { GAME_ID, liveScoreboard, summary, injury, news, nbaScoreboard, nbaPbp } from './fixtures.mjs';

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
  assert.equal(calls, 3);
});
test('today loads even when yesterday fails; delayed summary proof replays earlier report; persisted evidence survives restart', async () => {
  const path = join(tmpdir(), `nba-test-${randomUUID()}.json`);
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
  } finally { await rm(path, { force: true }); await rm(`${path}.tmp`, { force: true }); }
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
