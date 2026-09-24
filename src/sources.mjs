import { ESPN, NBA } from './engine.mjs';

export const urls = {
  scoreboard: day => `${ESPN}/scoreboard?dates=${day.replaceAll('-', '')}&limit=100`,
  summary: id => `${ESPN}/summary?event=${id}`,
  injuries: `${ESPN}/injuries`,
  news: `${ESPN}/news?limit=50`,
  nbaScoreboard: `${NBA}/scoreboard/todaysScoreboard_00.json`,
  nbaPbp: id => `${NBA}/playbyplay/playbyplay_${id}.json`
};

export class SourceClient {
  constructor({ fetcher = fetch, now = () => Date.now(), timeout = 8500 } = {}) {
    this.fetcher = fetcher;
    this.now = now;
    this.timeout = timeout;
    this.cooldown = new Map();
  }
  async json(key, url) {
    if (this.now() < (this.cooldown.get(key)?.until || 0)) throw new Error(`Cooling down after source failure (${key})`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      // No invented Referer/Origin, no embedded secrets, no public open-proxy URLs.
      const response = await this.fetcher(url, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) {
        const retry = Math.min(300, Math.max(15, Number(response.headers?.get('retry-after')) || 0));
        const error = new Error(`HTTP ${response.status} (${key})`);
        error.retryMs = response.status === 429 ? retry * 1000 : [403, 404].includes(response.status) ? 180_000 : 0;
        throw error;
      }
      const length = Number(response.headers?.get('content-length')) || 0;
      if (length > 8_000_000) throw new Error(`Oversize source (${key})`);
      const text = await response.text();
      if (text.length > 8_000_000) throw new Error(`Oversize source (${key})`);
      const data = JSON.parse(text);
      this.cooldown.delete(key);
      return data;
    } catch (error) {
      const prior = this.cooldown.get(key)?.failures || 0;
      const failures = Math.min(6, prior + 1);
      this.cooldown.set(key, { failures, until: this.now() + (error.retryMs || Math.min(180_000, 5000 * 2 ** (failures - 1))) });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
