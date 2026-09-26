-- Gym Tracker schema for Supabase (Postgres). Run once in the SQL editor or via the Management API.
-- Auth is handled by Supabase Auth (magic links). The Worker talks to these tables with the
-- service role key only; RLS is enabled with no policies so the anon key can't read anything.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  seq bigserial,
  email text not null unique,
  username text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id bigserial primary key,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  unique (requester_id, addressee_id)
);

create table if not exists public.weights (
  id bigserial primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  person text not null,
  date date not null,
  lbs real not null,
  created_at timestamptz not null default now()
);

create table if not exists public.lifts (
  id bigserial primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  person text not null,
  date date not null,
  workout text not null,
  exercise text not null,
  weight real not null,
  reps int not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_lifts_user_ex on public.lifts (user_id, exercise);
create index if not exists idx_lifts_user_date on public.lifts (user_id, date);
create index if not exists idx_weights_user on public.weights (user_id, date);
create index if not exists idx_friendships_addressee on public.friendships (addressee_id);

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.weights enable row level security;
alter table public.lifts enable row level security;
