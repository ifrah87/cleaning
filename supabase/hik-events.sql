-- Stores access/alarm events pushed from Hik-Connect for Teams (via hik-webhook).
create table if not exists public.hik_events (
  id          bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  event_time  text,          -- raw time string from the payload (format TBD from first live event)
  person_name text,
  person_code text,
  door_name   text,
  event_type  text,
  raw         jsonb not null default '{}'::jsonb
);
create index if not exists hik_events_received_idx on public.hik_events (received_at desc);

alter table public.hik_events enable row level security;
drop policy if exists "hik_events read" on public.hik_events;
create policy "hik_events read" on public.hik_events for select to authenticated using (true);
-- Writes come from the Edge Function via the service-role key (bypasses RLS).
