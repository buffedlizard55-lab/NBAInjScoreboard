/**
 * Google News RSS collector - free, keyless
 * Endpoint: https://news.google.com/rss/search?q=...
 * No API key required
 *
 * Tested LIVE, fixtures saved in fixtures/google-news-*.xml
 */

const GOOGLE_NEWS_BASE = 'https://news.google.com/rss/search';

const INJURY_KEYWORDS = [
  'injury', 'injured', 'questionable', 'out for', 'will not return',
  'carted', 'evaluated', 'ruled out', 'sidelined', 'exits game',
  'hamstring', 'acl', 'mcl', 'ankle', 'concussion', 'fracture'
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

async function fetchText(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'NBAInjScoreboard/1.0 (+https://github.com/buffedlizard55-lab/NBAInjScoreboard)'
      },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const txt = await res.text();
    if (txt.length > 5_000_000) throw new Error('Oversize RSS');
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Very small RSS parser - avoids external deps
 * Extracts <item> blocks with title, link, pubDate, description
 */
export function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const getTag = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const m = re.exec(block);
      if (!m) return '';
      // Unescape CDATA and entities minimally
      let v = m[1].trim();
      v = v.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
      v = v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      return v;
    };
    const title = getTag('title');
    const link = getTag('link');
    const pubDate = getTag('pubDate');
    const description = getTag('description');
    const source = getTag('source');
    if (title) {
      items.push({ title, link, pubDate, description, source });
    }
  }
  return items;
}

/**
 * Build Google News RSS URL for a query
 */
export function buildSearchUrl(query) {
  const q = encodeURIComponent(query);
  // hl=en-US&gl=US&ceid=US:en are required for US English
  return `${GOOGLE_NEWS_BASE}?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Fetch news for a single team query
 */
export async function fetchTeamNews(teamQuery, sport = 'nfl') {
  const query = `${teamQuery} injury ${sport}`;
  const url = buildSearchUrl(query);
  const xml = await fetchText(url);
  const items = parseRss(xml);
  return { query, url, xml: xml.slice(0, 2000), items };
}

/**
 * Parse RSS items into alerts
 */
export function parseNewsItems(items, sport, teamAbbr) {
  const alerts = [];
  for (const item of items) {
    const text = `${item.title} — ${item.description}`;
    if (!hasInjuryKeyword(text)) continue;

    let ts;
    try {
      ts = new Date(item.pubDate);
      if (isNaN(ts.getTime())) ts = new Date();
    } catch {
      ts = new Date();
    }
    const ageMs = Date.now() - ts.getTime();
    if (ageMs > 30 * 60 * 1000) continue; // discard stale >30 min

    const status = classifyStatus(text);
    // Extract player name heuristic
    let playerName = 'Unknown';
    const m = item.title.match(/([A-Z][a-z]+ [A-Z][a-z]+)/);
    if (m) playerName = m[1];

    alerts.push({
      source: 'google-news',
      sport,
      team: teamAbbr || '',
      player_name: playerName,
      status,
      timestamp_source: ts.toISOString(),
      timestamp_first_seen: new Date().toISOString(),
      latency_ms: ageMs,
      verbatim_text: item.title.slice(0, 900),
      source_url: item.link,
      verified: false,
      game_id: ''
    });
  }
  return alerts;
}

/**
 * Collect for active games: query per team every 20 sec
 * activeGames = [{sport, club_1, club_2, ...}]
 */
export async function collectGoogleNews(activeGames, { onAlert } = {}) {
  const allAlerts = [];
  // Deduplicate team queries
  const teamQueries = new Map(); // abbr -> sport
  for (const g of activeGames) {
    if (g.club_1) teamQueries.set(g.club_1, g.sport);
    if (g.club_2) teamQueries.set(g.club_2, g.sport);
    if (g.team) teamQueries.set(g.team, g.sport);
  }

  for (const [teamAbbr, sport] of teamQueries) {
    try {
      const { items } = await fetchTeamNews(teamAbbr, sport);
      const alerts = parseNewsItems(items, sport, teamAbbr);
      for (const a of alerts) {
        allAlerts.push(a);
        if (onAlert) onAlert(a);
      }
      // small delay
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`Google News fetch failed for ${teamAbbr}: ${e.message}`);
    }
  }
  return allAlerts;
}

export const __test__ = {
  parseRss,
  hasInjuryKeyword,
  classifyStatus,
  buildSearchUrl
};
