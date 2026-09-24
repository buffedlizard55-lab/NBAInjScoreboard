// Regression tests driven by REAL captured ESPN payloads (tests/real/*.json),
// fetched 2026-09-24 with the page-fetch tool. Their purpose is to catch the
// failure mode that let the original implementation ship broken: a synthetic
// fixture described a schema the live endpoint does not send, so every test
// passed while the production parser produced zero injury candidates.
//
// Nothing here is a claim about a live NBA game. These are preseason/offseason
// records used only to prove the parsers read the real wire format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine, espnAthleteId, parseEspnInjuries, parseEspnNews, hasMedicalDetail } from '../src/engine.mjs';

const load = name => JSON.parse(readFileSync(new URL(`./real/${name}`, import.meta.url), 'utf8'));
const injuries = load('espn-injuries-captured.json');
const news = load('espn-news-captured.json');
const box = load('espn-boxscore-athletes.json');

const rows = injuries.injuries[0].injuries;
const GAME_ID = '401999101';
const START = '2026-10-03T23:00:00Z';
const NOW = Date.parse('2026-10-03T23:30:00Z');

test('the live ESPN injuries feed really omits athlete.id (schema guard)', () => {
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.athlete.id, undefined,
    'If ESPN starts sending athlete.id, update espnAthleteId rather than weakening this guard.');
  // The id is still recoverable from the link, uid, headshot and core-API $ref.
  assert.match(rows[0].athlete.links[0].href, /\/id\/5105571\//);
  assert.match(rows[0].athlete.headshot.href, /full\/5105571\.png$/);
  assert.match(rows[0].athlete.notes.items[0].injury.$ref, /athletes\/5105571\//);
});

test('espnAthleteId recovers the id from each real location and fails closed on conflict', () => {
  const athlete = rows[0].athlete;
  assert.equal(espnAthleteId(athlete, rows[0]), '5105571');
  assert.equal(espnAthleteId({ links: athlete.links }), '5105571', 'player-card/sportscenter links');
  assert.equal(espnAthleteId({ headshot: athlete.headshot }), '5105571', 'headshot filename');
  assert.equal(espnAthleteId({ uid: 's:40~l:46~a:5105571' }), '5105571', 'uid');
  assert.equal(espnAthleteId({ id: 5105571 }), '5105571', 'numeric id, if ESPN ever sends one');
  assert.equal(espnAthleteId(null, rows[0]), '5105571', 'core-API $ref on the injury note');
  // Conflicting evidence must not silently pick a player.
  assert.equal(espnAthleteId({ id: '999', links: athlete.links }), '');
  assert.equal(espnAthleteId({}), '');
});

test('parseEspnInjuries extracts every real row instead of dropping them all', () => {
  const parsed = parseEspnInjuries(injuries);
  assert.deepEqual(parsed.map(p => p.athleteId), ['5105571', '4712863']);
  assert.deepEqual(parsed.map(p => p.teamId), ['1', '1']);
  assert.deepEqual(parsed.map(p => p.name), ['Henri Veesaar', 'Mouhamed Gueye']);
  assert.deepEqual(parsed.map(p => p.status), ['out', 'reported']);
  // The original publisher recorded by ESPN must be surfaced, not invented.
  assert.match(parsed[0].source, /RotoWire/);
  assert.match(parsed[0].source, /^ESPN injury report · /);
  assert.equal(parsed[1].source, 'ESPN injury report', 'no publisher recorded on this row');
  assert.equal(parsed[0].sourceUrl, 'https://www.espn.com/nba/player/news/_/id/5105571/henri-veesaar');
  // sourceKey must be stable per row so repeats corroborate instead of re-alerting.
  assert.equal(new Set(parsed.map(p => p.sourceKey)).size, 2);
});

test('real ESPN wording passes the medical gate, including inflected forms', () => {
  assert.ok(hasMedicalDetail(rows[0].shortComment), 'torn right ACL');
  assert.ok(hasMedicalDetail(rows[1].shortComment), 'surgery / fractured left foot');
  assert.equal(hasMedicalDetail('Resting as part of a scheduled rest day.'), false);
});

test('real current ESPN news produces no injury candidates (no false positives)', () => {
  // Both captured stories tag NBA athletes; neither reports an in-game injury.
  assert.deepEqual(parseEspnNews(news), []);
});

function liveEngine() {
  const engine = new Engine({ now: () => NOW });
  engine.scoreboard('2026-10-03', { events: [{
    id: GAME_ID, date: START,
    status: { type: { state: 'in', shortDetail: '7:15 - 2nd' }, period: 2, displayClock: '7:15' },
    competitions: [{ competitors: [
      { homeAway: 'away', score: '45', team: { id: '9002', abbreviation: 'AWY', displayName: 'Away Team', logo: '' } },
      { homeAway: 'home', score: '48', team: { id: '9001', abbreviation: 'HOM', displayName: 'Home Team', logo: '' } }
    ] }]
  }] });
  engine.summary(GAME_ID, { header: { id: GAME_ID }, boxscore: { players: [box] }, plays: [] });
  return engine;
}

test('real box-score rows prove participation for players who played, never for DNPs', () => {
  const engine = liveEngine();
  const game = engine.games.get(GAME_ID);
  assert.deepEqual(Object.keys(game.participants).sort(), ['2991043', '4432166'],
    'Cade Cunningham (41 min) and Caris LeVert (4 min) played; Tolu Smith and Marcus Sasser did not');
  assert.match(game.participants['4432166'].proof, /minutes played/);
  // "reason":"COACH'S DECISION" appears on players who played 41 minutes, so it
  // must never be used as a did-not-play signal.
  assert.equal(game.participants['4397882'], undefined);
  assert.equal(game.participants['4432107'], undefined);
});

test('end to end: a real-shaped injury row for a real participating athlete raises one alert', () => {
  const engine = liveEngine();
  const real = rows[0];
  const inGame = { ...real, date: '2026-10-03T23:12:00Z', status: 'Questionable',
    shortComment: 'Test guard is questionable to return due to a left ankle sprain.' };
  // Reuse the captured athlete object, but with the athlete who is in this fixture box score.
  // Keep the athlete object internally consistent: ESPN's injury note carries the
  // same athlete id in its core-API $ref, and espnAthleteId fails closed if the
  // sources disagree (proven separately above) rather than guessing a player.
  inGame.athlete = { ...box.statistics[0].athletes[0].athlete,
    links: [{ rel: ['news', 'desktop', 'athlete'], href: 'https://www.espn.com/nba/player/news/_/id/4432166/test' }],
    notes: { items: [{ ...real.athlete.notes.items[0], source: 'RotoWire',
      injury: { $ref: 'http://sports.core.api.espn.pvt/v2/sports/basketball/leagues/nba/seasons/2027/athletes/4432166/injuries/-57577?lang=en&region=us' } }] } };
  engine.injuriesFeed({ injuries: [{ id: '9001', injuries: [inGame] }] });
  const state = engine.snapshot('2026-10-03');
  assert.equal(state.injuries.length, 1);
  assert.equal(state.injuries[0].athleteId, '4432166');
  assert.equal(state.injuries[0].player, 'Cade Cunningham');
  assert.equal(state.injuries[0].status, 'questionable');
  assert.match(state.injuries[0].evidence[0].source, /RotoWire/);
  assert.equal(state.feed.filter(e => e.kind === 'injury').length, 1, 'the same update appears in the live feed');
  assert.equal(engine.drainChanges().filter(c => c.kind === 'injury').length, 1);
  // A repeat of the identical row corroborates; it must not create a second alert.
  engine.injuriesFeed({ injuries: [{ id: '9001', injuries: [inGame] }] });
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 1);
  assert.equal(engine.drainChanges().filter(c => c.kind === 'injury').length, 0);
});

test('the same injury row for a player who is NOT in this game never alerts', () => {
  const engine = liveEngine();
  engine.injuriesFeed(injuries); // 5105571 and 4712863 are not participants here
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
});
