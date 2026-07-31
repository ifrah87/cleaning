# Free always-on trigger via an external cron service

## Why

The scrape itself is reliable — about 90 seconds from trigger to data in the app.
What has never been reliable is *starting* it:

- The door terminal cannot push events to us; it only talks to Hik's cloud.
- Hik's API exposes the roster but not attendance.
- GitHub's `schedule:` trigger is best-effort and has run **2.5 to 4 hours late**,
  and some days not at all.
- Supabase `pg_cron` was set up and reported active, but never fired once.

GitHub does *not* throttle `workflow_dispatch` — an API trigger starts immediately.
So an external clock that calls that endpoint every few minutes gives a reliable
morning pull for free, with no server to maintain.

## Setup (cron-job.org, free tier)

Create a job with these exact settings:

| Field | Value |
|---|---|
| Title | Orfane attendance scrape |
| URL | `https://api.github.com/repos/ifrah87/cleaning/actions/workflows/scrape.yml/dispatches` |
| Method | **POST** |
| Schedule | Every **5 minutes** |
| Hours | **06 – 19** |
| Timezone | **Africa/Mogadishu** (EAT) |

Request body (raw / JSON):

```json
{"ref":"main"}
```

Headers:

```
Authorization: Bearer <YOUR_GITHUB_TOKEN>
Accept: application/vnd.github+json
Content-Type: application/json
User-Agent: cron-job.org
```

The token is the fine-grained PAT for `ifrah87/cleaning` with
**Actions: Read and write** (name: `supabase-cron-attendance`).

## Confirming it works

A successful call returns **HTTP 204** with an empty body — cron-job.org shows this
as a success. Then check github.com/ifrah87/cleaning/actions: a run appears within
seconds, labelled `workflow_dispatch`, and finishes in about 90 seconds.

If the job history shows:

- **401** — token wrong or expired
- **404** — token lacks Actions access to the repo (fine-grained tokens return 404,
  not 403, when unauthorised)
- **422** — the workflow has no `workflow_dispatch:` trigger on that ref

## Security note

The token lives with a third party. It can only trigger this one workflow — it
cannot read the cleaning data or reach Supabase. If the service is ever
compromised, revoke the token on GitHub and the exposure ends there.

Rotate it by generating a new PAT and updating the header in the cron job.

## Once this is working

Comment out the `schedule:` block in `.github/workflows/scrape.yml`, keeping
`workflow_dispatch:` — the GitHub scheduler adds unpredictable extra runs and
burns Actions minutes for nothing.

## Fallback that needs no automation at all

Hik portal → Attendance → Time Card → Time Period: Today → Export, then in the app:
Roll Call → **↑ Import Attendance File**. About a minute, works when everything
else is down.
