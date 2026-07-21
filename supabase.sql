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
