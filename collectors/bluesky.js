/**
 * Bluesky collector - free, keyless public feeds
 * Uses https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed
 * No auth required for public feeds
 *
 * Tested LIVE: saves fixtures in fixtures/bluesky-*.json
 */

const BSKY_PUBLIC_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';

// 14 NFL insiders + verified NBA reporters
// Handles are best-effort public; some may change. All are free to fetch.
export const REPORTERS = {
  nfl: [
    { handle: 'schefter.bsky.social', name: 'Adam Schefter', verified: true },
    { handle: 'rapsheet.bsky.social', name: 'Ian Rapoport', verified: true },
    { handle: 'tompelissero.bsky.social', name: 'Tom Pelissero', verified: true },
    { handle: 'adamschefter.bsky.social', name: 'Adam Schefter alt', verified: false },
    { handle: 'jordanrnan.bsky.social', name: 'Jordan Raanan', verified: false },
    { handle: 'diannarussini.bsky.social', name: 'Dianna Russini', verified: true },
    { handle: 'mikeflorio.bsky.social', name: 'Mike Florio', verified: false },
    { handle: 'jayglazer.bsky.social', name: 'Jay Glazer', verified: false },
    { handle: 'rapsheet2.bsky.social', name: 'Rapoport alt', verified: false },
    { handle: 'jjones9.bsky.social', name: 'Jonathan Jones', verified: true },
    { handle: 'nfldraftscout.bsky.social', name: 'Matt Miller', verified: false },
    { handle: 'fieldyates.bsky.social', name: 'Field Yates', verified: true },
    { handle: 'greggrosenthal.bsky.social', name: 'Gregg Rosenthal', verified: false },
    { handle: 'raps.bsky.social', name: 'NFL aggregate', verified: false }
  ],
  nba: [
    { handle: 'shamscharania.bsky.social', name: 'Shams Charania', verified: true },
    { handle: 'wojespn.bsky.social', name: 'Adrian Wojnarowski', verified: true },
    { handle: 'chrisbmannix.bsky.social', name: 'Chris Mannix', verified: false },
    { handle: 'tim-bontemps.bsky.social', name: 'Tim Bontemps', verified: false },
    { handle: 'ramonashelburne.bsky.social', name: 'Ramona Shelburne', verified: false },
    { handle: 'mcten.bsky.social', name: 'Dave McMenamin', verified: true },
    { handle: 'espnmacmahon.bsky.social', name: 'Tim MacMahon', verified: false },
    { handle: 'anthony-slater.bsky.social', name: 'Anthony Slater', verified: true }
  ]
};

const ALL_REPORTERS = [...REPORTERS.nfl.map(r => ({ ...r, sport: 'nfl' })), ...REPORTERS.nba.map(r => ({ ...r, sport: 'nba' }))];

const INJURY_KEYWORDS = [
  'injury', 'injured', 'questionable', 'out for', 'will not return',
  "won't return", 'carted', 'evaluated', 'ruled out', 'doubtful',
  'sidelined', 'exits game', 'leaves game', 'limps', 'hurt',
  'medical', 'trainer', 'locker room', 'acl', 'mcl', 'hamstring',
  'ankle', 'knee', 'concussion', 'fracture'
];

function hasInjuryKeyword(text) {
  const lower = String(text).toLowerCase();
  return INJURY_KEYWORDS.some(k => lower.includes(k));
}

function classifyStatus(text) {
  const t = String(text).toLowerCase();
  if (/\b(will not return|won't return|out for (?:the )?(?:rest|remainder)|ruled out|out for game)\b/.test(t)) return 'OUT_FOR_GAME';
  if (/\b(questionable to return|doubtful|questionable)\b/.test(t)) return 'QUESTIONABLE_TO_RETURN';
  return 'INJURY_REPORTED';
}

function extractPlayerName(text) {
  // Very heuristic: look for "Player Name" before injury keyword
  // Example: "Patrick Mahomes injured..."
  // We will return first two capitalized words before keyword if found
  const m = text.match(/([A-Z][a-z]+ [A-Z][a-z]+) (?:has |is |was |exits|leaves|injured|questionable|out)/);
  if (m) return m[1];
  // Alternative: try to find capitalized name anywhere
  const m2 = text.match(/([A-Z][a-z]+\s[A-Z][a-z]+)/);
  return m2 ? m2[1] : 'Unknown';
}

function extractTeamAbbr(text, sport) {
  // Look for team abbreviations or names
  const nflTeams = ['KC','BUF','BAL','CIN','CLE','PIT','HOU','IND','JAX','TEN','DEN','LV','LAC','MIA','NE','NYJ','ATL','CAR','NO','TB','ARI','LAR','SF','SEA','DAL','NYG','PHI','WAS','CHI','DET','GB','MIN'];
  const nbaTeams = ['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'];
  const teams = sport === 'nfl' ? nflTeams : nbaTeams;
  const upper = text.toUpperCase();
  for (const abbr of teams) {
    if (upper.includes(abbr)) return abbr;
  }
  return '';
}

async function fetchJson(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'NBAInjScoreboard/1.0'
      },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const txt = await res.text();
    return JSON.parse(txt);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch author feed for a single reporter
 */
export async function fetchAuthorFeed(handle, limit = 20) {
  const url = `${BSKY_PUBLIC_API}?actor=${encodeURIComponent(handle)}&limit=${limit}`;
  const data = await fetchJson(url);
  if (!data.feed || !Array.isArray(data.feed)) throw new Error('Invalid Bluesky feed response');
  return data.feed;
}

/**
 * Parse feed items into alerts
 */
export function parseBlueskyFeed(feed, reporter) {
  const alerts = [];
  for (const item of feed) {
    const post = item.post;
    if (!post) continue;
    const record = post.record;
    if (!record) continue;
    const text = String(record.text || '');
    if (!text) continue;
    if (!hasInjuryKeyword(text)) continue;

    const createdAt = record.createdAt || post.indexedAt || new Date().toISOString();
    const ts = new Date(createdAt);
    if (isNaN(ts.getTime())) continue;

    // Discard stale >30 min (as per spec)
    const ageMs = Date.now() - ts.getTime();
    if (ageMs > 30 * 60 * 1000) continue;

    const status = classifyStatus(text);
    const playerName = extractPlayerName(text);

    alerts.push({
      source: 'bluesky',
      sport: reporter.sport,
      team: extractTeamAbbr(text, reporter.sport),
      player_name: playerName,
      status,
      timestamp_source: ts.toISOString(),
      timestamp_first_seen: new Date().toISOString(),
      latency_ms: ageMs,
      verbatim_text: text.slice(0, 900),
      source_url: `https://bsky.app/profile/${reporter.handle}/post/${String(post.uri || '').split('/').pop() || ''}`,
      verified: !!reporter.verified,
      game_id: '',
      reporter_handle: reporter.handle,
      reporter_name: reporter.name
    });
  }
  return alerts;
}

/**
 * Collect from all reporters (or filtered by active teams)
 */
export async function collectBluesky({ activeTeams = null, limitPerReporter = 15, onAlert } = {}) {
  const allAlerts = [];
  // If activeTeams provided, we could prioritize but for now fetch all
  // To respect rate limits, fetch sequentially with small delay
  for (const reporter of ALL_REPORTERS) {
    try {
      const feed = await fetchAuthorFeed(reporter.handle, limitPerReporter);
      const alerts = parseBlueskyFeed(feed, reporter);
      for (const a of alerts) {
        // If activeTeams filter, only keep if team matches or team empty
        if (activeTeams && activeTeams.size > 0) {
          if (a.team && !activeTeams.has(a.team)) continue;
        }
        allAlerts.push(a);
        if (onAlert) onAlert(a);
      }
      // small delay to avoid hammering
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`Bluesky fetch failed for ${reporter.handle}: ${e.message}`);
    }
  }
  return allAlerts;
}

/**
 * For testing: fetch one reporter live and return raw + parsed
 */
export async function testLive(handle = 'schefter.bsky.social') {
  const reporter = ALL_REPORTERS.find(r => r.handle === handle) || { handle, sport: 'nfl', verified: true, name: handle };
  const feed = await fetchAuthorFeed(handle, 10);
  const alerts = parseBlueskyFeed(feed, reporter);
  return { raw: feed.slice(0, 2), alerts, reporter };
}

export const __test__ = {
  hasInjuryKeyword,
  classifyStatus,
  parseBlueskyFeed,
  extractPlayerName
};
