/**
 * GET /api/alerts endpoint handler
 * Query params: sport=nfl|nba, team=KC, limit=20, game_id=...
 * Returns: { alerts: [], game_window: {}, collectors: {}, meta: {} }
 */

import { db } from '../db/supabase.js';
import { getCollectorStatus } from '../collectors/index.js';

export async function handleAlerts(req, res, url) {
  const sport = url.searchParams.get('sport');
  const team = url.searchParams.get('team');
  const limitRaw = url.searchParams.get('limit');
  const gameId = url.searchParams.get('game_id');
  let limit = 20;
  if (limitRaw) {
    const parsed = parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100) limit = parsed;
  }

  if (sport && !['nfl', 'nba'].includes(sport)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid sport, must be nfl or nba' }));
    return;
  }

  try {
    const alerts = await db.queryAlerts({ sport, team, limit, game_id: gameId });
    const games = await db.queryGames({ sport, state: 'in' });
    const health = await db.queryHealth();
    const collectorStatus = getCollectorStatus();

    // Merge health from DB and memory collector status
    const collectors = {};
    for (const h of health) {
      collectors[h.collector_name] = h;
    }
    // Overlay with live collector status
    for (const [name, status] of Object.entries(collectorStatus)) {
      collectors[name] = {
        ...(collectors[name] || {}),
        ...status,
        collector_name: name
      };
    }

    // Game window: active games
    const gameWindow = {
      active_games: games,
      count: games.length,
      last_checked: new Date().toISOString()
    };

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      alerts,
      game_window: gameWindow,
      collectors,
      meta: {
        sport: sport || 'all',
        team: team || 'all',
        limit,
        count: alerts.length,
        generated_at: new Date().toISOString()
      }
    }));
  } catch (e) {
    console.error('Alerts API error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error', details: e.message.slice(0, 200) }));
  }
}
