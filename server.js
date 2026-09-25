/**
 * Real-Time Injury Alert Backend Service
 * - Frontend: GitHub Pages reads /api/alerts every 2 seconds
 * - Backend: Node.js on Render free tier, runs 24/7
 * - Database: Supabase free tier PostgreSQL (fallback to memory)
 * - Data sources: ESPN (scoreboard, play-by-play, injuries), Bluesky, Google News RSS, Mastodon
 *
 * No build step, plain Node 18+, no unnecessary npm packages
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from './db/supabase.js';
import { memoryDB } from './db/memory.js';
import { createAlert, validateAlert } from './models/alert.js';
import { handleAlerts } from './api/alerts.js';
import { handleHealth, setStartedAt } from './api/health.js';
import * as espn from './collectors/espn.js';
import * as bluesky from './collectors/bluesky.js';
import * as googleNews from './collectors/google-news.js';
import * as mastodon from './collectors/mastodon.js';
import { globalDeduper, Deduper } from './collectors/dedup.js';
import { updateCollectorStatus, getCollectorStatus } from './collectors/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = __dirname;

const PORT = Number(process.env.PORT) || 3000;
const startedAt = Date.now();
setStartedAt(startedAt);

// In-memory state
let ACTIVE_GAMES = []; // [{game_id, sport, club_1, club_2, state, ...}]
let ACTIVE_TEAMS = new Set();
let isRunning = false;
let mainLoopInterval = null;
let scoreboardInterval = null;

// Stats
let totalAlertsInserted = 0;
let lastAlertTime = null;

// Mime types
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(payload));
}

function easternDateYYYYMMDD(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}${m}${d}`;
}

// --- GAME DETECTION ---
async function fetchScoreboards() {
  const sports = ['nfl', 'nba'];
  const allGames = [];
  let errors = [];

  for (const sport of sports) {
    try {
      const dateStr = easternDateYYYYMMDD();
      const games = await espn.fetchScoreboard(sport, { date: dateStr });
      allGames.push(...games);
      // Also try to upsert each game to DB
      for (const g of games) {
        try {
          await db.upsertGame(g);
        } catch (e) {
          // fallback to memory
          await memoryDB.upsertGame(g);
        }
      }
    } catch (e) {
      errors.push(`${sport}: ${e.message}`);
      console.warn(`Scoreboard fetch failed for ${sport}: ${e.message}`);
    }
  }

  ACTIVE_GAMES = allGames;
  ACTIVE_TEAMS = new Set();
  for (const g of allGames) {
    if (g.state === 'in') {
      if (g.club_1) ACTIVE_TEAMS.add(g.club_1.toUpperCase());
      if (g.club_2) ACTIVE_TEAMS.add(g.club_2.toUpperCase());
      if (g.home_abbr) ACTIVE_TEAMS.add(g.home_abbr.toUpperCase());
      if (g.away_abbr) ACTIVE_TEAMS.add(g.away_abbr.toUpperCase());
    }
  }

  const activeCount = allGames.filter(g => g.state === 'in').length;
  updateCollectorStatus('espn_scoreboard', {
    status: errors.length === 0 ? 'ok' : 'degraded',
    error: errors.length ? errors.join('; ') : null,
    active_games: activeCount,
    total_games: allGames.length
  });

  try {
    await db.upsertHealth('espn_scoreboard', {
      status: errors.length === 0 ? 'ok' : 'degraded',
      error_msg: errors.length ? errors.join('; ').slice(0, 500) : null,
      active_games: activeCount
    });
  } catch {}

  console.log(`[Scoreboard] ${new Date().toISOString()} - Total: ${allGames.length}, Active: ${activeCount}, Teams: ${[...ACTIVE_TEAMS].join(',')}`);
  return allGames;
}

function getActiveGames() {
  return ACTIVE_GAMES.filter(g => g.state === 'in');
}

// --- INJURY COLLECTION ---
async function collectInjuries() {
  const activeGames = getActiveGames();
  if (activeGames.length === 0) {
    console.log(`[Collector] No active games, skipping injury checks`);
    return [];
  }

  const allAlerts = [];

  // A) ESPN play-by-play every 5 sec (called from main loop)
  try {
    updateCollectorStatus('espn_playbyplay', { status: 'running' });
    for (const game of activeGames) {
      try {
        const { alerts } = await espn.fetchPlayByPlay(game.sport, game.game_id);
        for (const raw of alerts) {
          const alert = createAlert(raw);
          const dedup = globalDeduper.shouldEmit(alert);
          if (dedup.emit) {
            await insertAlert(alert);
            allAlerts.push(alert);
            console.log(`[ESPN PBP] NEW ALERT: ${alert.player_name} ${alert.status} (${dedup.reason})`);
          } else {
            console.log(`[ESPN PBP] DEDUPED: ${alert.player_name} ${alert.status} (${dedup.reason})`);
          }
        }
      } catch (e) {
        console.warn(`[ESPN PBP] Failed for ${game.sport} ${game.game_id}: ${e.message}`);
      }
    }
    updateCollectorStatus('espn_playbyplay', { status: 'ok', count: allAlerts.length });
    await db.upsertHealth('espn_playbyplay', { status: 'ok', alerts_count: allAlerts.length }).catch(() => {});
  } catch (e) {
    updateCollectorStatus('espn_playbyplay', { status: 'error', error: e.message });
  }

  return allAlerts;
}

async function collectBlueskyAlerts() {
  const activeGames = getActiveGames();
  if (activeGames.length === 0) return [];

  try {
    updateCollectorStatus('bluesky', { status: 'running' });
    const alerts = await bluesky.collectBluesky({ activeTeams: ACTIVE_TEAMS, limitPerReporter: 10 });
    const emitted = [];
    for (const raw of alerts) {
      const alert = createAlert(raw);
      const dedup = globalDeduper.shouldEmit(alert);
      if (dedup.emit) {
        await insertAlert(alert);
        emitted.push(alert);
        console.log(`[Bluesky] NEW ALERT: ${alert.player_name} ${alert.status} from ${raw.reporter_handle || 'unknown'} (${dedup.reason})`);
      }
    }
    updateCollectorStatus('bluesky', { status: 'ok', count: emitted.length });
    await db.upsertHealth('bluesky', { status: 'ok', alerts_count: emitted.length }).catch(() => {});
    return emitted;
  } catch (e) {
    console.warn(`[Bluesky] Failed: ${e.message}`);
    updateCollectorStatus('bluesky', { status: 'error', error: e.message });
    return [];
  }
}

async function collectGoogleNewsAlerts() {
  const activeGames = getActiveGames();
  if (activeGames.length === 0) return [];

  try {
    updateCollectorStatus('google_news', { status: 'running' });
    const alerts = await googleNews.collectGoogleNews(activeGames);
    const emitted = [];
    for (const raw of alerts) {
      const alert = createAlert(raw);
      const dedup = globalDeduper.shouldEmit(alert);
      if (dedup.emit) {
        await insertAlert(alert);
        emitted.push(alert);
        console.log(`[GoogleNews] NEW ALERT: ${alert.player_name} ${alert.status} (${dedup.reason})`);
      }
    }
    updateCollectorStatus('google_news', { status: 'ok', count: emitted.length });
    await db.upsertHealth('google_news', { status: 'ok', alerts_count: emitted.length }).catch(() => {});
    return emitted;
  } catch (e) {
    console.warn(`[GoogleNews] Failed: ${e.message}`);
    updateCollectorStatus('google_news', { status: 'error', error: e.message });
    return [];
  }
}

async function collectMastodonAlerts() {
  const activeGames = getActiveGames();
  // Mastodon is low priority, even if no active games we might still check occasionally
  try {
    updateCollectorStatus('mastodon', { status: 'running' });
    const alerts = await mastodon.collectMastodon(activeGames);
    const emitted = [];
    for (const raw of alerts) {
      const alert = createAlert(raw);
      const dedup = globalDeduper.shouldEmit(alert);
      if (dedup.emit) {
        await insertAlert(alert);
        emitted.push(alert);
        console.log(`[Mastodon] NEW ALERT: ${alert.player_name} ${alert.status} (${dedup.reason})`);
      }
    }
    updateCollectorStatus('mastodon', { status: 'ok', count: emitted.length });
    await db.upsertHealth('mastodon', { status: 'ok', alerts_count: emitted.length }).catch(() => {});
    return emitted;
  } catch (e) {
    console.warn(`[Mastodon] Failed: ${e.message}`);
    updateCollectorStatus('mastodon', { status: 'error', error: e.message });
    return [];
  }
}

async function insertAlert(alert) {
  const validation = validateAlert(alert);
  if (!validation.valid) {
    console.warn(`Invalid alert dropped: ${validation.errors.join(', ')}`, alert);
    return null;
  }
  try {
    const inserted = await db.insertAlert(alert);
    totalAlertsInserted++;
    lastAlertTime = new Date().toISOString();
    return inserted;
  } catch (e) {
    console.warn(`DB insert failed, using memory: ${e.message}`);
    const inserted = await memoryDB.insertAlert(alert);
    totalAlertsInserted++;
    lastAlertTime = new Date().toISOString();
    return inserted;
  }
}

// --- MAIN LOOP ---
async function mainLoop() {
  if (isRunning) return;
  isRunning = true;
  console.log('[MainLoop] Starting main loop');

  // Initial scoreboard fetch
  await fetchScoreboards().catch(e => console.error('Initial scoreboard failed', e));

  // Scoreboard interval: every 30 sec
  scoreboardInterval = setInterval(async () => {
    try {
      await fetchScoreboards();
    } catch (e) {
      console.error('Scoreboard interval error', e);
    }
  }, 30 * 1000);

  // Timers for different collectors
  let lastPbp = 0;
  let lastBluesky = 0;
  let lastGoogleNews = 0;
  let lastMastodon = 0;

  const LOOP_INTERVAL = 5000; // 5 sec

  mainLoopInterval = setInterval(async () => {
    const now = Date.now();
    const activeGames = getActiveGames();

    // Always log active state
    if (activeGames.length > 0) {
      console.log(`[Loop] Active games: ${activeGames.length}, Teams: ${[...ACTIVE_TEAMS].join(',')}`);
    }

    // ESPN PBP every 5 sec
    if (now - lastPbp >= 5000) {
      lastPbp = now;
      await collectInjuries().catch(e => console.error('PBP collect error', e));
    }

    // Bluesky every 10 sec
    if (now - lastBluesky >= 10000) {
      lastBluesky = now;
      await collectBlueskyAlerts().catch(e => console.error('Bluesky collect error', e));
    }

    // Google News every 20 sec
    if (now - lastGoogleNews >= 20000) {
      lastGoogleNews = now;
      await collectGoogleNewsAlerts().catch(e => console.error('GoogleNews collect error', e));
    }

    // Mastodon every 30 sec (low priority)
    if (now - lastMastodon >= 30000) {
      lastMastodon = now;
      await collectMastodonAlerts().catch(e => console.error('Mastodon collect error', e));
    }
  }, LOOP_INTERVAL);

  console.log(`[MainLoop] Loop started with ${LOOP_INTERVAL}ms interval`);
}

function stopMainLoop() {
  if (mainLoopInterval) clearInterval(mainLoopInterval);
  if (scoreboardInterval) clearInterval(scoreboardInterval);
  mainLoopInterval = null;
  scoreboardInterval = null;
  isRunning = false;
  console.log('[MainLoop] Stopped');
}

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'Invalid URL' });
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // API routes
  if (req.method === 'GET' && url.pathname === '/api/alerts') {
    return handleAlerts(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return handleHealth(req, res);
  }

  // Legacy compatibility: /api/state from old server.mjs
  if (req.method === 'GET' && url.pathname === '/api/state') {
    // Return combined view for old frontend
    const sport = url.searchParams.get('sport');
    const team = url.searchParams.get('team');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const alerts = await db.queryAlerts({ sport, team, limit }).catch(() => memoryDB.queryAlerts({ sport, team, limit }));
    return sendJson(res, 200, {
      alerts,
      active_games: getActiveGames(),
      collectors: getCollectorStatus(),
      generatedAt: Date.now(),
      day: easternDateYYYYMMDD()
    });
  }

  // Serve static frontend files (for GitHub Pages compatibility + local dev)
  if (req.method === 'GET' || req.method === 'HEAD') {
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    // Allow only specific static files
    const allowed = /^\/(?:index|alerts|reviews|game|404)\.html$/.test(pathname) ||
                    /^\/(?:assets|src)\/[\w-]+(?:\/[\w-]+)*\.(?:css|js|mjs|svg|png|ico)$/.test(pathname) ||
                    pathname === '/package.json';

    if (allowed) {
      try {
        const filePath = resolve(root, `.${pathname}`);
        const bytes = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          'Content-Type': mime[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return;
      } catch {
        // fall through to 404
      }
    }

    // Root API info
    if (pathname === '/api' || pathname === '/api/') {
      return sendJson(res, 200, {
        service: 'nfl-nba-injury-alert-backend',
        endpoints: {
          '/api/alerts?sport=nfl&team=KC&limit=20': 'Get injury alerts',
          '/api/health': 'Health check'
        },
        active_games: getActiveGames().length,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString()
      });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return sendJson(res, 404, { error: 'Not found', path: url.pathname });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Injury alert backend listening on 0.0.0.0:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET /api/alerts?sport=nfl&team=KC&limit=20`);
  console.log(`  GET /api/health`);
  console.log(`Supabase configured: ${!!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY)}`);
  // Start main loop
  mainLoop().catch(e => console.error('Failed to start main loop', e));
});

// Graceful shutdown
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}, shutting down...`);
    stopMainLoop();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
  });
}

export { server, fetchScoreboards, getActiveGames, collectInjuries, insertAlert, ACTIVE_GAMES, ACTIVE_TEAMS };
