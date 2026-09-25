/**
 * Supabase client - uses fetch, no npm package required
 * Falls back to memory DB if env vars missing
 */

import { memoryDB } from './memory.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY;

function hasSupabaseConfig() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

async function supabaseFetch(path, { method = 'GET', body, useServiceKey = false } = {}) {
  if (!hasSupabaseConfig()) throw new Error('Supabase not configured');
  const url = `${SUPABASE_URL.replace(/\/$/, '')}${path}`;
  const key = useServiceKey ? SUPABASE_SERVICE_KEY : SUPABASE_KEY;
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : ''
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Supabase ${method} ${path} failed ${res.status}: ${txt.slice(0, 500)}`);
    }
    const txt = await res.text();
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  } finally {
    clearTimeout(timer);
  }
}

export class SupabaseDB {
  constructor() {
    this.startedAt = Date.now();
  }

  async insertAlert(alert) {
    if (!hasSupabaseConfig()) {
      return memoryDB.insertAlert(alert);
    }
    const payload = {
      sport: alert.sport,
      team: alert.team || '',
      player_name: alert.player_name,
      player_id: alert.player_id || null,
      status: alert.status,
      source: normalizeSource(alert.source),
      timestamp_source: alert.timestamp_source,
      timestamp_first_seen: alert.timestamp_first_seen || new Date().toISOString(),
      latency_ms: alert.latency_ms || 0,
      verbatim_text: alert.verbatim_text,
      source_url: alert.source_url || null,
      verified: !!alert.verified,
      game_id: alert.game_id || null
    };
    try {
      const data = await supabaseFetch('/rest/v1/alerts', {
        method: 'POST',
        body: payload,
        useServiceKey: true
      });
      return Array.isArray(data) ? data[0] : data;
    } catch (e) {
      console.warn(`Supabase insert failed, falling back to memory: ${e.message}`);
      return memoryDB.insertAlert(alert);
    }
  }

  async queryAlerts({ sport, team, limit = 20, game_id } = {}) {
    if (!hasSupabaseConfig()) {
      return memoryDB.queryAlerts({ sport, team, limit, game_id });
    }
    let query = '/rest/v1/alerts?select=*&order=created_at.desc';
    if (sport) query += `&sport=eq.${encodeURIComponent(sport)}`;
    if (team) query += `&team=eq.${encodeURIComponent(team.toUpperCase())}`;
    if (game_id) query += `&game_id=eq.${encodeURIComponent(game_id)}`;
    query += `&limit=${Math.min(limit, 100)}`;
    try {
      const data = await supabaseFetch(query);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn(`Supabase query failed, fallback to memory: ${e.message}`);
      return memoryDB.queryAlerts({ sport, team, limit, game_id });
    }
  }

  async upsertGame(game) {
    if (!hasSupabaseConfig()) {
      return memoryDB.upsertGame(game);
    }
    const payload = {
      sport: game.sport,
      game_id: game.game_id,
      club_1: game.club_1 || game.away_abbr || '',
      club_2: game.club_2 || game.home_abbr || '',
      state: game.state,
      kickoff_time: game.kickoff_time,
      last_checked: new Date().toISOString(),
      raw_data: game
    };
    try {
      // upsert via POST with on_conflict
      const url = `/rest/v1/games?on_conflict=game_id`;
      const data = await supabaseFetch(url, {
        method: 'POST',
        body: payload,
        useServiceKey: true
      });
      // Also try to update via PATCH if needed
      return data;
    } catch (e) {
      console.warn(`Supabase upsert game failed: ${e.message}`);
      return memoryDB.upsertGame(game);
    }
  }

  async queryGames({ sport, state } = {}) {
    if (!hasSupabaseConfig()) {
      return memoryDB.queryGames({ sport, state });
    }
    let query = '/rest/v1/games?select=*&order=last_checked.desc';
    if (sport) query += `&sport=eq.${encodeURIComponent(sport)}`;
    if (state) query += `&state=eq.${encodeURIComponent(state)}`;
    try {
      const data = await supabaseFetch(query);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return memoryDB.queryGames({ sport, state });
    }
  }

  async upsertHealth(collector_name, { status, error_msg, active_games, alerts_count } = {}) {
    if (!hasSupabaseConfig()) {
      return memoryDB.upsertHealth(collector_name, { status, error_msg, active_games, alerts_count });
    }
    const payload = {
      collector_name,
      last_run: new Date().toISOString(),
      status: status || 'ok',
      error_msg: error_msg || null,
      active_games: active_games ?? null,
      alerts_count: alerts_count ?? null,
      updated_at: new Date().toISOString()
    };
    try {
      const url = `/rest/v1/health_check?on_conflict=collector_name`;
      const data = await supabaseFetch(url, {
        method: 'POST',
        body: payload,
        useServiceKey: true
      });
      return data;
    } catch (e) {
      console.warn(`Supabase health upsert failed: ${e.message}`);
      return memoryDB.upsertHealth(collector_name, { status, error_msg, active_games, alerts_count });
    }
  }

  async queryHealth() {
    if (!hasSupabaseConfig()) {
      return memoryDB.queryHealth();
    }
    try {
      const data = await supabaseFetch('/rest/v1/health_check?select=*');
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return memoryDB.queryHealth();
    }
  }

  async getStats() {
    if (!hasSupabaseConfig()) {
      return memoryDB.getStats();
    }
    try {
      // Get count via head request? Simpler: query alerts count via memory fallback + supabase count
      // For free tier, we approximate
      const alerts = await this.queryAlerts({ limit: 1 });
      const memStats = await memoryDB.getStats();
      return {
        alerts_total: memStats.alerts_total, // plus supabase would need count endpoint
        last_alert: alerts[0]?.created_at || memStats.last_alert,
        games_total: (await this.queryGames()).length,
        uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000)
      };
    } catch {
      return memoryDB.getStats();
    }
  }

  async checkConnection() {
    if (!hasSupabaseConfig()) {
      return { ok: true, mode: 'memory', message: 'Supabase not configured, using memory' };
    }
    try {
      await supabaseFetch('/rest/v1/health_check?select=*&limit=1');
      return { ok: true, mode: 'supabase', url: SUPABASE_URL };
    } catch (e) {
      return { ok: false, mode: 'supabase', error: e.message, fallback: 'memory' };
    }
  }
}

function normalizeSource(src) {
  const map = {
    'play-by-play': 'play-by-play',
    'bluesky': 'bluesky',
    'google-news': 'google-news',
    'mastodon': 'mastodon',
    'espn-injuries': 'play-by-play',
    'espn-news': 'play-by-play'
  };
  return map[src] || 'play-by-play';
}

export const db = new SupabaseDB();
export const isSupabaseConfigured = hasSupabaseConfig;
