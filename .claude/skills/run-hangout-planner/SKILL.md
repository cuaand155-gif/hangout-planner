---
name: run-hangout-planner
description: Run, start, screenshot and drive Waddle (the hangout-planner web app) locally in headless Chromium, including signed-in friend and sharing features with a fake Supabase. Use when asked to run the app, take a screenshot of it, click through a flow, check a UI change, or run its tests.
---

Waddle is a no-build vanilla-JS web app (`index.html` + `app.js`, public booking page `book.html`) with Vercel-style API handlers in `api/`. Locally, `scripts/dev-server.mjs` serves both. Drive it with `.claude/skills/run-hangout-planner/driver.mjs`, a Playwright script that reads one command per line from stdin. For a repeatable check of the main flows, run the browser suite (`npm run test:e2e`, see Test). Both share their browser setup (stubs, seeded storage, error collection) through `session.mjs` in this folder. All paths are relative to the repo root.

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
- `/api/book` answers 503 "Booking links are not set up on this server yet." (the owner's Cancel button then cancels straight in the database, so it still works with `--signed-in`).

## Run (agent path): the driver

```bash
node .claude/skills/run-hangout-planner/driver.mjs [--signed-in] [--group-events] [--google-server] [--phone] [--theme dark] <<'EOF'
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
- `--google-server` answers `/api/google` as if `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` were set and a refresh token stored: the app syncs one event ("Server-synced brunch", two days out) with no browser token, and the Calendar links copy says it keeps syncing on its own. Without the flag the dev server answers `{configured:false}`, so the hourly browser-token flow is what you see.
- `--group-events` seeds the demo group so Jamie and Taylor share named events with places, and the group allows event details. The group view then shows name · person · place blocks.

**`--signed-in` in detail.** The fake is an in-memory database with you ("Alexi"), an accepted friend "Sam Rivera" who has "free now" turned on, and shares from Sam.
- It seeds two of your own events today (Therapy 9–10, Soccer 18–20), so My calendar, the named event blocks on the week grid, Who sees what, the booking dialog (save returns the row), Friends and the Free now strip all work.
- Like a real database it keeps what was written across reloads (localStorage `fake-db`), and `publish_share` / `shared_calendars` follow `supabase/schema.sql` (friends only; a temporary share falls back on its own). `window.__fakeDb` is the database. Set localStorage `fake-user` to `sam` or `jordan` before a load to be someone else.
- Edit `fake-supabase.js` to add tables or RPC answers.
- To start with some rows, seed any table before a second `nav` (the seed is used once). For a saved booking link: `eval localStorage.setItem('fake-seed', JSON.stringify({booking_pages:[{id:'p1', owner_id:'11111111-1111-1111-1111-111111111111', handle:'alexi', title:'Coffee chat', owner_name:'Alexi', settings:{}, busy:[], ics_urls:[], active:true, feed_token:'f'.repeat(32)}]}))`. Then `calls` shows the app keeping that page's `busy` in step with your calendars. Add `bookings:[{id, page_id:'p1', start_at, end_at, guest_name, guest_email, note:'', status:'confirmed'}]` to the same seed to get upcoming bookings with Cancel buttons (`[data-cancel-booking]`; the confirm prompt needs accepting).

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
npm test          # node --test "test/*.test.mjs"; 229 passing, about 5 s
npm run test:e2e  # node --test "test/e2e/*.e2e.mjs"; 50 browser tests, about 2.5 min
```

`npm test` covers the API handlers with a faked `fetch` (PostgREST, Supabase auth, Google, Resend: nothing real is called and no email is ever sent), the pure logic in `lib/` (booking, sharing, hangout, ics, …), and the offline-shell list in `sw.js`. `test/book-services.test.mjs` covers the booking page's Google freeBusy check and the booking emails. Database policies are checked separately by `supabase/rls-shares-test.sql`, run in a rolled-back transaction against a real project.

`npm run test:e2e` starts its own dev server on a free port (no need to start or stop one yourself), runs `test/e2e/app.e2e.mjs` in headless Chromium and stops the server. It covers the flows above: group view, plan → vote → pick → RSVP, painting My availability, the My availability details switch, Google connect via `?calendar=1` and disconnect, the `--google-server` sync, Who sees what, Free now, a public booking page (book and cancel, against a stubbed `/api/book`), the owner cancelling a booking, the activity bell, a friend's calendar, every Who sees what level as the friend sees it (a second browser signed in as Sam opens the row Alexi's device published), sharing more for a while, sharing choices on a second device, a friend request sent and accepted across two browsers, Settings (lock, export, reset), the phone day strip, the usual week, groups (create, rename, switch, checklist), people (invite link, placeholder, remove), repeating plans, add to calendar (the .ics file and the Google link; Google is never opened), ideas with photos, profile and palette, an ICS link (a routed `/api/calendar` runs `lib/ics.js` on a real .ics), best-time cards, booking link setup (persisted in the fake database), the sign-in gate (`/api/workspace` routed to answer 401 as it does with a database), the offline shell with the service worker allowed, the install button, layout checks (event chips show only whole lines, the YOU badge clears the status dot, friend rows have no dead space, the phone hero row and menu backdrop), and phone and dark-theme smoke tests. Every test fails on page errors. Without Playwright (at `PLAYWRIGHT_PATH`, default `/opt/node22/lib/node_modules/playwright/index.mjs`) every test is skipped with a message. To add a flow, use `browserTest(name, { signedIn, googleServer, groupEvents, phone, theme, as, seed, serviceWorkers }, async ({ page, context, go, google, open }) => …)` in that file; `openSession` in `session.mjs` takes the same options as the driver's flags. `as` ("alexi", "sam" or "jordan") picks who the fake signs in as, `seed` ({ table: rows }) starts the fake database with those rows, `serviceWorkers: true` lets `sw.js` run (it is blocked otherwise), and `open(options)` starts a second browser in the same test (another person, or another device).

## Gotchas

- **The app needs about 1.5 s after load** before it renders the group, because it waits for `/api/workspace`. `nav` already waits for that. Use `wait-for` on the thing you need rather than extra sleeps.
- **Service worker.** On localhost `sw.js` registers unless the URL has `?nosw`. Within one driver run it can serve a cached `app.js`, so use `/?nosw` while you're changing code.
- **`open <dialog>` skips the app's fill step.** For example, Settings shows an empty group name and "Shortest window". To see a dialog as users do, click its real button (`#settingsButton`, `#bookingButton`, `#sharingButton` …).
- **With `--phone` the sidebar is off-screen.** `click #calendarButton` times out until you `click #mobileMenu` first.
- **Theme switches animate** (view transition), so `wait 600` before reading `document.documentElement.dataset.theme`.
- **Two layers on the week grid.** On the group view, `.event-chip` shows name · person · place for events people share, plus your own. On My availability, `.busy-block` shows your calendar events as plain busy blocks; the `#mineDetailsToggle` switch ("Show event details", remembered in `gatherly-mine-details`) swaps them for `.event-chip`s with your own event names, places and times. Both are positioned from the laid-out cells, and are re-drawn when the grid resizes. They're `pointer-events:none`, so painting busy hours still works underneath.
- **RSVP and calendar-add controls stay hidden until a time is picked:** click a `.time-option [data-window]` first.
- **The sign-in gate for groups only happens with a database.** In demo mode `/?w=anything` opens normally. To see the gate, stub `/api/workspace` to return `401 {"signIn":true}` (Playwright `page.route`).
- **External requests fail in this sandbox.** The driver aborts Google Fonts (so the fallback serif and sans fonts render) and hides `ERR_FAILED` / `ERR_TUNNEL_CONNECTION_FAILED` noise. Without `--signed-in`, the Supabase CDN script fails too, so auth buttons toast "Google sign-in needs provider credentials first."
- **`localStorage` keys keep the old `gatherly-` prefix** (`gatherly-appearance`, `gatherly-sharing`, `gatherly-my-events` …).
