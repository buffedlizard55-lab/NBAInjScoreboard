/**
 * GET /api/health endpoint
 * Returns: {uptime_seconds, alerts_total, last_alert, db_connection}
 */

import { db } from '../db/supabase.js';
import { getCollectorStatus } from '../collectors/index.js';

let startedAt = Date.now();

export function setStartedAt(ts) {
  startedAt = ts;
}

export async function handleHealth(req, res) {
  try {
    const stats = await db.getStats();
    const conn = await db.checkConnection();
    const collectors = getCollectorStatus();

    const healthChecks = await db.queryHealth();

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      alerts_total: stats.alerts_total || 0,
      last_alert: stats.last_alert || null,
      db_connection: conn,
      collectors,
      health_checks: healthChecks,
      timestamp: new Date().toISOString(),
      service: 'nfl-nba-injury-alert-backend',
      version: '1.0.0',
      active_games: stats.games_total || 0
    }));
  } catch (e) {
    console.error('Health API error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Health check failed', details: e.message.slice(0, 200) }));
  }
}
