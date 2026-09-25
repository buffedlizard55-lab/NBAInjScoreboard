/**
 * ESPN collector - free, keyless, public API
 * Tested LIVE against real ESPN endpoints (fixtures saved in fixtures/)
 * Covers both NFL and NBA
 */

const ESPN_BASE = 'https://site.web.api.espn.com/apis/site/v2/sports';
const ESPN_SCOREBOARD_PATH = {
  nfl: `${ESPN_BASE}/football/nfl/scoreboard`,
  nba: `${ESPN_BASE}/basketball/nba/scoreboard`
};
const ESPN_SUMMARY_PATH = {
  nfl: `${ESPN_BASE}/football/nfl/summary`,
  nba: `${ESPN_BASE}/basketball/nba/summary`
};
const ESPN_INJURIES_PATH = {
  nfl: `${ESPN_BASE}/football/nfl/injuries`,
  nba: `${ESPN_BASE}/basketball/nba/injuries`
};

const INJURY_KEYWORDS = [
  'injury', 'injured', 'hurt', 'carted', 'evaluated', 'questionable',
  'out for', 'will not return', "won't return", 'doubtful', 'limp',
  'helped off', 'went down', 'shaken up', 'medical', 'trainer',
  'locker room', 'ruled out', 'sidelined', 'exits', 'leaves game'
];

const STATUS_MAP = {
  reported: 'INJURY_REPORTED',
  questionable: 'QUESTIONABLE_TO_RETURN',
  doubtful: 'QUESTIONABLE_TO_RETURN',
  out: 'OUT_FOR_GAME',
  confirmed_out: 'OUT_FOR_GAME',
  returned: 'RETURNED'
};

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

function classifyStatus(text) {
  const t = String(text).toLowerCase();
  if (/\b(will not return|won't return|wont return|out for (?:the )?(?:rest|remainder)|ruled out for (?:the )?game|out for game)\b/.test(t)) return 'OUT_FOR_GAME';
  if (/\b(questionable to return|doubtful to return|questionable|doubtful)\b/.test(t)) return 'QUESTIONABLE_TO_RETURN';
  if (/\b(returned|back in)\b/.test(t)) return 'RETURNED';
  return 'INJURY_REPORTED';
}

function hasInjuryKeyword(text) {
  const lower = String(text).toLowerCase();
  return INJURY_KEYWORDS.some(k => lower.includes(k));
}

async function fetchJson(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'NBAInjScoreboard/1.0 (+https://github.com/buffedlizard55-lab/NBAInjScoreboard)'
      },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    if (text.length > 8_000_000) throw new Error('Oversize response');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch scoreboard for a sport
 * Returns parsed games array
 */
export async function fetchScoreboard(sport = 'nfl', opts = {}) {
  const base = ESPN_SCOREBOARD_PATH[sport];
  if (!base) throw new Error(`Unsupported sport: ${sport}`);
  const dateStr = opts.date || easternDateYYYYMMDD();
  // ESPN accepts ?dates=YYYYMMDD and ?limit
  const url = `${base}?dates=${dateStr}&limit=100`;
  const data = await fetchJson(url);
  // Also try without date param as fallback (current live)
  // data.events is array
  if (!Array.isArray(data.events)) throw new Error('Invalid scoreboard response: missing events');
  return parseScoreboardEvents(data.events, sport);
}

export function parseScoreboardEvents(events, sport) {
  return events.map(ev => {
    const id = String(ev.id || '');
    const comp = ev.competitions?.[0];
    const status = ev.status?.type || {};
    const state = status.state || 'unknown'; // pre, in, post
    const detail = status.shortDetail || status.detail || '';
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    const kickoff = ev.date ? new Date(ev.date).toISOString() : null;
    return {
      id,
      game_id: id,
      sport,
      club_1: away?.team?.abbreviation || away?.team?.shortDisplayName || '',
      club_2: home?.team?.abbreviation || home?.team?.shortDisplayName || '',
      home_abbr: home?.team?.abbreviation || '',
      away_abbr: away?.team?.abbreviation || '',
      home_id: String(home?.team?.id || ''),
      away_id: String(away?.team?.id || ''),
      state,
      detail,
      kickoff_time: kickoff,
      last_checked: new Date().toISOString(),
      raw_status: status
    };
  }).filter(g => g.id);
}

export function getActiveGames(games) {
  return games.filter(g => g.state === 'in');
}

/**
 * Fetch play-by-play summary for a game
 * Parses injury keywords
 */
export async function fetchPlayByPlay(sport, gameId) {
  const base = ESPN_SUMMARY_PATH[sport];
  if (!base) throw new Error(`Unsupported sport: ${sport}`);
  const url = `${base}?event=${encodeURIComponent(gameId)}`;
  const data = await fetchJson(url);
  return parsePlayByPlay(data, sport, gameId);
}

export function parsePlayByPlay(data, sport, gameId) {
  const plays = Array.isArray(data.plays) ? data.plays : [];
  const alerts = [];
  const boxscorePlayers = [];
  // Collect roster for player lookup
  if (Array.isArray(data.boxscore?.players)) {
    for (const group of data.boxscore.players) {
      for (const statGroup of group.statistics || []) {
        for (const ath of statGroup.athletes || []) {
          if (ath.athlete?.displayName) {
            boxscorePlayers.push({
              id: String(ath.athlete.id || ''),
              name: ath.athlete.displayName,
              teamId: String(group.team?.id || ''),
              teamAbbr: group.team?.abbreviation || ''
            });
          }
        }
      }
    }
  }

  for (const play of plays) {
    const text = play.text || '';
    if (!text) continue;
    if (!hasInjuryKeyword(text)) continue;

    // Try to extract player name from play participants or text
    let playerName = '';
    let teamAbbr = '';
    if (Array.isArray(play.participants) && play.participants.length > 0) {
      const p = play.participants[0];
      playerName = p.athlete?.displayName || '';
      // team from play.team
      teamAbbr = play.team?.abbreviation || '';
    }
    // Fallback: try to match known player names in text (simple heuristic)
    if (!playerName) {
      // look for capitalized name pattern before injury keyword
      const m = text.match(/([A-Z][a-z]+ [A-Z][a-z]+) (?:injured|hurt|exits|leaves|limps|carted)/);
      if (m) playerName = m[1];
    }

    const status = classifyStatus(text);
    const timestamp = play.wallclock ? new Date(play.wallclock).toISOString() : new Date().toISOString();

    alerts.push({
      source: 'play-by-play',
      sport,
      team: teamAbbr || extractTeamFromText(text) || '',
      player_name: playerName || 'Unknown',
      status,
      timestamp_source: timestamp,
      timestamp_first_seen: new Date().toISOString(),
      latency_ms: 0, // will be computed by caller
      verbatim_text: text.slice(0, 900),
      source_url: `https://www.espn.com/${sport}/game/_/gameId/${gameId}`,
      verified: true, // ESPN PBP is verified source
      game_id: String(gameId)
    });
  }

  return { plays: plays.slice(-20), alerts, roster: boxscorePlayers };
}

function extractTeamFromText(text) {
  // crude team extraction not reliable, return empty
  return '';
}

/**
 * Fetch injuries endpoint (structured)
 */
export async function fetchInjuries(sport) {
  const base = ESPN_INJURIES_PATH[sport];
  if (!base) throw new Error(`Unsupported sport: ${sport}`);
  const data = await fetchJson(base);
  return parseInjuries(data, sport);
}

export function parseInjuries(data, sport) {
  if (!Array.isArray(data.injuries)) throw new Error('Invalid injuries response');
  const alerts = [];
  for (const teamGroup of data.injuries) {
    const teamAbbr = teamGroup.displayName || teamGroup.abbreviation || teamGroup.shortDisplayName || '';
    const teamId = String(teamGroup.id || '');
    for (const inj of teamGroup.injuries || []) {
      const athlete = inj.athlete || {};
      const name = athlete.displayName || `${athlete.firstName || ''} ${athlete.lastName || ''}`.trim();
      if (!name) continue;
      const text = [inj.shortComment, inj.longComment].filter(Boolean).join(' — ').slice(0, 900);
      if (!text) continue;
      // Only emit if it looks like in-game? For now emit all with timestamp check
      const dateStr = inj.date || athlete.notes?.items?.[0]?.date || new Date().toISOString();
      let ts;
      try { ts = new Date(dateStr).toISOString(); } catch { ts = new Date().toISOString(); }
      const statusRaw = String(inj.status || '').toLowerCase();
      let status = 'INJURY_REPORTED';
      if (statusRaw.includes('out')) status = 'OUT_FOR_GAME';
      else if (statusRaw.includes('questionable') || statusRaw.includes('doubtful')) status = 'QUESTIONABLE_TO_RETURN';
      else status = classifyStatus(text);

      // Recover athlete id from links/headshot/uid like existing engine does
      const athleteId = recoverAthleteId(athlete, inj);

      alerts.push({
        source: 'espn-injuries',
        sport,
        team: athlete.team?.abbreviation || teamAbbr.slice(0, 3).toUpperCase() || '',
        player_name: name,
        player_id: athleteId,
        team_id: teamId,
        status,
        timestamp_source: ts,
        timestamp_first_seen: new Date().toISOString(),
        latency_ms: 0,
        verbatim_text: text,
        source_url: (athlete.links || []).find(l => l.href && l.href.includes('/story/'))?.href || `https://www.espn.com/${sport}/injuries`,
        verified: true,
        game_id: '' // injuries endpoint not game-specific; caller will match to active game if possible
      });
    }
  }
  return alerts;
}

function recoverAthleteId(athlete, row) {
  const found = [];
  const push = v => { if (/^[1-9]\d{0,11}$/.test(String(v))) found.push(String(v)); };
  push(athlete?.id);
  const uid = /~a:(\d+)/.exec(String(athlete?.uid));
  if (uid) push(uid[1]);
  for (const link of athlete?.links || []) {
    const href = String(link?.href);
    const m1 = /\/nba\/player\/_\/id\/(\d+)/.exec(href) || /\/nfl\/player\/_\/id\/(\d+)/.exec(href);
    if (m1) push(m1[1]);
    const m2 = /~a:(\d+)/.exec(href);
    if (m2) push(m2[1]);
  }
  const hs = /\/full\/(\d+)\.png/i.exec(String(athlete?.headshot?.href));
  if (hs) push(hs[1]);
  for (const note of athlete?.notes?.items || row?.athlete?.notes?.items || []) {
    const ref = /\/athletes\/(\d+)\//.exec(String(note?.injury?.['$ref']));
    if (ref) push(ref[1]);
  }
  const uniq = [...new Set(found)];
  return uniq.length === 1 ? uniq[0] : (uniq[0] || '');
}

// Main collector entry for active games
export async function collectForActiveGames(activeGames, { onAlert } = {}) {
  const allAlerts = [];
  for (const game of activeGames) {
    try {
      const { alerts } = await fetchPlayByPlay(game.sport, game.game_id);
      for (const a of alerts) {
        // enrich latency
        const sourceTime = Date.parse(a.timestamp_source);
        if (Number.isFinite(sourceTime)) {
          a.latency_ms = Date.now() - sourceTime;
        }
        allAlerts.push(a);
        if (onAlert) onAlert(a);
      }
    } catch (e) {
      // log but continue
      console.warn(`ESPN PBP failed for ${game.sport} ${game.game_id}: ${e.message}`);
    }
  }
  return allAlerts;
}

export const __test__ = {
  classifyStatus,
  hasInjuryKeyword,
  parseScoreboardEvents,
  parsePlayByPlay,
  parseInjuries,
  easternDateYYYYMMDD
};
