/**
 * Collectors index - orchestrates all collectors
 */

import * as espn from './espn.js';
import * as bluesky from './bluesky.js';
import * as googleNews from './google-news.js';
import * as mastodon from './mastodon.js';
import { globalDeduper } from './dedup.js';

export { espn, bluesky, googleNews, mastodon, globalDeduper };

export const COLLECTOR_STATUS = {
  espn_scoreboard: { last_run: null, status: 'idle', error: null, active_games: 0 },
  espn_playbyplay: { last_run: null, status: 'idle', error: null, count: 0 },
  bluesky: { last_run: null, status: 'idle', error: null, count: 0 },
  google_news: { last_run: null, status: 'idle', error: null, count: 0 },
  mastodon: { last_run: null, status: 'idle', error: null, count: 0 }
};

export function updateCollectorStatus(name, { status, error = null, ...extra }) {
  if (!COLLECTOR_STATUS[name]) COLLECTOR_STATUS[name] = {};
  COLLECTOR_STATUS[name].last_run = new Date().toISOString();
  COLLECTOR_STATUS[name].status = status;
  COLLECTOR_STATUS[name].error_msg = error ? String(error).slice(0, 500) : null;
  Object.assign(COLLECTOR_STATUS[name], extra);
}

export function getCollectorStatus() {
  return { ...COLLECTOR_STATUS };
}
