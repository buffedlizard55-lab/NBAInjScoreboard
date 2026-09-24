import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Collector, loadSaved } from './src/collector.mjs';
import { easternDate, validDate } from './src/engine.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = resolve(process.env.NBA_STATE_FILE || `${root}/.runtime/state.json`);
const collector = new Collector({ statePath, saved: await loadSaved(statePath) });
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
function approvedUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    const approved = ['nba.com', 'espn.com', 'apnews.com'];
    const custom = (process.env.TRUSTED_SOURCE_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (approved.some(h => host === h || host.endsWith(`.${h}`)) || custom.includes(host)) return true;
    if (!['x.com', 'twitter.com'].includes(host)) return false;
    const handles = (process.env.TRUSTED_SOCIAL_HANDLES || '').split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
    const [handle, action, postId] = url.pathname.split('/').filter(Boolean);
    return handles.includes(str(handle).toLowerCase()) && action === 'status' && /^\d{8,25}$/.test(str(postId));
  } catch { return false; }
}
const str = value => value == null ? '' : String(value);

async function receiveJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (text.length > 10_000) throw new Error('Report too large');
  }
  return JSON.parse(text);
}
async function report(req, res) {
  if (!process.env.INJURY_INGEST_TOKEN) return sendJson(res, 503, { error: 'Editorial intake is not configured' });
  if (!tokenMatches(str(req.headers.authorization))) return sendJson(res, 401, { error: 'Unauthorized' });
  try {
    const body = await receiveJson(req);
    const text = str(body.text).trim();
    const name = str(body.source).trim();
    const publishedAt = Date.parse(body.publishedAt);
    if (!approvedUrl(body.sourceUrl) || text.length < 20 || text.length > 700 || name.length < 3 || name.length > 80 ||
      !Number.isFinite(publishedAt) || !/^\d{6,12}$/.test(str(body.athleteId)) ||
      !/^\d{6,12}$/.test(str(body.gameId))) return sendJson(res, 422, { error: 'Invalid source, player, game, timestamp or evidence' });
    const changed = collector.engine.curated({ gameId: str(body.gameId), athleteId: str(body.athleteId),
      status: body.status, name: '', teamId: '', text, source: `Curated · ${name}`,
      sourceUrl: body.sourceUrl, publishedAt });
    if (!changed) return sendJson(res, 422, { error: 'No matching live game and confirmed participating player, or duplicate report' });
    // Audit metadata, not auth; do not expose the audit log from the static server.
    const log = resolve(dirname(statePath), 'editorial.jsonl');
    let auditWarning = '';
    try {
      await mkdir(dirname(log), { recursive: true });
      await appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), gameId: body.gameId, athleteId: body.athleteId, status: body.status, sourceUrl: body.sourceUrl })}\n`);
    } catch (error) { auditWarning = 'Audit log write failed; check server storage'; console.error(auditWarning, error); }
    collector.publish(true);
    await collector.writeQueue;
    sendJson(res, 201, { accepted: true, ...((auditWarning || collector.persistenceError) ? { warning: [auditWarning, collector.persistenceError].filter(Boolean).join('; ') } : {}) });
  } catch (error) { sendJson(res, 400, { error: String(error.message).slice(0, 120) }); }
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
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { service: 'NBA injury collector', day: easternDate(), sources: collector.engine.health, activeGames: [...collector.engine.games.values()].filter(g => g.phase === 'in' && Date.now() - g.lastScoreboardAt < 90_000).length });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const day = url.searchParams.get('date') || easternDate();
    if (!validDate(day)) return sendJson(res, 400, { error: 'Invalid date' });
    return sendJson(res, 200, collector.engine.snapshot(day));
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
