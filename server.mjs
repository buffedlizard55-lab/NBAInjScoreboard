import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Collector, loadSaved } from './src/collector.mjs';
import { easternDate, validDate } from './src/engine.mjs';
import { loadRegistry } from './src/approved-sources.mjs';
import { str, validateReport } from './src/editorial.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = resolve(process.env.NBA_STATE_FILE || `${root}/.runtime/state.json`);
const collector = new Collector({ statePath, saved: await loadSaved(statePath) });
// Approved team/reporter/social registry. Empty by default: no automatic
// collection of those channels is active (see config/approved-sources.json).
// A broken registry must not take down the collector; it only narrows intake.
const registryPath = resolve(process.env.NBA_SOURCES_FILE || `${root}/config/approved-sources.json`);
let registry = { version: 1, updatedAt: '', sources: [] };
try {
  registry = await loadRegistry(registryPath);
  collector.engine.source('Approved source registry');
} catch (error) {
  const detail = String(error?.message || error).slice(0, 200);
  collector.engine.source('Approved source registry', detail);
  console.error(`Approved source registry unavailable (${registryPath}): ${detail}`);
}
const port = Number(process.env.PORT) || 3000;
const clients = new Set();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function tokenMatches(auth) {
  const token = process.env.INJURY_INGEST_TOKEN;
  if (!token || token.length < 24 || !auth.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(auth.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
async function receiveJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (text.length > 10_000) throw new Error('Report too large');
  }
  return JSON.parse(text);
}
// Durable audit line for an authenticated operator action. Returns a warning
// string when the append fails so the operator knows the trail is degraded.
// Unauthenticated requests are never logged per-request (disk-fill from scans).
async function audit(entry) {
  const result = await collector.store.appendAudit(entry);
  if (result.ok) {
    collector.engine.source('Local audit storage');
    collector.metrics.record('Local audit storage', true);
    return '';
  }
  collector.engine.source('Local audit storage', result.error);
  collector.metrics.record('Local audit storage', false, { error: result.error });
  console.error(`Audit log write failed: ${result.error}`);
  return 'Audit log write failed; check server storage';
}
const auditField = value => str(value).slice(0, 300);
async function report(req, res) {
  if (!process.env.INJURY_INGEST_TOKEN) return sendJson(res, 503, { error: 'Editorial intake is not configured' });
  if (!tokenMatches(str(req.headers.authorization))) return sendJson(res, 401, { error: 'Unauthorized' });
  try {
    const body = await receiveJson(req);
    // Shared validation (src/editorial.mjs): shape, URL and timestamp. The
    // engine still enforces live-game, participation and duplicate gates.
    const check = validateReport(body, { registry,
      trustedHosts: process.env.TRUSTED_SOURCE_HOSTS, trustedHandles: process.env.TRUSTED_SOCIAL_HANDLES });
    if (!check.ok) {
      await audit({ action: 'report.rejected', reason: check.error,
        gameId: auditField(body.gameId), athleteId: auditField(body.athleteId), status: auditField(body.status),
        sourceUrl: auditField(body.sourceUrl), sourceId: check.sourceId });
      return sendJson(res, 422, { error: check.error });
    }
    const text = str(body.text).trim();
    const name = str(body.source).trim();
    const changed = collector.engine.curated({ gameId: str(body.gameId), athleteId: str(body.athleteId),
      status: body.status, name: '', teamId: '', text, source: `Curated · ${name}`,
      sourceUrl: body.sourceUrl, publishedAt: check.publishedAt });
    if (!changed) {
      await audit({ action: 'report.rejected', reason: 'No matching live game and confirmed participating player, or duplicate report',
        gameId: auditField(body.gameId), athleteId: auditField(body.athleteId), status: auditField(body.status),
        sourceUrl: auditField(body.sourceUrl), sourceId: check.sourceId });
      return sendJson(res, 422, { error: 'No matching live game and confirmed participating player, or duplicate report' });
    }
    const auditWarning = await audit({ action: 'report.accepted', gameId: auditField(body.gameId),
      athleteId: auditField(body.athleteId), status: auditField(body.status),
      sourceUrl: auditField(body.sourceUrl), sourceId: check.sourceId });
    collector.publish(true);
    await collector.writeQueue;
    sendJson(res, 201, { accepted: true, ...((auditWarning || collector.persistenceError) ? { warning: [auditWarning, collector.persistenceError].filter(Boolean).join('; ') } : {}) });
  } catch (error) { sendJson(res, 400, { error: String(error.message).slice(0, 120) }); }
}
function activeGames(now = Date.now()) {
  return [...collector.engine.games.values()].filter(g => g.phase === 'in' && now - g.lastScoreboardAt < 90_000).length;
}
async function operatorLog(req, res, kind) {
  // Authenticated operator reads. The audit trail contains source URLs and
  // operator actions: never expose it without the ingest token.
  if (!process.env.INJURY_INGEST_TOKEN) return sendJson(res, 503, { error: 'Editorial intake is not configured' });
  if (!tokenMatches(str(req.headers.authorization))) return sendJson(res, 401, { error: 'Unauthorized' });
  try {
    const url = new URL(req.url, 'http://localhost');
    const entries = await collector.store.readRecent(kind, url.searchParams.get('limit'));
    return sendJson(res, 200, { kind, entries });
  } catch (error) { return sendJson(res, 500, { error: String(error?.message || error).slice(0, 120) }); }
}

collector.on('update', changes => {
  const data = JSON.stringify({ changes, updatedAt: Date.now() });
  for (const client of clients) {
    if (client.destroyed || !client.write(`event: update\ndata: ${data}\n\n`)) {
      client.end();
      clients.delete(client); // do not accumulate unbounded buffers behind slow viewers
    }
  }
});

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, 400, { error: 'Invalid URL' }); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://a.espncdn.com; connect-src 'self' https://site.web.api.espn.com https://cdn.nba.com; object-src 'none'; base-uri 'self'; form-action 'self'");
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const now = Date.now();
    return sendJson(res, 200, { service: 'NBA injury collector', day: easternDate(),
      startedAt: collector.startedAt, uptimeMs: Math.max(0, now - collector.startedAt),
      live: collector.live, activeGames: activeGames(now),
      sources: collector.engine.health, metrics: collector.metrics.snapshot(), alarms: collector.alarms() });
  }
  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    const now = Date.now();
    return sendJson(res, 200, { startedAt: collector.startedAt, uptimeMs: Math.max(0, now - collector.startedAt),
      live: collector.live, activeGames: activeGames(now),
      metrics: collector.metrics.snapshot(), alarms: collector.alarms() });
  }
  if (req.method === 'GET' && url.pathname === '/api/sources') return sendJson(res, 200, { registry });
  if (req.method === 'GET' && url.pathname === '/api/audit') return operatorLog(req, res, 'audit');
  if (req.method === 'GET' && url.pathname === '/api/events') return operatorLog(req, res, 'events');
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const day = url.searchParams.get('date') || easternDate();
    if (!validDate(day)) return sendJson(res, 400, { error: 'Invalid date' });
    // Collector-evaluated alarms ride along so the UI can surface repeated
    // source failures, not just the latest error string. Browser fallback
    // snapshots omit this field and the UI treats it as unknown.
    return sendJson(res, 200, { ...collector.engine.snapshot(day), alarms: collector.alarms() });
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    if (clients.size >= 200) return sendJson(res, 503, { error: 'Too many stream clients; use /api/state polling' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
    res.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/reports') return report(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!/^\/(?:index|alerts|reviews|game|404)\.html$/.test(path) && !/^\/(?:assets|src)\/[\w-]+(?:\/[\w-]+)*\.(?:css|js|mjs|svg|png|ico)$/.test(path)) return sendJson(res, 404, { error: 'Not found' });
  try {
    const file = resolve(root, `.${path}`);
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { sendJson(res, 404, { error: 'Not found' }); }
});

server.listen(port, '0.0.0.0', () => console.log(`NBA scoreboard listening on 0.0.0.0:${port}`));
collector.start();
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  server.close();
  for (const client of clients) client.end();
  await collector.stop();
  process.exit(0);
});
