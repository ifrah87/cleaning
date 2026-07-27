-- Trigger the attendance scrape every 5 minutes, for free, from Supabase.
--
-- WHY THIS WORKS
-- GitHub throttles `schedule:` triggers — ours asks for every 5 minutes and
-- delivers every 30-45. But `workflow_dispatch` (a manual/API trigger) is NOT
-- throttled; it queues immediately. So instead of asking GitHub's scheduler to
-- remember us, we poke it ourselves on a clock that actually keeps time.
--
-- Supabase already runs Postgres with pg_cron and pg_net available, so the
-- clock costs nothing and there is no server to maintain.
--
-- END-TO-END LATENCY: ~2-3 minutes (runner boot + npm install + scrape),
-- versus 30-45 minutes today. A VPS is faster still (~40s) — see README.md.

-- 1. Extensions (safe to re-run)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. Store the GitHub token in Vault rather than inline in the schedule.
--    Create a fine-grained PAT on github.com/settings/tokens with
--    Repository access: ifrah87/cleaning, Permissions: Actions = Read and write.
--    Then run this once with your token pasted in:
--
--    select vault.create_secret('ghp_xxxxxxxxxxxxxxxx', 'github_actions_token');
--
--    To rotate later:
--    select vault.update_secret(
--      (select id from vault.secrets where name = 'github_actions_token'),
--      'ghp_newtoken'
--    );

-- 3. The job. Runs every 5 minutes between 03:00 and 16:59 UTC,
--    which is 06:00-19:59 EAT — the crew's working day.
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

-- ---------------------------------------------------------------------------
-- CHECKING IT
--
--   select * from cron.job;                       -- is it scheduled?
--   select * from cron.job_run_details
--     order by start_time desc limit 20;          -- did the ticks fire?
--   select * from net._http_response
--     order by created desc limit 20;             -- GitHub should return 204
--
-- A 204 with an empty body means GitHub accepted the dispatch. A 401 means the
-- token is wrong or expired; 404 usually means the token lacks Actions access
-- to the repo (fine-grained tokens 404 rather than 403 when unauthorised).
--
-- TO STOP IT
--   select cron.unschedule('attendance-scrape');
--
-- AFTER THIS IS WORKING
-- Comment out the `schedule:` block in .github/workflows/scrape.yml so the
-- throttled scheduler stops firing alongside this. Keep `workflow_dispatch:` —
-- that is what this calls.
-- ---------------------------------------------------------------------------
