# Cleaning Ops

A daily operations app for the cleaning crew of a multi-storey office building. It
decides which rooms are due each day, hands them out to the cleaners, shows the day's
work on a TV board in the building, and records who arrived, who left and what was
cleaned.

The whole app is one HTML file (`index.html`) with no build step. Data lives in
Supabase, and attendance comes from the building's door badge reader.

## What it does

### Rooms and schedules
- Every serviced room has a cleaning frequency: **daily**, **every other day**, weekly,
  or on **fixed weekdays** chosen for that customer.
- Every-other-day rooms run on two fixed timetables:
  - **A:** Sat · Mon · Wed · Thu
  - **B:** Sat · Sun · Tue · Thu

  The app keeps the two timetables balanced by itself. A new room is placed on the
  lighter timetable, and an uneven floor is levelled automatically.
- A customer's days never move because a room was missed or not ticked off. A missed
  room comes back on its next own day.
- Before a closure, such as the Friday shutdown, every-other-day rooms are swept up on
  the last working day.
- A room can be paused, held until a date, or marked as cleaned on a different day.

### Handing out the work
- Rooms are grouped into **rounds**. Each round belongs to a **leader**, and assistants
  work alongside them on the same card.
- Each morning's plan is built from the standing rounds. Early rooms come first, and
  each leader gets a limited number of them.
- **⇄ Reassign** moves one or several rooms to anyone **for today**, **for tomorrow** or
  **from now on**. A hand-made change is never overwritten by the automatic deal.
- Rooms of someone who is off sick can be covered by the rest of the crew.

### The board
- The **Board** tab is the day at a glance: one card per leader with their rooms in
  order of urgency.
  - Early rooms are red and listed first.
  - Rooms that still need someone are amber.
  - Finished rooms turn green.
- A strip along the top shows everyone who is in, with their arrival time and, when
  the door recorded it, the time they left.
- Cleaners tick rooms off as they go. Each tick is written to a cleaning log.

### TV display
- `?tv=1` turns the board into a full-screen, read-only wall display.
- `tvapp/` is a small Android TV kiosk app that keeps the board open on the TV around
  the clock:
  - holds the screen awake;
  - reopens after a power cut;
  - reloads nightly to pick up new code;
  - reconnects when the network drops.

### Attendance
- The door badge reader records each scan in Hik-Connect.
- `scraper/` logs into Hik-Connect and reads the raw transaction log. It runs on a
  schedule in GitHub Actions: every 5 minutes in the morning to catch arrivals, and
  again in the late afternoon to catch departures.
  - Each person's first scan of the day is their arrival.
  - Their last scan, if it is at least an hour after the first, is when they left.
- If someone didn't scan, the office can type their arrival or leaving time on **Roll
  Call / Morning set-up**.
- `heartbeat.yml` keeps the scrape on time, because GitHub's own scheduler often runs
  hours late.

### Other tabs
| Tab | What it's for |
|---|---|
| **Board** | today's work, live |
| **Plan** | the plan for any day; edit who cleans what |
| **Calendar** | which rooms are due on which day |
| **Team** | staff, leaders, assistants, who owns which room |
| **Settings** | rooms, floors, frequencies, automation switches |

Short-term rental flats are a separate job with their own tab. They are cleaned after
the offices and kept off the morning roll call.

## How it's built

| Part | What it is |
|---|---|
| `index.html` | the whole app: plain JavaScript, HTML and CSS in one file, installable as a PWA (`manifest.webmanifest`, `sw.js`) |
| Supabase | login, plus three tables: `app_state` (the app's state as one JSON document, synced live between devices), `hik_events` (badge scans) and `cleaning_log` (every room ticked off) |
| `scraper/` | Node + Playwright scraper for Hik-Connect attendance |
| `.github/workflows/` | the scrape schedule and its heartbeat |
| `supabase/` | SQL for the attendance tables, plus edge functions for Hik sync and webhooks |
| `tvapp/` | the Android TV kiosk wrapper (no Gradle, see `tvapp/README.md`) |
| `tests/` | Playwright tests, one file per rule |

State is saved as one document, and **the last save wins**. Each hand edit is stamped
with a time, so when two devices' copies are merged, the newest hand edit is kept.

## Running it

1. Set up Supabase as described in [`SETUP.md`](SETUP.md).
2. Put the project URL and **anon** key at the top of `index.html`.
3. Serve the folder from any static host. There is no build step.

For attendance, run `node scraper/scrape.js` with these environment variables set:
`HIK_EMAIL`, `HIK_PASSWORD`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. This is how
GitHub Actions runs it, using repository secrets. Locally you can put the same details
in `scraper/config.json`, which is git-ignored because it holds secrets. See
`scraper/deploy/README.md` for ways to schedule it.

### Tests

```sh
cd scraper && npm install && cd ..
NODE_PATH="$(pwd)/scraper/node_modules" node tests/<test-file>.js
```

Each test serves the app locally, fakes the Supabase backend, and checks one rule. For
example, `a-chosen-day-pair-stands.js` checks that a customer's chosen days never move.
