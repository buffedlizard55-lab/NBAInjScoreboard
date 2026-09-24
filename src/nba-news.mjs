import { classifyReport, hasMedicalDetail, plainName } from './engine.mjs';

const trim = value => String(value || '').replace(/\s+/g, ' ').trim();
const signal = /\b(injur\w*|illness|concussion|sore\w*|sprain|strain|fracture|tear|torn|pain|hurt|exits?|leaves?|left|ruled out|questionable to return|will not return|won't return|returned to (?:the )?game)\b/i;
const attr = /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
const jsonLd = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const headlineTag = /<h1\b[^>]*>([^<]{1,400})<\/h1>/i;

function decode(value) {
  return trim(value).replace(/&#(x[\da-f]+|\d+);/gi, (entity, number) => {
    const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : entity;
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (entity, name) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[name.toLowerCase()] || entity);
}

function trustedArticleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.nba.com' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/news\/[a-z0-9-]+$/i.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}

function namedPlayers(headline, names) {
  const normalized = ` ${plainName(headline)} `;
  const found = [...new Set(names.filter(name => plainName(name) && normalized.includes(` ${plainName(name)} `)))];
  // The after-name check prevents an injury to another person in a multi-subject headline.
  if (found.length !== 1) return [];
  const afterName = normalized.slice(normalized.indexOf(` ${plainName(found[0])} `) + plainName(found[0]).length + 2);
  return signal.test(afterName) ? found : [];
}

/** The NBA.com news page supplies featured/latest posts in its actual Next.js data. */
export function nbaNewsLinks(html, participatingNames) {
  const embedded = html?.match(attr)?.[1];
  if (!embedded) throw new Error('NBA.com news index lacks serialized article data');
  let page;
  try { page = JSON.parse(embedded).props?.pageProps; }
  catch { throw new Error('NBA.com news index is not valid JSON'); }
  const articles = [...(Array.isArray(page?.features) ? page.features : []),
    ...(Array.isArray(page?.latest?.items) ? page.latest.items : [])];
  if (!articles.length) throw new Error('NBA.com news index has no articles');
  const results = new Map();
  for (const article of articles) {
    const url = trustedArticleUrl(article?.permalink);
    const title = decode(article?.title);
    if (article?.status !== 'publish' || !url || !namedPlayers(title, participatingNames).length) continue;
    results.set(url, { url, title });
  }
  return [...results.values()].slice(0, 8);
}

/** A fetched article needs matching HTML headline AND canonical JSON-LD URL/title/date. */
export function nbaArticle(html, url, participatingNames) {
  const canonical = trustedArticleUrl(url);
  if (!canonical) throw new Error('Untrusted NBA.com news article URL');
  const h1 = decode(html?.match(headlineTag)?.[1]);
  if (!h1) throw new Error('NBA.com article has no headline');
  let story;
  for (const match of html.matchAll(jsonLd)) {
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    if (['Article', 'NewsArticle'].includes(data?.['@type']) && data.url === canonical &&
      decode(data.headline) === h1 && typeof data.datePublished === 'string') { story = data; break; }
  }
  if (!story) throw new Error('NBA.com article lacks matching dated source metadata');
  const publishedAt = Date.parse(story.datePublished);
  if (!Number.isFinite(publishedAt) || !/T\d\d:\d\d/.test(story.datePublished) || !/(?:Z|[+-]\d\d:\d\d)$/i.test(story.datePublished)) return null;
  const names = namedPlayers(h1, participatingNames);
  if (names.length !== 1) return null;
  const description = decode(story.description);
  const text = trim([h1, description].filter(Boolean).join(' — '));
  const status = classifyReport(text);
  if (!status || !hasMedicalDetail(text) || !signal.test(h1)) return null;
  return { athleteId: '', teamId: '', name: names[0], status, text, publishedAt,
    source: 'NBA.com news article', sourceUrl: canonical, sourceKey: `nba-news:${canonical}:${story.datePublished}:${h1}` };
}
