# Waddle blueprint

The complete picture of what Waddle is supposed to do, where each piece lives, what proves it works, and what's left. Use it as the checklist before calling Waddle "done", and update it whenever a feature is added or changed. The product rules for what each view may show are in [CLAUDE.md](CLAUDE.md) and win over anything here.

Last checked: 2026-09-25, master `2b72c38` plus the Phase A browser tests and fixes. 228 unit/API tests and 34 browser tests, all passing (the browser suite ran twice in a row).

## 1. What Waddle is

A hangout planner for friend groups. Everyone's calendars feed one shared week so the group can see when people are free, pencil in a plan, vote on a time and RSVP. Friends can see each other's schedules at the level each person chooses. A public booking link lets anyone else book open time.

Live: https://hangout-planner-omega.vercel.app (also hangout-planner-cuacua.vercel.app).

## 2. How it's built

| Layer | What | Where |
|---|---|---|
| App | Vanilla JS, no build step: one page plus the public booking page | `index.html`, `app.js`, `styles.css`, `book.html`, `book.js`, `booking-owner.js`, `lib/*.js` |
| Offline / install | Service worker and manifest (installable on a phone home screen) | `sw.js`, `manifest.webmanifest`, `lib/pwa.js` |
| Server | Vercel functions | `api/workspace.js` (groups), `api/groups.js`, `api/calendar.js` (ICS links), `api/google.js` (Google sync), `api/book.js` (booking links), `api/_email.js` (booking emails) |
| Database | Supabase Postgres with row-level security | Tables: `workspaces`, `profiles`, `friend_requests`, `calendar_shares`, `sharing_settings`, `presence`, `booking_pages`, `bookings`, `google_tokens`. Schema in `supabase/schema.sql`; policy checks in `supabase/rls-*.sql` |
| Sign-in | Google through Supabase Auth | `app.js` (`signInWithOAuth`) |
| Hosting | Vercel project `hangout-planner`, deploys `master` automatically | `vercel.json` |

### Settings the live site needs (Vercel environment variables)

| Setting | Status | Turns on |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (+ Supabase integration vars) | ✅ set | Groups, friends, sharing, booking links |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ✅ set 2026-09-25 | Google Calendar keeps syncing past an hour; booking links check Google while Waddle is closed |
| `RESEND_API_KEY`, `BOOKING_EMAIL_FROM` | ⬜ not set (needs a domain you own) | Booking confirmation and cancellation emails |

## 3. Feature inventory

Status key: ✅ proven by an automated browser test · 🧪 proven by unit/API tests only · 👀 checked by hand only · 🙋 needs Alexi (real accounts or a decision). A 🧪 row says why it isn't ✅ yet.

### Groups and people

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Demo group loads with no errors | `app.js` | e2e "loads the demo group" | ✅ |
| Opening a group needs sign-in (when the database is on) | `api/workspace.js` 401 gate | `test/api.test.mjs`, `test/groups-api.test.mjs` | 🧪 (browser test not written yet: Phase A item 2) |
| Create, rename and switch between groups | "Your groups", `lib/groups.js`, `api/groups.js` | `groups-api`, `groups-sync` tests; renaming also runs in e2e "activity bell" | 🧪 (browser test not written yet: Phase A item 2) |
| Invite link, add a placeholder person, remove someone | People dialog, `lib/membership.js` | `membership` tests | 🧪 (browser test not written yet: Phase A item 2) |
| Friend requests (send, accept) | Friends tab, `lib/friends.js` | e2e "send a friend request, they accept it…" (two browsers); `friends` tests | ✅ |
| Getting-started checklist for new groups | `lib/checklist.js` | `checklist` tests | 🧪 (browser test not written yet: Phase A item 2) |
| Activity feed / bell | `#activityButton` | e2e "the bell shows a dot for news…" | ✅ |
| Profile: name, avatar colours | `lib/avatar.js`, `lib/palettes.js` | `avatar`, `palettes` tests | 🧪 (browser test not written yet: Phase A item 2) |

### Calendars in

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Connect Google Calendar, then disconnect | Calendar links, `app.js` | e2e "connect Google…" | ✅ |
| Google keeps syncing past the hour, on every device | `api/google.js` | e2e `--google-server`; `google-api` tests | ✅ (real Google: 🙋) |
| Any ICS link (iCloud, Outlook, Google secret address) | `api/calendar.js`, `lib/ics.js` | `api`, `ics` tests | 🧪 (browser test not written yet: Phase A item 2) |
| Paint your own busy hours | My availability | e2e "painting marks hours busy" | ✅ |
| Save as my usual week; I'm free all week | `#saveUsualWeek`, `#clearMyWeek` | `planner` tests (weekly blocks) | 🧪 (browser test not written yet: Phase A item 2) |

### Seeing schedules (rules in CLAUDE.md)

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Group view: who's free, plus name · person · place blocks | `renderEventLayer` | e2e layout "event chips…" | ✅ |
| My availability: busy blocks, or your schedule with "Show event details" | `#mineDetailsToggle` | e2e "plain busy blocks, or…" | ✅ |
| Group calendar: one row per person, names only when the group allows | `renderGroupCalendar` | e2e "group calendar" | ✅ |
| Your calendar agenda: pick events to share, lock private ones | `#mycalendar` | e2e "Who sees what: a private event…" | ✅ |
| A friend's calendar view | Friends → Calendar | e2e "Friends → Calendar shows what they shared…" | ✅ |
| Best-time cards and the chosen window | `bestTimes`, `planner.js` | `planner` tests | 🧪 (browser test not written yet: Phase A item 2) |
| Phone: one day at a time | `#dayStrip` | e2e "one day at a time: pick a day from the strip, or swipe" | ✅ |

### Sharing and privacy

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Levels: Nothing / Busy / Picked / Everything; per-friend override; group level | Who sees what, `lib/sharing.js` | e2e "who sees what, as a friend sees it" (each level opened in a second browser as Sam; the group level checked in what the group receives); `sharing` tests | ✅ |
| Share more for a while (today, weekend, 24 h, 7 days) | `grantEnd`, `publish_share` RPC | e2e "share more for a while…" (start, until, fallback, stop); `sharing` tests | ✅ |
| Private events hidden from everyone (only a hash is stored) | `hideHash`, `withoutHidden` | `sharing` tests; e2e (preview, as Sam, and in the group) | ✅ |
| Choices sync across devices | `sharing_settings`, `mergeSharing` | e2e "sharing choices follow you to another device" (second browser, fake database); `sharing` tests | ✅ (real accounts: 🙋) |
| Database only lets friends read what was shared | RLS, `publish_share`, `shared_calendars` | `supabase/rls-shares-test.sql` (run against the live project) | 🧪 (a database policy: only SQL against the real project can prove it, not a browser) |
| Free now status and strip | `lib/presence.js` | e2e "Free now strip" | ✅ |

### Plans

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Propose a plan, vote on times, pick one, RSVP | Tentative plan, `lib/hangout.js` | e2e "propose a plan…" | ✅ |
| Repeating plans (weekly etc.) | `#planRepeat` | `hangout` tests; e2e "propose a plan" saves a weekly one | 🧪 (browser test not written yet: Phase A item 2) |
| Add to calendar (.ics file or Google link) | `lib/calendar-export.js` | `calendar-export` tests | 🧪 (browser test not written yet: Phase A item 2) |
| Activity ideas with photos | Ideas section | `idea-photos` tests | 🧪 (browser test not written yet: Phase A item 2) |

### Booking links

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Owner sets up a link: days, hours, length, gap, notice | `booking-owner.js`, `lib/booking.js` | `booking` tests | 🧪 (browser test not written yet: Phase A item 2) |
| Guest picks a time, books, cancels | `book.html`, `api/book.js` | e2e "pick a time, book it…"; `book-api` tests | ✅ |
| Blocks your calendars' busy times (never names) | `busyForBooking`, `api/book.js` | `booking`, `book-api` tests | 🧪 (the blocking happens in `api/book.js`, which needs the database; the owner-side browser test is still to write) |
| Checks Google directly while Waddle is closed | `googleFreeBusy` | `book-services` tests | 🧪 (server only, no screen; real Google: 🙋) |
| Owner sees and cancels bookings | Booking dialog | e2e "cancelling…" (both paths) | ✅ |
| Confirmation and cancellation emails | `api/_email.js` | `book-services` tests; e2e copy check | 🧪 (off until email is set up; tests never send real email) |

### App-wide

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Light / dark / auto theme | `lib/appearance.js` | e2e dark smoke; `appearance` tests | ✅ |
| Phone layout, menu drawer with backdrop | `styles.css` | e2e phone tests | ✅ |
| Install to home screen, works offline | `sw.js`, `lib/pwa.js` | `pwa` tests (shell list) | 🧪 (browser test not written yet: Phase A item 2) |
| Settings: lock group, export, reset | `#settingsButton` | e2e "settings" (lock signed out and in, export, reset) | ✅ |

## 4. The plan

### Phase A: automate what's still hand-checked (Claude can do all of it)

Goal: every row above is ✅ or has a named reason it can't be.

1. [x] Browser tests for the 👀 rows: activity feed, a friend's calendar view, settings (lock, export, reset), the phone day strip.
2. [ ] Browser tests for 🧪 rows that have a screen. Done: each sharing level as a friend sees it (plus the per-friend override and the group level), "share more for a while" (start, until, stop), sharing choices on a second device, send and accept a friend request. Still to write (stopped here at Alexi's "finish it"): save as usual week, create and switch groups, invite and remove a person, repeating plans, add to calendar, ideas with photos, booking owner setup, the sign-in gate, the offline shell, and the checklist, profile, ICS link and best-time rows.
3. [x] One command runs everything: `npm test && npm run test:e2e`, noted in the README.
4. [x] Update this file's status column and the "last checked" line.

Found and fixed along the way (2026-09-25):
- On a phone, one swipe moved several days: the day strip, best-time and swipe listeners were added again on every redraw (`app.js`, now wired once).
- A shared event's place never reached the group: `replaceBusyRange` dropped it, and `sameBusy` didn't compare it (`lib/planner.js`, `lib/sync.js`, with unit tests).
- "Reset this device" kept the imported calendar events, names included, after removing their calendar links (`app.js`).

Done when: all rows are ✅ except the 🙋 ones, and both test commands pass.

### Phase B: things only Alexi can do

1. **Reconnect Google once** (Calendar links → remove Google → Connect) so the server keeps syncing.
2. **Two-account test with a friend**: both sign in, add each other, check sharing levels, private events, Free now, a shared plan, and the group calendar. Open your booking link in a private window; Google events should show as unavailable.
3. **Google's "unverified app" warning**: add friends as test users in Google Cloud (quick), or apply for verification (weeks).
4. **Booking emails** (optional): buy a domain, create a free Resend account, then add `RESEND_API_KEY` and `BOOKING_EMAIL_FROM` in Vercel.
5. **Tidy-up**: delete the Google key file from Google Drive (it's now stored in Vercel).

### Phase C: ideas for later (not started, need a yes)

- Reminders before a plan starts.
- Suggest a time automatically from everyone's free windows and open votes.
- A shared plan chat or comments.

## 5. Release checklist (run before calling any change done)

- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes.
- [ ] Views still follow CLAUDE.md: busy/free by default, names only when the owner switches them on, booking links show open times only.
- [ ] Checked on desktop, on a phone, and in dark mode, with no page errors.
- [ ] Merged to `master`, the Vercel production deploy is Ready, and the live page shows the change.
- [ ] This blueprint's status table and CLAUDE.md are updated if anything changed.
