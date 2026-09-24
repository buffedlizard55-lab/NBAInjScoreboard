import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, easternDate, dateOffset, validDate, parseEspnInjuries, parseEspnNews, classifyReport, reviewSignal, parseScoreboard } from '../src/engine.mjs';
import { GAME_ID, OFFICIAL_ID, START, liveScoreboard, summary, injury, news, nbaScoreboard, nbaPbp } from './fixtures.mjs';

const NOW = Date.parse('2026-10-03T23:30:00Z');
function ready() {
  const engine = new Engine({ now: () => NOW });
  engine.scoreboard('2026-10-03', liveScoreboard());
  engine.summary(GAME_ID, summary());
  return engine;
}
test('Eastern game dates respect midnight and DST and reject invalid dates', () => {
  assert.equal(easternDate(new Date('2026-10-04T03:59:00Z')), '2026-10-03');
  assert.equal(easternDate(new Date('2026-10-04T04:01:00Z')), '2026-10-04');
  assert.equal(easternDate(new Date('2026-01-04T04:30:00Z')), '2026-01-03');
  assert.equal(dateOffset('2026-10-03', -1), '2026-10-02');
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2024-02-29'), true);
});
test('scoreboard keeps real phases/teams/scores, rejects malformed payload', () => {
  assert.equal(parseScoreboard(liveScoreboard('in'), '2026-10-03')[0].phase, 'in');
  assert.equal(parseScoreboard(liveScoreboard('pre'), '2026-10-03')[0].phase, 'pre');
  assert.equal(parseScoreboard(liveScoreboard('post'), '2026-10-03')[0].home.abbr, 'BOS');
  assert.throws(() => parseScoreboard({}, '2026-10-03'), /Invalid ESPN/);
  assert.throws(() => parseScoreboard(liveScoreboard(), '2026-02-30'), /Invalid ESPN/);
});
test('a live player with box-score minutes can be reported; feed and alerts share the same update', () => {
  const engine = ready();
  engine.injuriesFeed(injury());
  const state = engine.snapshot('2026-10-03');
  assert.equal(state.injuries.length, 1);
  assert.equal(state.injuries[0].status, 'questionable');
  assert.match(state.injuries[0].proof, /minutes played/);
  assert.equal(state.feed.filter(e => e.kind === 'injury').length, 1);
  assert.equal(state.injuries[0].evidence[0].source, 'ESPN injury report');
  assert.equal(engine.drainChanges().filter(c => c.kind === 'injury').length, 1);
  engine.injuriesFeed(injury());
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 1);
  assert.equal(engine.drainChanges().filter(c => c.kind === 'injury').length, 0);
});
test('do not turn old pregame, future game, personal reason, unrelated team, DNP or final-game items into live alerts', () => {
  const engine = ready();
  engine.injuriesFeed(injury({ date: '2026-10-03T22:50:00Z' }));
  engine.injuriesFeed(injury({ date: '2026-10-03T23:02:00Z' })); // after scheduled tip, before first recorded basketball action
  engine.injuriesFeed(injury({ id: '7654321' }));
  engine.injuriesFeed(injury({ team: '3' }));
  engine.injuriesFeed(injury({ text: 'Test Player is out for personal reasons.' }));
  engine.injuriesFeed(injury({ text: "Test Player (ankle) is out for Tuesday's game." }));
  engine.injuriesFeed(injury({ text: 'Test Player injured ankle but will not play Friday.' }));
  engine.injuriesFeed(injury({ text: 'Test Player (ankle) may not play next Monday.' }));
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
  engine.scoreboard('2026-10-03', liveScoreboard('post'));
  engine.injuriesFeed(injury());
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
});
test('reports pending box score participation can be picked up on the next poll', () => {
  const engine = new Engine({ now: () => NOW });
  engine.scoreboard('2026-10-03', liveScoreboard());
  engine.injuriesFeed(injury());
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
  engine.summary(GAME_ID, summary()); engine.injuriesFeed(injury());
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 1);
});
test('short legacy ESPN athlete IDs retain minutes/play participation and in-game injury matching', () => {
  const engine = new Engine({ now: () => NOW });
  engine.scoreboard('2026-10-03', liveScoreboard());
  const data = summary();
  data.boxscore.players[0].statistics[0].athletes[0].athlete = { id: '6440', displayName: 'Legacy Test Player' };
  data.plays[0].participants[0].athlete.id = '6440';
  engine.summary(GAME_ID, data);
  const report = injury({ id: '6440', text: 'Legacy Test Player is questionable to return with an ankle sprain.' });
  report.injuries[0].injuries[0].athlete.displayName = 'Legacy Test Player';
  engine.injuriesFeed(report);
  assert.equal(engine.games.get(GAME_ID).participants['6440'].proof, 'ESPN box score: minutes played');
  assert.equal(engine.snapshot('2026-10-03').injuries[0].status, 'questionable');
});
test('recorded basketball action can prove participation even before minutes appear', () => {
  const engine = new Engine({ now: () => NOW });
  engine.scoreboard('2026-10-03', liveScoreboard());
  const data = summary();
  data.boxscore.players[0].statistics[0].athletes[0].stats = [];
  engine.summary(GAME_ID, data);
  engine.injuriesFeed(injury());
  assert.match(engine.snapshot('2026-10-03').injuries[0].proof, /recorded action/);
  assert.equal(engine.games.get(GAME_ID).participants['7654321'], undefined);
});
test('status progression; cross-source corroboration dedups; stale later source cannot reverse newer status', () => {
  const engine = ready();
  engine.injuriesFeed(injury());
  engine.injuriesFeed(injury({ status: 'Out', date: '2026-10-03T23:12:00Z', text: 'Test Player (left ankle sprain) was ruled out.' }));
  engine.newsFeed(news());
  assert.deepEqual(engine.snapshot('2026-10-03').injuries.map(e => e.status), ['confirmed_out','out','questionable']);
  engine.injuriesFeed(injury({ status: 'Questionable', date: '2026-10-03T23:11:00Z', text: 'Test Player (ankle) is questionable.' }));
  assert.equal(engine.snapshot('2026-10-03').injuries[0].status, 'confirmed_out');
  engine.injuriesFeed(injury({ status: 'Out', date: '2026-10-03T23:16:00Z', text: 'Test Player has an ankle injury and is out.' }));
  assert.equal(engine.snapshot('2026-10-03').injuries[0].status, 'confirmed_out');
  assert.equal(engine.snapshot('2026-10-03').injuries[0].evidence.length, 2);
  const restored = new Engine({ now: () => NOW, saved: engine.export() });
  restored.injuriesFeed(injury());
  assert.equal(restored.snapshot('2026-10-03').injuries.length, 3);
});
test('separate reviews use explicit PBP; never invent an injury or review outcome', () => {
  const engine = ready();
  engine.nbaScoreboard(nbaScoreboard());
  assert.equal(engine.games.get(GAME_ID).officialId, OFFICIAL_ID);
  engine.nbaPbp(GAME_ID, nbaPbp());
  let state = engine.snapshot('2026-10-03');
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].type, 'challenge');
  assert.equal(state.reviews[0].outcome, 'overturned');
  assert.equal(state.reviews[0].evidence.length, 2);
  assert.equal(state.injuries.length, 0);
  engine.nbaPbp(GAME_ID, nbaPbp());
  state = engine.snapshot('2026-10-03');
  assert.equal(state.reviews[0].evidence.length, 2);
  assert.equal(state.feed[0].source, 'NBA official play-by-play');
  assert.throws(() => engine.nbaPbp(GAME_ID, { game: { gameId: '0028800101', actions: [] } }), /Invalid NBA/);
  assert.equal(reviewSignal('Timeout after shot').found, false);
  assert.equal(reviewSignal('Instant Replay: out of bounds').result, '');
});
test('conflicting explicit replay outcomes are flagged, not assigned a fabricated winner', () => {
  const engine = ready();
  engine.nbaScoreboard(nbaScoreboard());
  engine.nbaPbp(GAME_ID, nbaPbp());
  const espn = summary();
  espn.plays.push({ id: `${GAME_ID}999`, wallclock: '2026-10-03T23:09:00Z', type: { text: 'Instant Replay' },
    text: 'Replay Review: call stands', period: { number: 1 }, clock: { displayValue: '10:00' }, awayScore: 2, homeScore: 0 });
  engine.summary(GAME_ID, espn);
  assert.equal(engine.snapshot('2026-10-03').reviews[0].outcome, 'conflict');
  assert.equal(engine.snapshot('2026-10-03').reviews[0].evidence.length, 3);
});
test('review text is not misclassified as an injury report; no made-up future scores', () => {
  assert.equal(classifyReport('Player went to the bench'), '');
  assert.equal(classifyReport('Player will not return to the game after a left ankle sprain'), 'confirmed_out');
  assert.equal(classifyReport('Player (ankle) out for Tuesday\'s game'), '');
  assert.equal(classifyReport('Player injured his knee in the third quarter'), 'reported');
  assert.equal(reviewSignal("Coach's Challenge: foul being reviewed").found, true);
  assert.equal(reviewSignal('Call stands').found, false);
});
test('news needs exact athlete in headline, timestamp, explicit injury wording and source URL', () => {
  assert.equal(parseEspnNews(news()).length, 1);
  const duplicateCategory = news();
  duplicateCategory.articles[0].categories.push(duplicateCategory.articles[0].categories[0]);
  assert.equal(parseEspnNews(duplicateCategory).length, 1);
  assert.equal(parseEspnNews(news({ headline: 'Another Player injures knee' })).length, 0);
  assert.equal(parseEspnNews(news({ headline: 'Test Player signs a contract' })).length, 0);
  assert.equal(parseEspnNews(news({ headline: 'Test Player will not return after ejection', description: 'Flagrant foul ejection.' })).length, 0);
  assert.equal(parseEspnNews(news({ date: 'invalid' })).length, 0);
  const engine = ready();
  engine.newsFeed(news());
  assert.equal(engine.snapshot('2026-10-03').injuries[0].status, 'confirmed_out');
  assert.throws(() => parseEspnNews({}), /Invalid ESPN/);
});
test('name-only articles cannot select one of two live players with the same name', () => {
  const engine = ready();
  const second = structuredClone(liveScoreboard().events[0]);
  second.id = '401999102';
  second.competitions[0].competitors[0].team.id = '3';
  second.competitions[0].competitors[1].team.id = '4';
  const slate = liveScoreboard();
  slate.events.push(second);
  engine.scoreboard('2026-10-03', slate);
  const details = summary();
  details.header.id = second.id;
  details.boxscore.players[0].team.id = '3';
  details.boxscore.players[1].team.id = '4';
  details.boxscore.players[0].statistics[0].athletes[0].athlete.id = '9999999';
  details.plays = [];
  engine.summary(second.id, details);
  assert.equal(engine.accept({ sourceKey: 'untagged-story', publishedAt: Date.parse('2026-10-03T23:10:00Z'),
    name: 'Test Player', status: 'questionable', text: 'Test Player questionable to return with an ankle injury.' }), false);
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
});
test('official mapping requires unique teams and reasonable game time', () => {
  const engine = ready();
  const data = nbaScoreboard();
  data.scoreboard.games[0].gameTimeUTC = '2026-10-01T19:00:00Z';
  engine.nbaScoreboard(data);
  assert.equal(engine.games.get(GAME_ID).officialId, '');
  assert.throws(() => engine.nbaScoreboard({}), /Invalid NBA/);
});
test('editorial intake still needs live participation and is deduplicated', () => {
  const engine = ready();
  const item = { gameId: GAME_ID, athleteId: '1234567', teamId: '1', status: 'reported',
    text: 'Team statement: Test Player has a right ankle injury.', source: 'Curated · official team', sourceUrl: 'https://www.nba.com/news/example', publishedAt: Date.parse('2026-10-03T23:20:00Z') };
  assert.equal(engine.curated(item), true);
  assert.equal(engine.curated(item), false);
  assert.equal(engine.curated({ ...item, athleteId: '7654321' }), false);
  assert.equal(engine.curated({ ...item, status: 'confirmed_out' }), false); // no won't-return wording
  assert.equal(engine.curated({ ...item, text: 'Another person has a right ankle injury.' }), false);
  const standalone = ready();
  assert.equal(standalone.curated({ ...item, status: 'returned', text: 'Test Player returned to the game.' }), false);
  assert.equal(standalone.curated({ ...item, status: 'confirmed_out', text: 'Test Player will not return after ejection.' }), false);
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 1);
});
test('ESPN raw injury shape and timestamps fail closed', () => {
  assert.equal(parseEspnInjuries(injury()).length, 1);
  assert.equal(parseEspnInjuries(injury({ date: '' })).length, 0);
  assert.equal(parseEspnInjuries(injury({ text: 'Out - personal reasons' })).length, 0);
  assert.throws(() => parseEspnInjuries({}), /Invalid ESPN/);
  const engine = ready();
  engine.injuriesFeed(injury({ date: '2026-10-04T00:45:00Z' }));
  assert.equal(engine.snapshot('2026-10-03').injuries.length, 0);
});
