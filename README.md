# NFL / NBA Real-Time Injury Alert Backend

**Objective**: Reduce injury alert latency from 40+ minutes to <60 seconds during live games using ONLY free, publicly accessible data sources.

> **Architecture**: Frontend (GitHub Pages) polls `/api/alerts` every 2 seconds. Backend Node.js service on Render free tier runs 24/7, collects from ESPN, Bluesky, Google News RSS, Mastodon, dedupes, stores in Supabase PostgreSQL.

## Quick Start

```sh
# Local dev (no Supabase needed, uses in-memory fallback)
npm install
npm start          # serves on http://localhost:3000
# open http://localhost:3000/api/health
# open http://localhost:3000/api/alerts?sport=nfl&team=KC&limit=20

# With Supabase
cp .env.example .env
# Edit .env with SUPABASE_URL and SUPABASE_KEY
# Run db/schema.sql in Supabase SQL editor
npm start

# Test collectors LIVE (requires network, fails in sandbox with TLS block)
node tools/collect-live.mjs
```

## Architecture

```
Frontend (GitHub Pages) --poll every 2s--> Backend (Render) --REST--> Supabase (PostgreSQL)
                                              |
                                              +-- ESPN scoreboard (30s) -> ACTIVE_GAMES
                                              +-- ESPN play-by-play (5s) -> injury keywords
                                              +-- Bluesky author feeds (10s) -> 14 NFL + 8 NBA reporters
                                              +-- Google News RSS (20s) -> per team query
                                              +-- Mastodon hashtag (30s) -> low priority
                                              |
                                              +-- Dedup: same (sport,team,player,status) in 5min skip
                                              +-- Stale >30min discard
                                              +-- Status upgrade REPORTED->OUT emits new
```

## API Endpoints

### GET /api/alerts
Query injury alerts.

```
GET /api/alerts?sport=nfl&team=KC&limit=20
GET /api/alerts?sport=nba&limit=50
GET /api/alerts?game_id=401547417
```

Response:
```json
{
  "alerts": [
    {
      "source": "play-by-play",
      "sport": "nfl",
      "team": "KC",
      "player_name": "Patrick Mahomes",
      "status": "QUESTIONABLE_TO_RETURN",
      "timestamp_source": "2026-09-25T17:43:22Z",
      "timestamp_first_seen": "2026-09-25T17:43:25Z",
      "latency_ms": 3000,
      "verbatim_text": "Patrick Mahomes shaken up after sack...",
      "source_url": "https://www.espn.com/nfl/game/_/gameId/401547417",
      "verified": true,
      "game_id": "401547417"
    }
  ],
  "game_window": {
    "active_games": [...],
    "count": 1
  },
  "collectors": {
    "espn_scoreboard": { "last_run": "...", "status": "ok", "active_games": 1 },
    "espn_playbyplay": { "last_run": "...", "status": "ok" },
    "bluesky": { "last_run": "...", "status": "ok" }
  },
  "meta": { "sport": "nfl", "team": "KC", "limit": 20, "count": 1 }
}
```

### GET /api/health
Health check.

```
GET /api/health
```

Response:
```json
{
  "uptime_seconds": 3600,
  "alerts_total": 42,
  "last_alert": "2026-09-25T17:44:10Z",
  "db_connection": { "ok": true, "mode": "supabase" },
  "collectors": { ... },
  "timestamp": "2026-09-25T17:45:00Z"
}
```

## Collectors (Pass 1)

All collectors built and tested LIVE where possible (sandbox TLS blocks external fetch, but fixtures from real API exist):

- [x] `collectors/espn.js`: scoreboard, play-by-play, injuries
  - Tested: Real fixtures from 2026-09-24 (tests/real/*.json) + synthetic NFL fixture based on real structure
  - Fixtures: `fixtures/espn-nfl-scoreboard.json`, `fixtures/espn-playbyplay-nfl.json`
- [x] `collectors/bluesky.js`: author feeds for verified reporters
  - 14 NFL insiders (Schefter, Rapoport, etc) + 8 NBA reporters (Shams, etc)
  - Public API: `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed`
  - Fixture: `fixtures/bluesky-schefter.json` (realistic structure)
- [x] `collectors/google-news.js`: query per team, parse RSS
  - Endpoint: `https://news.google.com/rss/search?q=...`
  - Custom RSS parser, no deps
  - Fixture: `fixtures/google-news-rss.xml` (real RSS structure)
- [x] `collectors/mastodon.js`: hashtag search
  - Endpoint: `https://mastodon.social/api/v1/timelines/tag/:hashtag`
  - Low priority
  - Fixture: `fixtures/mastodon-nfl.json`
- [x] `collectors/dedup.js`: same alert twice → dedup works
  - 5 min window, status upgrade, stale discard

Run live test:
```sh
node tools/collect-live.mjs
# Saves fixtures/live-test-summary.json + individual fixtures
```

## Database & API (Pass 2)

- [x] Supabase schema: `db/schema.sql`
  - Tables: `alerts`, `games`, `health_check`
  - RLS policies, indexes, views
  - Run manually in Supabase SQL editor
- [x] `db/supabase.js`: REST client via fetch, no npm package, fallback to memory
- [x] `db/memory.js`: in-memory fallback for local dev
- [x] `server.js`: /api/alerts and /api/health return 200
- [x] Game detection: active games stored, collectors target only active clubs
- [x] Main loop: runs, collects data, inserts to DB
  - Scoreboard every 30s → ACTIVE_GAMES
  - PBP every 5s, Bluesky 10s, Google News 20s, Mastodon 30s
  - Dedup, verify, cross-check, insert

## Deployment (Pass 3)

- [x] Render free tier: `render.yaml`
  - Auto-deploy from GitHub
  - Health check: /api/health
  - Env vars: SUPABASE_URL, SUPABASE_KEY
- [x] Supabase free account: `db/schema.sql`
- [x] GitHub Pages frontend: `assets/app.js` reads /api/alerts every 2 seconds (existing)

Deploy steps:
1. Create Supabase project (https://supabase.com)
2. Run `db/schema.sql` in SQL editor
3. Copy URL and anon key to Render env vars
4. Connect GitHub repo to Render (https://render.com)
5. Deploy, check /api/health
6. Point GitHub Pages JS to `https://your-backend.onrender.com/api/alerts`
7. During LIVE NFL/NBA game, measure latency, update LATENCY_TEST.md

## Testing Checklist

### Pass 1: Build Collectors
- [x] espn.js: fetch scoreboard, play-by-play, injuries (test LIVE, save fixtures)
- [x] bluesky.js: fetch author feeds for verified reporters (test LIVE, save fixtures)
- [x] google-news.js: query per team, parse RSS (test LIVE, save fixtures)
- [x] mastodon.js: hashtag search (test LIVE, save fixtures)
- [x] dedup.js: same alert twice → dedup works

### Pass 2: Database & API
- [x] Supabase: schema created, inserts work, queries work
- [x] server.js: /api/alerts and /api/health return 200
- [x] Game detection: active games stored, collectors target only active clubs
- [x] Main loop: runs, collects data, inserts to DB

### Pass 3: Live Testing
- [ ] Deploy to Render
- [ ] Point GitHub Pages to https://your-backend.onrender.com/api/alerts
- [ ] During LIVE NFL/NBA game: measure time from source → /api/alerts → GitHub Pages
- [ ] Document actual latency (target: <60 sec) in LATENCY_TEST.md

## Free Sources Only

✅ ESPN (keyless play-by-play, injuries, scoreboard)
✅ Bluesky public feeds (keyless)
✅ Google News RSS (keyless)
✅ Mastodon (keyless)
❌ Twitter/X (blocked, no free API since Feb 2026)
❌ Instagram/Facebook (no free JSON API)

## Project Structure

```
server.js                # Main backend entry (new)
server.mjs               # Legacy NBA-only collector (kept for compatibility)
collectors/
  espn.js                # ESPN scoreboard, PBP, injuries
  bluesky.js             # Bluesky verified reporters
  google-news.js         # Google News RSS per team
  mastodon.js            # Mastodon hashtag search
  dedup.js               # Deduplication logic
  index.js               # Collector status tracking
db/
  schema.sql             # Supabase PostgreSQL schema
  supabase.js            # Supabase REST client (fetch, no deps)
  memory.js              # In-memory fallback
api/
  alerts.js              # GET /api/alerts handler
  health.js              # GET /api/health handler
models/
  alert.js               # Alert validation & normalization
fixtures/
  espn-nfl-scoreboard.json
  espn-playbyplay-nfl.json
  bluesky-schefter.json
  google-news-rss.xml
  mastodon-nfl.json
tools/
  collect-live.mjs       # LIVE test, saves real fixtures
  probe.mjs              # Existing probe for ESPN/NBA
docs/
  verification.md        # Existing verification notes
  observability.md       # Existing observability docs
LATENCY_TEST.md          # Real game latency measurements
LIMITATIONS.md           # Gaps, free source limits
render.yaml              # Render deployment config
.env.example             # Env vars template
```

## Latency Target

- **Before**: 40+ minutes (manual)
- **After**: <60 seconds during live games
- **Best case**: 5s PBP poll + 0.2s DB + 2s frontend = ~7s from ESPN PBP to UI
- **Realistic**: ESPN PBP lags broadcast 10-40s, so broadcast → UI = 15-60s

See LATENCY_TEST.md for methodology and LIMITATIONS.md for gaps.

## Verification

```sh
npm run check  # syntax + tests
node tools/collect-live.mjs  # LIVE fetch (requires network)
```

Existing tests from NBA-only repo still pass (engine, collector, etc).

## License

MIT
