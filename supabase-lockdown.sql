-- ============================================================
-- LOCK DOWN  — run this ONLY AFTER real office login is working.
-- It removes public (anon) access, so the open URL can no longer
-- read or write data without signing in. Requires the app to be
-- deployed with Supabase Auth login (which it now is).
-- ============================================================

-- app_state: authenticated users only
drop policy if exists "anon read"   on public.app_state;
drop policy if exists "anon insert" on public.app_state;
drop policy if exists "anon update" on public.app_state;
drop policy if exists "auth all"    on public.app_state;
create policy "auth all" on public.app_state
  for all to authenticated using (true) with check (true);

-- cleaning_log: authenticated users only
drop policy if exists "log read"     on public.cleaning_log;
drop policy if exists "log insert"   on public.cleaning_log;
drop policy if exists "log delete"   on public.cleaning_log;
drop policy if exists "log auth all" on public.cleaning_log;
create policy "log auth all" on public.cleaning_log
  for all to authenticated using (true) with check (true);
