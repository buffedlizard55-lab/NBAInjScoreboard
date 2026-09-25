/**
 * Mastodon collector - free, keyless public hashtag search
 * Uses public timelines: https://mastodon.social/api/v1/timelines/tag/:hashtag
 * No auth required for public tags
 * Low priority per spec
 */

const MASTODON_INSTANCES = [
  'https://mastodon.social',
  'https://mastodon.online',
  'https://fosstodon.org'
];

const HASHTAGS = {
  nfl: ['nfl', 'nflinjury', 'footballinjury'],
  nba: ['nba', 'nbainjury', 'basketballinjury']
};

const INJURY_KEYWORDS = [
  'injury', 'injured', 'questionable', 'out for', 'will not return',
  'carted', 'evaluated', 'ruled out', 'sidelined'
];

function hasInjuryKeyword(text) {
  const lower = String(text).toLowerCase();
  return INJURY_KEYWORDS.some(k => lower.includes(k));
}

function classifyStatus(text) {
  const t = String(text).toLowerCase();
  if (/\b(will not return|won't return|out for (?:the )?(?:rest|remainder)|ruled out)\b/.test(t)) return 'OUT_FOR_GAME';
  if (/\b(questionable|doubtful)\b/.test(t)) return 'QUESTIONABLE_TO_RETURN';
  return 'INJURY_REPORTED';
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
    if (txt.length > 5_000_000) throw new Error('Oversize');
    return JSON.parse(txt);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch hashtag timeline from Mastodon
 */
export async function fetchHashtagTimeline(hashtag, instance = MASTODON_INSTANCES[0], limit = 20) {
  const url = `${instance}/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?limit=${limit}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new Error('Invalid Mastodon response');
  return data;
}

/**
 * Strip HTML tags from Mastodon content (content is HTML)
 */
function stripHtml(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900);
}

export function parseMastodonPosts(posts, sport) {
  const alerts = [];
  for (const post of posts) {
    const rawContent = post.content || '';
    const text = stripHtml(rawContent);
    if (!text) continue;
    if (!hasInjuryKeyword(text)) continue;

    let ts;
    try {
      ts = new Date(post.created_at);
      if (isNaN(ts.getTime())) continue;
    } catch {
      continue;
    }
    const ageMs = Date.now() - ts.getTime();
    if (ageMs > 30 * 60 * 1000) continue;

    const status = classifyStatus(text);

    alerts.push({
      source: 'mastodon',
      sport,
      team: '',
      player_name: 'Unknown',
      status,
      timestamp_source: ts.toISOString(),
      timestamp_first_seen: new Date().toISOString(),
      latency_ms: ageMs,
      verbatim_text: text,
      source_url: post.url || post.uri || '',
      verified: false,
      game_id: ''
    });
  }
  return alerts;
}

export async function collectMastodon(activeGames, { onAlert } = {}) {
  const allAlerts = [];
  const sports = new Set(activeGames.map(g => g.sport));
  // If no active games, still try both
  const targetSports = sports.size > 0 ? [...sports] : ['nfl', 'nba'];

  for (const sport of targetSports) {
    const tags = HASHTAGS[sport] || [];
    for (const tag of tags) {
      try {
        const posts = await fetchHashtagTimeline(tag, MASTODON_INSTANCES[0], 15);
        const alerts = parseMastodonPosts(posts, sport);
        for (const a of alerts) {
          allAlerts.push(a);
          if (onAlert) onAlert(a);
        }
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.warn(`Mastodon fetch failed for #${tag}: ${e.message}`);
        // try fallback instance
        try {
          const posts = await fetchHashtagTimeline(tag, MASTODON_INSTANCES[1], 15);
          const alerts = parseMastodonPosts(posts, sport);
          for (const a of alerts) {
            allAlerts.push(a);
            if (onAlert) onAlert(a);
          }
        } catch (e2) {
          console.warn(`Mastodon fallback failed for #${tag}: ${e2.message}`);
        }
      }
    }
  }
  return allAlerts;
}

export const __test__ = {
  hasInjuryKeyword,
  parseMastodonPosts,
  stripHtml
};
