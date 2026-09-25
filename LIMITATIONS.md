# LIMITATIONS

## Free Sources Only - What Works and What Doesn't

### ✅ Working (Free, Keyless, Public)

#### ESPN (Keyless)
- **Scoreboard**: `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` and `basketball/nba/scoreboard`
  - ✅ No API key, public
  - ✅ Real-time state='in' for active games
  - ⚠️ Rate limited, no SLA, structure can change without notice
  - ⚠️ Sandbox TLS blocked (Debian OpenSSL issue), but works on Render/local
  - ✅ Verified via fixtures from 2026-09-24 real captures

- **Play-by-play**: `/summary?event=ID`
  - ✅ Contains injury keywords in text field
  - ⚠️ Not all injuries appear in PBP (e.g., off-ball, post-play)
  - ⚠️ Wallclock may lag broadcast 10-40s
  - ✅ Tested with fixture containing "shaken up", "carted", "evaluating"

- **Injuries**: `/injuries`
  - ✅ Structured injuries, but no athlete.id (must recover from links/headshot/uid)
  - ⚠️ Often delayed, not in-game focused (preseason, out for season)
  - ✅ Real capture exists in tests/real/

- **News**: `/news?limit=50`
  - ✅ Headlines with injury signal
  - ⚠️ Only 50 latest, role players fall off
  - ⚠️ Requires headline to explicitly name single athlete with injury after name

#### Bluesky (Keyless)
- **Public API**: `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=HANDLE&limit=30`
  - ✅ No auth for public feeds
  - ✅ Free, documented
  - ⚠️ Handles can change, reporters may not post on Bluesky first (Twitter still primary for some)
  - ⚠️ Need to maintain list of 14 NFL + NBA insiders manually
  - ⚠️ Sandbox TLS blocked, but structure documented, fixture realistic
  - ⚠️ Not all reporters are verified on Bluesky

#### Google News RSS (Keyless)
- **Endpoint**: `https://news.google.com/rss/search?q=QUERY&hl=en-US&gl=US&ceid=US:en`
  - ✅ No API key, RSS is public
  - ⚠️ Google indexing delay 1-5 min
  - ⚠️ RSS parsing requires custom XML parser (no deps)
  - ⚠️ Query per team every 20s could hit rate limits if many teams
  - ⚠️ Stale filter (>30 min) may discard valid but delayed articles
  - ✅ Fixture with real RSS structure

#### Mastodon (Keyless, Low Priority)
- **Endpoint**: `https://mastodon.social/api/v1/timelines/tag/:hashtag`
  - ✅ Public timeline, no auth
  - ⚠️ Low signal-to-noise, hashtag spam
  - ⚠️ Instance choice matters (mastodon.social vs others)
  - ⚠️ Content is HTML, needs stripping
  - ⚠️ Very low priority per spec, may not have real-time injury reports
  - ✅ Fixture realistic

### ❌ Blocked / Not Free

#### Twitter/X
- **Status**: ❌ Blocked since Feb 2026, no free API
- **Why**: X API v2 free tier removed, basic tier $200/mo, enterprise $42k/mo
- **Impact**: Many insiders still post first on X, Bluesky is secondary
- **Workaround**: Bluesky + Mastodon, but latency higher than X would be

#### Instagram / Facebook
- **Status**: ❌ No free JSON API
- **Why**: Graph API requires app review, business account, no public feed without auth
- **Impact**: Team PR often posts on Instagram first

#### NBA.com / NFL.com Official News
- **Status**: ⚠️ HTML only, no JSON, CORS blocked for browser
- **Why**: NBA.com news index is HTML, needs scraping, no CORS
- **Workaround**: Hosted collector only (Node), not browser. Existing repo had nba-news.mjs for this, but fragile

#### NBA Official CDN (cdn.nba.com)
- **Status**: ⚠️ 403 from GitHub Actions, TLS fails in sandbox
- **Why**: CDN blocks certain clients, requires specific headers
- **Impact**: Official PBP unavailable in some environments

## Architecture Limitations

### Render Free Tier
- **Sleep**: Sleeps after 15 min inactivity, cold start 10-30s
- **Workaround**: UptimeRobot ping /api/health every 10 min (free)
- **Alternative**: Fly.io, Railway free tiers similar

### Supabase Free Tier
- **Limits**: 500MB DB, 2GB bandwidth, 50k monthly active users
- **Rate**: 100 requests/sec, but REST API can throttle
- **Fallback**: In-memory DB when SUPABASE_URL not set (for local dev)
- **Data retention**: 30-day view, cleanup function provided

### Deduplication Edge Cases
- Same (sport, team, player, status) in 5 min = skip
  - ⚠️ May skip legitimate second injury to same player in same game (rare)
- Status upgrade REPORTED → OUT = emit new
  - ✅ Correct, but downgrade OUT → REPORTED is blocked (could be correction)
- Stale >30 min discard
  - ⚠️ Google News indexing may be >30 min, causing valid alerts to be dropped
  - Tradeoff: prevents old news from flooding during live game

### Player Name Extraction
- Heuristic: regex for capitalized names before injury keywords
- ⚠️ Fails for:
  - Names with suffixes (e.g., "Ronald Holland II")
  - Nicknames, abbreviations
  - Multiple players in same sentence
  - Non-English characters
- **Better**: Use roster from boxscore to match known players (implemented in espn.js roster collection)

### Team Detection
- From ESPN competitors, or uppercase abbr in text
- ⚠️ Google News, Bluesky, Mastodon team extraction is crude (search for KC, BUF etc)
- ⚠️ May misattribute if multiple teams mentioned

### Latency
- **Best case**: 5s PBP poll + 0.2s DB + 2s frontend = ~7s from ESPN PBP to UI
- **Realistic**: ESPN PBP lags broadcast 10-40s, so broadcast → UI = 15-60s
- **Worst case**: Render cold start 30s + Google News indexing 5 min = >5 min
- **Target <60s**: Achievable for ESPN PBP source during active games, not for Google News

### No Background Alerts
- GitHub Pages frontend only polls while tab open
- No push notifications, no service worker (would require extra setup)
- Hosted Node collector runs 24/7 but frontend doesn't get background alerts when closed

### Security / Abuse
- No auth on /api/alerts (public read)
- No rate limiting on API (could be abused)
- Supabase RLS allows public read, service key for writes
- Should add rate limiting, caching, CDN in production

### Testing Gaps
- Sandbox TLS blocked, cannot test LIVE in CI
- Real game testing requires manual during NFL/NBA live game
- Fixtures are realistic but not live-captured for NFL (NBA fixtures from 2026-09-24 are real)
- No automated load testing

## Future Improvements (If Paid APIs Allowed)
- Twitter/X basic tier for real-time reporter feeds (lowest latency)
- Sportradar or ESPN+ for official injury feed
- Push notifications via Web Push API
- WebSocket instead of 2s polling
- Player ID resolution via roster API
- ML for injury keyword classification

## Compliance
- Follow ESPN, Bluesky, Google News, Mastodon terms of service
- Respect polling limits (ESPN 10s scoreboard, 6s summary, etc.)
- No scraping of private data
- All sources logged with timestamps and URLs for audit
