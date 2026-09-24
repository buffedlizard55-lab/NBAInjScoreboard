import { Engine, easternDate, dateOffset, validDate, parseEspnInjuries, parseEspnNews } from '../src/engine.mjs';
import { SourceClient, urls } from '../src/sources.mjs';

const page = document.body.dataset.page;
const query = new URLSearchParams(location.search);
let day = validDate(query.get('date')) ? query.get('date') : easternDate();
const gameId = /^\d{6,12}$/.test(query.get('id') || '') ? query.get('id') : '';
let engine = new Engine({ mode: 'browser' });
let client = new SourceClient({ timeout: 8500 });
let snapshot = null;
let hosted = false;
let stream = null;
let timers = new Set();
let booted = false;
let bootedAt = 0;
let reportsStarted = false;
let generation = 0;
let filter = 'all';
let latestInjuries = null;
let latestNews = null;
let alertIds = new Set();
const $ = id => document.getElementById(id);
const node = (tag, className = '', text = null) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = String(text);
  return element;
};
const label = { reported: 'Reported injury', questionable: 'Questionable', out: 'Out (source status)', confirmed_out: 'Will not return', returned: 'Returned to game' };
const shortTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const longTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const time = (ms, detailed = false) => ms ? (detailed ? longTime : shortTime).format(new Date(ms)) : 'Time not published';
const safeUrl = raw => { try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') ? u.href : ''; } catch { return ''; } };
const safeLogo = raw => { try { const u = new URL(raw); return u.protocol === 'https:' && u.hostname === 'a.espncdn.com' ? u.href : ''; } catch { return ''; } };
const link = (href, text, className = '') => {
  const element = node('a', className, text);
  element.href = href;
  if (/^https:/.test(href)) { element.target = '_blank'; element.rel = 'noopener noreferrer'; }
  return element;
};
const gameLink = id => `game.html?id=${encodeURIComponent(id)}&date=${day}`;
const stateText = game => game.phase === 'in' ? (game.detail || `Q${game.period} ${game.clock}`) : game.phase === 'post' ? (game.detail || 'Final') : game.phase === 'pre' ? `Tips ${time(game.start)}` : game.detail;
const matchup = game => game ? `${game.away.abbr} @ ${game.home.abbr}` : 'Game unavailable';
const byId = id => snapshot?.games.find(g => g.id === id);
const empty = (parent, text) => { parent.replaceChildren(node('p', 'empty-state', text)); };
const isCurrent = () => day === easternDate() || day === dateOffset(easternDate(), -1);
const isToday = () => day === easternDate();
const scoreboardHealth = () => snapshot?.health?.[hosted && day !== easternDate() ? 'ESPN previous-day scoreboard' : 'ESPN scoreboard'];
function schedule(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); }
function resetConnection() { generation++; timers.forEach(clearTimeout); timers.clear(); stream?.close(); stream = null; booted = false; bootedAt = 0; reportsStarted = false; hosted = false; snapshot = null; engine = new Engine({ mode: 'browser' }); client = new SourceClient({ timeout: 8500 }); latestInjuries = null; latestNews = null; alertIds = new Set(); }

function updateNavigation() {
  for (const a of document.querySelectorAll('a[href]')) {
    const target = new URL(a.getAttribute('href'), location.href);
    if (target.origin !== location.origin || !/(?:index|alerts|reviews)\.html$/.test(target.pathname)) continue;
    target.searchParams.set('date', day);
    a.href = target.href;
  }
}
function setDay(next) {
  if (!validDate(next) || next === day) return;
  day = next;
  const params = new URLSearchParams(location.search);
  params.set('date', day);
  history.replaceState(null, '', `${location.pathname}?${params}`);
  $('date-picker').value = day;
  updateNavigation();
  resetConnection();
  initConnection();
}
function initControls() {
  $('date-picker').value = day;
  $('date-picker').addEventListener('change', event => setDay(event.target.value));
  $('prev-day').addEventListener('click', () => setDay(dateOffset(day, -1)));
  $('next-day').addEventListener('click', () => setDay(dateOffset(day, 1)));
  $('today-button').addEventListener('click', () => setDay(easternDate()));
  updateNavigation();
  const filters = $(page === 'alerts' ? 'alert-filters' : 'review-filters');
  filters?.addEventListener('click', event => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    for (const el of filters.querySelectorAll('button')) {
      const active = el === button; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active));
    }
    render();
  });
  const notify = $('notify-button');
  if (notify) {
    notify.textContent = localStorage.getItem('nba-alerts-on') === '1' ? 'Alerts on ♫' : 'Enable alerts ♫';
    notify.addEventListener('click', async () => {
      const enabled = localStorage.getItem('nba-alerts-on') === '1';
      if (enabled) { localStorage.setItem('nba-alerts-on', '0'); notify.textContent = 'Enable alerts ♫'; return; }
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      localStorage.setItem('nba-alerts-on', '1'); notify.textContent = 'Alerts on ♫';
    });
  }
}

async function initConnection() {
  const version = generation;
  if (isCurrent()) {
    try {
      const response = await fetch(`/api/state?date=${day}`, { signal: AbortSignal.timeout(2200), cache: 'no-store' });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        const data = await response.json();
        if (!Array.isArray(data.games) || !Array.isArray(data.injuries)) throw new Error('Invalid API response');
        if (generation !== version) return;
        hosted = true; acceptSnapshot(data);
        connectStream(version);
        return;
      }
    } catch { /* GitHub Pages has no persistent collector: use the public CORS feeds in this tab. */ }
  }
  if (generation === version) startBrowserPolling(version);
}
function connectStream(version) {
  if (!('EventSource' in window)) return hostedPoll(version);
  stream = new EventSource('/api/stream');
  stream.addEventListener('update', () => hostedFetch(version));
  stream.onerror = () => { stream?.close(); stream = null; }; // periodic HTTP polling is already running
  // Recover if the event-stream proxy goes quiet, without multiplying clients.
  hostedPoll(version);
}
async function hostedFetch(version) {
  if (generation !== version || !hosted) return;
  try {
    const response = await fetch(`/api/state?date=${day}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok) throw new Error('Hosted collector unavailable');
    const data = await response.json();
    if (generation === version) acceptSnapshot(data);
  } catch {
    if (generation === version) { stream?.close(); stream = null; hosted = false; startBrowserPolling(version); }
  }
}
function hostedPoll(version) {
  if (generation !== version || !hosted) return;
  schedule(async () => { await hostedFetch(version); if (hosted && generation === version) hostedPoll(version); }, 20_000);
}
function acceptSnapshot(data) {
  if (snapshot && Number(data.generatedAt) < Number(snapshot.generatedAt)) return;
  snapshot = data;
  render();
  checkNotifications();
}
function browserSnapshot() { acceptSnapshot(engine.snapshot(day)); }
async function browserCall(name, url, fn, version) {
  try {
    const data = await client.json(url, url);
    if (version === generation) {
      fn(data);
      if (name === 'ESPN scoreboard') engine.source(name); // also covers selected historical dates
    }
    return version === generation ? data : null;
  } catch (error) {
    if (version === generation) { engine.source(name, error.name === 'AbortError' ? 'Timed out' : error.message); browserSnapshot(); }
    return null;
  }
}
function startBrowserPolling(version) {
  engine.mode = 'browser';
  browserScoreboard(version);
}
async function browserScoreboard(version) {
  const primary = await browserCall('ESPN scoreboard', urls.scoreboard(day), data => engine.scoreboard(day, data), version);
  if (version !== generation) return;
  browserSnapshot(); // optional CDN failures must not delay the first slate
  if (primary && !reportsStarted) {
    reportsStarted = true;
    browserDetails(version);
    browserInjuries(version);
    browserNews(version);
  }
  if (primary && isCurrent()) await browserCall('NBA official scoreboard', urls.nbaScoreboard, data => engine.nbaScoreboard(data), version);
  if (version !== generation) return;
  browserSnapshot();
  const near = engine.snapshot(day).games.some(g => g.phase === 'in' || (g.phase === 'pre' && g.start - Date.now() < 15 * 60_000));
  schedule(() => browserScoreboard(version), near || !primary ? 10_000 : 55_000);
}
async function browserDetails(version) {
  const games = engine.snapshot(day).games.filter(g => g.phase === 'in' || (g.phase === 'pre' && g.start - Date.now() < 10 * 60_000 && g.start > Date.now() - 90_000) || (g.phase === 'post' && !g.lastSummary));
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, games.length) }, async () => {
    while (index < games.length && version === generation) {
      const game = games[index++];
      await browserCall('ESPN play-by-play', urls.summary(game.id), data => {
        engine.summary(game.id, data);
        if (latestInjuries) for (const item of parseEspnInjuries(latestInjuries)) engine.accept(item);
        if (latestNews) for (const item of parseEspnNews(latestNews)) engine.accept(item);
      }, version);
      if (game.officialId) await browserCall('NBA official play-by-play', urls.nbaPbp(game.officialId), data => engine.nbaPbp(game.id, data), version);
    }
  }));
  if (version !== generation) return;
  browserSnapshot();
  schedule(() => browserDetails(version), engine.snapshot(day).games.some(g => g.phase === 'in') ? 8_000 : 23_000);
}
async function browserInjuries(version) {
  if (engine.snapshot(day).games.some(g => g.phase === 'in')) await browserCall('ESPN injuries', urls.injuries, data => { latestInjuries = data; engine.injuriesFeed(data); }, version);
  if (version !== generation) return;
  browserSnapshot();
  schedule(() => browserInjuries(version), engine.snapshot(day).games.some(g => g.phase === 'in') ? 15_000 : 40_000);
}
async function browserNews(version) {
  if (engine.snapshot(day).games.some(g => g.phase === 'in')) await browserCall('ESPN news', urls.news, data => { latestNews = data; engine.newsFeed(data); }, version);
  if (version !== generation) return;
  browserSnapshot();
  schedule(() => browserNews(version), engine.snapshot(day).games.some(g => g.phase === 'in') ? 30_000 : 70_000);
}

function chime() {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    const ctx = new Audio();
    [0, .12].forEach((offset, index) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = index ? 660 : 520;
      gain.gain.setValueAtTime(.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(.06, ctx.currentTime + offset + .02);
      gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + offset + .33);
      osc.connect(gain).connect(ctx.destination); osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + .35);
    });
    setTimeout(() => ctx.close(), 900);
  } catch { /* autoplay policies may mute sound until the user interacts */ }
}
function checkNotifications() {
  const ids = new Set(snapshot.injuries.map(u => u.id));
  const live = snapshot.games.some(g => g.phase === 'in');
  const ready = !live || !!(snapshot.health?.['ESPN injuries']?.okAt && snapshot.health?.['ESPN play-by-play']?.okAt);
  if (!booted && ready) { booted = true; bootedAt = Date.now(); alertIds = ids; return; }
  const fresh = snapshot.injuries.filter(u => !alertIds.has(u.id) && u.observedAt >= bootedAt && u.time >= bootedAt - 3000);
  if (booted && isToday() && localStorage.getItem('nba-alerts-on') === '1' && fresh.length) {
    chime();
    if ('Notification' in window && Notification.permission === 'granted') {
      const item = fresh[0];
      new Notification(`${item.player} · ${label[item.status] || 'Injury update'}`, { body: `${item.team} · ${item.text}`, tag: `nba-injury-${item.id}` });
    }
  }
  alertIds = ids;
}
function renderHealth() {
  const panel = $('health-panel'), mode = $('mode-label');
  if (!snapshot) return;
  const live = snapshot.games.some(g => g.phase === 'in');
  const scoreboard = scoreboardHealth();
  const injuries = snapshot.health?.['ESPN injuries'];
  const pbp = snapshot.health?.['ESPN play-by-play'];
  const recent = field => !!(field?.okAt && !field.error && Date.now() - field.okAt < (live ? 65_000 : 120_000));
  const storage = snapshot.health?.['Local event storage'];
  const nbaNews = snapshot.health?.['NBA.com news index'];
  const nbaArticles = snapshot.health?.['NBA.com articles'];
  const nbaNewsHealthy = !!(nbaNews?.okAt && !nbaNews.error && Date.now() - nbaNews.okAt < 150_000);
  const failed = !recent(scoreboard) || (live && (!recent(injuries) || !recent(pbp))) ||
    (hosted && !!storage?.error) || (hosted && live && (!nbaNewsHealthy || !!nbaArticles?.error));
  const issues = [];
  if (!recent(scoreboard)) issues.push(`Scoreboard: ${scoreboard?.error || 'not yet verified'}`);
  if (live && !recent(injuries)) issues.push(`Injuries: ${injuries?.error || 'not yet verified'}`);
  if (live && !recent(pbp)) issues.push(`Play-by-play: ${pbp?.error || 'not yet verified'}`);
  if (hosted && storage?.error) issues.push(`Event storage: ${storage.error}`);
  if (hosted && live && !nbaNewsHealthy) issues.push(`NBA.com news: ${nbaNews?.error || 'not yet verified'}`);
  if (hosted && live && nbaArticles?.error) issues.push(`NBA.com article: ${nbaArticles.error}`);
  const official = snapshot.health?.['NBA official play-by-play'];
  if (live && official?.error && recent(pbp)) issues.push('NBA official PBP unavailable; ESPN fallback');
  mode.textContent = hosted ? 'Hosted collector · continuous polling' : 'Browser polling · only while open';
  mode.className = `connection ${failed ? 'bad' : 'good'}`;
  if (failed) {
    panel.className = 'health-panel bad';
    panel.textContent = `⚠ Source coverage degraded — ${issues.join(' · ')}. No missing update should be interpreted as “no injury.”`;
  } else if (!live) {
    panel.className = 'health-panel warn';
    panel.textContent = `No games currently in progress on this slate. In-game injury monitoring is idle; scheduled and final games still appear. ${hosted ? 'Hosted collector remains online.' : 'Browser polling stops when this page closes.'}`;
  } else {
    panel.className = 'health-panel good';
    // Report real per-player coverage; a partial sweep must not read as full monitoring.
    const playerNews = snapshot.health?.['ESPN player news'];
    const coverage = hosted && live && Number(playerNews?.participants)
      ? ` Player-news sweep reached ${playerNews.polledDistinct || 0} of ${playerNews.participants} players on the floor — it supplements the structured injury feed, it does not replace it.` : '';
    panel.textContent = `● ESPN scoreboard, play-by-play and injury feed recently reached. ${issues.join('. ') || 'Source-linked updates only; coverage is not guaranteed.'}${coverage}`;
  }
  const last = Math.max(scoreboard?.okAt || 0, injuries?.okAt || 0, pbp?.okAt || 0);
  if ($('footer-update')) $('footer-update').textContent = last ? `Latest successful source poll ${time(last, true)}` : 'Waiting for a successful source poll';
}
function render() {
  if (!snapshot) return;
  renderHealth();
  if (page === 'home') renderHome();
  if (page === 'alerts') renderAlerts();
  if (page === 'reviews') renderReviews();
  if (page === 'game') renderGame();
}
function teamRow(team, phase) {
  const row = node('div', 'team-row');
  const logo = safeLogo(team.logo);
  if (logo) { const img = node('img', 'team-logo'); img.src = logo; img.alt = ''; img.loading = 'lazy'; row.append(img); }
  else row.append(node('span', 'team-fallback', team.abbr.slice(0, 1)));
  row.append(node('strong', '', team.abbr), node('span', 'team-name', team.name), node('span', 'team-score', phase === 'pre' ? '—' : (team.score || '—')));
  return row;
}
function gameCard(game) {
  const card = link(gameLink(game.id), ``, `game-card ${game.phase === 'in' ? 'live' : ''}`);
  card.setAttribute('aria-label', `${game.away.name} at ${game.home.name}. ${stateText(game)}. Open game center.`);
  const top = node('div', 'game-top'); top.append(node('span', '', time(game.start)), node('span', 'game-state', stateText(game)));
  const matchupEl = node('div', 'game-matchup'); matchupEl.append(teamRow(game.away, game.phase), teamRow(game.home, game.phase));
  const bottom = node('div', 'game-bottom'), badge = node('span', 'game-badges');
  const injuryCount = new Set(snapshot.injuries.filter(i => i.gameId === game.id).map(i => i.athleteId)).size;
  const reviewCount = snapshot.reviews.filter(r => r.gameId === game.id).length;
  if (injuryCount) badge.append(node('span', 'mini-badge injury', `${injuryCount} INJURY`));
  if (reviewCount) badge.append(node('span', 'mini-badge review', `${reviewCount} REVIEW`));
  bottom.append(node('span', '', game.phase === 'in' && game.clock ? `Q${game.period} · ${game.clock}` : 'GAME CENTER ↗'), badge);
  card.append(top, matchupEl, bottom); return card;
}
function miniEntries(container, entries, type) {
  if (!container) return;
  container.replaceChildren();
  if (!entries.length) { container.textContent = type === 'injury' ? 'No source-linked in-game injuries yet. This does not prove there are none.' : 'No reviews in the available play-by-play yet.'; return; }
  for (const entry of entries.slice(0, 3)) {
    const row = node('div', 'mini-entry');
    const text = type === 'injury' ? `${entry.player} · ${label[entry.status] || entry.status}` : `${entry.type === 'challenge' ? 'Coach’s challenge' : 'Replay review'} · ${entry.outcome || 'outcome unknown'}`;
    row.append(node('strong', '', text), node('span', '', matchup(byId(entry.gameId)))); container.append(row);
  }
}
function feedRow(entry) {
  const injury = entry.kind === 'injury';
  const item = node('article', `feed-item ${injury ? 'injury' : ''}`);
  item.append(node('span', 'feed-mark', injury ? '✳' : '↗'));
  const body = node('div', 'feed-body'), meta = node('div', 'feed-meta');
  meta.append(node('strong', '', matchup(byId(entry.gameId))), node('span', '', injury ? (label[entry.status] || 'Injury report') : `Q${entry.period || '—'} · ${entry.clock || 'Clock unknown'}`), node('span', '', time(entry.time)));
  body.append(meta, node('p', '', injury ? `${entry.player} — ${entry.text}` : entry.text));
  const source = injury ? entry.evidence?.at(-1) : entry;
  const href = safeUrl(source?.url || source?.sourceUrl);
  if (href) body.append(link(href, source.source || 'Source ↗'));
  item.append(body);
  if (!injury && entry.homeScore && entry.awayScore) item.append(node('span', 'feed-score', `${entry.awayScore} – ${entry.homeScore}`));
  return item;
}
function renderHome() {
  const live = snapshot.games.filter(g => g.phase === 'in').length;
  $('stat-games').textContent = scoreboardHealth()?.okAt ? snapshot.games.length : '—';
  $('stat-live').textContent = live;
  $('stat-injuries').textContent = snapshot.injuries.length || (snapshot.health?.['ESPN injuries']?.okAt && !snapshot.health?.['ESPN injuries']?.error) ? new Set(snapshot.injuries.map(i => `${i.gameId}:${i.athleteId}`)).size : '—';
  $('stat-reviews').textContent = snapshot.reviews.length;
  $('game-summary').textContent = `${snapshot.games.length} GAMES · ${live} LIVE`;
  const grid = $('games-grid'); grid.replaceChildren();
  if (!snapshot.games.length) empty(grid, scoreboardHealth()?.okAt && !scoreboardHealth()?.error ? 'No NBA games scheduled for this date.' : 'Could not verify the schedule. Check source status above.');
  else snapshot.games.forEach(game => grid.append(gameCard(game)));
  miniEntries($('alerts-mini'), snapshot.injuries, 'injury');
  miniEntries($('reviews-mini'), snapshot.reviews, 'review');
  const feed = $('live-feed'); feed.replaceChildren();
  $('feed-summary').textContent = `${snapshot.feed.length} RECENT ITEMS`;
  if (!snapshot.feed.length) empty(feed, live ? 'Waiting for the first source-linked play or injury update.' : 'No live play-by-play yet.');
  else snapshot.feed.slice(0, 65).forEach(item => feed.append(feedRow(item)));
}
function evidenceRows(container, evidence) {
  for (const proof of evidence) {
    const el = node('div', 'evidence');
    const href = safeUrl(proof.url);
    if (href) el.append(link(href, `${proof.source} ↗`));
    else el.append(node('span', '', proof.source));
    el.append(node('span', '', ` · published ${time(proof.publishedAt, true)}`));
    container.append(el);
  }
}
function injuryCard(update) {
  const card = node('article', 'alert-card injury'), side = node('div', 'alert-aside'), body = node('div', 'alert-body');
  side.append(node('strong', '', update.team), node('span', '', time(update.time, true)));
  body.append(node('span', `status-pill ${update.status}`, label[update.status] || 'Injury update'), node('h3', '', update.player), node('span', 'team-caption', matchup(byId(update.gameId))));
  body.append(node('p', '', update.text));
  evidenceRows(body, update.evidence || []);
  body.append(node('div', 'proof', `Participation: ${update.proof || 'Not independently confirmed'} · Observed ${time(update.observedAt, true)} · `));
  body.lastChild.append(link(gameLink(update.gameId), 'Game center ↗'));
  card.append(side, body); return card;
}
function renderAlerts() {
  $('injury-count').textContent = `${snapshot.injuries.length} SOURCE-LINKED UPDATES`;
  const list = snapshot.injuries.filter(item => filter === 'all' || item.status === filter);
  $('alerts-summary').textContent = `${list.length} MATCHING UPDATES`;
  const target = $('alerts-feed'); target.replaceChildren();
  if (!list.length) empty(target, snapshot.games.some(g => g.phase === 'in') ? 'No matching source-linked updates detected. This does not prove nobody is injured; check source status above.' : 'No in-progress games or matching in-game reports on this date. Pregame injuries are intentionally excluded.');
  else list.forEach(item => target.append(injuryCard(item)));
}
function reviewCard(review) {
  const card = node('article', 'alert-card review-card'), side = node('div', 'alert-aside'), body = node('div', 'alert-body');
  side.append(node('strong', '', `Q${review.period || '—'} · ${review.clock || '—'}`), node('span', '', time(review.time, true)));
  body.append(node('span', `status-pill ${review.outcome || 'review'}`, review.outcome === 'overturned' ? 'Overturned (stated)' : review.outcome === 'stands' ? 'Stands (stated)' : review.outcome === 'conflict' ? 'Conflicting source rulings' : 'Outcome not stated'));
  body.append(node('h3', '', review.type === 'challenge' ? 'Coach’s challenge' : 'Replay review'));
  body.append(node('span', 'team-caption', `${matchup(byId(review.gameId))} · Challenging team not specified unless in source text`));
  body.append(node('p', '', review.text));
  const entries = (review.evidence || []).slice(-3);
  evidenceRows(body, entries.map(e => ({ ...e, publishedAt: review.time })));
  if (review.outcome === 'conflict') {
    body.append(node('div', 'proof', 'Sources disagree. Check each original play-by-play entry before trusting a ruling.'));
    for (const entry of entries) body.append(node('div', 'source-quote', `${entry.source}: ${entry.text}`));
  }
  body.append(node('div', 'proof', 'Ruling and score impact are not inferred · '));
  body.lastChild.append(link(gameLink(review.gameId), 'Game center ↗'));
  card.append(side, body); return card;
}
function renderReviews() {
  $('review-count').textContent = `${snapshot.reviews.length} SOURCE-LINKED REVIEWS`;
  $('metric-challenges').textContent = snapshot.reviews.filter(r => r.type === 'challenge').length;
  $('metric-official').textContent = snapshot.reviews.filter(r => r.type !== 'challenge').length;
  $('metric-pending').textContent = snapshot.reviews.filter(r => !r.outcome).length;
  $('metric-overturned').textContent = snapshot.reviews.filter(r => r.outcome === 'overturned').length;
  const list = snapshot.reviews.filter(item => filter === 'all' || item.type === filter || (filter === 'pending' && !item.outcome) || item.outcome === filter);
  $('reviews-summary').textContent = `${list.length} MATCHING REVIEWS`;
  const target = $('reviews-feed'); target.replaceChildren();
  if (!list.length) empty(target, 'No explicit replay or coach’s challenge events found for this filter in available play-by-play. Missing events are possible.');
  else list.forEach(item => target.append(reviewCard(item)));
}
function renderGame() {
  const game = byId(gameId), header = $('game-header'); header.replaceChildren();
  if (!game) { empty(header, gameId ? 'Game not found on this date. Return to the scoreboard and choose a game.' : 'Select a game from the scoreboard.'); empty($('game-plays'), 'No game selected.'); return; }
  document.title = `${matchup(game)} | NBA Courtside`;
  const top = node('div', 'game-hero-top'); top.append(node('span', '', `${time(game.start, true)} · ${game.phase === 'in' ? 'LIVE' : game.phase === 'post' ? 'FINAL' : 'SCHEDULED'}`), node('span', game.phase === 'in' ? 'live-now' : '', stateText(game)));
  const scores = node('div', 'game-hero-score');
  for (const [team, cls] of [[game.away, 'away'], [game.home, 'home']]) {
    const div = node('div', `game-hero-team ${cls}`), logo = safeLogo(team.logo);
    if (logo) { const img = node('img'); img.src = logo; img.alt = ''; div.append(img); }
    const name = node('div'); name.append(node('strong', '', team.abbr), node('small', '', team.name));
    div.append(name, node('span', 'big-score', game.phase === 'pre' ? '—' : (team.score || '—')));
    if (cls === 'away') scores.append(div, node('span', 'versus', 'VS'));
    else scores.append(div);
  }
  header.append(top, scores);
  const plays = snapshot.feed.filter(item => item.kind === 'play' && item.gameId === game.id);
  const playList = $('game-plays'); playList.replaceChildren();
  if (!plays.length) empty(playList, 'No play-by-play available for this game yet.');
  else plays.slice(0, 100).forEach(play => playList.append(feedRow(play)));
  miniEntries($('game-injuries'), snapshot.injuries.filter(item => item.gameId === game.id), 'injury');
  miniEntries($('game-reviews'), snapshot.reviews.filter(item => item.gameId === game.id), 'review');
}

initControls();
initConnection();
