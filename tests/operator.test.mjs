// Operator CLI tests. Network commands run against a stub HTTP server on
// 127.0.0.1 (no external egress); validate/sources-validate run fully local.
// Asserts exit codes documented in tools/operator.mjs --help.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (args, env = {}) => new Promise(resolve => {
  execFile(process.execPath, ['tools/operator.mjs', ...args], { cwd: root, env: { ...process.env, ...env } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
});
const payload = (overrides = {}) => ({ gameId: '401999101', athleteId: '1234567', status: 'questionable',
  publishedAt: '2026-10-03T23:20:00Z', source: 'Example Team PR',
  sourceUrl: 'https://www.nba.com/news/example-injury-update',
  text: 'Test Player is questionable to return due to a left ankle sprain.', ...overrides });
async function writePayload(body) {
  const file = join(tmpdir(), `nba-operator-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(body));
  return file;
}
function stubServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('help and sources validate exit 0 without network or token', async () => {
  const help = await run(['help'], { INJURY_INGEST_TOKEN: '' });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /health \[--check\]/);
  const validate = await run(['sources', 'validate']);
  assert.equal(validate.code, 0);
  assert.match(validate.stdout, /registry OK: v1 · 0 entries · 0 automatic/);
});

test('validate preflights a report locally: valid passes, invalid fails before any network', async () => {
  const good = await writePayload(payload());
  const bad = await writePayload(payload({ sourceUrl: 'https://unrelated.example/x' }));
  try {
    const ok = await run(['validate', '--file', good]);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /valid report: game 401999101 athlete 1234567 status questionable/);
    const rejected = await run(['validate', '--file', bad]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /invalid report: Source URL is not from a trusted host/);
  } finally { await rm(good, { force: true }); await rm(bad, { force: true }); }
});

test('health --check exit codes: 0 healthy, 1 on critical alarms, 2 when unreachable', async () => {
  const healthy = { service: 'NBA injury collector', day: '2026-10-03', startedAt: Date.now() - 1000,
    uptimeMs: 1000, live: false, activeGames: 0, alarms: [] };
  const critical = { ...healthy, alarms: [{ name: 'ESPN scoreboard', severity: 'critical', reason: '3 consecutive failures' }] };
  const server = await stubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('critical') ? critical : healthy));
  });
  try {
    const port = server.address().port;
    // The stub answers for any path; point --host at a sub-path is not
    // supported, so verify healthy vs unreachable here and critical below.
    const ok = await run(['health', '--check', '--host', `http://127.0.0.1:${port}`]);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /alarms: 0/);
    server.close();
    await new Promise(resolve => server.on('close', resolve));
    const down = await run(['health', '--check', '--host', `http://127.0.0.1:${port}`]);
    assert.equal(down.code, 2);
    assert.match(down.stderr, /collector unreachable/);
  } finally { server.close(); }
  const alarming = await stubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(critical));
  });
  try {
    const red = await run(['health', '--check', '--host', `http://127.0.0.1:${alarming.address().port}`]);
    assert.equal(red.code, 1);
    assert.match(red.stdout, /critical.*ESPN scoreboard/);
  } finally { alarming.close(); }
});

test('auth commands fail closed without a token and never print it', async () => {
  const audit = await run(['audit'], { INJURY_INGEST_TOKEN: '' });
  assert.equal(audit.code, 2);
  assert.match(audit.stderr, /INJURY_INGEST_TOKEN is not set/);
  const good = await writePayload(payload());
  try {
    const submit = await run(['submit', '--file', good], { INJURY_INGEST_TOKEN: '' });
    assert.equal(submit.code, 2);
    assert.match(submit.stderr, /INJURY_INGEST_TOKEN is not set/);
    assert.doesNotMatch(submit.stdout + submit.stderr, /SECRET/);
  } finally { await rm(good, { force: true }); }
});
