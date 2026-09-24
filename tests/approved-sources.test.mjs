// Approved team/reporter/social registry tests.
// The shipped registry must contain ZERO automatic sources: no authorization,
// identity verification, terms review or replayable captures exist in this
// repository, so automatic collection of those channels stays disabled.
// Every gate below is asserted line by line against src/approved-sources.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { validateSource, validateRegistry, isApprovedForAuto, approvedAutoSources, sourceAllowsUrl, findSourcesForUrl } from '../src/approved-sources.mjs';

const shipped = JSON.parse(await readFile(new URL('../config/approved-sources.json', import.meta.url), 'utf8'));

const full = () => ({
  id: 'example-team-pr',
  kind: 'team-pr',
  publisher: 'Example Team PR',
  description: 'Official injury updates posted by the example team PR account.',
  hosts: ['www.example.com'],
  handles: ['ExampleTeamPR'],
  authorization: { basis: 'Written permission from the team communications office.', reviewedAt: '2026-09-20', reviewer: 'Ops lead', notes: 'On file.' },
  identity: { method: 'Verified check plus bio link to team domain plus test post.', verifiedAt: '2026-09-20', evidence: 'On file with operators.' },
  terms: { reviewedAt: '2026-09-20', policyUrl: 'https://example.com/terms', notes: 'Collection permitted at stated rate.' },
  captures: [],
  status: 'approved',
  autoPoll: false
});

test('shipped registry is valid and enables zero automatic team/social sources', () => {
  assert.deepEqual(validateRegistry(shipped, { rootDir: new URL('..', import.meta.url).pathname }), []);
  assert.deepEqual(approvedAutoSources(shipped), [], 'no automatic team/reporter/social collection is active');
});

test('structural validation rejects malformed entries', () => {
  assert.match(validateSource({ ...full(), id: 'Bad ID!' })[0], /must match/);
  assert.match(validateSource({ ...full(), kind: 'rss' })[0], /kind must be/);
  assert.match(validateSource({ ...full(), hosts: [], handles: [] })[0], /host or handle/);
  assert.match(validateSource({ ...full(), hosts: ['example.com:8080'] })[0], /invalid host/);
  assert.match(validateSource({ ...full(), hosts: ['not a host'] })[0], /invalid host/);
  assert.match(validateSource({ ...full(), handles: ['way-too-long-handle-name'] })[0], /invalid handle/);
  assert.match(validateSource({ ...full(), status: 'pending' })[0], /status must be/);
  assert.match(validateSource({ ...full(), autoPoll: 'yes' })[0], /autoPoll must be/);
  assert.match(validateSource({ ...full(), status: 'proposed', autoPoll: true })[0], /requires status "approved"/);
  assert.deepEqual(validateSource(full()), [], 'a complete non-auto approved entry validates');
  assert.deepEqual(validateSource({ ...full(), status: 'proposed', autoPoll: false, authorization: {}, identity: {}, terms: {} }), [],
    'proposed entries may omit the checklist until they seek approval');
});

test('approval checklist is mandatory before automatic collection', () => {
  const base = { ...full(), autoPoll: true };
  assert.ok(validateSource({ ...base, authorization: {} }).some(e => e.includes('authorization.basis')));
  assert.ok(validateSource({ ...base, identity: {} }).some(e => e.includes('identity.method')));
  assert.ok(validateSource({ ...base, terms: {} }).some(e => e.includes('terms.reviewedAt')));
  assert.ok(validateSource({ ...base }).some(e => e.includes('at least one replayable capture')));
  assert.equal(isApprovedForAuto(base), false);
  assert.equal(isApprovedForAuto({ ...base, status: 'suspended' }), false);
});

test('autoPoll requires a capture file that actually exists on disk', async () => {
  const root = join(tmpdir(), `nba-capture-${randomUUID()}`);
  try {
    await mkdir(join(root, 'tests', 'real'), { recursive: true });
    await writeFile(join(root, 'tests', 'real', 'team-post.json'), '{"post":"verbatim capture"}');
    const entry = { ...full(), autoPoll: true,
      captures: [{ path: 'tests/real/team-post.json', capturedAt: '2026-09-20T12:00:00Z', provenance: 'Manual save of the public post HTML.', parser: 'parseTeamPost in src/team-post.mjs, tested in tests/team-post.test.mjs' }] };
    assert.deepEqual(validateSource(entry, { rootDir: root }), []);
    assert.equal(isApprovedForAuto(entry, { rootDir: root }), true);
    const missing = { ...entry, captures: [{ ...entry.captures[0], path: 'tests/real/does-not-exist.json' }] };
    assert.ok(validateSource(missing, { rootDir: root }).some(e => e.includes('capture file missing')));
    assert.equal(isApprovedForAuto(missing, { rootDir: root }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registry rejects duplicate ids and unknown versions', () => {
  assert.deepEqual(validateRegistry({ version: 1, sources: [full(), full()] }).filter(e => e.includes('duplicate')).length, 1);
  assert.deepEqual(validateRegistry({ version: 99, sources: [] }), ['registry.version must be 1']);
  assert.deepEqual(validateRegistry({ version: 1, sources: {} }), ['registry.sources must be an array']);
});

test('URL scoping matches exact hosts and verified-handle status URLs only', () => {
  const entry = full();
  assert.equal(sourceAllowsUrl(entry, 'https://www.example.com/news/injury-update'), true);
  assert.equal(sourceAllowsUrl(entry, 'https://www.example.com.evil.example/news/x'), false, 'suffix match is not allowed');
  assert.equal(sourceAllowsUrl(entry, 'http://www.example.com/news/x'), false, 'https only');
  assert.equal(sourceAllowsUrl(entry, 'https://www.example.com:8443/news/x'), false, 'no ports');
  assert.equal(sourceAllowsUrl(entry, 'https://x.com/ExampleTeamPR/status/1234567890123456789'), true);
  assert.equal(sourceAllowsUrl(entry, 'https://twitter.com/ExampleTeamPR/status/1234567890123456789'), true);
  assert.equal(sourceAllowsUrl(entry, 'https://x.com/OtherAccount/status/1234567890123456789'), false, 'unlisted handle');
  assert.equal(sourceAllowsUrl(entry, 'https://x.com/ExampleTeamPR'), false, 'profile URL is not a citable post');
  assert.equal(sourceAllowsUrl(entry, 'https://x.com/ExampleTeamPR/status/abc'), false, 'post id must be numeric');
  assert.deepEqual(findSourcesForUrl({ sources: [entry] }, 'https://www.example.com/news/x').map(s => s.id), ['example-team-pr']);
  assert.deepEqual(findSourcesForUrl({ sources: [{ ...entry, status: 'suspended' }] }, 'https://www.example.com/news/x'), [], 'suspended sources never match');
  assert.deepEqual(findSourcesForUrl({ sources: [entry] }, 'https://unrelated.example/other'), []);
});
