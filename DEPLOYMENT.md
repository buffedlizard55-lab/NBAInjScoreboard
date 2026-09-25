# Deployment Guide

## Prerequisites
- GitHub repo (this one)
- Render account (free tier) https://render.com
- Supabase account (free tier) https://supabase.com

## Step 1: Supabase Setup

1. Create project at https://supabase.com/dashboard
2. Go to SQL Editor
3. Copy paste `db/schema.sql` and run
4. Go to Settings -> API
5. Copy:
   - Project URL (SUPABASE_URL)
   - anon public key (SUPABASE_KEY)
   - service_role key (SUPABASE_SERVICE_ROLE_KEY) - keep secret!

## Step 2: Render Setup

1. Go to https://dashboard.render.com
2. New -> Web Service
3. Connect GitHub repo `buffedlizard55-lab/NBAInjScoreboard`
4. Settings:
   - Name: nba-nfl-injury-alerts
   - Runtime: Node
   - Build Command: `npm ci`
   - Start Command: `node server.js`
   - Plan: Free
   - Health Check Path: `/api/health`
5. Environment Variables:
   - `SUPABASE_URL`: https://your-project.supabase.co
   - `SUPABASE_KEY`: your anon key
   - `SUPABASE_SERVICE_ROLE_KEY`: your service role key
   - `PORT`: 10000 (Render requires 10000)
   - `NODE_VERSION`: 18
6. Deploy

Or use `render.yaml` (Infrastructure as Code):
- Push `render.yaml` to repo
- Render auto-detects and creates service

## Step 3: Verify Deployment

```sh
curl https://your-backend.onrender.com/api/health
# Should return {uptime_seconds, alerts_total, ...}

curl https://your-backend.onrender.com/api/alerts?sport=nfl&limit=5
# Should return {alerts: [], game_window: {...}}
```

## Step 4: GitHub Pages Frontend

1. Go to repo Settings -> Pages
2. Source: main branch, root
3. Your site will be at https://buffedlizard55-lab.github.io/NBAInjScoreboard/

4. Point frontend to backend:
   Option A: Edit `index.html` meta tag:
   ```html
   <meta name="injury-api-base" content="https://your-backend.onrender.com">
   ```

   Option B: In browser console on GitHub Pages:
   ```js
   localStorage.setItem('INJURY_API_BASE', 'https://your-backend.onrender.com')
   location.reload()
   ```

   Option C: Update `assets/realtime.js` default backend URL and redeploy Pages.

5. Frontend now polls `https://your-backend.onrender.com/api/alerts` every 2 seconds.

## Step 5: Keep Render Awake (Free Tier Workaround)

Render free tier sleeps after 15 min inactivity.

- Use UptimeRobot (free): https://uptimerobot.com
  - Create monitor: HTTP(s) -> https://your-backend.onrender.com/api/health
  - Interval: 5 minutes
  - This pings and keeps service awake

- Or use cron-job.org (free)

## Step 6: Live Testing During Game

1. Check ESPN scoreboard for live games: https://www.espn.com/nfl/scoreboard or /nba/scoreboard
2. During live game, watch for injury in play-by-play:
   ```sh
   curl https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=GAME_ID | jq .plays
   ```
3. Poll your backend:
   ```sh
   watch -n 2 'curl -s https://your-backend.onrender.com/api/alerts?sport=nfl | jq .alerts[0]'
   ```
4. Measure latency:
   - T0 = time injury appears in ESPN PBP
   - T1 = time alert appears in /api/alerts
   - Latency = T1 - T0
5. Document in LATENCY_TEST.md

## Local Development

```sh
# Without Supabase (memory fallback)
npm install
npm start
# http://localhost:3000/api/health

# With Supabase
cp .env.example .env
# Edit .env
npm start

# Test collectors LIVE
node tools/collect-live.mjs
```

## Troubleshooting

- **ESPN fetch fails**: Check if sandbox TLS blocked (expected in some envs). Works on Render.
- **Supabase insert fails**: Check RLS policies, service key. Fallback to memory is automatic.
- **No active games**: Offseason, no games in progress. Collector logs "No active games, skipping".
- **Render cold start**: First request after sleep takes 10-30s. Use UptimeRobot.
- **CORS**: Backend sets Access-Control-Allow-Origin: *. Frontend should work cross-origin.

## Cost

- Render free tier: $0, 750 hrs/month, sleeps after 15 min
- Supabase free tier: $0, 500MB DB, 2GB bandwidth
- GitHub Pages: $0
- Total: $0/month
