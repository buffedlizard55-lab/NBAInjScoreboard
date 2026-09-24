# Verification log and coverage gaps

**Scope:** NBA games. One line in the task mentioned NFL; that contradicts the NBA repository and the rest of the request. No NFL data is processed. **Verification date:** 2026-09-24 UTC, during the NBA offseason. A currently live game is not available for a genuine live-injury acceptance test.

## Audit before implementation

- `main` contained only `README.md` (`# NBAInjScoreboard`); [its Pages site](https://buffedlizard55-lab.github.io/NBAInjScoreboard/) rendered that heading. There was no pre-existing collection, verification, timing, deduplication or alert system to repair.
- The [MLB reference replay page](https://buffedlizard55-lab.github.io/MLB-Live-PBP/reviews.html) showed **0 review events** when checked; its repository documents client-side polling against MLB's public StatsAPI. MLB replay/status fields **must not be assumed to exist** in NBA PBP.
- Read actual ESPN web API responses via the page-fetch tool: [NBA scoreboard for 2026-04-25](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260425&limit=100), [game summary 401869414](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401869414), [league injuries](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries) and [NBA news](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=20). Observed `events[]`, `competitions[].competitors`, `status.type.state`; summary `boxscore.players[].statistics[].athletes[].didNotPlay/stats` and `plays[].wallclock/participants`; injury `injuries[].injuries[].date/status/athlete/shortComment`; news `articles[].published/headline/categories/links.web.href`. ESPN team injury path `/teams/{id}/injuries` returned `{}` and was **not** used. NBA's official [injury report page](https://official.nba.com/nba-injury-report-2025-26-season/) states reports are updated throughout the day, but it is a **pregame/game-day participation report**, not a complete live injury feed.
- Attempts to use `curl`/Node HTTPS to `site.web.api.espn.com`, `site.api.espn.com` and `cdn.nba.com` from this sandbox failed at TLS negotiation (`SSL_ERROR_SYSCALL` / EOF). The page-fetch tool could inspect ESPN JSON, but the NBA CDN returned HTTP 500 from that tool. **A live upstream fetch from the locally running collector could not be verified in this sandbox.** The code reports failures rather than pretending to have live data. The workflow's separate read-only probe may reveal a different outcome on a GitHub Actions runner.

## Pass 1 — functional baseline

Implemented multi-game ET schedule/scoreboard, ESPN summary PBP, NBA official PBP when unique ESPN-to-NBA matching succeeds, ESPN injury/news ingestion, evidence/participation/time gates, per-player incident updates in both the Live and Alerts feeds, dedicated replay reviews, hosted persistent SSE collector, and a browser-only GitHub Pages fallback. HTTPS source URLs and original text are displayed; injury and review claims are not inferred from absence/score changes. Added deterministic synthetic fixtures explicitly marked **not real game claims**.

## Pass 2 — bug and edge-case review

Found and addressed:

1. Initial collector and browser startup could wait 40–60s before polling the first live game's injury/summary feed; idle loops now check frequently without making off-game network requests and browser loops start immediately after the first valid scoreboard.
2. A failure to load yesterday's schedule could suppress today's request through a shared URL cooldown. Retry/backoff is now per URL; today and yesterday fetch independently and overnight games are retained.
3. A previous success followed by a failed request had incorrectly appeared healthy; last success and current error are both recorded. Missing active games in a transient empty scoreboard do not silently clear the slate; a stale live status blocks new injury acceptance.
4. A newer, less specific `Out` snapshot could overwrite an explicitly confirmed *will not return* update. Less-specific repeated statuses now corroborate unless a more recent explicit correction supports a reversal. Repeated source items are deduplicated across process restarts.
5. ESPN news headlines unrelated to injuries could inherit an old injury mention in a story description; a single athlete and an injury/status signal **in the headline** are required. Multi-athlete headlines fail closed. Nonmedical personal reasons, DNP roster entries and future-game designations are excluded.
6. Server shutdown in the persistence throttle window could lose the last event; shutdown and editor submission now force an atomic state write. ESPN summaries with minutes but no `plays` can still prove participation while PBP health remains degraded.
7. Browser-specific defects: team logos were being rejected by an overly strict URL checker; historical date navigation could lose the date; reconnect could multiply polling loops; boot-time backfill could sound an alert. These have dedicated DOM smoke tests.

The second-pass baseline ran **19 passing synthetic tests**, including source cooldown, ET midnight/DST, late statuses, dedup, participation delays, stale games, manual intake, replay isolation, persistence and DOM rendering on all four pages. The third pass below added further tests. Local HTTP checks returned `200` for all site pages/API/assets and `404` for `.git` and unapproved paths.

## Pass 3 — source verification and final re-check

- GitHub Actions' read-only [source probe](https://github.com/buffedlizard55-lab/NBAInjScoreboard/actions/runs/35960612902) succeeded against ESPN from a CI runner: current scoreboard `200` (0 games that day), archived scoreboard `200` (4 games), archived game summary `200` (513 raw plays, 2 box-score teams), injury list `200` (27 team groups), and news `200` (50 articles). The ESPN responses reported `Access-Control-Allow-Origin: *` for a request with the Pages origin. The production parser actually parsed the archived summary into 160 recent plays, 19 participants and 2 reviews **before** a legacy-athlete-ID defect was corrected. This is schema/egress verification, not a real live-game observation or browser latency guarantee.
- The same runner received HTTP **403** from NBA's live scoreboard and archived PBP CDN both with a Pages `Origin` and without an `Origin`; the official feed has not been validated from any live deployment. NBA.com news HTML and a dated historical article returned `200` but have **no browser CORS**. The official NBA injury-report index returned `200` but its HTML exposed **0 current PDF links**. No historical PDF filename was repurposed as a current report.
- A source-shaped NBA.com featured/latest news index (12 latest + 9 featured entries when probed) and actual canonical dated `Article` JSON-LD were inspected before implementing server-only news ingestion. Stories are screened by exact participating-player name and medical headline, then independently fetched and matched against their original URL, headline and publication time. The historical example was not treated as an in-game event. NBA.com may publish Associated Press stories: hosting is not team medical confirmation. The short index can omit stories.
- An archived ESPN athlete ID was **6440**, whereas the first implementation incorrectly required 6+ digits and would have missed some veteran players. Athlete IDs and game IDs now have separate validation in both the engine and editorial API; a short-ID regression test covers participation and alert matching. ESPN's `source.description` in one injury row was `basic/manual`, not a team/reporter citation; the UI labels it ESPN rather than inventing an original publisher.
- Reports before the first recorded basketball action (when available) are withheld, editorial injury statuses require matching medical wording or an existing injury incident, unrelated ejections cannot become a confirmed medical alert, future-weekday and duplicate athlete tags are filtered, and ambiguous same-name headlines cannot choose an arbitrary game. Conflicting explicit replay rulings show a conflict instead of a winner. Storage-write errors and NBA.com news failures surface as degraded health rather than silent success.
- **25 deterministic tests passed locally** after these changes; the CI result for the final commit must be checked before merging. No game was live during these passes, and this sandbox's direct ESPN/NBA TLS requests failed, so real-time delivery, p95 latency, missed injury counts and actual browser CORS behavior have **not** been measured.

## Session 2026-09-24 (b) — root cause of missed injuries

The prior section recorded "25 deterministic tests passed" and no live game to test against. That was
technically true and still misleading: **the structured injury parser had been returning zero
candidates since the first commit.** Every claim below was produced by a tool call in this session.

### The root cause, verified against the live endpoint

- `curl` from this sandbox cannot reach the internet at all: `site.web.api.espn.com`, `cdn.nba.com`,
  `www.nba.com` and even `https://1.1.1.1` all fail with `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`.
  Only the page-fetch tool has egress, so all live-source inspection below went through it.
- Fetched the real `ESPN /injuries` payload. Two consecutive rows (Henri Veesaar, Mouhamed Gueye).
  The observed `athlete` keys are: `firstName, lastName, displayName, shortName, links, headshot,
  position, team, notes, status` — **there is no `id`**.
- Ran that captured payload through the shipped parser: `parseEspnInjuries(...)` returned **0**
  candidates, because `athleteId(row.athlete.id)` produced `''` and the `if (!id ...) return []`
  gate dropped every row. The single most important injury source was dead, silently.
- Why 25 tests still passed: `tests/fixtures.mjs` built `athlete: { id, displayName, team, links: [] }`.
  The fixture described a schema production never sends, so the suite validated the parser against
  imaginary data. This is the concrete failure the "no hallucinations" instruction targets.

### Fixes and what was verified for each

1. **Athlete id recovery** — `espnAthleteId()` reads the id from the player-card link
   (`/nba/player/_/id/5105571/...`), the sportscenter uid (`~a:5105571`), the headshot filename
   (`/full/5105571.png`) and the injury note's core-API `$ref` (`/athletes/5105571/`), and **fails
   closed if the recovered ids disagree** rather than picking a player. On the captured payload:
   `rows: 2, rowsWithAthleteId: 0, rowsWithRecoverableAthleteId: 2, parsedCandidates: 2`.
2. **Real publisher attribution** — ESPN stores the originating wire inside
   `athlete.notes.items[].source`; the captured row says `RotoWire`. That was being discarded and
   every alert read only "ESPN injury report". It is now cited as
   `ESPN injury report · RotoWire`, still labelled as ESPN-carried rather than independently verified.
3. **Fixtures now mirror production** — `tests/fixtures.mjs` no longer invents `athlete.id`; the id
   lives only in links/uid/headshot exactly as on the wire. `tests/real/*.json` holds verbatim
   captures (injuries, news, box-score athlete rows) and `tests/real-source.test.mjs` asserts the
   parsers read them. A schema guard fails if ESPN ever starts sending `athlete.id`, so the change
   is deliberate rather than accidental.
4. **CI drift guard** — `tools/probe.mjs` now reports `rows / rowsWithAthleteId /
   rowsWithRecoverableAthleteId / parsedCandidates` and exits non-zero if a non-empty injury feed
   yields zero recoverable ids. The original bug would have failed the build.
5. **Participation proof** — the real box score *does* carry `athlete.id` (Cade Cunningham `4432166`,
   plus `uid` and `guid`), so participation matching was never the broken half. Two real details were
   encoded: `"reason":"COACH'S DECISION"` appears on players who logged 41 minutes with
   `didNotPlay:false`, so `reason` is unusable as a DNP signal; and true DNPs arrive with
   `didNotPlay:true` and `stats: []`. A populated stats line now counts as recorded appearance, so a
   sub-minute player whose minutes round to `"0"` is no longer invisible; the proof string says
   "recorded stats line" rather than claiming minutes.
6. **Medical lexicon** — the old regex matched `fracture` but not `fractured`, and missed `sprained`,
   `strained`, `swollen`, `surgical`, ACL/MCL/meniscus/labrum/tendon/ligament and similar. Inflected
   forms and those terms were added; the real Gueye comment ("surgery ... fractured left foot") now
   passes on more than one token.
7. **Post-buzzer reports** — a player hurt on the final possession is often reported after the game
   flips to `post` and was dropped outright. Reports are now accepted for a `post` game only when the
   report's own timestamp sits between the last recorded play and 10 minutes after it; anything later
   stays rejected (both directions are tested).
8. **New source: per-player news** — `GET /athletes/{id}/news` was verified live and returns
   `{"header":"{0} News","articles":[]}`, the same contract as the league feed. The league feed only
   carries ~50 stories, so role-player injuries fall off it. A bounded round-robin polls the players
   actually on the floor (default 8 per 30s, `ESPN_ATHLETE_NEWS_BATCH`, disable with
   `ESPN_ATHLETE_NEWS=0`). Both news routes emit the **same** `sourceKey`, so one story cannot alert
   twice. Coverage is published to `/api/health` and the health panel as
   `polledDistinct / participants` so a partial sweep never reads as full monitoring.
9. **News URL gate** — the captured news feed contains a `type:"Media"` clip whose `links.web.href`
   is a `/video/clip/` URL; the existing `https://www.espn.com/nba/story/` requirement correctly
   excludes it, and a regression test now covers that with the real article.

### Test and runtime results this session

- `npm ci --ignore-scripts` then `npm test`: **39 passing** (was 25). `npm run check` also syntax-checks
  `server.mjs` and `assets/app.js`.
- New tests cover: real-payload parsing and id recovery (including fail-closed on conflicting ids),
  no false positives on the real current news feed, real box-score participation vs DNPs, end-to-end
  collector pipeline from a real-shaped row to an alert in *both* the live feed and the alerts feed,
  per-athlete news discovery plus cross-route dedup, the batch bound, and `ESPN_ATHLETE_NEWS=0`.
- `node server.mjs` boots and serves: `/`, `/alerts.html`, `/reviews.html`, `/game.html`, `/api/health`
  and `/api/state` all `200`; `/api/state?date=bogus` `400`; `/.git/config` and `/nope.html` `404`;
  `/api/reports` `503` with no token configured; `/api/stream` emits `: connected` then `event: update`.
- Because the sandbox has no egress, the running collector reports
  `ESPN scoreboard / previous-day scoreboard / NBA official scoreboard: "fetch failed"` and
  `activeGames: 0`. That is the intended degraded state: the UI shows a source failure rather than
  presenting "0 injuries" as a finding.
- The per-**team** news endpoint was probed for and **not** verified, so it was not added. Adding a
  source whose shape has not been observed is how the original bug happened.

### Independent confirmation from the GitHub Actions runner

The same commit's read-only probe ran on a CI runner with real egress
([run 36031723925](https://github.com/buffedlizard55-lab/NBAInjScoreboard/actions/runs/36031723925)).
This is the strongest evidence in this repository, because it reached the live endpoints directly:

| Source | Status | Observed |
| --- | --- | --- |
| ESPN current scoreboard | `200`, CORS `*` | `events: 0` on 2026-09-24 |
| ESPN archived scoreboard (2026-04-25) | `200`, CORS `*` | 4 games, first id `401869414` |
| ESPN archived summary | `200`, CORS `*` | 513 plays, 2 box-score teams, `keys[0] === "minutes"`, first athlete id `6440` (short legacy id), first play participant has `athlete.id` `4277847`; parsed to **20 participants, 160 plays, 2 reviews** |
| **ESPN injuries** | `200`, CORS `*` | 27 teams, **73 rows, `rowsWithAthleteId: 0`, `rowsWithRecoverableAthleteId: 73`, `parsedCandidates: 56`**, athlete keys exactly `firstName, lastName, displayName, shortName, links, headshot, position, team, notes, status`, publishers `["RotoWire"]`, `source.description` `basic/manual` |
| ESPN news | `200`, CORS `*` | 50 articles, 32 athlete-tagged, `parsedCandidates: 0` (offseason) |
| ESPN player news | `200`, CORS `*` | `keys: ["header","articles"]`, `articles: 0` — the new source's contract |
| NBA official scoreboard + archived PBP | `403` (with and without `Origin`) | blocked; still exercised only against synthetic fixtures |
| NBA.com news + article | `200`, **no CORS** | index exposes 12 latest + 9 featured; a dated article's JSON-LD parsed; browser polling of NBA.com is impossible |
| NBA official injury-report index | `200` | **0** PDF links; no historical filename reused as current |

The decisive line is `rows=73 withAthleteId=0 recoverable=73 parsed=56`: **not one of 73 real injury
rows carried `athlete.id`**, and the fix recovers every one. Before this change all 73 were dropped,
which is exactly the reported symptom. `keys[0] === "minutes"` validates the minutes-index lookup,
the `6440` athlete id confirms short legacy ids must stay legal, and play participants carrying
`athlete.id` confirms the play-by-play participation path was never the broken half.

Honest caveat on the same line: `parsed=56` means 17 of 73 rows were filtered by the medical,
future-game and available/active gates. Those exclusions look correct in aggregate but have not been
audited row by row, and cannot be until a live game shows which filtered rows were genuine in-game
injuries.

### Still not verified anywhere

- No NBA game was in progress on 2026-09-24 (`?dates=20260924` returns `events: []`; the 2026-27
  season's first listed game day is 2026-10-03). End-to-end latency, missed-injury rate and
  false-positive rate against a live slate are still unmeasured.
- `cdn.nba.com` PBP/scoreboard returned HTTP 500 through the page-fetch tool and is unreachable by
  direct TLS here, so the official feed is still exercised only against synthetic fixtures.
- Browser CORS behaviour from GitHub Pages at the real origin has not been observed in a browser.

## What prevents full real-time coverage (next session)

1. **No always-on public collector is deployed.** GitHub Pages only runs browser polling while a tab is open. Deploy `npm start` on a monitored HTTPS host with a persistent volume, test its outbound access from that host and point users at that URL. GitHub Actions' scheduled runs have a 5-minute minimum and variable queue times; they cannot meet a near-real-time SLA.
2. **Team/social injury channels and the NBA official injury PDFs are not automatically ingested.** NBA.com published news is automatically screened in hosted mode, but its featured/latest index is not an exhaustive league injury feed; syndicated copy is not a team medical statement. NBA's PDF report is a different pregame product; NBA CDN PBP is not a complete medical feed. Team PR posts, credentialed beat reporters and X/Twitter require verified identity, platform/API access, authentication/terms clearance and source-specific timestamps. Only an authorized human can submit those URLs now. Next session: select licensed/contractual feeds or approved adapters with publisher verification and replayable captures.
3. **Public source reliability and CORS aren't guaranteed.** ESPN and NBA endpoints are not contractual, can cache/rate-limit/block origins and may omit injuries or PBP. CI reached ESPN with permissive CORS, but NBA CDN returned 403 and NBA.com news HTML lacks CORS. The local environment blocked direct NBA/ESPN TLS; CI egress is not proof of every user's browser or the eventual Node host. Check actual CORS and provider latency in Chrome/Firefox at the final public origin during a game, comply with provider usage terms and set a request budget.
4. **No claim of 100% detection.** An injury without a published timestamp, a named athlete or a box-score/PBP participation record is intentionally withheld. The ESPN injury list can lag and its entry date may represent a transaction rather than a precise reporting time. Source text may be ambiguous or refer to another game; conservative filtering can miss those cases. Review events may not appear explicitly in either PBP, and clock-based grouping can conflate reviews at the exact same clock. No challenge counters or hypothetical scores are asserted.
5. **No independent live truth set/latency measurements.** During the next live NBA slate, capture provider arrival timestamps vs official team statements for *every* game, score both missed and false injuries, measure p50/p95 arrival/notification latency, test status reversals/corrections, OT and overnight games, and tune polling/backoff to provider policies. Add uptime metrics, error alerts, a replayable event store and on-call recovery procedures.
6. **Notifications are only in an open page.** Browser sound requires a user gesture; desktop notification permission is optional. Background push/email/SMS, 24/7 alerts and an operational audit UI need a hosted service and explicit consent/privacy design.
7. **Per-player news is a partial sweep, not per-player monitoring.** At the default 8 requests per
   30s, a 15-game slate with ~270 players on the floor needs roughly 17 minutes to touch everyone
   once. Raise `ESPN_ATHLETE_NEWS_BATCH` only after checking ESPN's tolerance from the real host —
   getting the collector's IP rate-limited would take down the primary feeds too. A per-team news
   endpoint would cut this to ~30 requests per cycle but has **not** been verified to exist.
8. **No recorded truth set for the fixed parser.** The regression suite proves the parser reads the
   wire format that was live on 2026-09-24. It cannot prove that a real in-game injury published
   during a real game is captured, because none was available. During the first live slate: record
   every `/api/state` transition, compare against the ESPN injury list and team statements, and score
   misses and false positives per status (`reported` / `questionable` / `out` / `confirmed_out` /
   `returned`).
9. **The classification rules are still keyword based.** `classifyReport` and `hasMedicalDetail` were
   widened, but they remain regexes over free text. Ambiguous wording ("left the arena", "left ankle"
   as a body part rather than an exit) can still mislabel a status. A small labelled corpus of real
   injury sentences, with the resulting status asserted, would make these rules measurable instead of
   eyeballed.
