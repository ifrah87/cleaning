-- Cleaning Ops — shared server storage
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.

-- One row holds the whole app state for one building.
create table if not exists public.app_state (
  building    text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Seed the building this site uses (matches BUILDING in index.html).
insert into public.app_state (building, data)
values ('orfane-main', '{}'::jsonb)
on conflict (building) do nothing;

-- Row Level Security.
-- v1: the public (anon) key may read/write. This is obscurity-level security
-- only — anyone with the site URL + anon key can read/write. It matches the
-- app's current client-side login. Harden later with real Supabase Auth
-- (see the "Next step: real logins" note in SETUP.md).
alter table public.app_state enable row level security;

drop policy if exists "anon read"   on public.app_state;
drop policy if exists "anon insert" on public.app_state;
drop policy if exists "anon update" on public.app_state;

create policy "anon read"   on public.app_state for select using (true);
create policy "anon insert" on public.app_state for insert with check (true);
create policy "anon update" on public.app_state for update using (true) with check (true);

-- Push live changes to every connected device.
-- Wrapped so re-running the script doesn't error if the table is already added.
do $$
begin
  alter publication supabase_realtime add table public.app_state;
exception
  when duplicate_object then null;   -- already a member → fine
end $$;


-- ============================================================
-- CLEANING HISTORY LOG — append-only record of who cleaned which
-- guest room and when. This is separate from app_state so entries
-- can never be clobbered by a concurrent state save.
-- ============================================================
create table if not exists public.cleaning_log (
  id           bigint generated always as identity primary key,
  building     text not null,
  unit_id      text not null,
  unit_label   text,
  cleaner_id   text,
  cleaner_name text,
  cleaned_at   timestamptz not null default now()
);

create index if not exists cleaning_log_lookup_idx
  on public.cleaning_log (building, unit_id, cleaned_at desc);

alter table public.cleaning_log enable row level security;

drop policy if exists "log read"   on public.cleaning_log;
drop policy if exists "log insert" on public.cleaning_log;
drop policy if exists "log delete" on public.cleaning_log;

create policy "log read"   on public.cleaning_log for select using (true);
create policy "log insert" on public.cleaning_log for insert with check (true);
create policy "log delete" on public.cleaning_log for delete using (true);  -- lets a mis-tap be undone

do $$
begin
  alter publication supabase_realtime add table public.cleaning_log;
exception
  when duplicate_object then null;
end $$;
