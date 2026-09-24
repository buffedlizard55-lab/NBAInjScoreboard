import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Engine, easternDate, dateOffset, parseEspnInjuries, parseEspnNews } from './engine.mjs';
import { SourceClient, urls } from './sources.mjs';

const validGame = (game, now) => game.phase === 'in' && Number.isFinite(game.lastScoreboardAt) && now - game.lastScoreboardAt < 90_000;
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
    this.writeQueue = Promise.resolve();
    this.lastInjuries = null;
    this.lastNews = null;
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
      (g.phase === 'post' && now - g.start < 5 * 3_600_000 && !g.lastSummary));
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
      }).catch(error => console.error(`Cannot persist state: ${message(error)}`));
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
  }
  async stop() {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.publish(true); // force final atomic snapshot even if stopped during a write throttle
    await this.writeQueue;
  }
}
