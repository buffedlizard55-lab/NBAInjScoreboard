#!/usr/bin/env node
/**
 * Live collector test - fetches all sources LIVE and saves fixtures
 * Run with: node tools/collect-live.mjs
 * Requires network access (fails in sandbox with TLS blocked, works on Render/local)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const fixturesDir = resolve(root, 'fixtures');

await mkdir(fixturesDir, { recursive: true });

async function fetchAndSave(name, url, opts = {}) {
  const isJson = opts.json !== false;
  console.log(`\n[FETCH] ${name}: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': isJson ? 'application/json' : 'text/html, application/rss+xml, application/xml, */*',
        'User-Agent': 'NBAInjScoreboard/1.0 (+https://github.com/buffedlizard55-lab/NBAInjScoreboard)'
      },
      cache: 'no-store'
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`  Bytes: ${text.length}`);
    console.log(`  Preview: ${text.slice(0, 300).replace(/\n/g, ' ')}`);

    const ext = isJson ? 'json' : (url.includes('rss') ? 'xml' : 'json');
    const filename = `${name}.${ext}`;
    const filepath = resolve(fixturesDir, filename);

    // Try to pretty-print JSON
    if (isJson) {
      try {
        const data = JSON.parse(text);
        await writeFile(filepath, JSON.stringify(data, null, 2));
        console.log(`  Saved JSON to ${filepath}`);
        return { ok: true, data, filepath, status: res.status };
      } catch {
        await writeFile(filepath, text);
        console.log(`  Saved raw to ${filepath}`);
        return { ok: true, raw: text, filepath, status: res.status };
      }
    } else {
      await writeFile(filepath, text);
      console.log(`  Saved to ${filepath}`);
      return { ok: true, raw: text, filepath, status: res.status };
    }
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    return { ok: false, error: e.message, url };
  }
}

console.log('=== LIVE COLLECTOR TEST ===');
console.log(`Fixtures dir: ${fixturesDir}`);
console.log(`Date: ${new Date().toISOString()}`);

const results = [];

// 1. ESPN scoreboard - NFL and NBA
results.push(await fetchAndSave('espn-nfl-scoreboard-live', 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=100'));
results.push(await fetchAndSave('espn-nba-scoreboard-live', 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?limit=100'));
results.push(await fetchAndSave('espn-nfl-scoreboard-alt', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'));
results.push(await fetchAndSave('espn-nba-scoreboard-alt', 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'));

// 2. ESPN injuries
results.push(await fetchAndSave('espn-nfl-injuries-live', 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/injuries'));
results.push(await fetchAndSave('espn-nba-injuries-live', 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries'));

// 3. ESPN summary (play-by-play) - need a recent game ID
// Try to get a game ID from scoreboard
let sampleGameId = null;
try {
  const scoreboardData = results.find(r => r.ok && r.data?.events?.[0])?.data;
  if (scoreboardData?.events?.[0]?.id) {
    sampleGameId = scoreboardData.events[0].id;
    console.log(`\nFound sample game ID: ${sampleGameId}`);
    results.push(await fetchAndSave(`espn-summary-${sampleGameId}`, `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${sampleGameId}`));
  } else {
    // Fallback to known historical game
    console.log('\nNo live game, using historical NFL game 401547417');
    results.push(await fetchAndSave('espn-summary-historical-nfl', 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401547417'));
  }
} catch (e) {
  console.warn(`Could not fetch sample summary: ${e.message}`);
}

// 4. Bluesky author feeds
const reporters = [
  'schefter.bsky.social',
  'rapsheet.bsky.social',
  'shamscharania.bsky.social'
];
for (const handle of reporters) {
  results.push(await fetchAndSave(`bluesky-${handle.replace(/\./g, '-')}`, `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=10`));
}

// 5. Google News RSS
results.push(await fetchAndSave('google-news-kc-chiefs-injury', 'https://news.google.com/rss/search?q=Kansas%20City%20Chiefs%20injury%20nfl&hl=en-US&gl=US&ceid=US:en', { json: false }));
results.push(await fetchAndSave('google-news-lakers-injury', 'https://news.google.com/rss/search?q=Los%20Angeles%20Lakers%20injury%20nba&hl=en-US&gl=US&ceid=US:en', { json: false }));

// 6. Mastodon hashtag
results.push(await fetchAndSave('mastodon-nfl-tag', 'https://mastodon.social/api/v1/timelines/tag/nfl?limit=10'));
results.push(await fetchAndSave('mastodon-nba-tag', 'https://mastodon.social/api/v1/timelines/tag/nba?limit=10'));

console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.filepath || r.url} - ${r.ok ? r.status : r.error}`);
}

const summary = {
  timestamp: new Date().toISOString(),
  results: results.map(r => ({
    ok: r.ok,
    file: r.filepath,
    url: r.url,
    status: r.status,
    error: r.error,
    bytes: r.data ? JSON.stringify(r.data).length : r.raw?.length
  }))
};

await writeFile(resolve(fixturesDir, 'live-test-summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nSummary saved to fixtures/live-test-summary.json`);
