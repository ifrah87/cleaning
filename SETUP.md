# Cleaning Ops — make it save (Supabase backend)

The app now stores its data on a shared server instead of only in the browser.
Do these 3 steps once and every device will save to the same live database.

## 1. Create the database
1. Go to https://supabase.com → sign in → **New project** (free tier is fine).
   Pick a name + a database password, wait ~1 min for it to provision.
2. Left sidebar → **SQL Editor** → **New query**.
3. Open `supabase-schema.sql` (in this folder), paste the whole thing, click **Run**.
   You should see "Success". This creates the `app_state` table and turns on live sync.

## 2. Get your two keys
1. Left sidebar → **Project Settings** (gear) → **API**.
2. Copy **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **anon / public** key (a long string). *Not* the `service_role` key.

## 3. Paste them into the app
Open `index.html`, near the top find:

    const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
    const SUPABASE_ANON_KEY = 'YOUR-PUBLIC-ANON-KEY';

Replace both values with what you copied. Save the file, then **redeploy it the
same way you deployed the current site** (whatever puts it on
cleaning.orfanerealestate.so).

## Done — how to confirm it works
- Open the site, add a unit or employee, then fully close and reopen it. It's still there.
- Open the site on a second phone → you see the same data. Change something on one → it
  appears on the other within a second or two.
- If the server is ever unreachable you'll now see a red banner at the top ("Changes are
  NOT saving to the server"), instead of silently losing data like before.

---

## Notes / next steps (optional)

**Security (recommended soon):** right now the login (`admin` / `admin123`) is checked in
the browser and the database is open to anyone with the site's public key — same weak
level as before. To make it real, we'd switch the login screen to Supabase Auth (real
accounts) and change the table's security policy to "logged-in users only". Ask me and
I'll wire it up.

**Concurrency:** the whole state is saved as one document ("last write wins"). If two
people save in the same second, one change can be overwritten. Fine for a small crew. If
it becomes an issue, the fix is to move the high-write parts (attendance, completions)
into their own rows — ask me and I'll do it.
