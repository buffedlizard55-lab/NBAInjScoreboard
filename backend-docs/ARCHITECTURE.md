# Architecture

## Overview
Real-time injury alert backend reduces latency from 40+ minutes to <60 seconds.

## Components

### Frontend
- GitHub Pages (static HTML/CSS/JS)
- Polls `/api/alerts` every 2 seconds via `assets/realtime.js`
- Fallback to `/api/state` for legacy NBA-only mode
- Configurable backend via `localStorage.INJURY_API_BASE` or `<meta name="injury-api-base">`

### Backend
- Node.js 18+ plain, no build step
- Runs on Render free tier 24/7
- Main loop:
  ```js
  while (true) {
    1. Fetch scoreboard every 30s -> ACTIVE_GAMES
    2. For each active game:
       - ESPN play-by-play every 5s
       - Bluesky feeds every 10s
       - Google News RSS every 20s
       - Mastodon hashtag every 30s
    3. Deduplicate, verify, cross-check
    4. Insert new alerts into DB
    5. Wait 5s, repeat
  }
  ```
- In-memory ACTIVE_GAMES list
- Dedup: same (sport,team,player,status) in 5 min skip, upgrade emits new, stale >30 min discard

### Database
- Supabase free tier PostgreSQL
- Tables: alerts, games, health_check
- Fallback to in-memory when SUPABASE_URL not set
- 30-day retention via view recent_alerts

### Data Sources (Free Only)
- ESPN: scoreboard, play-by-play, injuries, news (keyless)
- Bluesky: getAuthorFeed for 14 NFL + 8 NBA reporters (keyless)
- Google News RSS: per team query (keyless)
- Mastodon: hashtag search (keyless, low priority)

## Data Flow

```
ESPN Scoreboard (30s)
    ↓
ACTIVE_GAMES (in-memory + Supabase games table)
    ↓
[ESPN PBP 5s] → parse injury keywords → Alert
[Bluesky 10s] → parse reporter posts → Alert
[Google News 20s] → parse RSS → Alert
[Mastodon 30s] → parse hashtag → Alert
    ↓
Deduper (5min window, upgrade detection, stale filter)
    ↓
Supabase alerts table (or memory)
    ↓
GET /api/alerts → Frontend (2s poll) → UI
```

## Alert Object

```json
{
  "source": "play-by-play | bluesky | google-news | mastodon",
  "sport": "nfl | nba",
  "team": "KC",
  "player_name": "Patrick Mahomes",
  "status": "INJURY_REPORTED | OUT_FOR_GAME | QUESTIONABLE_TO_RETURN | RETURNED",
  "timestamp_source": "2026-09-25T17:43:22Z",
  "timestamp_first_seen": "2026-09-25T17:43:25Z",
  "latency_ms": 3000,
  "verbatim_text": "source sentence",
  "source_url": "link",
  "verified": true,
  "game_id": "ESPN ID"
}
```

## Deployment

- Render: `render.yaml` auto-deploy from GitHub
- Supabase: run `db/schema.sql` manually
- Env vars: SUPABASE_URL, SUPABASE_KEY, PORT
- Health check: /api/health

## Latency Breakdown

- ESPN PBP poll: 5s
- Processing: <100ms
- DB insert: 50-200ms
- API: 0ms (no cache)
- Frontend poll: 2s
- Total: ~7s from ESPN PBP text to UI
- Realistic: ESPN PBP lags broadcast 10-40s, so 15-60s broadcast to UI
