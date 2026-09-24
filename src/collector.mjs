import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Engine, easternDate, dateOffset, parseEspnInjuries, parseEspnNews, parseAthleteNews } from './engine.mjs';
import { SourceClient, urls } from './sources.mjs';
import { nbaNewsLinks, nbaArticle } from './nba-news.mjs';

// A report filed just after the final buzzer still describes this game, so keep
// polling briefly once it ends (engine.gameAcceptsReports enforces the timestamp).
const inPostGrace = (game, now) => game.phase === 'post' && Number.isFinite(game.lastPlayAt) &&
  game.lastPlayAt > 0 && now - game.lastPlayAt < 15 * 60_000;
const validGame = (game, now) => (game.phase === 'in' || inPostGrace(game, now)) &&
  Number.isFinite(game.lastScoreboardAt) && now - game.lastScoreboardAt < 90_000;
const message = error => error?.name === 'AbortError' ? 'Timed out' : String(error?.message || error).slice(0, 130);

export async function loadSaved(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error(`State could not be loaded (${message(error)}); rebuilding from public sources.`);
    return null;
  }
}

export class Collector extends EventEmitter {
  constructor({ now = () => Date.now(), client = new SourceClient({ now }), statePath = '.runtime/state.json', saved = null } = {}) {
    super();
    this.now = now;
    this.client = client;
    this.statePath = statePath;
    this.engine = new Engine({ now, saved });
    this.timers = new Set();
    this.running = false;
    this.lastWrite = 0;
    this.persistenceError = '';
    this.writeQueue = Promise.resolve();
    this.lastInjuries = null;
    this.lastNews = null;
    this.lastNbaCandidates = new Map();
    this.lastAthleteNews = new Map();
    this.athleteCursor = 0;
    this.athletePolled = new Set();
    this.articleChecked = new Map();
  }
  get live() { return [...this.engine.games.values()].some(g => validGame(g, this.now())); }
  async attempt(name, url, consume) {
    try {
      const data = await this.client.json(url, url); // per-URL backoff: yesterday cannot suppress today
      consume(data);
      return true;
    } catch (error) {
      this.engine.source(name, message(error));
      return false;
    }
  }
  async scoreboardTick() {
    const today = easternDate(new Date(this.now()));
    // Midnight in ET must not drop a West Coast game begun the previous date.
    await Promise.all([
      this.attempt('ESPN scoreboard', urls.scoreboard(today), data => this.engine.scoreboard(today, data)),
      this.attempt('ESPN previous-day scoreboard', urls.scoreboard(dateOffset(today, -1)), data => this.engine.scoreboard(dateOffset(today, -1), data))
    ]);
    this.publish(); // never hold ESPN scores behind an optional CDN timeout
    await this.attempt('NBA official scoreboard', urls.nbaScoreboard, data => this.engine.nbaScoreboard(data));
    this.publish();
  }
  async gameTick() {
    const now = this.now();
    const games = [...this.engine.games.values()].filter(g => validGame(g, now) ||
      (g.phase === 'pre' && g.start - now < 10 * 60_000 && g.start - now > -90_000) ||
      (g.phase === 'post' && now - g.start < 5 * 3_600_000 && !g.lastSummary) || inPostGrace(g, now));
    let index = 0;
    const worker = async () => {
      while (index < games.length) {
        const game = games[index++];
        // ESPN summary is also our evidence of actual participation. Never skip it
        // merely because the NBA PBP succeeded.
        await this.attempt('ESPN play-by-play', urls.summary(game.id), data => {
          this.engine.summary(game.id, data);
          // An injury may be published before ESPN's box score shows first minutes.
          if (this.lastInjuries) for (const item of parseEspnInjuries(this.lastInjuries)) this.engine.accept(item);
          if (this.lastNews) for (const item of parseEspnNews(this.lastNews)) this.engine.accept(item);
          for (const items of this.lastAthleteNews.values()) for (const item of items) this.engine.accept(item);
          for (const item of this.lastNbaCandidates.values()) this.engine.accept(item);
        });
        if (game.officialId) await this.attempt('NBA official play-by-play', urls.nbaPbp(game.officialId), data => this.engine.nbaPbp(game.id, data));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, games.length) }, worker));
    this.publish();
  }
  async injuryTick() {
    if (this.live) await this.attempt('ESPN injuries', urls.injuries, data => { this.lastInjuries = data; this.engine.injuriesFeed(data); });
    this.publish();
  }
  async newsTick() {
    if (this.live) await this.attempt('ESPN news', urls.news, data => { this.lastNews = data; this.engine.newsFeed(data); });
    this.publish();
  }
  /**
   * The league-wide news feed only carries the newest ~50 stories, so an injury to
   * a role player can fall off it before we ever see it. Poll each participating
   * player's own news feed in a bounded round-robin. Set ESPN_ATHLETE_NEWS=0 to
   * disable; respect provider rate limits before raising the batch size.
   */
  async athleteNewsTick() {
    if (!this.live || process.env.ESPN_ATHLETE_NEWS === '0') return this.publish();
    const participants = [...this.engine.games.values()].filter(g => validGame(g, this.now()))
      .flatMap(g => Object.values(g.participants).map(p => ({ ...p, gameId: g.id })));
    if (!participants.length) return this.publish();
    const names = [...new Set(participants.map(p => p.name))];
    const batch = Math.max(1, Math.min(12, Number(process.env.ESPN_ATHLETE_NEWS_BATCH) || 8));
    let checked = 0;
    for (let step = 0; step < participants.length && checked < batch; step++) {
      const player = participants[this.athleteCursor % participants.length];
      this.athleteCursor = (this.athleteCursor + 1) % participants.length;
      if (!player?.id) continue;
      const ok = await this.attempt('ESPN player news', urls.athleteNews(player.id), data => {
        const items = parseAthleteNews(data, player.id, { name: player.name, others: names.filter(n => n !== player.name) });
        this.lastAthleteNews.set(player.id, items);
        for (const item of items) this.engine.accept(item);
      });
      if (ok) { checked++; this.athletePolled.add(player.id); }
    }
    // Publish real coverage so nobody mistakes a partial sweep for full monitoring.
    this.athletePolled = new Set([...this.athletePolled].filter(id => participants.some(p => p.id === id)));
    this.engine.source('ESPN player news', null,
      { polledDistinct: this.athletePolled.size, participants: participants.length });
    // Bound the delayed-replay cache the same way NBA.com candidates are bounded.
    this.lastAthleteNews = new Map([...this.lastAthleteNews].slice(-250));
    this.publish();
  }
  async nbaNewsTick() {
    const names = [...new Set([...this.engine.games.values()].filter(g => validGame(g, this.now()))
      .flatMap(g => Object.values(g.participants).map(p => p.name)))];
    if (!names.length) return;
    try {
      const index = await this.client.text(urls.nbaNews, urls.nbaNews);
      const articles = nbaNewsLinks(index, names);
      this.engine.source('NBA.com news index');
      let articleFailure = '';
      let checked = 0;
      for (const article of articles) {
        if (this.now() - (this.articleChecked.get(article.url) || 0) < 10 * 60_000) continue;
        try {
          const html = await this.client.text(article.url, article.url);
          const candidate = nbaArticle(html, article.url, names);
          this.articleChecked.set(article.url, this.now());
          checked++;
          if (candidate) {
            this.lastNbaCandidates.set(candidate.sourceKey, candidate);
            this.engine.accept(candidate);
          }
        } catch (error) { articleFailure = message(error); }
      }
      if (articleFailure || checked) this.engine.source('NBA.com articles', articleFailure || null);
      // Keep delayed box-score replays bounded, and allow old article links to be checked again.
      this.lastNbaCandidates = new Map([...this.lastNbaCandidates].slice(-200));
      this.articleChecked = new Map([...this.articleChecked].filter(([, t]) => this.now() - t < 24 * 3_600_000));
    } catch (error) { this.engine.source('NBA.com news index', message(error)); }
    this.publish();
  }
  publish(force = false) {
    const changes = this.engine.drainChanges();
    this.emit('update', changes);
    if (force || this.now() - this.lastWrite > 5000) {
      this.lastWrite = this.now();
      const json = JSON.stringify(this.engine.export());
      this.writeQueue = this.writeQueue.then(async () => {
        await mkdir(dirname(this.statePath), { recursive: true });
        await writeFile(`${this.statePath}.tmp`, json);
        await rename(`${this.statePath}.tmp`, this.statePath);
        this.persistenceError = '';
        this.engine.source('Local event storage');
      }).catch(error => {
        this.persistenceError = message(error);
        this.engine.source('Local event storage', this.persistenceError);
        console.error(`Cannot persist state: ${this.persistenceError}`);
      });
    }
  }
  runLoop(fn, delay) {
    const execute = async () => {
      if (!this.running) return;
      try { await fn.call(this); }
      catch (error) { console.error(`Collector error: ${message(error)}`); }
      if (this.running) {
        const timer = setTimeout(() => { this.timers.delete(timer); execute(); }, delay.call(this));
        this.timers.add(timer);
      }
    };
    execute();
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.runLoop(this.scoreboardTick, () => this.live || [...this.engine.games.values()].some(g => g.phase === 'pre' && g.start - this.now() < 15 * 60_000) ? 10_000 : 55_000);
    this.runLoop(this.gameTick, () => this.live ? 6_000 : 8_000);
    // Idle iterations do no network I/O. Keep them short so the first live game
    // cannot wait up to a minute for the first injury check after tip-off.
    this.runLoop(this.injuryTick, () => this.live ? 12_000 : 8_000);
    this.runLoop(this.newsTick, () => this.live ? 30_000 : 12_000);
    // Idle iterations return immediately without network I/O.
    this.runLoop(this.athleteNewsTick, () => this.live ? 30_000 : 15_000);
    // NBA.com has server-readable, dated articles but no CORS on its HTML pages.
    this.runLoop(this.nbaNewsTick, () => this.live ? 45_000 : 12_000);
  }
  async stop() {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.publish(true); // force final atomic snapshot even if stopped during a write throttle
    await this.writeQueue;
  }
}
