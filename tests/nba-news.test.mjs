import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../src/collector.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.mjs';
import { nbaNewsLinks, nbaArticle } from '../src/nba-news.mjs';
import { GAME_ID, liveScoreboard, summary } from './fixtures.mjs';

// Synthetic source-shaped fixtures; none of these headlines or players are real reports.
const URL = 'https://www.nba.com/news/test-player-ankle-injury';
const TIME = '2026-10-03T23:10:00Z';
const NOW = Date.parse('2026-10-03T23:30:00Z');
const headline = 'Test Player exits game with ankle injury';
const index = (posts = []) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {
  features: posts.slice(0, 1), latest: { items: posts.slice(1) }
} } })}</script>`;
const post = (title = headline, url = URL) => ({ title, permalink: url, date: TIME, status: 'publish' });
const article = (title = headline, url = URL, published = TIME) => `<h1>${title}</h1>
<script type="application/ld+json">${JSON.stringify({ '@type': 'Article', headline: title,
  url, datePublished: published, description: 'Test Player exited the game with an ankle injury.' })}</script>`;

test('NBA.com index only exposes published injury links for exactly one participating athlete and a fixed trusted origin', () => {
  const posts = [post(), post('Test Player chats with coach', 'https://www.nba.com/news/test-player-interview'),
    post('Test Player injured and Other Player leaves game', 'https://www.nba.com/news/two-players'),
    post('Test Player injured', 'https://www.nba.com.evil.example/news/test-player'),
    { ...post('Test Player injured', 'https://www.nba.com/news/draft-story'), status: 'draft' },
    post('Other Player ruled out with ankle injury', 'https://www.nba.com/news/other-player')];
  assert.deepEqual(nbaNewsLinks(index(posts), ['Test Player', 'Other Player']), [
    { url: URL, title: headline }, { url: 'https://www.nba.com/news/other-player', title: posts[5].title }
  ]);
  assert.throws(() => nbaNewsLinks('<html>updated template</html>', ['Test Player']), /lacks serialized/);
  assert.throws(() => nbaNewsLinks(index(), ['Test Player']), /no articles/);
});

test('NBA.com article needs matching canonical JSON-LD, headline, dated publication and medical wording', () => {
  assert.deepEqual(nbaArticle(article(), URL, ['Test Player']), {
    athleteId: '', teamId: '', name: 'Test Player', status: 'reported',
    text: `${headline} — Test Player exited the game with an ankle injury.`,
    publishedAt: Date.parse(TIME), source: 'NBA.com news article', sourceUrl: URL,
    sourceKey: `nba-news:${URL}:${TIME}:${headline}`
  });
  assert.equal(nbaArticle(article('Test Player chats with coach'), URL, ['Test Player']), null);
  const ejection = article('Test Player will not return').replace('Test Player exited the game with an ankle injury.', 'Test Player was ejected for a flagrant foul.');
  assert.equal(nbaArticle(ejection, URL, ['Test Player']), null);
  assert.equal(nbaArticle(article('Test Player exits game with ankle injury', URL, '2026-10-03T23:10:00'), URL, ['Test Player']), null);
  assert.equal(nbaArticle(article(), URL, ['Bench Player']), null);
  assert.throws(() => nbaArticle(article(headline, 'https://www.nba.com/news/other-story'), URL, ['Test Player']), /matching dated source/);
  assert.throws(() => nbaArticle(article(), 'https://www.nba.com.evil.example/news/x', ['Test Player']), /Untrusted/);
  assert.throws(() => nbaArticle('<h1>Test Player exits with ankle injury</h1>', URL, ['Test Player']), /matching dated source/);
  const possessive = "Test Player's ankle injury forces exit";
  assert.equal(nbaArticle(article(possessive), URL, ['Test Player']).status, 'reported');
});

test('server-only NBA.com articles enter the same verified game feed; pre-action reports and duplicates do not alert', async () => {
  let calls = 0;
  const runtimeDir = join(tmpdir(), `nba-news-test-${randomUUID()}`);
  const statePath = join(runtimeDir, 'state.json');
  const collector = new Collector({ now: () => NOW, statePath, client: {
    text: async (_key, url) => { calls++; return url === 'https://www.nba.com/news' ? index([post()]) : article(); }
  } });
  try {
    collector.engine.scoreboard('2026-10-03', liveScoreboard());
    collector.engine.summary(GAME_ID, summary());
    await collector.nbaNewsTick();
    assert.deepEqual(collector.engine.snapshot('2026-10-03').injuries.map(i => i.status), ['reported']);
    assert.equal(collector.engine.snapshot('2026-10-03').injuries[0].evidence[0].url, URL);
    await collector.nbaNewsTick();
    assert.equal(calls, 3); // index polled again, article cached for ten minutes
    assert.equal(collector.engine.snapshot('2026-10-03').injuries.length, 1);
    const engine = new Engine({ now: () => NOW });
    engine.scoreboard('2026-10-03', liveScoreboard());
    engine.summary(GAME_ID, summary());
    assert.equal(engine.accept(nbaArticle(article(headline, URL, '2026-10-03T23:02:00Z'), URL, ['Test Player'])), false);
    const future = article('Test Player injured ankle, ruled out for Friday game');
    assert.equal(nbaArticle(future, URL, ['Test Player']), null);
  } finally {
    await collector.stop();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
