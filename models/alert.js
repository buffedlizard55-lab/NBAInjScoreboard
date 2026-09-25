/**
 * Alert model - validates and normalizes alert objects
 */

const VALID_SOURCES = ['play-by-play', 'bluesky', 'google-news', 'mastodon', 'espn-injuries', 'espn-news'];
const VALID_SPORTS = ['nfl', 'nba'];
const VALID_STATUSES = ['INJURY_REPORTED', 'OUT_FOR_GAME', 'QUESTIONABLE_TO_RETURN', 'RETURNED'];

export function validateAlert(alert) {
  const errors = [];
  if (!VALID_SPORTS.includes(alert.sport)) errors.push(`Invalid sport: ${alert.sport}`);
  if (!alert.team || typeof alert.team !== 'string') errors.push('Missing team');
  if (!alert.player_name || typeof alert.player_name !== 'string') errors.push('Missing player_name');
  if (!VALID_STATUSES.includes(alert.status)) errors.push(`Invalid status: ${alert.status}`);
  if (!alert.timestamp_source) errors.push('Missing timestamp_source');
  if (!alert.timestamp_first_seen) errors.push('Missing timestamp_first_seen');
  if (!alert.verbatim_text) errors.push('Missing verbatim_text');
  if (!alert.game_id && !alert.source_url) errors.push('Missing game_id or source_url');
  // source can be normalized
  return { valid: errors.length === 0, errors };
}

export function createAlert({
  source,
  sport,
  team,
  player_name,
  status,
  timestamp_source,
  timestamp_first_seen,
  latency_ms,
  verbatim_text,
  source_url,
  verified,
  game_id,
  player_id,
  ...extra
}) {
  const now = new Date().toISOString();
  const srcTime = timestamp_source || now;
  const firstSeen = timestamp_first_seen || now;
  let latency = latency_ms;
  if (latency == null) {
    try {
      latency = Date.parse(firstSeen) - Date.parse(srcTime);
      if (!Number.isFinite(latency) || latency < 0) latency = 0;
    } catch {
      latency = 0;
    }
  }

  return {
    source: VALID_SOURCES.includes(source) ? source : 'play-by-play',
    sport: String(sport || 'nfl').toLowerCase(),
    team: String(team || '').toUpperCase().slice(0, 5),
    player_name: String(player_name || 'Unknown').slice(0, 100),
    player_id: player_id ? String(player_id) : undefined,
    status: VALID_STATUSES.includes(status) ? status : 'INJURY_REPORTED',
    timestamp_source: new Date(srcTime).toISOString(),
    timestamp_first_seen: new Date(firstSeen).toISOString(),
    latency_ms: Math.max(0, Math.floor(latency)),
    verbatim_text: String(verbatim_text || '').slice(0, 900),
    source_url: source_url ? String(source_url).slice(0, 500) : '',
    verified: !!verified,
    game_id: game_id ? String(game_id) : '',
    ...extra
  };
}

export function isStatusUpgrade(oldStatus, newStatus) {
  const priority = {
    'INJURY_REPORTED': 1,
    'QUESTIONABLE_TO_RETURN': 2,
    'OUT_FOR_GAME': 3,
    'RETURNED': 4
  };
  return (priority[newStatus] || 0) > (priority[oldStatus] || 0);
}
