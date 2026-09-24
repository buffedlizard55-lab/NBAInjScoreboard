# NBA / COURTSIDE — live scoreboard and in-game injury desk

A source-linked NBA scoreboard with **two separate systems on one site**: in-game injury updates in the [Injury desk](alerts.html), and explicit coach's challenges/replay reviews in the [Replay room](reviews.html). The all-game [Live feed](index.html) contains play-by-play **and the same injury updates as the alerts feed**. Reviews do not create injury alerts.

> **Coverage is best-effort, not guaranteed.** As of 2026-09-24 there are no games in progress to validate end-to-end live injury delivery. This repository started as a README only. The MLB example's `/reviews.html` was reviewed as a UI reference, not treated as an NBA data source. The isolated reference to "NFL games" in the request conflicts with the NBA repository and the repeated NBA specification; this implementation is **NBA-only**.

## Quick start

```sh
npm ci            # installs test-only DOM dependency
npm test          # deterministic tests; no external network needed
npm start         # Node 22+, serves the site and runs the continuously polling collector
# open http://localhost:3000
```

The server binds `0.0.0.0` and listens on `PORT` (default 3000). It has no production runtime dependencies (the lockfile only installs a test-only DOM helper). It polls the selected ESPN and NBA public feeds, merges/de-duplicates source-linked events, exposes same-origin `/api/state` and `/api/stream` (SSE), and persists event IDs and evidence in `.runtime/state.json` across restarts. `.runtime` is intentionally gitignored. Run it **on an always-on Node host with HTTPS**, a writable volume for `.runtime`, process supervision and a reverse proxy. `INJURY_INGEST_TOKEN` is optional; without it the editorial intake endpoint is disabled.

GitHub Pages serves the HTML/CSS/JS but **does not run Node**. On Pages the browser transparently polls ESPN's web API (and attempts the NBA official CDN) only **while that tab is open**. The site labels which mode it is using and shows source errors/staleness prominently; it does not quietly display a missing feed as zero injuries. Pages alone cannot maintain a persistent incident history, ingest curated/team/social sources, or deliver background alerts. If the browser's CORS requests fail, the fallback reports degraded coverage rather than making up games or players. For a reliable hosted public URL, deploy the Node collector and serve the site from that URL instead of relying on Pages.

## Data and evidence rules

| Use | Public endpoint / source | How it is used |
| --- | --- | --- |
| Schedule, scores and game phase | [`ESPN web scoreboard`](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260425&limit=100) | Finds **all** games for the selected ET game date; server also checks yesterday for overnight games. Includes preseason, playoffs and regular season as provided. |
| Recorded participation, play-by-play, replay text | [`ESPN game summary`](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401869414) | Box-score minutes or an actual basketball play establishes participation. Review outcomes are quoted, never projected from score changes. Fallback PBP if NBA CDN is unavailable. |
| Structured injury status | [`ESPN league injuries`](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries) | Needs a published timestamp after game start, current live game, team and athlete ID match, participation evidence, medical detail and non-future game context. The timestamp is **ESPN's entry date**, not proof of instant publication. |
| Reported injury news | [`ESPN NBA news`](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=20) | Only an NBA story with a timestamp, source link, a single athlete explicitly named in an injury-related headline, an athlete-category ID matching a player who checked in, and an explicit report. This intentionally misses ambiguous headlines. |
| Official game feed and reviews | [`NBA live scoreboard`](https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json) + [`NBA live PBP`](https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_0022400247.json) | Only attach a NBA game ID after unique home/away **and start time** matching. Prefer official PBP if fresh; show errors/fall back to ESPN when blocked. **These endpoints have not been reachable by this sandbox; the CDN fields are also documented by `nba_api`.** |
| Official pregame report | [NBA official injury-report page](https://official.nba.com/nba-injury-report-2025-26-season/) | Linked for reference, **not used for in-game alerts**. The league's PDFs primarily cover pregame availability and cannot prove that a player was hurt during the current game. |
| Team statements / credentialed reporters / social posts | Authenticated editorial intake (hosted Node only) | A human must verify an original public source, report time, player ID, injury wording and the exact game. **No automatic Twitter/X or team-PR collection is represented as active.** |

Public endpoints are not contractual, and the NBA CDN can block certain clients. See [verification & limitations](docs/verification.md) for what was actually exercised. An ESPN injury status of `Out` appears as **"Out (source status)"**, not "confirmed out for this game." Only explicit *will not return / out for the remainder* wording earns the "Will not return" label. `Questionable` retains the source's exact words. Absence from the box score, benching, substitutions, and elapsed time **never** become injury alerts. Multiple sources for the same athlete/status attach as evidence to one update; a later explicit change is a new update. A late older source cannot reverse a newer report. Every alert displays source link(s), publisher, original wording, published time, observed time, game, and participation proof. Replay text has its own feed and does not assert the challenging team/counters or the ruling when missing.

**Latency targets, not SLAs:** hosted server polls live ESPN scoreboard about every 10s, summaries about every 6s + response time, injuries about every 12s, news about every 30s; the NBA PBP is attempted for mapped games. Browser fallback polls per tab (10s scoreboard, 8s summaries, 15s injuries, 30s news while games are live). Each provider controls its own publishing/caching latency; a 6s poll cannot make a 10-minute-late report real-time. Failed requests back off and the UI explicitly reports gaps. There are no background notifications when the page is closed; optional sound/desktop notifications require opt-in and browser permission and are suppressed for existing backfill.

## Curated official/team/reporter/social reports (hosted mode only)

Set `INJURY_INGEST_TOKEN` to a long random value (24+ characters) **in the server environment**, never in this repository or in a browser. Operators can additionally configure exact `TRUSTED_SOURCE_HOSTS` and exact `TRUSTED_SOCIAL_HANDLES` (comma-separated; X/Twitter URLs must link to a `/status/<id>`). NBA.com, ESPN.com and APNews.com HTTPS links are accepted by default. A trusted URL/handle is a **link check, not proof that the statement is authentic**: the operator must inspect the source and timestamp first. Editorial entries are labeled **Curated**, not independently machine-verified.

```sh
curl -X POST https://YOUR-HOST/api/reports \
  -H "Authorization: Bearer $INJURY_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"gameId":"ESPN_EVENT_ID","athleteId":"ESPN_ATHLETE_ID","status":"questionable","publishedAt":"SOURCE_ISO_TIMESTAMP","source":"TEAM_OR_REPORTER","sourceUrl":"https://www.nba.com/news/ORIGINAL_ARTICLE","text":"Exact, verified source wording of at least twenty characters"}'
```

The backend still rejects non-live games, non-participants, missing medical context in automated feeds, duplicate editorial entries, implausible times and unauthorized submissions. Supported editorial statuses are `reported`, `questionable`, `out`, `confirmed_out`, `returned`. A structured audit log (no token) is written to `.runtime/editorial.jsonl`. **Do not submit example or synthetic records to a real collector.**

## Verification and next session

Run `npm run check` for the local syntax + contract/edge-case suite. `.github/workflows/verify.yml` runs it in CI and probes public source headers/shapes, with a separate nonblocking network probe because a provider outage or Akamai policy should not silently invalidate logic tests. [Verification notes and outstanding work →](docs/verification.md)

This is not an official NBA product or medical advice. Follow provider terms, polling limits and source-use requirements before deploying at scale.
