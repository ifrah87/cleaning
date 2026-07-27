-- =========================================================================
-- Trigger the attendance scrape every 5 minutes, for free, from Supabase.
--
-- HOW TO USE: replace PASTE_YOUR_GITHUB_TOKEN_HERE below with your token,
-- then run this whole file in the Supabase SQL editor. Safe to re-run.
--
-- WHY THIS WORKS
-- GitHub throttles `schedule:` triggers — ours asks for every 5 minutes and
-- delivers every 30-45. But `workflow_dispatch` (an API trigger) is NOT
-- throttled; it queues immediately. So rather than asking GitHub's scheduler
-- to remember us, we poke it ourselves on a clock that keeps time.
--
-- Supabase already runs Postgres with pg_cron and pg_net, so the clock costs
-- nothing and there is no server to maintain.
--
-- END-TO-END LATENCY: ~2-3 min (runner boot + npm install + scrape), versus
-- 30-45 min today. A VPS is faster still (~40s) — see README.md.
-- =========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The token lives in Vault, not inline in the schedule, so it never appears in
-- cron.job or in query logs.
select vault.create_secret(
  'PASTE_YOUR_GITHUB_TOKEN_HERE',
  'github_actions_token',
  'Fine-grained PAT for ifrah87/cleaning — Actions: Read and write'
);

-- Replace any previous version of the job before scheduling it.
select cron.unschedule('attendance-scrape')
where exists (select 1 from cron.job where jobname = 'attendance-scrape');

-- Every 5 minutes, 03:00-16:59 UTC = 06:00-19:59 EAT — the crew's working day.
select cron.schedule(
  'attendance-scrape',
  '*/5 3-16 * * *',
  $$
  select net.http_post(
    url     := 'https://api.github.com/repos/ifrah87/cleaning/actions/workflows/scrape.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_actions_token'),
      'Accept',        'application/vnd.github+json',
      'User-Agent',    'supabase-cron',
      'Content-Type',  'application/json'
    ),
    body    := '{"ref":"main"}'::jsonb
  );
  $$
);

-- =========================================================================
-- FIRE ONE NOW, to prove the token works without waiting for the next tick.
-- Run this on its own, then check the response below.
-- =========================================================================
-- select net.http_post(
--   url     := 'https://api.github.com/repos/ifrah87/cleaning/actions/workflows/scrape.yml/dispatches',
--   headers := jsonb_build_object(
--     'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_actions_token'),
--     'Accept',        'application/vnd.github+json',
--     'User-Agent',    'supabase-cron',
--     'Content-Type',  'application/json'
--   ),
--   body    := '{"ref":"main"}'::jsonb
-- );

-- =========================================================================
-- CHECKING IT
--
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
--   select id, status_code, content, created
--     from net._http_response order by created desc limit 10;
--
-- status_code 204 = GitHub accepted the dispatch and the run is starting.
--   401 -> token wrong or expired.
--   404 -> token lacks Actions access to the repo (fine-grained tokens 404
--          rather than 403 when unauthorised). Check the repo is selected AND
--          Permissions -> Actions is "Read and write".
--   422 -> the workflow has no `workflow_dispatch:` trigger on the ref.
--
-- ROTATING THE TOKEN
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'github_actions_token'),
--     'ghp_newtoken'
--   );
--
-- STOPPING IT
--   select cron.unschedule('attendance-scrape');
--
-- AFTER IT IS CONFIRMED WORKING
-- Comment out the `schedule:` block in .github/workflows/scrape.yml so the
-- throttled scheduler stops firing alongside this. Keep `workflow_dispatch:` —
-- that is what this calls.
-- =========================================================================
