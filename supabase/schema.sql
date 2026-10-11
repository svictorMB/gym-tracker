-- Gym Tracker schema for Supabase (Postgres). Safe to re-run in the SQL editor after pulling changes.
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

-- Who entered each row: the owner, or a buddy logging for them on a shared phone.
-- Buddies can only change or delete rows they entered themselves.
alter table public.weights add column if not exists logged_by uuid references public.profiles(id) on delete set null;
alter table public.lifts add column if not exists logged_by uuid references public.profiles(id) on delete set null;

-- Replaces one person's sets for an exercise on a day in a single transaction, so a failed
-- insert can't leave the old sets deleted. Refuses when a buddy (p_actor) would overwrite
-- sets that someone else entered.
create or replace function public.replace_lifts(p_actor uuid, p_user uuid, p_person text, p_date date,
                                                p_workout text, p_exercise text, p_sets jsonb)
returns int language plpgsql as $$
declare n int;
begin
  if p_actor <> p_user and exists (
    select 1 from public.lifts
    where user_id = p_user and date = p_date and exercise = p_exercise and logged_by is distinct from p_actor
  ) then
    raise exception 'sets entered by someone else' using hint = 'locked';
  end if;
  delete from public.lifts where user_id = p_user and date = p_date and exercise = p_exercise;
  insert into public.lifts (user_id, logged_by, person, date, workout, exercise, weight, reps)
  select p_user, p_actor, p_person, p_date, p_workout, p_exercise, (s->>'weight')::real, (s->>'reps')::int
  from jsonb_array_elements(p_sets) s;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.replace_lifts(uuid, uuid, text, date, text, text, jsonb) from public, anon, authenticated;
