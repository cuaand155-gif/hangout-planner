---
name: run-hangout-planner
description: Run, start, screenshot and drive Waddle (the hangout-planner web app) locally in headless Chromium, including signed-in friend and sharing features with a fake Supabase. Use when asked to run the app, take a screenshot of it, click through a flow, check a UI change, or run its tests.
---

Waddle is a no-build vanilla-JS web app (`index.html` + `app.js`, public booking page `book.html`) with Vercel-style API handlers in `api/`. Locally, `scripts/dev-server.mjs` serves both. Drive it with `.claude/skills/run-hangout-planner/driver.mjs`, a Playwright script that reads one command per line from stdin. All paths are relative to the repo root.

## Prerequisites

Node 22 and Playwright with Chromium are already in this container (`/opt/node22/lib/node_modules/playwright`, browsers in `/opt/pw-browsers`). Don't run `playwright install`. There are no npm dependencies to install.

## Start the dev server

```bash
(PORT=4173 node scripts/dev-server.mjs > /tmp/waddle-dev.log 2>&1 &)
timeout 20 bash -c 'until curl -sf http://localhost:4173/ >/dev/null; do sleep 0.3; done' && echo up
```

Stop it: `fuser -k 4173/tcp`. Never use `pkill -f node`: it matches the agent's own shell and kills the session.

Without `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` the server runs in demo mode:
- `/api/workspace` serves the sample "Weekend crew" group and saves nothing.
- `/api/book` answers 503 "Booking links are not set up on this server yet."

## Run (agent path): the driver

```bash
node .claude/skills/run-hangout-planner/driver.mjs [--signed-in] [--phone] [--theme dark] <<'EOF'
nav /?nosw
click [data-plan-idea]
select #planRepeat weekly
click #tentativePlanForm button[type=submit]
wait-for .time-option
click .time-vote
click .time-option [data-window]
wait-for [data-rsvp="yes"]
click [data-rsvp="yes"]
text #rsvpSummary
shot plan #tentativePlanSection
errors
EOF
```

Each line prints `ok  <command>` or `ERR <command>` followed by the reason. Screenshots are saved to `$SHOTS`, which defaults to `/tmp/waddle-shots/`. Open them with Read to look at them.

| command | does |
|---|---|
| `nav <path>` | open a page and wait 1.5 s for the first render. Use `/?nosw` to skip the service worker |
| `click <sel>` / `fill <sel> <text>` / `select <sel> <value>` / `press <key>` | interact (8 s timeout) |
| `wait <ms>` / `wait-for <sel>` | wait |
| `text <sel>` / `eval <js>` | print text or a JSON value |
| `open <dialogId>` | `showModal()` a dialog directly (skips its fill logic, see Gotchas) |
| `shot <name> [sel]` / `shot-full <name>` | viewport, one element, or the full page |
| `errors` | page errors and console errors, minus the known network noise |
| `calls` | (`--signed-in`) every database call the page made (`publish_share`, upserts, …) |
| `toast` | current toast text |

**Flags:**
- `--phone` gives an iPhone 13 viewport, where the sidebar moves behind `#mobileMenu`.
- `--theme dark` switches to the dark theme.
- `--signed-in` replaces supabase-js with `fake-supabase.js` (see below). It also answers Google Calendar's events API with two events tomorrow: `nav /?calendar=1` runs the "back from Connect Google Calendar" path (keeps the token, syncs).
- `--group-events` seeds the demo group so Jamie and Taylor share named events with places, and the group allows event details. The group view then shows name · person · place blocks.

**`--signed-in` in detail.** The fake is an in-memory database with you ("Alexi"), an accepted friend "Sam Rivera" who has "free now" turned on, and shares from Sam.
- It seeds two of your own events today (Therapy 9–10, Soccer 18–20), so My calendar, the named event blocks on the week grid, Who sees what, the booking dialog (save returns the row), Friends and the Free now strip all work.
- Edit `fake-supabase.js` to add tables or RPC answers.

Useful selectors:

| Where | Selectors |
|---|---|
| Sidebar | `#settingsButton`, `#bookingButton`, `#calendarButton`, `#managePeople` (then `#friendsTab`) |
| Plans | `#tentativePlanButton`, `[data-plan-idea]`, `.time-vote`, `.time-option [data-window]`, `[data-rsvp=yes]` |
| My calendar | `#sharingButton`, `[data-private-title="Therapy"]`, `#mycalPreview` |
| Status | `#freeStart` |

## Run (human path)

`npm run dev`, then open http://localhost:4173. This is useless headless.

## Test

```bash
npm test     # node --test "test/*.test.mjs"; 194 passing
```

Tests cover the API handlers with a fake PostgREST, the pure logic in `lib/` (booking, sharing, hangout, ics, …), and the offline-shell list in `sw.js`. Database policies are checked separately by `supabase/rls-shares-test.sql`, run in a rolled-back transaction against a real project.

## Gotchas

- **The app needs about 1.5 s after load** before it renders the group, because it waits for `/api/workspace`. `nav` already waits for that. Use `wait-for` on the thing you need rather than extra sleeps.
- **Service worker.** On localhost `sw.js` registers unless the URL has `?nosw`. Within one driver run it can serve a cached `app.js`, so use `/?nosw` while you're changing code.
- **`open <dialog>` skips the app's fill step.** For example, Settings shows an empty group name and "Shortest window". To see a dialog as users do, click its real button (`#settingsButton`, `#bookingButton`, `#sharingButton` …).
- **With `--phone` the sidebar is off-screen.** `click #calendarButton` times out until you `click #mobileMenu` first.
- **Theme switches animate** (view transition), so `wait 600` before reading `document.documentElement.dataset.theme`.
- **Two layers on the week grid.** On the group view, `.event-chip` shows name · person · place for events people share, plus your own. On My availability, `.busy-block` shows your calendar events as plain busy blocks. Both are positioned from the laid-out cells, and are re-drawn when the grid resizes. They're `pointer-events:none`, so painting busy hours still works underneath.
- **RSVP and calendar-add controls stay hidden until a time is picked:** click a `.time-option [data-window]` first.
- **The sign-in gate for groups only happens with a database.** In demo mode `/?w=anything` opens normally. To see the gate, stub `/api/workspace` to return `401 {"signIn":true}` (Playwright `page.route`).
- **External requests fail in this sandbox.** The driver aborts Google Fonts (so the fallback serif and sans fonts render) and hides `ERR_FAILED` / `ERR_TUNNEL_CONNECTION_FAILED` noise. Without `--signed-in`, the Supabase CDN script fails too, so auth buttons toast "Google sign-in needs provider credentials first."
- **`localStorage` keys keep the old `gatherly-` prefix** (`gatherly-appearance`, `gatherly-sharing`, `gatherly-my-events` …).
