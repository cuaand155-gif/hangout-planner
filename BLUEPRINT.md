# Waddle blueprint

The complete picture of what Waddle is supposed to do, where each piece lives, what proves it works, and what's left. Use it as the checklist before calling Waddle "done", and update it whenever a feature is added or changed. The product rules for what each view may show are in [CLAUDE.md](CLAUDE.md) and win over anything here.

Last checked: 2026-09-26 (database rules on the live project: 38/38). Tests: 2026-09-25, master `f4199d1` plus the rest of Phase A (merged straight after). 229 unit/API tests and 50 browser tests, all passing (the browser suite ran twice in a row).

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
| Opening a group needs sign-in (when the database is on) | `api/workspace.js` 401 gate | e2e "sign-in gate" (signed out: the gate, nothing loaded or saved; signed in: the group opens), with `/api/workspace` answering as it does with a database; `api`, `groups-api` tests | ✅ |
| Create, rename and switch between groups | "Your groups", `lib/groups.js`, `api/groups.js` | e2e "create a group, rename it, switch…"; `groups-api`, `groups-sync` tests | ✅ |
| Invite link, add a placeholder person, remove someone | People dialog, `lib/membership.js` | e2e "invite link, a placeholder person, and removing people"; `membership` tests | ✅ |
| Friend requests (send, accept) | Friends tab, `lib/friends.js` | e2e "send a friend request, they accept it…" (two browsers); `friends` tests | ✅ |
| Getting-started checklist for new groups | `lib/checklist.js` | e2e "getting-started checklist…"; `checklist` tests | ✅ |
| Activity feed / bell | `#activityButton` | e2e "the bell shows a dot for news…" | ✅ |
| Profile: name, avatar colours | `lib/avatar.js`, `lib/palettes.js` | e2e "profile name and photo…; the colour palette"; `avatar`, `palettes` tests | ✅ |

### Calendars in

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Connect Google Calendar, then disconnect | Calendar links, `app.js` | e2e "connect Google…" | ✅ |
| Google keeps syncing past the hour, on every device | `api/google.js` | e2e `--google-server`; `google-api` tests | ✅ (real Google: 🙋) |
| Any ICS link (iCloud, Outlook, Google secret address) | `api/calendar.js`, `lib/ics.js` | e2e "an ICS link…" (a real .ics parsed by `lib/ics.js`; only the download is faked); `api`, `ics` tests for fetching and its safety checks | ✅ |
| Paint your own busy hours | My availability | e2e "painting marks hours busy" | ✅ |
| Save as my usual week; I'm free all week | `#saveUsualWeek`, `#clearMyWeek` | e2e "save as my usual week…"; `planner` tests | ✅ |

### Seeing schedules (rules in CLAUDE.md)

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Group view: who's free, plus name · person · place blocks | `renderEventLayer` | e2e layout "event chips…" | ✅ |
| My availability: busy blocks, or your schedule with "Show event details" | `#mineDetailsToggle` | e2e "plain busy blocks, or…" | ✅ |
| Group calendar: one row per person, names only when the group allows | `renderGroupCalendar` | e2e "group calendar" | ✅ |
| Your calendar agenda: pick events to share, lock private ones | `#mycalendar` | e2e "Who sees what: a private event…" | ✅ |
| A friend's calendar view | Friends → Calendar | e2e "Friends → Calendar shows what they shared…" | ✅ |
| Best-time cards and the chosen window | `bestTimes`, `planner.js` | e2e "best-time cards…"; `planner` tests | ✅ |
| Phone: one day at a time | `#dayStrip` | e2e "one day at a time: pick a day from the strip, or swipe" | ✅ |

### Sharing and privacy

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Levels: Nothing / Busy / Picked / Everything; per-friend override; group level | Who sees what, `lib/sharing.js` | e2e "who sees what, as a friend sees it" (each level opened in a second browser as Sam; the group level checked in what the group receives); `sharing` tests | ✅ |
| Share more for a while (today, weekend, 24 h, 7 days) | `grantEnd`, `publish_share` RPC | e2e "share more for a while…" (start, until, fallback, stop); `sharing` tests | ✅ |
| Private events hidden from everyone (only a hash is stored) | `hideHash`, `withoutHidden` | `sharing` tests; e2e (preview, as Sam, and in the group) | ✅ |
| Choices sync across devices | `sharing_settings`, `mergeSharing` | e2e "sharing choices follow you to another device" (second browser, fake database); `sharing` tests | ✅ (real accounts: 🙋) |
| Database only lets friends read what was shared | RLS, `publish_share`, `shared_calendars` | `supabase/rls-test.sql` (14 checks) and `supabase/rls-shares-test.sql` (24 checks), run against the live project inside a transaction that rolls back | ✅ 38/38 on 2026-09-26 |
| Free now status and strip | `lib/presence.js` | e2e "Free now strip" | ✅ |

### Plans

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Propose a plan, vote on times, pick one, RSVP | Tentative plan, `lib/hangout.js` | e2e "propose a plan…" | ✅ |
| Repeating plans (weekly etc.) | `#planRepeat` | e2e "repeating plans roll on…"; `hangout` tests | ✅ |
| Add to calendar (.ics file or Google link) | `lib/calendar-export.js` | e2e "add to calendar…" (the .ics file and the Google link's contents; Google itself is never opened); `calendar-export` tests | ✅ |
| Activity ideas with photos | Ideas section | e2e "an idea with a photo…"; `idea-photos` tests | ✅ |

### Booking links

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Owner sets up a link: days, hours, length, gap, notice | `booking-owner.js`, `lib/booking.js` | e2e "set up a booking link, and every setting is still there after a reload"; `booking` tests | ✅ |
| Guest picks a time, books, cancels | `book.html`, `api/book.js` | e2e "pick a time, book it…"; `book-api` tests | ✅ |
| Blocks your calendars' busy times (never names) | `busyForBooking`, `api/book.js` | e2e owner setup (the link stores busy times only, no names or places); `booking`, `book-api` tests | 🧪 (the blocking itself runs in `api/book.js` against the database, so only the API tests prove it) |
| Checks Google directly while Waddle is closed | `googleFreeBusy` | `book-services` tests | 🧪 (server only, no screen; real Google: 🙋) |
| Owner sees and cancels bookings | Booking dialog | e2e "cancelling…" (both paths) | ✅ |
| Confirmation and cancellation emails | `api/_email.js` | `book-services` tests; e2e copy check | 🧪 (off until email is set up; tests never send real email) |

### App-wide

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Light / dark / auto theme | `lib/appearance.js` | e2e dark smoke; `appearance` tests | ✅ |
| Phone layout, menu drawer with backdrop | `styles.css` | e2e phone tests | ✅ |
| Install to home screen, works offline | `sw.js`, `lib/pwa.js` | e2e "home screen app" (the shell is cached and the page opens offline; the Install button; the iPhone steps); `pwa` tests | ✅ |
| Settings: lock group, export, reset | `#settingsButton` | e2e "settings" (lock signed out and in, export, reset) | ✅ |

## 4. The plan

### Phase A: automate what's still hand-checked (Claude can do all of it)

Goal: every row above is ✅ or has a named reason it can't be.

1. [x] Browser tests for the 👀 rows: activity feed, a friend's calendar view, settings (lock, export, reset), the phone day strip.
2. [x] Browser tests for 🧪 rows that have a screen: each sharing level as a friend sees it (plus the per-friend override and the group level), "share more for a while", sharing choices on a second device, send and accept a friend request, save as usual week, create and switch groups, invite and remove a person, repeating plans, add to calendar, ideas with photos, booking owner setup, the sign-in gate, the offline shell and install, the checklist, profile, an ICS link and best-time cards.
3. [x] One command runs everything: `npm test && npm run test:e2e`, noted in the README.
4. [x] Update this file's status column and the "last checked" line.

Found and fixed along the way (2026-09-25):
- On a phone, one swipe moved several days: the day strip, best-time and swipe listeners were added again on every redraw (`app.js`, now wired once).
- A shared event's place never reached the group: `replaceBusyRange` dropped it, and `sameBusy` didn't compare it (`lib/planner.js`, `lib/sync.js`, with unit tests).
- "Reset this device" kept the imported calendar events, names included, after removing their calendar links (`app.js`).
- Your groups kept a renamed group's old name until it was opened again (`lib/groups.js` `renameGroup`, with a unit test).
- A group behind the sign-in gate was saved to Your groups as "Weekend crew"; now a group is listed once it has opened (`app.js`).

Done when: all rows are ✅ except the 🙋 ones, and both test commands pass. Done 2026-09-25: the rows still marked 🧪 are ones no browser can prove (database policies, server-only checks, real email).

### Phase B: things only Alexi can do

1. ~~**Reconnect Google once**~~ Done: the server holds a Google connection saved 2026-09-25 with the live keys.
2. **Two-account test with a friend**: both sign in, add each other, check sharing levels, private events, Free now, a shared plan, and the group calendar. Open your booking link in a private window; Google events should show as unavailable.
3. **Google's "unverified app" warning**: add friends as test users in Google Cloud (quick), or apply for verification (weeks).
4. **Booking emails** (optional): buy a domain, create a free Resend account, then add `RESEND_API_KEY` and `BOOKING_EMAIL_FROM` in Vercel.
5. ~~**Tidy-up**~~ Done 2026-09-26: the Google key file is in Drive's trash (the keys live in Vercel).

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
