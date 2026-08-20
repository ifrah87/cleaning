-- =========================================================================
-- Don't keep attendance scrapes for ever.
--
-- HOW TO USE: run this whole file in the Supabase SQL editor. Safe to re-run.
--
-- WHY 45 DAYS
-- Two things in the app read back into this table:
--   · inferRotasFromAttendance() looks back 42 days to work out who actually
--     works which weekdays;
--   · the backdate sheet offers the names of whoever badged in on a past day.
-- 45 days covers the longer of the two with a few days' headroom. Keep less
-- than 42 and the rota inference quietly starts guessing from a short window;
-- keep none at all and "record a past day" can no longer name anybody.
--
-- WHY NOT received_at
-- event_time is the day the scan HAPPENED; received_at is the moment the row
-- landed, which for an imported file or a catch-up scrape can be days later.
-- Pruning on received_at would keep old scans that arrived recently and drop
-- recent scans that arrived late. event_time is the one the app queries, so it
-- is the one that decides. It is text, but always starts YYYY-MM-DD, which
-- sorts correctly as a string. Rows with no usable event_time fall back to
-- received_at rather than living for ever.
-- =========================================================================

-- The cutoff, in one place, so the one-off and the nightly job cannot disagree.
create or replace function public.hik_events_day(e public.hik_events)
returns text language sql immutable as $$
  select coalesce(nullif(left(e.event_time, 10), ''), to_char(e.received_at, 'YYYY-MM-DD'))
$$;

-- --- One-off: clear everything older than 45 days, now --------------------
-- Look before you delete. Run this on its own first to see what would go.
--   select public.hik_events_day(h) as day, count(*)
--   from public.hik_events h
--   where public.hik_events_day(h) < to_char(current_date - 45, 'YYYY-MM-DD')
--   group by 1 order by 1;

delete from public.hik_events h
where public.hik_events_day(h) < to_char(current_date - 45, 'YYYY-MM-DD');

-- --- Nightly, so it never builds up again ---------------------------------
-- pg_cron is already installed for the scrape trigger, so this costs nothing
-- and there is no server to maintain. 01:20 UTC = 04:20 EAT, before the crew
-- badges in and well after the previous work day has closed out.
create extension if not exists pg_cron;

select cron.unschedule('prune-hik-events')
where exists (select 1 from cron.job where jobname = 'prune-hik-events');

select cron.schedule(
  'prune-hik-events',
  '20 1 * * *',
  $$delete from public.hik_events h
    where public.hik_events_day(h) < to_char(current_date - 45, 'YYYY-MM-DD')$$
);

-- Check it took:
--   select jobname, schedule, active from cron.job where jobname = 'prune-hik-events';
