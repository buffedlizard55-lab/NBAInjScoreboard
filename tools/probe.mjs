// Read-only source probe. Logs observed endpoint shapes/headers, not speculative results.
// Network reachability from a CI runner does NOT prove reachability from GitHub Pages.
import { urls } from '../src/sources.mjs';
import { easternDate } from '../src/engine.mjs';

const origin = 'https://buffedlizard55-lab.github.io';
const probes = [
  ['ESPN current scoreboard', urls.scoreboard(easternDate()), data => ({ games: data.events?.length, firstEventKeys: Object.keys(data.events?.[0] || {}) })],
  ['ESPN archived scoreboard', urls.scoreboard('2026-04-25'), data => ({ games: data.events?.length, firstId: data.events?.[0]?.id })],
  ['ESPN archived summary', urls.summary('401869414'), data => ({ plays: data.plays?.length, boxscoreTeams: data.boxscore?.players?.length, firstPlayKeys: Object.keys(data.plays?.[0] || {}) })],
  ['ESPN injuries', urls.injuries, data => ({ teams: data.injuries?.length, firstRowKeys: Object.keys(data.injuries?.[0]?.injuries?.[0] || {}), firstSource: data.injuries?.[0]?.injuries?.[0]?.source, firstDetailsKeys: Object.keys(data.injuries?.[0]?.injuries?.[0]?.details || {}) })],
  ['ESPN news', urls.news, data => ({ articles: data.articles?.length, firstArticleKeys: Object.keys(data.articles?.[0] || {}) })],
  ['NBA official scoreboard', urls.nbaScoreboard, data => ({ date: data.scoreboard?.gameDate, games: data.scoreboard?.games?.length })],
  ['NBA archived PBP', urls.nbaPbp('0022400247'), data => ({ actions: data.game?.actions?.length,
    reviewExamples: data.game?.actions?.filter(a => /review|challeng/i.test(a.description || '')).slice(0, 3).map(a => ({ actionType: a.actionType, period: a.period, clock: a.clock, description: a.description })) })],
  ['NBA.com news HTML', 'https://www.nba.com/news', null],
  ['NBA.com injury article HTML', 'https://www.nba.com/news/kyrie-irving-wont-return-2025-26-season', null],
  ['NBA official injury-report index HTML', 'https://official.nba.com/nba-injury-report-2025-26-season/', null]
];

function log(result) {
  const line = JSON.stringify(result);
  console.log(line);
  // Actions' log archive may be inaccessible to an API-only checkout. Check-run
  // annotations are also readable through the GitHub REST API for PR review.
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=${result.name}::${line.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}

for (const [name, url, extract] of probes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Origin: origin, Accept: extract ? 'application/json' : 'text/html' } });
    const allow = response.headers.get('access-control-allow-origin') || 'NOT PRESENT';
    const raw = await response.text();
    let shape = {};
    if (extract && response.ok) shape = extract(JSON.parse(raw));
    else if (!extract && response.ok) shape = { pdfLinks: (raw.match(/Injury-Report_[^"'\s<>]+\.pdf/g) || []).length,
      newsLinks: (raw.match(/href=["'][^"']*\/news\/[\w-]+["']/g) || []).length,
      dateMetadata: /article:published_time|datePublished/.test(raw),
      firstAnchor: raw.match(/<a\b[^>]*href=["'][^"']*\/news\/[\w-]+[^>]*>/i)?.[0]?.slice(0, 230),
      articleAnchorSamples: name === 'NBA.com news HTML' ? (raw.match(/<a\b[^>]*>/gi) || []).filter(t => /href=["'](?:https:\/\/www\.nba\.com)?\/news\/[\w-]+["']/.test(t) && /Article link for|data-text=/.test(t) && !/data-id=["']nba:navigation/.test(t)).slice(0, 3).map(t => t.slice(0, 420)) : undefined,
      knownArticleAnchor: name === 'NBA.com news HTML' ? raw.match(/<a\b[^>]*href=["'](?:https:\/\/www\.nba\.com)?\/news\/live-updates-2026-27-houston-rockets-media-day["'][^>]*>/i)?.[0]?.slice(0, 500) : undefined,
      nextKeys: name === 'NBA.com news HTML' ? (() => { try { const text = raw.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1]; const data = JSON.parse(text); return Object.keys(data.props?.pageProps || {}); } catch { return []; } })() : undefined,
      publishedMeta: raw.match(/<meta\b[^>]*(?:article:published_time|datePublished)[^>]*>/i)?.[0]?.slice(0, 220),
      publishedJson: raw.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1],
      dateContext: name.includes('article') ? raw.match(/.{0,90}"datePublished"\s*:\s*"[^"]+".{0,90}/)?.[0] : undefined,
      articleBodyMarker: name.includes('article') ? /"articleBody"/.test(raw) : undefined,
      h1: raw.match(/<h1\b[^>]*>([^<]{1,120})/i)?.[1],
      indexSnippet: name.includes('injury-report') ? raw.match(/(?:injury.report|admin.ajax|\.pdf)[^<>]{0,120}/i)?.[0]?.slice(0, 180) : undefined };
    log({ name, status: response.status, cors: allow, bytes: raw.length, shape });
  } catch (error) {
    log({ name, error: error.name === 'AbortError' ? 'Timeout' : String(error.message) });
  } finally { clearTimeout(timeout); }
}
