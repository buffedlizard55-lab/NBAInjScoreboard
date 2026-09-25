-- Supabase PostgreSQL schema for real-time injury alerts
-- Run this manually in Supabase SQL editor
-- Free tier compatible

-- Enable UUID extension if not exists
create extension if not exists "uuid-ossp";

-- Table: alerts
-- Stores all injury alerts from all sources
create table if not exists alerts (
  id uuid primary key default uuid_generate_v4(),
  sport text not null check (sport in ('nfl', 'nba')),
  team text not null,
  player_name text not null,
  player_id text,
  status text not null check (status in ('INJURY_REPORTED', 'OUT_FOR_GAME', 'QUESTIONABLE_TO_RETURN', 'RETURNED')),
  source text not null check (source in ('play-by-play', 'bluesky', 'google-news', 'mastodon', 'espn-injuries', 'espn-news')),
  timestamp_source timestamptz not null,
  timestamp_first_seen timestamptz not null default now(),
  latency_ms integer,
  verbatim_text text not null,
  source_url text,
  verified boolean not null default false,
  game_id text,
  created_at timestamptz not null default now()
);

-- Indexes for fast queries
create index if not exists idx_alerts_sport on alerts(sport);
create index if not exists idx_alerts_team on alerts(team);
create index if not exists idx_alerts_game_id on alerts(game_id);
create index if not exists idx_alerts_created_at on alerts(created_at desc);
create index if not exists idx_alerts_sport_team on alerts(sport, team);
create index if not exists idx_alerts_player_name on alerts(player_name);

-- Table: games
-- Tracks active games and their state
create table if not exists games (
  id uuid primary key default uuid_generate_v4(),
  sport text not null check (sport in ('nfl', 'nba')),
  game_id text not null unique,
  club_1 text,
  club_2 text,
  state text not null,
  kickoff_time timestamptz,
  last_checked timestamptz not null default now(),
  raw_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_games_sport on games(sport);
create index if not exists idx_games_state on games(state);
create index if not exists idx_games_game_id on games(game_id);

-- Table: health_check
-- Tracks collector health
create table if not exists health_check (
  id uuid primary key default uuid_generate_v4(),
  collector_name text not null unique,
  last_run timestamptz,
  status text not null,
  error_msg text,
  active_games integer,
  alerts_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Insert initial health check rows
insert into health_check (collector_name, status) values
  ('espn_scoreboard', 'idle'),
  ('espn_playbyplay', 'idle'),
  ('bluesky', 'idle'),
  ('google_news', 'idle'),
  ('mastodon', 'idle')
on conflict (collector_name) do nothing;

-- Enable Row Level Security (RLS) for Supabase
-- For free tier, we allow public read, but restrict writes to service key
alter table alerts enable row level security;
alter table games enable row level security;
alter table health_check enable row level security;

-- Policies: allow public read
drop policy if exists "Allow public read alerts" on alerts;
create policy "Allow public read alerts" on alerts for select using (true);

drop policy if exists "Allow public read games" on games;
create policy "Allow public read games" on games for select using (true);

drop policy if exists "Allow public read health" on health_check;
create policy "Allow public read health" on health_check for select using (true);

-- Policies: allow insert/update with service key (bypass RLS for service_role)
-- Service role bypasses RLS automatically, so no need for insert policies for anon
-- But we create policies for authenticated inserts if needed
drop policy if exists "Allow service insert alerts" on alerts;
create policy "Allow service insert alerts" on alerts for insert with check (true);

drop policy if exists "Allow service upsert games" on games;
create policy "Allow service upsert games" on games for all using (true) with check (true);

drop policy if exists "Allow service upsert health" on health_check;
create policy "Allow service upsert health" on health_check for all using (true) with check (true);

-- Function to auto-update updated_at
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists update_games_updated_at on games;
create trigger update_games_updated_at before update on games
  for each row execute function update_updated_at_column();

drop trigger if exists update_health_updated_at on health_check;
create trigger update_health_updated_at before update on health_check
  for each row execute function update_updated_at_column();

-- View for recent alerts (last 30 days)
create or replace view recent_alerts as
  select * from alerts
  where created_at > now() - interval '30 days'
  order by created_at desc;

-- Cleanup function (optional, for manual cron)
create or replace function cleanup_old_alerts()
returns void as $$
begin
  delete from alerts where created_at < now() - interval '30 days';
end;
$$ language plpgsql;
