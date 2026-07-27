# Fixing the attendance lag

## Options, cheapest first

| | Cost | Lag | Needs |
|---|---|---|---|
| **Supabase pg_cron → GitHub dispatch** | **$0** | ~2-3 min | A GitHub token. No server. See `supabase-cron.sql` |
| **A droplet you already pay for** | **$0 extra** | ~40s | SSH access. Run `setup.sh` on it |
| New droplet, 1GB | $6/mo | ~40s | New box |
| New droplet, 512MB + swap | $4/mo | ~60s | Tight for Chromium; works but slower |

**Start with `supabase-cron.sql`.** It costs nothing, adds no server to maintain,
and takes the lag from 30-45 minutes down to 2-3. The trick is that GitHub
throttles `schedule:` triggers but *not* `workflow_dispatch` — so a clock that
actually keeps time (Supabase's pg_cron) pokes the workflow directly.

Only move to a VPS if 2-3 minutes still isn't tight enough, or if you want the
scrape to keep working when GitHub Actions is down.

## Why

The GitHub Actions schedule asks for a run every 5 minutes. It actually delivers
every 30–45 minutes, because GitHub throttles high-frequency `cron` triggers and
scheduled runs are best-effort. Measured against real badge-ins:

| Day | First badge-in | Rows landed in Supabase | Lag |
|-----|----------------|-------------------------|-----|
| 25 Jul 2026 | 07:03 | 07:50 | 47 min |
| 26 Jul 2026 | 06:54 | 07:24 | 30 min |
| 27 Jul 2026 | 06:52 | never (pulled by hand at 07:09) | — |

The crew badges in around 06:52 and the office opens roll call at 07:00, so the
app looks empty every morning. A systemd timer on a $5 box fires on schedule.

## What you need

- A DigitalOcean droplet (or any Ubuntu 22.04/24.04 box). **1GB RAM minimum** —
  Chromium will not fit in 512MB. The setup script adds 2GB of swap on small
  boxes, but 1GB is the sane floor.
- The Hik-Connect login and the Supabase **service_role** key.

## Setup

SSH into the droplet as root, then:

```sh
curl -fsSL https://raw.githubusercontent.com/ifrah87/cleaning/main/scraper/deploy/setup.sh -o setup.sh
bash setup.sh
```

The script installs Node 20, clones the repo, installs Chromium, adds swap if the
box is small, sets the timezone to EAT, and installs a systemd timer running
**every 5 minutes between 06:00 and 19:59 local time**.

Then fill in the credentials it created:

```sh
nano /etc/cleaning-scraper.env      # HIK_EMAIL, HIK_PASSWORD, SUPABASE_SERVICE_KEY
systemctl start cleaning-scraper.service    # run one now to prove it works
journalctl -u cleaning-scraper.service -f   # watch it
```

A healthy run ends with:

```
✅ Done. Pushed 7 records across 1 day(s): 2026-07-27 … 2026-07-27
```

## After it's confirmed working

Turn off the GitHub schedule so the two don't scrape in parallel. In
`.github/workflows/scrape.yml`, comment out the `schedule:` block and keep
`workflow_dispatch` so the Actions tab still gives you a manual button:

```yaml
on:
  # schedule:
  #   - cron: '*/5 3-16 * * *'
  workflow_dispatch: {}
```

Duplicate scrapes are harmless — the upsert dedupes on `person_name,event_time` —
but they waste Actions minutes and make the logs confusing.

## Also worth removing

The old launchd agent on the Mac,
`~/Library/LaunchAgents/com.orfane.cleaning-scraper.plist`, still fires and fails
with `ERR_INTERNET_DISCONNECTED` whenever the laptop is asleep:

```sh
launchctl unload ~/Library/LaunchAgents/com.orfane.cleaning-scraper.plist
rm ~/Library/LaunchAgents/com.orfane.cleaning-scraper.plist
```

## Checking it later

```sh
systemctl list-timers cleaning-scraper.timer      # when it next fires
journalctl -u cleaning-scraper.service --since today
```

To update the scraper after a code change, re-run `bash setup.sh` — it resets the
checkout to `origin/main` and restarts the timer.
