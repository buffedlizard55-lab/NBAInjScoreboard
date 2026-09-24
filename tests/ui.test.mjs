import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { easternDate } from '../src/engine.mjs';
import { GAME_ID } from './fixtures.mjs';

// Synthetic snapshot, supplied through the same /api/state contract as the site.
const today = easternDate();
function state() {
  const now = Date.now();
  const game = { id: GAME_ID, day: today, start: now - 30 * 60_000, phase: 'in', detail: '6:12 - 2nd', period: 2, clock: '6:12',
    home: { id: '2', abbr: 'BOS', name: 'Boston Celtics', score: '48', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/bos.png' },
    away: { id: '1', abbr: 'ATL', name: 'Atlanta Hawks', score: '45', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/atl.png' } };
  const injuries = [{ id: `${GAME_ID}:1234567:1`, kind: 'injury', gameId: GAME_ID, athleteId: '1234567', team: 'ATL', player: 'Test Player',
    status: 'questionable', text: 'Test Player is questionable to return with a left ankle sprain. <img src=x onerror=alert(1)>',
    time: now - 10_000, observedAt: now - 10_000, proof: 'ESPN box score: minutes played', evidence: [
      { source: 'ESPN injury report', publishedAt: now - 10_000, url: 'https://www.espn.com/nba/injuries', text: 'Source text' }
    ] }];
  const reviews = [{ id: `${GAME_ID}:q2:6:12`, gameId: GAME_ID, kind: 'review', type: 'challenge', outcome: 'stands', period: 2, clock: '6:12',
    time: now - 9_000, text: "Coach's Challenge: call stands", evidence: [
      { source: 'NBA official play-by-play', url: 'https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_0029900101.json', text: "Coach's Challenge: call stands" }
    ] }];
  const plays = [{ id: 'espn:play:1', kind: 'play', gameId: GAME_ID, period: 2, clock: '6:12', time: now - 20_000,
    text: 'Test Player makes 2-foot layup', source: 'ESPN play-by-play', sourceUrl: 'https://www.espn.com/nba/game/_/gameId/401999101', homeScore: '48', awayScore: '45' }];
  const health = Object.fromEntries(['ESPN scoreboard','ESPN play-by-play','ESPN injuries','ESPN news'].map(name => [name, { okAt: now, checkedAt: now, error: '' }]));
  return { mode: 'live', day: today, generatedAt: now, games: [game], injuries, reviews, feed: [...injuries, ...plays], health };
}
async function open(page) {
  const html = await readFile(new URL(`../${page}.html`, import.meta.url), 'utf8');
  const { document, window } = parseHTML(html);
  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = new URL(`https://example.test/${page}.html?date=${today}${page === 'game' ? `&id=${GAME_ID}` : ''}`);
  globalThis.history = { replaceState() {} };
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, String(value)) };
  globalThis.fetch = async url => {
    assert.match(url, /^\/api\/state\?date=/);
    return new Response(JSON.stringify(state()), { headers: { 'content-type': 'application/json' } });
  };
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => ms >= 10_000 ? 0 : original(callback, ms, ...args);
  try {
    await import(`../assets/app.js?ui=${page}`);
    await new Promise(resolve => original(resolve, 20));
  } finally { globalThis.setTimeout = original; }
  return document;
}

test('all four pages render separate, source-linked feeds from one state; unsafe source text is inert', async () => {
  const home = await open('index');
  assert.equal(home.querySelectorAll('.game-card').length, 1);
  assert.match(home.querySelector('#live-feed').textContent, /questionable to return/);
  assert.match(home.querySelector('#alerts-mini').textContent, /Test Player/);
  assert.match(home.querySelector('#reviews-mini').textContent, /challenge/i);
  assert.ok(home.querySelector('.team-logo'));
  assert.match(home.querySelector('nav a[href*="alerts.html"]').href, /date=/);

  const alerts = await open('alerts');
  assert.equal(alerts.querySelectorAll('#alerts-feed .alert-card').length, 1);
  assert.equal(alerts.querySelectorAll('#alerts-feed img').length, 0);
  assert.doesNotMatch(alerts.querySelector('#alerts-feed').textContent, /Coach's Challenge/);
  assert.ok(alerts.querySelector('#alerts-feed a[href^="https://www.espn.com/"]'));
  alerts.querySelector('#alert-filters [data-filter="out"]').click();
  assert.equal(alerts.querySelectorAll('#alerts-feed .alert-card').length, 0);

  const reviews = await open('reviews');
  assert.equal(reviews.querySelectorAll('#reviews-feed .alert-card').length, 1);
  assert.doesNotMatch(reviews.querySelector('#reviews-feed').textContent, /ankle sprain/);
  assert.match(reviews.querySelector('#reviews-feed').textContent, /Stands \(stated\)/);

  const game = await open('game');
  assert.match(game.querySelector('#game-plays').textContent, /layup/);
  assert.match(game.querySelector('#game-injuries').textContent, /Test Player/);
  assert.match(game.querySelector('#game-reviews').textContent, /challenge/);
  assert.doesNotMatch(game.querySelector('#game-plays').textContent, /ankle sprain/);
});
