/**
 * In-memory fallback DB when Supabase env vars not set
 * Implements same interface as supabase.js for local testing
 */

export class MemoryDB {
  constructor() {
    this.alerts = [];
    this.games = new Map(); // game_id -> game
    this.health = new Map(); // collector_name -> health
    this.startedAt = Date.now();
  }

  async insertAlert(alert) {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      id,
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
      game_id: alert.game_id || null,
      created_at: new Date().toISOString()
    };
    this.alerts.unshift(row);
    // Keep only last 5000 in memory
    if (this.alerts.length > 5000) this.alerts = this.alerts.slice(0, 5000);
    return row;
  }

  async queryAlerts({ sport, team, limit = 20, game_id } = {}) {
    let filtered = [...this.alerts];
    if (sport) filtered = filtered.filter(a => a.sport === sport);
    if (team) filtered = filtered.filter(a => a.team.toUpperCase() === team.toUpperCase());
    if (game_id) filtered = filtered.filter(a => a.game_id === game_id);
    // Sort by created_at desc
    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return filtered.slice(0, Math.min(limit, 100));
  }

  async upsertGame(game) {
    const existing = this.games.get(game.game_id);
    const row = {
      id: existing?.id || `game_${game.game_id}`,
      sport: game.sport,
      game_id: game.game_id,
      club_1: game.club_1 || game.away_abbr || '',
      club_2: game.club_2 || game.home_abbr || '',
      state: game.state,
      kickoff_time: game.kickoff_time,
      last_checked: new Date().toISOString(),
      raw_data: game,
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.games.set(game.game_id, row);
    return row;
  }

  async queryGames({ sport, state } = {}) {
    let games = [...this.games.values()];
    if (sport) games = games.filter(g => g.sport === sport);
    if (state) games = games.filter(g => g.state === state);
    return games;
  }

  async upsertHealth(collector_name, { status, error_msg, active_games, alerts_count } = {}) {
    const existing = this.health.get(collector_name);
    const row = {
      id: existing?.id || `health_${collector_name}`,
      collector_name,
      last_run: new Date().toISOString(),
      status: status || 'ok',
      error_msg: error_msg || null,
      active_games: active_games ?? null,
      alerts_count: alerts_count ?? null,
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.health.set(collector_name, row);
    return row;
  }

  async queryHealth() {
    return [...this.health.values()];
  }

  async getStats() {
    return {
      alerts_total: this.alerts.length,
      last_alert: this.alerts[0]?.created_at || null,
      games_total: this.games.size,
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000)
    };
  }

  async checkConnection() {
    return { ok: true, mode: 'memory' };
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
  return map[src] || src;
}

export const memoryDB = new MemoryDB();
