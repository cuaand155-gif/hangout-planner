# Waddle blueprint

The complete picture of what Waddle is supposed to do, where each piece lives, what proves it works, and what's left. Use it as the checklist before calling Waddle "done", and update it whenever a feature is added or changed. The product rules for what each view may show are in [CLAUDE.md](CLAUDE.md) and win over anything here.

Last checked: 2026-10-02, after the development-manager review (best time, plan comments, locked groups): 289 unit/API tests and 69 browser tests, all passing; `rls-server-test.sql` 10/10 on the live project. Database rules re-checked on the live project 2026-10-01 after the phone-number schema: `rls-test.sql` 22/22 and `rls-shares-test.sql` 24/24.

## 1. What Waddle is

A hangout planner for friend groups. Everyone's calendars feed one shared week so the group can see when people are free, pencil in a plan, vote on a time and RSVP. Friends can see each other's schedules at the level each person chooses. A public booking link lets anyone else book open time.

Live: https://hangout-planner-omega.vercel.app (also hangout-planner-cuacua.vercel.app).

## 2. How it's built

| Layer | What | Where |
|---|---|---|
| App | Vanilla JS, no build step: one page plus the public booking page | `index.html`, `app.js`, `styles.css`, `book.html`, `book.js`, `booking-owner.js`, `lib/*.js` |
| Offline / install | Service worker and manifest (installable on a phone home screen) | `sw.js`, `manifest.webmanifest`, `lib/pwa.js` |
| Server | Vercel functions | `api/workspace.js` (groups), `api/push.js`, `api/notify.js`, `api/cron.js` (notifications), `api/page.js`, `api/og.js` (link previews), `api/groups.js`, `api/calendar.js` (ICS links), `api/google.js` (Google sync), `api/book.js` (booking links), `api/_email.js` (booking emails) |
| Database | Supabase Postgres with row-level security | Tables: `workspaces`, `profiles`, `friend_requests`, `calendar_shares`, `sharing_settings`, `presence`, `booking_pages`, `bookings`, `google_tokens`, `push_subscriptions`, `notification_log`. Schema in `supabase/schema.sql`; policy checks in `supabase/rls-*.sql` |
| Sign-in | Google, or a texted code to your phone, through Supabase Auth | `app.js` (`signInWithOAuth`, `signInWithOtp`/`verifyOtp`), `lib/phone.js` |
| Hosting | Vercel project `hangout-planner`, deploys `master` automatically | `vercel.json` |

### Settings the live site needs (Vercel environment variables)

| Setting | Status | Turns on |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (+ Supabase integration vars) | ✅ set | Groups, friends, sharing, booking links |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ✅ set 2026-09-25 | Google Calendar keeps syncing past an hour; booking links check Google while Waddle is closed |
| `RESEND_API_KEY`, `BOOKING_EMAIL_FROM` | ⬜ not set (needs a domain you own) | Booking confirmation and cancellation emails |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | ✅ set 2026-09-27 | Phone/desktop push notifications |
| `CRON_SECRET` (also in Supabase Vault as `waddle_cron_secret`) | ✅ set 2026-09-27 | Supabase `pg_cron` calls `/api/cron` every 15 minutes (plan reminders) and Thursdays 21:00 UTC ("Who's free this weekend?") |

## 3. Feature inventory

Status key: ✅ proven by an automated browser test · 🧪 proven by unit/API tests only · 👀 checked by hand only · 🙋 needs Alexi (real accounts or a decision). A 🧪 row says why it isn't ✅ yet.

### Groups and people

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Demo group loads with no errors | `app.js` | e2e "loads the demo group" | ✅ |
| Sign in with a phone number (texted code) | Account dialog, sign-in gate | e2e "sign in with a phone number and a texted code" (fake Supabase) | ✅ in the app; 🙋 needs Phone sign-in turned on in Supabase with an SMS provider |
| Opening a group needs sign-in or its invite link (when the database is on) | `api/workspace.js` 401 gate | e2e "sign-in gate" (signed out: the gate, nothing loaded or saved; signed in: the group opens), with `/api/workspace` answering as it does with a database; `api`, `groups-api` tests | ✅ |
| Create, rename and switch between groups | "Your groups", `lib/groups.js`, `api/groups.js` | e2e "create a group, rename it, switch…"; `groups-api`, `groups-sync` tests | ✅ |
| Invite link, add a placeholder person, remove someone | People dialog, `lib/membership.js` | e2e "invite link, a placeholder person, and removing people"; `membership` tests | ✅ |
| Join from an invite link with just a name (guests): mark busy hours, vote on times and ideas, RSVP | Gate join card, `lib/guests.js`, `POST /api/workspace` guest actions | e2e "a guest joins with just a name, marks busy hours, votes on a time and RSVPs" (real API on the fake database); `guests` tests | ✅ |
| Guests never see event names, places, emails or secrets, even when the group allows event details | `guestView` (server side) | e2e "a guest never sees event names or places…" (page text, storage and every API answer checked); `guests` tests | ✅ |
| Owner turns the invite link off or makes a new one; removes a guest (votes go too) | People dialog `#inviteControls`, owner actions | e2e "turning the invite link off…", "the owner removes a guest, and their votes disappear"; `guests` API tests (only the owner may) | ✅ |
| Share a group or a plan: the phone's share sheet, else copy with a toast | `#shareButton`, `#sharePlan`, `shareLink` | e2e "share a group or a plan…" (both paths, and a cancelled share sheet) | ✅ |
| Link previews in chats: `/g/<group>` and `/p/<group>` serve the page with Open Graph and Twitter tags and a drawn card (plan title and "Vote on a time", or "RSVP" once a time is picked); no names, places or event names | `api/page.js`, `api/og.js` (`@vercel/og`), `api/_preview.js`, `vercel.json` rewrites; static fallback `icons/og-card.png` | `preview` tests (tags, no names, generic without the live code, the PNG); e2e "a /p/ link: chats get the plan's preview…", "a /g/ link opens the group…" | ✅ (real chat apps: 👀 after deploy) |
| Guest writes are rate-limited (40 per 5 min per guest, 20 joins per hour per group) and size-capped (256 KB) | `countWrite`, `api/workspace.js` | `guests` API tests | 🧪 (server only, no screen) |
| Friend requests (send, accept) | Friends page (sidebar), `lib/friends.js` | e2e "send a friend request, they accept it…" (two browsers); `friends` tests | ✅ |
| Friends page: friends without a group | `#friendsDialog`, sidebar Friends | e2e "the Friends page: a request by phone number…" | ✅ |
| Friend requests by phone number | `lib/friends.js`, `lib/phone.js`, `recipient_phone` | e2e "…by phone number, accepted by the person with that number" (two browsers); `friends`, `phone` tests; `supabase/rls-test.sql` phone checks (22/22 on the live project, 2026-10-01) | ✅ |
| 1-on-1 with a friend: "You're both free", plan it, same space for both | Friends → Calendar / 1-on-1, `pairSlug`, `freeTogether` | e2e "a 1-on-1 with a friend…" (both friends reach the same link); `groups-sync`, `planner` tests | ✅ |
| Organization or business groups (free/busy only, always) | Your groups → Start a new group, Settings → Group type, `normalizeWorkspaceState` | e2e "an organization group is free/busy only…"; `planner` test (names stripped on save) | ✅ |
| Getting-started checklist for new groups | `lib/checklist.js` | e2e "getting-started checklist…"; `checklist` tests | ✅ |
| Activity feed / bell | `#activityButton` | e2e "the bell shows a dot for news…" | ✅ |
| Profile: name, avatar colours | `lib/avatar.js`, `lib/palettes.js` | e2e "profile name and photo…; the colour palette"; `avatar`, `palettes` tests | ✅ |

### Calendars in

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Connect Google Calendar, then disconnect | Calendar links, `app.js` | e2e "connect Google…" | ✅ |
| Google keeps syncing past the hour, on every device | `api/google.js` | e2e `--google-server`; `google-api` tests | ✅ (real Google: 🙋) |
| Calendar links say when Google last synced, or why the last sync didn't work (kept per device in `gatherly-google-health`) | `noteGoogleSync`, `renderGoogleState` in `app.js` | e2e "Calendar links say when Google last synced…" | ✅ |
| Any ICS link (iCloud, Outlook, Google secret address) | `api/calendar.js`, `lib/ics.js` | e2e "an ICS link…" (a real .ics parsed by `lib/ics.js`; only the download is faked); `api`, `ics` tests for fetching and its safety checks | ✅ |
| Paint your own busy hours | My availability | e2e "painting marks hours busy" | ✅ |
| Save as my usual week; I'm free all week | `#saveUsualWeek`, `#clearMyWeek` | e2e "save as my usual week…"; `planner` tests | ✅ |
| Always busy: the same hours blocked every week (quick adds for work, school, sleep) | Sidebar → Always busy, `lib/blocked.js` | e2e "block the same hours every week…" (group row, friend's share, booking link, account sync, the grid); `blocked`, `planner` tests | ✅ |

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
| Database only lets friends read what was shared | RLS, `publish_share`, `shared_calendars` | `supabase/rls-test.sql` (22 checks, phone numbers included) and `supabase/rls-shares-test.sql` (24 checks), run against the live project inside a transaction that rolls back | ✅ 46/46 on 2026-10-01 |
| Free now status and strip | `lib/presence.js` | e2e "Free now strip" | ✅ |

### Plans

| Feature | Where | Proven by | Status |
|---|---|---|---|
| Propose a plan, vote on times, pick one, RSVP | Tentative plan, `lib/hangout.js` | e2e "propose a plan…" | ✅ |
| Best time: one suggested time from the votes and who's free, picked with one tap (never picked by itself) | `#bestTime`, `suggestBestTime`, `whoIsFree` | e2e "the best time follows the votes, and one tap picks it"; `hangout`, `planner` tests | ✅ |
| Talk the plan over: comments under the plan; members and guests add theirs and delete only their own | `#planChat`, `plan.comments`, `applyGuestUpdate` | e2e "comments: send with Enter…", "a guest talks the plan over…"; `hangout`, `guests` tests | ✅ |
| Repeating plans (weekly etc.) | `#planRepeat` | e2e "repeating plans roll on…"; `hangout` tests | ✅ |
| Add to calendar (.ics file or Google link) | `lib/calendar-export.js` | e2e "add to calendar…" (the .ics file and the Google link's contents; Google itself is never opened); `calendar-export` tests | ✅ |
| Activity ideas with photos | Ideas section | e2e "an idea with a photo…"; `idea-photos` tests | ✅ |
| Notification bell: "X proposed a plan", "you haven't voted", "time chosen", "starts soon" (guests too) | `lib/notifications.js`, `#activityButton` | e2e "the bell…"; `notify` tests | ✅ |
| Push notifications: opt in with a tap, a new plan reaches your devices | `lib/push.js`, `api/push.js`, `api/notify.js`, `push_subscriptions` | e2e "turn on notifications…" (push service stubbed); `notify` tests; `supabase/rls-server-test.sql` (10/10 on the live project, 2026-09-27) | ✅ (a real phone receiving one: 🙋) |
| Nudge people who haven't voted (once per 12 hours) | `api/notify.js` | e2e "the proposer nudges…"; `notify` tests | ✅ |
| Hour-before reminders and the weekly "Who's free this weekend?" (opt-in) | `api/cron.js`, Supabase `pg_cron` | `notify` tests (cron) | 🧪 (runs on a schedule on the server, no screen) |

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
2. **Turn on phone features** (new, 2026-09-26):
   - ~~Run the updated `supabase/schema.sql`, then `supabase/rls-test.sql`~~ Done: the schema is on the live project, and the rules checks passed 22/22 (plus 24/24 for sharing) on 2026-10-01. Friend requests by phone work now.
   - Supabase → Authentication → Sign In / Providers → **Phone**: turn it on and connect an SMS provider (Twilio, MessageBird, Vonage or Textlocal; each needs its own account and costs a little per text). Until then, "Text me a code" says phone sign-in isn't switched on yet.
3. **Two-account test with a friend**: both sign in, add each other, check sharing levels, private events, Free now, a shared plan, and the group calendar. Open your booking link in a private window; Google events should show as unavailable.
4. **Google's "unverified app" warning**: add friends as test users in Google Cloud (quick), or apply for verification (weeks).
5. **Booking emails** (optional): buy a domain, create a free Resend account, then add `RESEND_API_KEY` and `BOOKING_EMAIL_FROM` in Vercel.
6. ~~**Tidy-up**~~ Done 2026-09-26: the Google key file is in Drive's trash (the keys live in Vercel).

### Phase C: ideas for later

- ~~Reminders before a plan starts.~~ Done 2026-09-27 (notifications).
- ~~Suggest a time automatically from everyone's free windows and open votes.~~ Done 2026-10-02: "Best time" on the plan card.
- ~~A shared plan chat or comments.~~ Done 2026-10-02: "Talk it over" under the plan.

## 4b. Reviews

### 2026-10-02: development-manager read-only review of PR #26 (friends, phone, organizations, always busy) and PR #30 (best time, comments)

Two read-only reviewers (correctness; security and privacy) found no blockers. Should-fix findings and what was done:

| Finding | Fix | Proven by |
|---|---|---|
| Best time could prefer more people free over a voted time | `suggestBestTime` ranks votes, then people free, then sooner | `hangout` test "one vote beats more people free" |
| Editing a plan could drop comments, votes or RSVPs saved by someone else at the same moment | The kept fields are copied from the copy being saved, inside `mutate` | browser test "comments: … kept when the plan is edited" |
| A stale guest page could bring deleted comments back, or onto a new plan | Guests send `{ planId, keep, add }`; only genuinely new comments are added, and only to the plan they saw | `guests` test "a stale guest page never brings comments back" |
| Guests could push everyone else's comments out of the 100-comment cap; long ids were re-added on every save | A full plan takes no more guest comments; ids are cut to 40 characters before comparing | same `guests` test |
| A member's whole-group save could rewrite, delete or forge other people's comments | The server keeps everyone else's comments as stored and stamps new ones (`mergeMemberComments`) | `api` test "a member's save keeps everyone else's comments" |
| A non-owner could turn an organization back into a friends group | The server keeps `kind: "organization"` unless the owner changes it; Settings disables the choice for others | `api` test "only the owner can turn an organization back" |
| A locked group (every 1-on-1) could be read by any signed-in account with the link; a refused save sent the whole group back | Only the owner, signed-in members and pending email invitees can open it; refusals carry nothing about the group | `api` test "a locked group … tells an outsider nothing" |

Accepted as designed (Alexi can change): removing a plan deletes its comments; a member who leaves takes their comments with them.

## 5. Release checklist (run before calling any change done)

- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes.
- [ ] Views still follow CLAUDE.md: busy/free by default, names only when the owner switches them on, booking links show open times only.
- [ ] Checked on desktop, on a phone, and in dark mode, with no page errors.
- [ ] Merged to `master`, the Vercel production deploy is Ready, and the live page shows the change.
- [ ] This blueprint's status table and CLAUDE.md are updated if anything changed.
