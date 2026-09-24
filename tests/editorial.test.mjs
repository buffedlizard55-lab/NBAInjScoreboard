// Editorial validation tests. src/editorial.mjs is imported by BOTH the server
// and the operator CLI, so these assertions pin the single source of truth.
// Every rule below mirrors a line in that module; the server adds only the
// live-game/participation/duplicate gates from Engine.curated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedUrl, exactZonedTimestamp, validateReport, EDITORIAL_STATUSES } from '../src/editorial.mjs';

const report = () => ({ gameId: '401999101', athleteId: '1234567', status: 'questionable',
  publishedAt: '2026-10-03T23:20:00Z', source: 'Example Team PR',
  sourceUrl: 'https://www.nba.com/news/example-injury-update',
  text: 'Test Player is questionable to return due to a left ankle sprain.' });

test('approvedUrl accepts default and configured hosts, verified-handle status URLs only', () => {
  assert.equal(approvedUrl('https://www.nba.com/news/x'), true);
  assert.equal(approvedUrl('https://www.espn.com/nba/story/_/id/1/x'), true);
  assert.equal(approvedUrl('https://apnews.com/article/x'), true);
  assert.equal(approvedUrl('https://sub.espn.com/x'), true, 'subdomains of approved hosts');
  assert.equal(approvedUrl('https://espn.com.evil.example/x'), false, 'suffix match is not allowed');
  assert.equal(approvedUrl('http://www.nba.com/news/x'), false, 'https only');
  assert.equal(approvedUrl('https://www.nba.com:8443/news/x'), false, 'no ports');
  assert.equal(approvedUrl('https://user@www.nba.com/news/x'), false, 'no userinfo');
  assert.equal(approvedUrl('https://unrelated.example/x'), false);
  assert.equal(approvedUrl('https://team.example/news/x', { trustedHosts: 'team.example' }), true);
  assert.equal(approvedUrl('https://other.example/x', { trustedHosts: 'team.example' }), false);
  assert.equal(approvedUrl('https://x.com/TeamPR/status/1234567890123456789', { trustedHandles: 'TeamPR' }), true);
  assert.equal(approvedUrl('https://twitter.com/TeamPR/status/1234567890123456789', { trustedHandles: '@TeamPR' }), true);
  assert.equal(approvedUrl('https://x.com/Other/status/1234567890123456789', { trustedHandles: 'TeamPR' }), false);
  assert.equal(approvedUrl('https://x.com/TeamPR', { trustedHandles: 'TeamPR' }), false, 'profile URL is not citable');
  assert.equal(approvedUrl('not a url'), false);
});

test('exactZonedTimestamp requires a zone and a real calendar date', () => {
  assert.equal(exactZonedTimestamp('2026-10-03T23:20:00Z'), Date.parse('2026-10-03T23:20:00Z'));
  assert.equal(exactZonedTimestamp('2026-10-03T19:20:00-04:00'), Date.parse('2026-10-03T19:20:00-04:00'));
  assert.equal(exactZonedTimestamp('2026-10-03T23:20:00'), NaN, 'ambiguous local time is rejected');
  assert.equal(exactZonedTimestamp('2026-02-30T12:00:00Z'), NaN, 'impossible date is rejected');
  assert.equal(exactZonedTimestamp('tomorrow at 7'), NaN);
});

test('validateReport accepts a complete payload and names each violation', () => {
  assert.deepEqual(EDITORIAL_STATUSES, ['reported', 'questionable', 'out', 'confirmed_out', 'returned']);
  const ok = validateReport(report());
  assert.equal(ok.ok, true);
  assert.equal(ok.publishedAt, Date.parse('2026-10-03T23:20:00Z'));
  assert.equal(ok.sourceId, '');
  assert.match(validateReport({ ...report(), sourceUrl: 'https://unrelated.example/x' }).error, /trusted host/);
  assert.match(validateReport({ ...report(), text: 'too short' }).error, /20-700/);
  assert.match(validateReport({ ...report(), source: 'x' }).error, /3-80/);
  assert.match(validateReport({ ...report(), publishedAt: '2026-10-03 23:20' }).error, /zoned ISO/);
  assert.match(validateReport({ ...report(), athleteId: 'abc' }).error, /athleteId/);
  assert.match(validateReport({ ...report(), gameId: '42' }).error, /gameId/);
  assert.match(validateReport({ ...report(), status: 'injured' }).error, /status must be/);
});

test('validateReport scopes sourceId to one registry entry', () => {
  const registry = { version: 1, sources: [
    { id: 'team-pr', kind: 'team-pr', publisher: 'Team PR', description: 'd', hosts: ['team.example'], handles: [], status: 'approved', autoPoll: false },
    { id: 'suspended-beat', kind: 'reporter', publisher: 'Beat', description: 'd', hosts: ['beat.example'], handles: [], status: 'suspended', autoPoll: false }
  ] };
  const viaEntry = validateReport({ ...report(), sourceId: 'team-pr', sourceUrl: 'https://team.example/news/x' }, { registry });
  assert.equal(viaEntry.ok, true);
  assert.equal(viaEntry.sourceId, 'team-pr');
  assert.match(validateReport({ ...report(), sourceId: 'team-pr', sourceUrl: 'https://other.example/x' }, { registry }).error, /trusted host/);
  assert.match(validateReport({ ...report(), sourceId: 'nope' }, { registry }).error, /Unknown sourceId/);
  assert.match(validateReport({ ...report(), sourceId: 'suspended-beat', sourceUrl: 'https://beat.example/x' }, { registry }).error, /suspended/);
  // Without a sourceId, a non-suspended registry host is also accepted.
  assert.equal(validateReport({ ...report(), sourceUrl: 'https://team.example/news/x' }, { registry }).ok, true);
  assert.equal(validateReport({ ...report(), sourceUrl: 'https://beat.example/x' }, { registry }).ok, false, 'suspended entries never match');
});
