import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

test('ESPN collector parses scoreboard', async () => {
  const { parseScoreboardEvents, getActiveGames } = await import('../collectors/espn.js');
  const data = JSON.parse(await readFile(resolve(root, 'fixtures/espn-nfl-scoreboard.json'), 'utf8'));
  const games = parseScoreboardEvents(data.events, 'nfl');
  assert.equal(games.length, 2);
  assert.equal(games[0].sport, 'nfl');
  assert.equal(games[0].state, 'in');
  const active = getActiveGames(games);
  assert.equal(active.length, 1);
  assert.equal(active[0].club_1, 'KC');
});

test('ESPN collector parses play-by-play injury keywords', async () => {
  const { parsePlayByPlay } = await import('../collectors/espn.js');
  const data = JSON.parse(await readFile(resolve(root, 'fixtures/espn-playbyplay-nfl.json'), 'utf8'));
  const { alerts } = parsePlayByPlay(data, 'nfl', '401547417');
  assert.ok(alerts.length >= 2, `Expected >=2 alerts, got ${alerts.length}`);
  assert.ok(alerts[0].verbatim_text.toLowerCase().includes('shaken up') || alerts[0].verbatim_text.toLowerCase().includes('injury'));
  assert.equal(alerts[0].source, 'play-by-play');
  assert.equal(alerts[0].sport, 'nfl');
});

test('ESPN collector parses injuries endpoint', async () => {
  const { parseInjuries } = await import('../collectors/espn.js');
  const data = JSON.parse(await readFile(resolve(root, 'tests/real/espn-injuries-captured.json'), 'utf8'));
  const alerts = parseInjuries(data, 'nba');
  assert.ok(alerts.length > 0);
  assert.equal(alerts[0].sport, 'nba');
  assert.ok(alerts[0].player_name);
});

test('Bluesky collector parses feed', async () => {
  const { parseBlueskyFeed } = await import('../collectors/bluesky.js');
  const data = JSON.parse(await readFile(resolve(root, 'fixtures/bluesky-schefter.json'), 'utf8'));
  const reporter = { handle: 'schefter.bsky.social', sport: 'nfl', verified: true, name: 'Adam Schefter' };
  // Mock Date.now to make stale check pass - set now to close to fixture timestamp
  const originalNow = Date.now;
  Date.now = () => new Date('2026-09-25T17:45:00Z').getTime();
  try {
    const alerts = parseBlueskyFeed(data.feed, reporter);
    // Should filter out non-injury post and keep 2 injury posts
    assert.ok(alerts.length >= 1, `Expected >=1 alerts, got ${alerts.length}`);
    assert.equal(alerts[0].source, 'bluesky');
    assert.ok(alerts[0].verbatim_text.toLowerCase().includes('injury') || alerts[0].verbatim_text.toLowerCase().includes('questionable'));
  } finally {
    Date.now = originalNow;
  }
});

test('Google News RSS parser', async () => {
  const { parseRss, parseNewsItems } = await import('../collectors/google-news.js');
  const xml = await readFile(resolve(root, 'fixtures/google-news-rss.xml'), 'utf8');
  const items = parseRss(xml);
  assert.equal(items.length, 3);
  assert.ok(items[0].title.includes('Mahomes'));

  const originalNow = Date.now;
  Date.now = () => new Date('2026-09-25T17:46:00Z').getTime();
  try {
    const alerts = parseNewsItems(items, 'nfl', 'KC');
    assert.ok(alerts.length >= 1);
    assert.equal(alerts[0].source, 'google-news');
  } finally {
    Date.now = originalNow;
  }
});

test('Mastodon parser', async () => {
  const { parseMastodonPosts } = await import('../collectors/mastodon.js');
  const data = JSON.parse(await readFile(resolve(root, 'fixtures/mastodon-nfl.json'), 'utf8'));
  const originalNow = Date.now;
  Date.now = () => new Date('2026-09-25T17:45:00Z').getTime();
  try {
    const alerts = parseMastodonPosts(data, 'nfl');
    assert.ok(alerts.length >= 1);
    assert.equal(alerts[0].source, 'mastodon');
  } finally {
    Date.now = originalNow;
  }
});

test('Dedup: same alert twice -> skip', async () => {
  const { Deduper } = await import('../collectors/dedup.js');
  const deduper = new Deduper();
  const alert = {
    sport: 'nfl',
    team: 'KC',
    player_name: 'Patrick Mahomes',
    status: 'INJURY_REPORTED',
    timestamp_source: new Date().toISOString(),
    timestamp_first_seen: new Date().toISOString(),
    verbatim_text: 'Mahomes injured',
    source: 'play-by-play',
    game_id: '123'
  };
  const first = deduper.shouldEmit(alert);
  assert.equal(first.emit, true);
  assert.equal(first.reason, 'new');

  const second = deduper.shouldEmit(alert);
  assert.equal(second.emit, false);
  assert.equal(second.reason, 'duplicate');
});

test('Dedup: status upgrade emits new', async () => {
  const { Deduper } = await import('../collectors/dedup.js');
  const deduper = new Deduper();
  const base = {
    sport: 'nfl',
    team: 'KC',
    player_name: 'Patrick Mahomes',
    timestamp_source: new Date().toISOString(),
    timestamp_first_seen: new Date().toISOString(),
    verbatim_text: 'Mahomes injured',
    source: 'play-by-play',
    game_id: '123'
  };
  const reported = { ...base, status: 'INJURY_REPORTED' };
  const out = { ...base, status: 'OUT_FOR_GAME' };

  const r1 = deduper.shouldEmit(reported);
  assert.equal(r1.emit, true);

  const r2 = deduper.shouldEmit(out);
  assert.equal(r2.emit, true);
  assert.equal(r2.reason, 'upgrade');
});

test('Dedup: stale posts discard', async () => {
  const { Deduper } = await import('../collectors/dedup.js');
  const deduper = new Deduper();
  const staleAlert = {
    sport: 'nfl',
    team: 'KC',
    player_name: 'Patrick Mahomes',
    status: 'INJURY_REPORTED',
    timestamp_source: new Date(Date.now() - 31 * 60 * 1000).toISOString(), // 31 min ago
    timestamp_first_seen: new Date().toISOString(),
    verbatim_text: 'Old injury',
    source: 'google-news',
    game_id: '123'
  };
  const result = deduper.shouldEmit(staleAlert);
  assert.equal(result.emit, false);
  assert.equal(result.reason, 'stale');
});

test('Memory DB insert and query', async () => {
  const { memoryDB } = await import('../db/memory.js');
  memoryDB.alerts = []; // clear
  const alert = {
    sport: 'nfl',
    team: 'KC',
    player_name: 'Test Player',
    status: 'INJURY_REPORTED',
    timestamp_source: new Date().toISOString(),
    timestamp_first_seen: new Date().toISOString(),
    latency_ms: 100,
    verbatim_text: 'Test injury',
    source: 'play-by-play',
    verified: true,
    game_id: 'test123'
  };
  const inserted = await memoryDB.insertAlert(alert);
  assert.ok(inserted.id);
  const queried = await memoryDB.queryAlerts({ sport: 'nfl', team: 'KC', limit: 5 });
  assert.ok(queried.length >= 1);
  assert.equal(queried[0].player_name, 'Test Player');
});
