// One data model for the hosted collector and the static, in-browser fallback.
// No inferred diagnoses, participation, challenge outcomes, or game-specific availability.
export const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba';
export const NBA = 'https://cdn.nba.com/static/json/liveData';

const DAY = 86_400_000;
const asArray = value => Array.isArray(value) ? value : [];
const str = value => value == null ? '' : String(value);
const dateMs = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : 0; };
const compact = value => str(value).replace(/\s+/g, ' ').trim();
const safeId = value => /^\d{6,12}$/.test(str(value)) ? str(value) : '';
const plainName = value => compact(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/gi, '').toLowerCase();
const gameUrl = id => `https://www.espn.com/nba/game/_/gameId/${id}`;
const injuryListUrl = 'https://www.espn.com/nba/injuries';
const hasMedicalDetail = value => /\b(injur\w*|illness|concussion|protocol|pain|sore\w*|strain|sprain|bruise|contusion|fracture|tear|torn|swelling|tightness|surgery|ankle|knee|foot|hamstring|calf|hip|groin|back|shoulder|wrist|hand|elbow|neck|quad|achilles|head|finger|thumb|toe|rib|abdominal|oblique|migrain\w*|cramp\w*|dizz\w*|limp\w*)\b/i.test(str(value));
const explicitlyFuture = value => /\b(next game|tomorrow|upcoming game|(?:on|for|out|questionable|doubtful) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:'s)?(?: game)?)\b/i.test(str(value)) && !/\b(to return|remainder|tonight|this game)\b/i.test(str(value));

export function easternDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function dateOffset(day, delta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid date');
  return new Date(Date.parse(`${day}T12:00:00Z`) + delta * DAY).toISOString().slice(0, 10);
}
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str(value)) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

export function parseScoreboard(data, day) {
  if (!validDate(day) || !Array.isArray(data?.events)) throw new Error('Invalid ESPN scoreboard response');
  return data.events.flatMap(event => {
    const id = safeId(event?.id);
    const competition = event?.competitions?.[0];
    const home = competition?.competitors?.find(c => c.homeAway === 'home');
    const away = competition?.competitors?.find(c => c.homeAway === 'away');
    const start = dateMs(event?.date);
    if (!id || !home?.team?.id || !away?.team?.id || !start || home.team.id === away.team.id) return [];
    const team = c => ({ id: str(c.team.id), abbr: str(c.team.abbreviation), name: str(c.team.displayName || c.team.name), score: str(c.score ?? ''), logo: str(c.team.logo || '') });
    const status = event.status?.type || {};
    const phase = ['pre', 'in', 'post'].includes(status.state) ? status.state : 'unknown';
    return [{ id, day, start, home: team(home), away: team(away), phase,
      detail: compact(status.shortDetail || status.detail || status.description || (phase === 'pre' ? 'Scheduled' : 'Status unknown')),
      period: Number(event.status?.period) || 0, clock: str(event.status?.displayClock || ''),
      sourceUrl: gameUrl(id), officialId: '', participants: {}, espnPlays: [], nbaPlays: [], lastSummary: 0 }];
  });
}

function playedMinutes(raw) {
  if (typeof raw === 'number') return raw > 0;
  const text = str(raw).trim();
  // ESPN sends "23", "0:14", or "--". A DNP or roster entry is NOT participation.
  return /^\d+(?::\d{1,2})?$/.test(text) && (Number(text.split(':')[0]) > 0 || Number(text.split(':')[1] || 0) > 0);
}

function addParticipant(game, athlete, teamId, proof) {
  const id = safeId(athlete?.id);
  if (!id || ![game.home.id, game.away.id].includes(str(teamId)) || !compact(athlete.displayName)) return;
  const existing = game.participants[id];
  game.participants[id] = { id, name: compact(athlete.displayName), teamId: str(teamId),
    proof: existing?.proof === 'ESPN box score: minutes played' ? existing.proof : proof };
}

function espnPlays(game, data) {
  const roster = new Map();
  for (const group of asArray(data.boxscore?.players)) {
    const teamId = str(group.team?.id);
    if (![game.home.id, game.away.id].includes(teamId)) continue;
    for (const set of asArray(group.statistics)) {
      const minuteIndex = asArray(set.keys).indexOf('minutes');
      for (const row of asArray(set.athletes)) {
        const id = safeId(row.athlete?.id);
        if (id) roster.set(id, { athlete: row.athlete, teamId });
        if (row.didNotPlay === false && minuteIndex >= 0 && playedMinutes(row.stats?.[minuteIndex])) {
          addParticipant(game, row.athlete, teamId, 'ESPN box score: minutes played');
        }
      }
    }
  }
  const plays = asArray(data.plays);
  const opening = plays.find(play => Number(play.period?.number) === 1 &&
    !/\b(timeout|review|challenge|injury|start|end of)\b/i.test(str(play.type?.text)) &&
    dateMs(play.wallclock) >= game.start - 10 * 60_000 && dateMs(play.wallclock) < game.start + 2 * 3_600_000);
  if (opening) game.liveStartedAt = dateMs(opening.wallclock);
  for (const play of plays) {
    // An athlete on a roster/timeout/review isn't necessarily a player who checked in.
    if (/\b(timeout|review|challenge|injury|start|end of|eject)\b/i.test(str(play.type?.text)) || !play.type?.text) continue;
    const teamId = str(play.team?.id);
    for (const participant of asArray(play.participants)) {
      const entry = roster.get(str(participant.athlete?.id));
      if (entry && (!teamId || entry.teamId === teamId)) addParticipant(game, entry.athlete, entry.teamId, 'ESPN play-by-play: recorded action');
    }
  }
  return plays.slice(-160).flatMap(play => {
    if (!play?.id || !compact(play.text)) return [];
    return [{ id: `espn:${game.id}:${play.id}`, kind: 'play', gameId: game.id,
      time: dateMs(play.wallclock) || 0, period: Number(play.period?.number) || 0,
      clock: str(play.clock?.displayValue), text: compact(play.text),
      source: 'ESPN play-by-play', sourceUrl: game.sourceUrl,
      homeScore: str(play.homeScore ?? ''), awayScore: str(play.awayScore ?? ''),
      teamId: str(play.team?.id) }];
  });
}

function normalizedClock(value) {
  const text = str(value);
  const nba = /^PT(?:(\d+)M)?(\d+(?:\.\d+)?)S$/.exec(text);
  if (nba) return `${nba[1] || '0'}:${str(Math.floor(Number(nba[2]))).padStart(2, '0')}`;
  return /^\d{1,2}:\d{2}$/.test(text) ? text : '';
}

export function reviewSignal(text) {
  const description = compact(text);
  const challenged = /\b(coach(?:'|’)?s? challenge|challeng(?:e|ed|ing)(?: the)? (?:call|ruling|play)|challenge (?:is |was )?(?:successful|unsuccessful))\b/i.test(description);
  const reviewed = /\b(instant replay|replay review|video review|official(?:s)? review|referee(?:s)? review|under review|reviewing (?:the )?play|(?:call|play|ruling) (?:is |was )?being reviewed)\b/i.test(description);
  const result = /\b(unsuccessful|challenge failed|call stands|ruling stands|call upheld|ruling upheld|call confirmed)\b/i.test(description) ? 'stands'
    : /\b(overturned|call reversed|ruling reversed|successful challenge|challenge successful)\b/i.test(description) ? 'overturned' : '';
  return { found: challenged || reviewed, type: challenged ? 'challenge' : 'review', result };
}

function ingestReviews(engine, game, plays) {
  for (const play of plays) {
    const signal = reviewSignal(play.text);
    const clock = normalizedClock(play.clock);
    const period = play.period;
    const key = period && clock ? `${game.id}:q${period}:${clock}` : `${game.id}:${play.id}`;
    const existing = engine.reviews.get(key);
    if (!signal.found && !(existing && signal.result)) continue;
    // Same clock can have multiple unrelated plays; never infer the challenging team or an outcome.
    if (!existing && !signal.found) continue;
    const sourceKey = play.id;
    if (existing?.evidence?.some(e => e.key === sourceKey)) continue;
    const review = existing || { id: key, gameId: game.id, kind: 'review', type: signal.type,
      outcome: '', period, clock, time: play.time || engine.now(), evidence: [], firstObserved: engine.now() };
    if (signal.type === 'challenge' && signal.found) review.type = 'challenge';
    const was = review.outcome;
    if (signal.result) review.outcome = review.outcome && review.outcome !== signal.result ? 'conflict' : signal.result;
    review.evidence.push({ key: sourceKey, text: play.text, url: play.sourceUrl, source: play.source, result: signal.result });
    if (signal.result || !was) { review.text = play.text; review.sourceUrl = play.sourceUrl; review.source = play.source; }
    review.lastEventTime = Math.max(review.lastEventTime || 0, play.time || 0);
    review.updatedAt = engine.now();
    engine.reviews.set(key, review);
    if (!existing || was !== review.outcome) engine.changed.push({ id: `${key}:${review.outcome || 'started'}`, kind: 'review', gameId: game.id });
  }
}

export function classifyReport(value) {
  const text = compact(value);
  if (!text || explicitlyFuture(text)) return '';
  if (/\b(will not return|won't return|not returning to (?:the|tonight's) game|ruled out for (?:the )?(?:rest|remainder)|out for (?:the )?(?:rest|remainder) of (?:the|tonight's) game)\b/i.test(text)) return 'confirmed_out';
  if (/\b(questionable to return|return (?:is |was )?questionable|doubtful to return)\b/i.test(text)) return 'questionable';
  if (/\b(ruled out|will miss (?:the )?remainder of (?:the|tonight's) game)\b/i.test(text) && hasMedicalDetail(text)) return 'out';
  if (/\b(returned to (?:the )?game|back in (?:the )?game)\b/i.test(text) && hasMedicalDetail(text)) return 'returned';
  if (hasMedicalDetail(text) && /\b(suffer\w*|sustain\w*|injur\w*|hurt|exits?|leaves?|left|limps?|helped off|went down|was shaken up)\b/i.test(text)) return 'reported';
  return '';
}

export function parseEspnInjuries(data) {
  if (!Array.isArray(data?.injuries)) throw new Error('Invalid ESPN injuries response');
  return data.injuries.flatMap(group => asArray(group.injuries).flatMap(row => {
    const athleteId = safeId(row?.athlete?.id);
    const teamId = str(group.id || row?.athlete?.team?.id);
    // A mismatch can reflect a trade/incorrect roster; it cannot prove this game's team.
    if (row?.athlete?.team?.id && str(row.athlete.team.id) !== teamId) return [];
    const short = compact(row?.shortComment), long = compact(row?.longComment);
    if (/\b(personal reasons|suspension|coach's decision|g league|rest day|not with (?:the )?team)\b/i.test(short) && !hasMedicalDetail(short)) return [];
    const text = short && !hasMedicalDetail(short) && hasMedicalDetail(long) ? `${short} — ${long.slice(0, 350)}` : short || long;
    const publishedAt = dateMs(row?.date);
    if (!athleteId || !teamId || !text || !publishedAt || !hasMedicalDetail(text)) return [];
    if (explicitlyFuture(text)) return [];
    if (/^(available|active)$/i.test(str(row.status)) && !/\b(returned to (?:the )?game|cleared to return to (?:the )?game)\b/i.test(text)) return [];
    const status = /\b(will not return|won't return|remainder of the game)\b/i.test(text) ? 'confirmed_out'
      : /\bquestionable to return\b/i.test(text) ? 'questionable'
      : /\b(returned to (?:the )?game|cleared to return to (?:the )?game)\b/i.test(text) ? 'returned'
      : ({ out: 'out', questionable: 'questionable', doubtful: 'questionable', 'day-to-day': 'reported', probable: 'reported' })[str(row.status).toLowerCase()] || 'reported';
    const url = asArray(row.athlete.links).find(link => link.rel?.includes('news') && /^https:\/\/www\.espn\.com\/nba\//.test(link.href))?.href || injuryListUrl;
    return [{ athleteId, teamId, name: compact(row.athlete.displayName), status, text,
      publishedAt, source: 'ESPN injury report', sourceUrl: url, sourceKey: `espn-injury:${athleteId}:${row.date}:${row.status}:${text}` }];
  }));
}

export function parseEspnNews(data) {
  if (!Array.isArray(data?.articles)) throw new Error('Invalid ESPN news response');
  return data.articles.flatMap(article => {
    const headline = compact(article?.headline);
    // A routine headline can tag the athlete while its description mentions an OLD injury.
    // Require an injury/availability signal in the headline itself before considering details.
    if (!/\b(injur\w*|illness|concussion|sore\w*|sprain|strain|fracture|tear|torn|pain|limp\w*|hurt|exits?|leaves?|left|ruled out|questionable to return|will not return|won't return|out for the game)\b/i.test(headline)) return [];
    const text = compact([headline, article?.description].filter(Boolean).join(' — '));
    const status = classifyReport(text);
    const publishedAt = dateMs(article?.published); // Never use lastModified on rolling articles.
    const url = str(article?.links?.web?.href);
    if (!status || !publishedAt || !/^https:\/\/www\.espn\.com\/nba\/story\//.test(url) || !headline) return [];
    const title = ` ${plainName(headline)} `;
    const named = asArray(article.categories).filter(c => c.type === 'athlete' && safeId(c.athleteId) &&
      plainName(c.description) && title.includes(` ${plainName(c.description)} `));
    // A multi-player headline cannot safely assign a designation to either player.
    if (named.length !== 1) return [];
    const c = named[0];
    const afterName = title.slice(title.indexOf(` ${plainName(c.description)} `) + plainName(c.description).length + 2);
    if (!/\b(injur\w*|illness|concussion|sore\w*|sprain|strain|fracture|tear|torn|pain|hurt|exits?|leaves?|left|ruled out|questionable|will not return|wont return|out)\b/i.test(afterName)) return [];
    return [{ athleteId: str(c.athleteId), teamId: '', name: compact(c.description), status,
      text, publishedAt, source: `ESPN news${article.byline ? ` · ${compact(article.byline)}` : ''}`,
      sourceUrl: url, sourceKey: `espn-news:${article.id}:${c.athleteId}:${headline}` }];
  });
}

function candidateForGame(engine, candidate, requestedGameId = '') {
  const now = engine.now();
  if (!candidate?.publishedAt || candidate.publishedAt > now + 120_000 || now - candidate.publishedAt > DAY) return null;
  const games = requestedGameId ? [engine.games.get(requestedGameId)] : [...engine.games.values()];
  for (const game of games) {
    if (!game || game.phase !== 'in' || !Number.isFinite(game.lastScoreboardAt) || now - game.lastScoreboardAt > 90_000 ||
      candidate.publishedAt < Math.max(game.start, game.liveStartedAt || 0) ||
      ![game.away.id, game.home.id].some(id => !candidate.teamId || id === candidate.teamId)) continue;
    const player = candidate.athleteId ? game.participants[candidate.athleteId] :
      Object.values(game.participants).find(p => plainName(p.name) === plainName(candidate.name));
    if (!player || (candidate.teamId && player.teamId !== candidate.teamId)) continue;
    return { game, player };
  }
  return null;
}

export class Engine {
  constructor({ now = () => Date.now(), saved = null, mode = 'live' } = {}) {
    this.now = now;
    this.mode = mode;
    this.games = new Map(asArray(saved?.games).map(g => [g.id, g]));
    this.injuries = new Map(asArray(saved?.injuries).map(i => [i.id, i]));
    this.reviews = new Map(asArray(saved?.reviews).map(r => [r.id, r]));
    this.seen = new Set(asArray(saved?.seen));
    this.health = saved?.health || {};
    this.changed = [];
  }
  source(name, error = null) {
    this.health[name] = { ...this.health[name], checkedAt: this.now(),
      ...(error ? { error: compact(error) } : { okAt: this.now(), error: '' }) };
  }
  scoreboard(day, data) {
    const incoming = parseScoreboard(data, day);
    const ids = new Set(incoming.map(g => g.id));
    const activeMissing = [...this.games.values()].some(g => g.day === day && g.phase === 'in' &&
      !ids.has(g.id) && this.now() - g.start < 6 * 3_600_000);
    if (activeMissing) throw new Error('Scoreboard omitted an ongoing game; retaining last known slate');
    for (const [id, existing] of this.games) if (existing.day === day && !ids.has(id)) this.games.delete(id);
    for (const game of incoming) {
      game.lastScoreboardAt = this.now();
      const old = this.games.get(game.id);
      if (old) Object.assign(old, { ...game, officialId: old.officialId, participants: old.participants,
        espnPlays: old.espnPlays, nbaPlays: old.nbaPlays, lastSummary: old.lastSummary });
      else this.games.set(game.id, game);
    }
    this.source(day === easternDate(new Date(this.now())) ? 'ESPN scoreboard' : 'ESPN previous-day scoreboard');
  }
  summary(id, data) {
    const game = this.games.get(id);
    if (!game || (data.header?.id && str(data.header.id) !== id) ||
      (!Array.isArray(data?.plays) && !Array.isArray(data?.boxscore?.players))) throw new Error('Invalid ESPN summary/game ID');
    const parsed = espnPlays(game, data);
    game.espnPlays = parsed;
    game.lastSummary = this.now();
    ingestReviews(this, game, parsed);
    this.source('ESPN box score');
    if (Array.isArray(data.plays)) this.source('ESPN play-by-play');
    else this.source('ESPN play-by-play', 'Summary has no play-by-play yet');
  }
  nbaScoreboard(data) {
    if (!Array.isArray(data?.scoreboard?.games)) throw new Error('Invalid NBA scoreboard response');
    for (const entry of data.scoreboard.games) {
      const id = str(entry.gameId);
      if (!/^\d{10}$/.test(id)) continue;
      const candidates = [...this.games.values()].filter(game => game.away.abbr === entry.awayTeam?.teamTricode && game.home.abbr === entry.homeTeam?.teamTricode && Math.abs(game.start - dateMs(entry.gameTimeUTC)) < 3 * 3_600_000);
      if (candidates.length === 1) candidates[0].officialId = id;
    }
    this.source('NBA official scoreboard');
  }
  nbaPbp(id, data) {
    const game = this.games.get(id);
    if (!game?.officialId || str(data?.game?.gameId) !== game.officialId || !Array.isArray(data.game.actions)) throw new Error('Invalid NBA play-by-play/game ID');
    game.nbaPlays = data.game.actions.slice(-160).flatMap(action => {
      if (!Number.isInteger(Number(action.actionNumber)) || !compact(action.description)) return [];
      return [{ id: `nba:${game.officialId}:${action.actionNumber}`, kind: 'play', gameId: game.id,
        time: dateMs(action.timeActual) || 0, period: Number(action.period) || 0,
        clock: normalizedClock(action.clock), text: compact(action.description),
        source: 'NBA official play-by-play', sourceUrl: `${NBA}/playbyplay/playbyplay_${game.officialId}.json`,
        homeScore: str(action.scoreHome ?? ''), awayScore: str(action.scoreAway ?? ''), teamId: str(action.teamId || '') }];
    });
    ingestReviews(this, game, game.nbaPlays);
    this.source('NBA official play-by-play');
  }
  accept(candidate, requestedGameId = '') {
    if (!candidate?.sourceKey || this.seen.has(candidate.sourceKey)) return false;
    const match = candidateForGame(this, candidate, requestedGameId);
    if (!match) return false; // retry on next poll if the box score hasn't confirmed participation yet
    const { game, player } = match;
    const id = `${game.id}:${player.id}`;
    const incident = this.injuries.get(id) || { id, gameId: game.id, athleteId: player.id,
      player: player.name, teamId: player.teamId, proof: player.proof, updates: [] };
    const evidence = { key: candidate.sourceKey, source: candidate.source, url: candidate.sourceUrl,
      text: candidate.text, publishedAt: candidate.publishedAt };
    const current = incident.updates.at(-1);
    // A late arriving older source can corroborate, but cannot reverse a newer designation.
    const priority = { reported: 0, questionable: 1, out: 2, confirmed_out: 3, returned: 4 };
    const downgrade = current && priority[candidate.status] < priority[current.status];
    const explicitChange = /\b(correction|retract\w*|upgraded|now (?:available|questionable)|questionable to return|returned to (?:the )?game|left (?:the )?game again|new injury)\b/i.test(candidate.text);
    if (current && candidate.publishedAt < current.time && candidate.status !== current.status) {
      const previous = incident.updates.findLast(u => u.status === candidate.status && u.time <= candidate.publishedAt);
      if (previous) previous.evidence.push(evidence);
    } else if (current && (current.status === candidate.status || (downgrade && !explicitChange))) {
      // A second publisher repeating a less specific status is corroboration, not a new alert.
      current.evidence.push(evidence);
    } else {
      const update = { id: `${id}:${incident.updates.length + 1}`, kind: 'injury', gameId: game.id,
        athleteId: player.id, player: player.name, team: player.teamId === game.home.id ? game.home.abbr : game.away.abbr,
        status: candidate.status, text: candidate.text, time: candidate.publishedAt,
        observedAt: this.now(), proof: player.proof, evidence: [evidence] };
      incident.updates.push(update);
      this.changed.push({ id: update.id, kind: 'injury', gameId: game.id });
    }
    this.injuries.set(id, incident);
    this.seen.add(candidate.sourceKey);
    return true;
  }
  injuriesFeed(data) {
    const items = parseEspnInjuries(data);
    for (const item of items) this.accept(item);
    this.source('ESPN injuries');
  }
  newsFeed(data) {
    const items = parseEspnNews(data);
    for (const item of items) this.accept(item);
    this.source('ESPN news');
  }
  curated(candidate) {
    const game = this.games.get(str(candidate.gameId));
    const player = game?.participants?.[str(candidate.athleteId)];
    const wording = compact(candidate.text);
    const normalized = ` ${plainName(wording)} `;
    const statusEvidence = {
      reported: hasMedicalDetail(wording),
      questionable: /\bquestionable\b/i.test(wording) && hasMedicalDetail(wording),
      out: /\b(ruled out|out)\b/i.test(wording) && hasMedicalDetail(wording),
      confirmed_out: /\b(will not return|won't return|out for (?:the )?(?:rest|remainder) of (?:the )?game)\b/i.test(wording),
      returned: /\b(returned to (?:the )?game|cleared to return to (?:the )?game)\b/i.test(wording)
    };
    if (!game || !safeId(candidate.athleteId) || !player || !statusEvidence[candidate.status] ||
      !normalized.includes(` ${plainName(player.name)} `)) return false;
    return this.accept({ ...candidate, sourceKey: `curated:${candidate.sourceUrl}:${candidate.publishedAt}:${candidate.athleteId}:${candidate.status}` }, game.id);
  }
  plays(game) {
    const nba = game.nbaPlays || [];
    const espn = game.espnPlays || [];
    const official = nba.at(-1)?.time || 0;
    const alternate = espn.at(-1)?.time || 0;
    return nba.length && (!espn.length || official >= alternate - 20_000) ? nba : espn;
  }
  snapshot(day = easternDate(new Date(this.now()))) {
    const games = [...this.games.values()].filter(g => g.day === day).sort((a, b) => a.start - b.start);
    const ids = new Set(games.map(g => g.id));
    const injuries = [...this.injuries.values()].filter(i => ids.has(i.gameId)).flatMap(i => i.updates);
    const reviews = [...this.reviews.values()].filter(r => ids.has(r.gameId));
    const plays = games.flatMap(g => this.plays(g).slice(-65));
    const newest = (a, b) => (b.time || b.updatedAt || 0) - (a.time || a.updatedAt || 0);
    return { mode: this.mode, day, generatedAt: this.now(), games, injuries: injuries.sort(newest).slice(0, 250),
      reviews: reviews.sort((a, b) => (b.lastEventTime || b.time || 0) - (a.lastEventTime || a.time || 0)).slice(0, 200),
      feed: [...plays, ...injuries].sort(newest).slice(0, 200), health: this.health };
  }
  export() {
    const cutoff = this.now() - 3 * DAY;
    return { games: [...this.games.values()].filter(g => g.start > cutoff),
      injuries: [...this.injuries.values()].filter(i => i.updates.at(-1)?.time > cutoff),
      reviews: [...this.reviews.values()].filter(r => r.time > cutoff),
      seen: [...this.seen].slice(-15000), health: this.health };
  }
  drainChanges() { return this.changed.splice(0); }
}
