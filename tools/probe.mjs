// Read-only probes. These are observations from the CI runner, not a live-game latency test.
import { urls } from '../src/sources.mjs';
import { Engine, easternDate } from '../src/engine.mjs';
import { nbaNewsLinks, nbaArticle } from '../src/nba-news.mjs';

const origin = 'https://buffedlizard55-lab.github.io';
const story = 'https://www.nba.com/news/kyrie-irving-wont-return-2025-26-season';
const archivedPbp = urls.nbaPbp('0022400247');
// Browser probes include the Pages Origin; server probes use runtime-style Accept and no Origin.
const probes = [
  ['ESPN current scoreboard', urls.scoreboard(easternDate()), data => ({ games: data.events?.length, firstEventKeys: Object.keys(data.events?.[0] || {}) })],
  ['ESPN archived scoreboard', urls.scoreboard('2026-04-25'), data => ({ games: data.events?.length, firstId: data.events?.[0]?.id })],
  ['ESPN archived summary', urls.summary('401869414'), data => ({ plays: data.plays?.length, boxscoreTeams: data.boxscore?.players?.length,
    statsKeys: data.boxscore?.players?.[0]?.statistics?.[0]?.keys, firstAthlete: data.boxscore?.players?.[0]?.statistics?.[0]?.athletes?.[0] && {
      id: data.boxscore.players[0].statistics[0].athletes[0].athlete?.id,
      didNotPlay: data.boxscore.players[0].statistics[0].athletes[0].didNotPlay,
      stats: data.boxscore.players[0].statistics[0].athletes[0].stats?.slice(0, 4) },
    firstPlayParticipant: (() => { const p = data.plays?.find(p => p.participants?.length)?.participants?.[0]; return p && { keys: Object.keys(p), athleteId: p.athlete?.id }; })() })],
  ['ESPN injuries', urls.injuries, data => ({ teams: data.injuries?.length, firstRowKeys: Object.keys(data.injuries?.[0]?.injuries?.[0] || {}), firstSource: data.injuries?.[0]?.injuries?.[0]?.source })],
  ['ESPN news', urls.news, data => ({ articles: data.articles?.length, firstArticleKeys: Object.keys(data.articles?.[0] || {}) })],
  ['NBA official scoreboard', urls.nbaScoreboard, data => ({ games: data.scoreboard?.games?.length })],
  ['NBA archived PBP', archivedPbp, data => ({ actions: data.game?.actions?.length,
    reviewExamples: data.game?.actions?.filter(a => /review|challeng/i.test(a.description || '')).slice(0, 3).map(a => ({ actionType: a.actionType, period: a.period, clock: a.clock, description: a.description })) })],
  ['NBA official scoreboard Node', urls.nbaScoreboard, data => ({ games: data.scoreboard?.games?.length })],
  ['NBA archived PBP Node', archivedPbp, data => ({ actions: data.game?.actions?.length })],
  ['NBA.com news HTML', urls.nbaNews, null],
  ['NBA.com article HTML', story, null],
  ['NBA.com news Node', urls.nbaNews, null],
  ['NBA.com article Node', story, null],
  ['NBA official injury-report index', 'https://official.nba.com/nba-injury-report-2025-26-season/', null]
];

function log(result) {
  const line = JSON.stringify(result);
  console.log(line);
  // Actions log archive retrieval can be blocked; PR check-run annotations are API-readable.
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=${result.name}::${line.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}

function htmlShape(name, raw, url) {
  if (name.includes('NBA.com news')) {
    const embedded = raw.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
    const page = JSON.parse(embedded).props?.pageProps;
    const shape = { latest: page?.latest?.items?.length, features: page?.features?.length,
      first: page?.latest?.items?.[0] && { title: page.latest.items[0].title, date: page.latest.items[0].date, url: page.latest.items[0].permalink } };
    shape.parserEligibleLinks = nbaNewsLinks(raw, ['Kyrie Irving']).length;
    return shape;
  }
  if (name.includes('NBA.com article')) {
    const result = nbaArticle(raw, url, ['Kyrie Irving']);
    return { headline: raw.match(/<h1\b[^>]*>([^<]{1,140})/i)?.[1], parserCandidate: !!result,
      published: raw.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] };
  }
  return { pdfLinks: (raw.match(/Injury-Report_[^"'\s<>]+\.pdf/g) || []).length,
    postMetadata: /article:published_time|datePublished/.test(raw) };
}

let archivedScoreboard;
for (const [name, url, extract] of probes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const server = name.endsWith('Node');
    const headers = { Accept: extract ? 'application/json' : 'text/html', ...(server ? {} : { Origin: origin }) };
    const response = await fetch(url, { signal: controller.signal, headers });
    const raw = await response.text();
    let shape = {};
    if (response.ok) {
      const data = extract ? JSON.parse(raw) : null;
      shape = extract ? extract(data) : htmlShape(name, raw, url);
      if (name === 'ESPN archived scoreboard') archivedScoreboard = data;
      if (name === 'ESPN archived summary' && archivedScoreboard) {
        const engine = new Engine({ now: () => Date.parse('2026-04-26T00:00:00Z') });
        engine.scoreboard('2026-04-25', archivedScoreboard);
        engine.summary('401869414', data);
        const game = engine.games.get('401869414');
        shape.parsed = { participants: Object.keys(game?.participants || {}).length, plays: game?.espnPlays.length, reviews: engine.reviews.size };
      }
    }
    log({ name, status: response.status, cors: response.headers.get('access-control-allow-origin') || 'NOT PRESENT', bytes: raw.length, shape });
  } catch (error) { log({ name, error: error.name === 'AbortError' ? 'Timeout' : String(error.message) }); }
  finally { clearTimeout(timeout); }
}
