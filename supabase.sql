-- Journal app schema. Paste this whole file into Supabase → SQL Editor → Run.

-- Each user's journal data, as key/value rows. Row Level Security below
-- makes it IMPOSSIBLE for one user to read or write another user's rows.
create table if not exists kv (
  user_id uuid not null,
  key text not null,
  value text,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- `default now()` only fires on INSERT, so an updated row would keep its original
-- timestamp forever. This trigger stamps every write with the SERVER clock, which
-- is what lets the app tell whether a phone or a laptop wrote last (a device with
-- a wrong clock can't corrupt the ordering).
create or replace function kv_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists kv_touch_trg on kv;
create trigger kv_touch_trg before insert or update on kv
  for each row execute function kv_touch();

alter table kv enable row level security;

drop policy if exists "own rows only" on kv;
create policy "own rows only" on kv
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Daily AI-usage counter (only the server touches this; users have no access).
create table if not exists usage (
  user_id uuid not null,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table usage enable row level security;
-- no policies on purpose: regular users cannot read or write usage at all.

create or replace function bump_usage(p_user uuid, p_day date)
returns int
language plpgsql
security definer
as $$
declare c int;
begin
  insert into usage (user_id, day, count) values (p_user, p_day, 1)
  on conflict (user_id, day) do update set count = usage.count + 1
  returning count into c;
  return c;
end $$;

-- This runs as a privileged function, and it takes an arbitrary user id. Left
-- callable by anyone, a signed-in user could bump SOMEONE ELSE's counter and
-- lock them out of the AI. Only the server (service_role) may call it.
revoke execute on function bump_usage(uuid, date) from public, anon, authenticated;
grant execute on function bump_usage(uuid, date) to service_role;

-- ============ push notifications ============

-- One row per device that turned reminders on. `sub` is the browser's push
-- subscription (endpoint + keys). `tz` is that device's timezone, so the cron
-- can turn a schedule item's local "3:00 PM" into the right moment to fire.
create table if not exists push_subs (
  user_id uuid not null,
  endpoint text not null,
  sub jsonb not null,
  tz text,
  reminder_time text,           -- "HH:MM" for the daily "time to journal" nudge, or null = off
  updated_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

alter table push_subs enable row level security;

drop policy if exists "own subs only" on push_subs;
create policy "own subs only" on push_subs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Remembers what has already been pushed so the cron never sends the same
-- reminder twice. `tag` is e.g. "sched:<itemid>" or "journal:2026-07-22".
create table if not exists push_log (
  user_id uuid not null,
  tag text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, tag)
);

alter table push_log enable row level security;
-- no policies: only the server (service key) reads/writes this.
