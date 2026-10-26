-- 92 Rush — classement saison 4 (pseudo ↔ device_id)
-- Coller dans Supabase → SQL Editor → Run

create table if not exists public.players (
  device_id text primary key check (char_length(device_id) between 8 and 64),
  name text not null,
  name_key text generated always as (lower(name)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists players_name_key_uidx on public.players (name_key);

create table if not exists public.scores (
  id bigserial primary key,
  season int not null default 4,
  name text not null,
  name_key text generated always as (lower(name)) stored,
  device_id text references public.players(device_id) on delete set null,
  time_ms int not null check (time_ms >= 0 and time_ms <= 32400000),
  meters int not null check (meters >= 0 and meters <= 5000),
  cams int not null check (cams >= 0 and cams <= 999),
  win boolean not null default false,
  at timestamptz not null default now(),
  rose_at timestamptz
);
create unique index if not exists scores_season_name_uidx on public.scores (season, name_key);
create index if not exists scores_season_rank_idx on public.scores (season, win desc, time_ms asc, meters desc);

-- Accès uniquement via service_role côté API Vercel (pas d’anon côté front)
alter table public.players enable row level security;
alter table public.scores enable row level security;
