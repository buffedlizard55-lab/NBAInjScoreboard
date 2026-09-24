// Operator tooling for the hosted collector. No runtime dependencies.
//
//   node tools/operator.mjs health [--host URL] [--check] [--json]
//   node tools/operator.mjs metrics [--host URL] [--json]
//   node tools/operator.mjs sources [--host URL] [--json]
//   node tools/operator.mjs sources validate [--registry PATH]
//   node tools/operator.mjs audit [--host URL] [--limit N] [--json]
//   node tools/operator.mjs events [--host URL] [--limit N] [--json]
//   node tools/operator.mjs validate --file payload.json [--registry PATH]
//   node tools/operator.mjs submit --file payload.json [--host URL]
//
// Auth commands (audit, events, submit) read INJURY_INGEST_TOKEN from the
// environment only -- never pass it as a CLI flag (shell history, ps output).
// The token is never printed. Host defaults to NBA_COLLECTOR_URL or
// http://localhost:3000. `health --check` is for uptime monitors: exit 0 when
// reachable with no critical alarms, 1 on critical alarms, 2 when unreachable.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../src/approved-sources.mjs';
import { validateReport } from '../src/editorial.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultRegistry = resolve(root, 'config/approved-sources.json');
const host = flagValue('--host') || process.env.NBA_COLLECTOR_URL || 'http://localhost:3000';
const jsonOut = hasFlag('--json');

function args() { return process.argv.slice(2); }
function hasFlag(name) { return args().includes(name); }
function flagValue(name) {
  const index = args().indexOf(name);
  return index >= 0 ? args()[index + 1] : '';
}
function fail(message, code = 1) {
  console.error(`operator: ${message}`);
  process.exit(code);
}
function out(payload) {
  console.log(jsonOut ? JSON.stringify(payload, null, 2) : payload);
}
async function get(path, { auth = false } = {}) {
  const headers = {};
  if (auth) {
    const token = process.env.INJURY_INGEST_TOKEN;
    if (!token) fail('INJURY_INGEST_TOKEN is not set in this shell', 2);
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${host}${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) fail(`${path} returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`, response.status === 401 ? 2 : 1);
  return response.json();
}
async function localRegistry() {
  const path = flagValue('--registry') || defaultRegistry;
  try {
    return await loadRegistry(resolve(path));
  } catch (error) {
    fail(`cannot load registry ${path}: ${error.message}`);
  }
}
async function payload() {
  const file = flagValue('--file');
  if (!file) fail('missing --file payload.json');
  try {
    return JSON.parse(await readFile(resolve(file), 'utf8'));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function showHealth(data) {
  if (jsonOut) return out(data);
  const lines = [
    `service: ${data.service} (${data.day})`,
    `uptime: ${Math.round((data.uptimeMs || 0) / 1000)}s since ${new Date(data.startedAt).toISOString()}`,
    `live: ${data.live ? 'yes' : 'no'} · active games: ${data.activeGames}`,
    `alarms: ${data.alarms?.length || 0}`
  ];
  for (const alarm of data.alarms || []) lines.push(`  [${alarm.severity}] ${alarm.name}: ${alarm.reason}`);
  out(lines.join('\n'));
}
function showMetrics(data) {
  if (jsonOut) return out(data);
  const names = Object.keys(data.metrics || {});
  const lines = [`sources with attempts: ${names.length} · alarms: ${data.alarms?.length || 0}`];
  for (const name of names.sort()) {
    const m = data.metrics[name];
    lines.push(`  ${name}: ${m.successes}/${m.attempts} ok · failures=${m.failures} consecutive=${m.consecutiveFailures}${m.lastError ? ` · last: ${m.lastError}` : ''}`);
  }
  for (const alarm of data.alarms || []) lines.push(`  [${alarm.severity}] ${alarm.name}: ${alarm.reason}`);
  out(lines.join('\n'));
}
function showSources(data) {
  const registry = data.registry || data;
  if (jsonOut) return out(registry);
  const sources = registry.sources || [];
  const auto = sources.filter(s => s.autoPoll && s.status === 'approved');
  const lines = [`approved-sources registry v${registry.version} · entries: ${sources.length} · automatic: ${auto.length}`];
  for (const s of sources) lines.push(`  ${s.id} [${s.kind}/${s.status}${s.autoPoll ? '/auto' : ''}] ${s.publisher}`);
  if (!auto.length) lines.push('  automatic team/reporter/social collection is OFF; curated intake only');
  out(lines.join('\n'));
}
function showLog(data) {
  if (jsonOut) return out(data);
  const entries = data.entries || [];
  if (!entries.length) return out('(no entries)');
  out(entries.map(e => `${e.at} ${e.action || e.kind} ${[e.gameId, e.athleteId, e.status, e.id, e.reason].filter(Boolean).join(' ')}`.trim()).join('\n'));
}

const [command, sub] = args();
if (!command || command === 'help' || hasFlag('--help') || hasFlag('-h')) {
  console.log(`NBA collector operator tooling. Host: ${host} (override with --host or NBA_COLLECTOR_URL).\n\n` +
    `  health [--check] [--json]     collector health, uptime and alarms (--check: exit 1 on critical, 2 unreachable)\n` +
    `  metrics [--json]              per-source request counters and alarms\n` +
    `  sources [--json]              approved team/reporter registry as loaded by the collector\n` +
    `  sources validate              validate the local registry file (default config/approved-sources.json)\n` +
    `  audit [--limit N]             recent intake actions (needs INJURY_INGEST_TOKEN)\n` +
    `  events [--limit N]            recent state transitions (needs INJURY_INGEST_TOKEN)\n` +
    `  validate --file p.json        preflight a curated report without sending it\n` +
    `  submit --file p.json          preflight then POST a curated report (needs INJURY_INGEST_TOKEN)\n\n` +
    `Client-side checks mirror the server but the server is authoritative: its\n` +
    `allowlist env may differ, and only it enforces live-game/participation gates.`);
  process.exit(0);
}

if (command === 'health') {
  try {
    const data = await get('/api/health');
    showHealth(data);
    if (hasFlag('--check') && (data.alarms || []).some(a => a.severity === 'critical')) process.exit(1);
  } catch (error) {
    if (hasFlag('--check')) fail(`collector unreachable: ${error.message}`, 2);
    throw error;
  }
} else if (command === 'metrics') {
  showMetrics(await get('/api/metrics'));
} else if (command === 'sources' && sub === 'validate') {
  const registry = await localRegistry();
  console.log(`registry OK: v${registry.version} · ${registry.sources.length} entries · ` +
    `${registry.sources.filter(s => s.autoPoll && s.status === 'approved').length} automatic`);
} else if (command === 'sources') {
  showSources(await get('/api/sources'));
} else if (command === 'audit') {
  const limit = Number(flagValue('--limit')) || 50;
  showLog(await get(`/api/audit?limit=${limit}`, { auth: true }));
} else if (command === 'events') {
  const limit = Number(flagValue('--limit')) || 50;
  showLog(await get(`/api/events?limit=${limit}`, { auth: true }));
} else if (command === 'validate') {
  const body = await payload();
  const registry = await localRegistry();
  const check = validateReport(body, { registry,
    trustedHosts: process.env.TRUSTED_SOURCE_HOSTS, trustedHandles: process.env.TRUSTED_SOCIAL_HANDLES });
  if (!check.ok) fail(`invalid report: ${check.error}`);
  console.log(`valid report: game ${body.gameId} athlete ${body.athleteId} status ${body.status} published ${body.publishedAt}`);
} else if (command === 'submit') {
  const body = await payload();
  const registry = await localRegistry();
  const check = validateReport(body, { registry,
    trustedHosts: process.env.TRUSTED_SOURCE_HOSTS, trustedHandles: process.env.TRUSTED_SOCIAL_HANDLES });
  if (!check.ok) fail(`invalid report (not sent): ${check.error}`);
  const token = process.env.INJURY_INGEST_TOKEN;
  if (!token) fail('INJURY_INGEST_TOKEN is not set in this shell', 2);
  // The token travels only in this request's Authorization header and is never printed.
  const response = await fetch(`${host}/api/reports`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 201) {
    console.log(`accepted${data.warning ? ` (warning: ${data.warning})` : ''}`);
  } else {
    fail(`server returned HTTP ${response.status}: ${data.error || 'unknown error'}${response.status === 422 ? ' (server allowlists/gates may differ from this shell)' : ''}`);
  }
} else {
  fail(`unknown command "${command}" (try: help)`, 2);
}
