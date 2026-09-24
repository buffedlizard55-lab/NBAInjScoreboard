// Read-only source probe. Logs observed endpoint shapes/headers, not speculative results.
// Network reachability from a CI runner does NOT prove reachability from GitHub Pages.
import { urls } from '../src/sources.mjs';
import { easternDate } from '../src/engine.mjs';

const origin = 'https://buffedlizard55-lab.github.io';
const probes = [
  ['ESPN current scoreboard', urls.scoreboard(easternDate()), data => ({ games: data.events?.length, firstEventKeys: Object.keys(data.events?.[0] || {}) })],
  ['ESPN archived scoreboard', urls.scoreboard('2026-04-25'), data => ({ games: data.events?.length, firstId: data.events?.[0]?.id })],
  ['ESPN archived summary', urls.summary('401869414'), data => ({ plays: data.plays?.length, boxscoreTeams: data.boxscore?.players?.length, firstPlayKeys: Object.keys(data.plays?.[0] || {}) })],
  ['ESPN injuries', urls.injuries, data => ({ teams: data.injuries?.length, firstRowKeys: Object.keys(data.injuries?.[0]?.injuries?.[0] || {}) })],
  ['ESPN news', urls.news, data => ({ articles: data.articles?.length, firstArticleKeys: Object.keys(data.articles?.[0] || {}) })],
  ['NBA official scoreboard', urls.nbaScoreboard, data => ({ date: data.scoreboard?.gameDate, games: data.scoreboard?.games?.length })],
  ['NBA archived PBP', urls.nbaPbp('0022400247'), data => ({ actions: data.game?.actions?.length,
    reviewExamples: data.game?.actions?.filter(a => /review|challeng/i.test(a.description || '')).slice(0, 3).map(a => ({ actionType: a.actionType, period: a.period, clock: a.clock, description: a.description })) })],
  ['NBA.com news HTML', 'https://www.nba.com/news', null],
  ['NBA official injury-report index HTML', 'https://official.nba.com/nba-injury-report-2025-26-season/', null]
];

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
      dateMetadata: /article:published_time|datePublished/.test(raw) };
    console.log(JSON.stringify({ name, status: response.status, cors: allow, bytes: raw.length, shape }));
  } catch (error) {
    console.log(JSON.stringify({ name, error: error.name === 'AbortError' ? 'Timeout' : String(error.message) }));
  } finally { clearTimeout(timeout); }
}
