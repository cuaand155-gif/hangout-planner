# Waddle 🐧

Find the time everyone is actually free, then fill it with something worth doing.

Waddle is a small, dependency-free web app. A group shares one link; each
person marks when they're busy — by hand or by importing a calendar — and the
planner shows the windows where everybody is free, ranked longest first. The
group collects ideas, votes on them, and pencils in a plan with its own time
votes and RSVPs. Around that: friends, a "free now" status, per-friend control
over what of your calendar they see, and a public booking link.

No build step, no frontend framework, no npm dependencies.

## Run it locally

```bash
npm run dev          # http://localhost:4173
npm test             # unit and API tests, no dependencies
```

`npm run dev` serves the static files *and* the `/api` handlers, so the app
behaves the same locally as it does deployed. Without database credentials it
runs in demo mode: a sample workspace, with your changes kept in this browser.

## How it works

| File | What it does |
| --- | --- |
| `index.html` | The whole UI. Every dynamic region is an empty container the app renders into. |
| `app.js` | State, rendering and interactions. Loaded as an ES module. |
| `booking-owner.js` | Your side of a booking link: set it up, share it, see and cancel bookings. |
| `book.html`, `book.js` | The public booking page at `/book/<handle>`, for guests without an account. |
| `sw.js`, `manifest.webmanifest` | The home-screen app: installable, and opens offline from its cached shell. |
| `lib/planner.js` | Dates, overlap detection and state validation — shared by the browser and the API. |
| `lib/ics.js` | A small iCalendar reader (recurrence rules, exceptions, all-day events). |
| `lib/membership.js` | Decides which member row is you, so nobody ends up in a group twice. |
| `lib/friends.js` | Friend requests: what belongs in each list, and the database calls. |
| `lib/calendar-export.js` | Turns a pencilled-in plan into an `.ics` file or a Google Calendar link. |
| `lib/hangout.js` | A plan's time votes, repeats and RSVPs. |
| `lib/groups.js` | The "Your groups" list, and unguessable links for new groups. |
| `lib/sharing.js` | Who sees what of your calendar: levels, picked and private events, time-limited shares, and the filtered copies friends get. |
| `lib/booking.js` | Booking links: working hours across time zones, open slots, and the calendar files guests and owners get. |
| `lib/presence.js` | "Free now": how long a status lasts. |
| `lib/sync.js` | When a saved calendar is due for a refresh, and whether a refresh changed anything. |
| `lib/checklist.js`, `lib/appearance.js`, `lib/palettes.js`, `lib/avatar.js`, `lib/pwa.js` | The getting-started steps, theme and colour choices, profile photos, and install prompts. |
| `api/_supabase.js` | Shared by the handlers: reads the database settings and checks sign-in tokens. Not an endpoint. |
| `api/workspace.js` | Loads and saves the shared workspace, with validation and conflict detection. |
| `api/groups.js` | Lists a signed-in person's groups, so the list follows them between devices. |
| `api/calendar.js` | Fetches a calendar feed server-side, with the guards an inbound URL needs. |
| `api/google.js` | Keeps Google Calendar syncing past Google's one-hour limit (optional; see DEPLOY.md). |
| `api/book.js` | Open slots, bookings and cancellations for booking links, plus the owner's bookings feed. |
| `supabase/schema.sql` | Every table, policy and function: `workspaces`, `profiles`, `friend_requests`, `calendar_shares`, `sharing_settings`, `presence`, `booking_pages`, `bookings` and `google_tokens`. Safe to run again. |
| `supabase/rls-shares-test.sql` | Proves only you can write your calendar shares and only that friend can read them. |
| `supabase/rls-test.sql` | Proves the friend-request policies hold; runs in a transaction and rolls back. |

### Availability

Each member carries two kinds of availability:

- **A usual week** — recurring busy blocks (`Mondays 9–12`). It applies to every
  week you haven't touched, so a workspace stays useful without constant upkeep.
- **Dated blocks** — a specific week you edited by hand, or times imported from
  a calendar. For the days they cover, they win over the usual week.

A member who has shared neither is *unknown* for that week rather than free, so
"everyone is free" never quietly includes somebody who simply hasn't answered.
The group grid shows three states: everyone free, some free, and busy.

### Adding people

There are three ways, and none of them can put the same person in a group twice:

- **Share the link.** Anyone who opens it can add their times without an account.
- **Add them by name.** They appear as "Waiting for times". When that person
  arrives they can pick their name from *Manage people* and say "That's me", or
  sign in with the email the invite was addressed to and claim it automatically.
  Either way they take over the existing row rather than adding a second one,
  keeping whatever times were already filled in.
- **Friend requests** (accounts). Send one to an email address — it works even
  if they haven't signed up, and they'll see it the first time they sign in.
  Once accepted, a friend can be added to any of your groups in one click, and
  stays available for the next group without re-inviting.

If a friend you add is already in the group under a name somebody typed by
hand, Waddle offers to **link** that row to their account instead of adding
a duplicate. The rules for all of this live in `lib/membership.js` and are
covered by tests.

### Groups

Each group lives at its own link (`/?w=book-club-7fq2x`). **Your groups** (in
the sidebar, or tap the group name at the top) lists every group you've opened
on this device and, when you're signed in, every group your account belongs
to on any device. **Start a new group** there: the link gets a random code on
the end, so nobody can find your group by guessing its name.

### Plans

**Set a tentative plan** (or **Plan this** on an idea) pencils something in
without locking anyone into a date. The plan card lists the group's best free
times; people vote on them with the heart, and anyone can pick one. Once a
time is picked, everyone answers Going, Maybe or Can't make it. A plan can
repeat every week, every 2 weeks or every month: after each date it rolls on
to the next by itself, keeping its wall-clock time across daylight-saving
changes, and each date gets its own RSVPs.

### Calendars

- **Reading busy times.** Paste any calendar's `.ics` address under Calendar
  links — for Google, that's Settings → your calendar → *Secret address in
  iCal format*. Saved links refresh by themselves every time you open
  Waddle, or come back to the tab, if the last refresh is over 30 minutes
  old. A refresh that finds nothing new saves nothing.
- **Adding the plan to your calendar.** Once a plan is pencilled in, the plan
  card offers **Google Calendar** and **Apple / Outlook**. The Apple/Outlook
  file carries a fixed event ID, so opening it again after the plan moves
  updates the same event. Google's add link can't do that, so the app
  remembers you've added it and says so, instead of letting a second tap make
  a duplicate. The event lasts as long as the group's "shortest window"
  setting (2 hours by default), within the free stretch.

### Your calendar and who sees what

**My calendar** shows your own week with every event name, from all the
calendars you've connected. Only you see it: the names are kept in this
browser, and only what the choices below allow ever leaves it.

**Who sees what** decides what leaves, per audience:

| Level | What they get |
| --- | --- |
| Nothing | Can't open your calendar at all |
| Busy / free only | When you're busy, never what |
| Only events I pick | Names of the events you tapped in My calendar; the rest read "Busy" |
| Everything | Every event name |

- **Friends** get a default level, and any friend can be set differently.
  Each friend receives their own filtered copy (`calendar_shares`, one row per
  friend), which row level security lets only them read. Open a friend's
  calendar from Manage people → Friends → Calendar.
- **Groups** get one level for all of them — busy, picked or everything — and
  a group must also allow event details under Privacy before any name reaches
  it, because everyone holding a group's link can read it. Inside a group you
  always show as busy when you are, since that's how the group finds a time.
- **Preview as** shows your week exactly as a given friend or group sees it.
- Picking works by name: pick "Soccer" once and every Soccer event is shared.
- **Private events** (the lock on an event) are hidden from everyone, not even
  shown as busy. Only a scrambled code of each name is saved. Booking links
  still keep those times closed.
- **Share more for a while** gives one friend a fuller view until a set time,
  then goes back by itself. The database makes the switch, so it happens even
  while your phone is off.
- Signed in, these choices are saved to your account (`sharing_settings`) and
  follow you to every device; whichever device changed them last wins.

### Friends and free now

Friends are people who accepted a friend request. Manage people → Friends
lists them, opens their calendar (as much as they chose to show you), and
adds them to the current group in one tap. **I'm free** tells your friends
you're free for an hour, 2 hours or the rest of today; friends who are free
show in the **Free now** strip on the home screen.

### Booking links

**Booking link** in the sidebar gives you one public page (`/book/<handle>`)
for anyone outside your groups. Guests need no account and only ever see open
times. You choose the days and hours (or only the times you pick), meeting
length, gap between meetings, notice and how far ahead. When **Keep my
calendar's busy times blocked** is on, open times skip:

- anything in your calendar links (up to three), which the server re-reads
  itself, so they stay fresh while Waddle is closed;
- busy times from every calendar you've connected, Google included. The app
  saves those with the link (times only, never names) whenever you open it
  and your calendar has changed.

Bookings show in the same dialog, where you can cancel them, and a private
calendar feed puts them in your own calendar app. Guests get a calendar file
and a cancel link.

### Sharing and privacy

- A group lives at `/?w=<slug>`. Opening one needs a Google sign-in: without a
  valid token the API answers 401 and returns nothing about the group, and the
  app shows a sign-in screen instead. Anyone signed in with the link can join.
  The demo group (`weekend-crew`) stays open so people can try the app.
- **Settings → Only signed-in members can edit** narrows that further: only
  people already in the group (or its owner) can make changes.
- Booking links (`/book/<handle>`) never need an account on the booker's side.
- Calendar links are kept in your browser's local storage. The only copy
  that leaves it is the one your own booking link keeps (up to three links,
  readable only by you and the server) when it blocks your busy times. Groups
  only ever get the resulting busy blocks.
- Event titles are stripped unless the group turns on **Show event details**,
  and even then only the ones each person allows. Switching back removes
  titles that were already imported.

### Saving

Every change renders immediately, then saves. A save carries the revision it
read; if somebody else saved first, the change is re-applied on top of their
version and retried rather than overwriting it. If the network is down, the
change stays in local storage and the header reads `OFFLINE`.

## Connecting a calendar

- **Any ICS link** (iCloud, Outlook, Google's secret address, most others):
  paste it into **Calendar links**. The server fetches and parses it, and
  returns busy blocks for the next four weeks.
- **Google Calendar**: connect it under **Calendar links**. This uses Supabase
  Auth to request read-only calendar access and reads your primary calendar.
  When the server has `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, it keeps
  Google's refresh token (encrypted) so syncing continues past the hour and on
  every device you sign in on; without them the browser reads it directly for
  about an hour.

Groups only need the `workspaces` table. Accounts, friends, sharing, free now
and booking links need the rest of `supabase/schema.sql`.

See [DEPLOY.md](DEPLOY.md) for hosting, database and Google sign-in setup.

## Known limitations

- Event names stay on the devices that imported them, so friends' copies,
  and the busy times your booking link keeps for connected calendars, refresh
  from whichever device last synced your calendar.
- Friends see events from your connected calendars. Times you paint by hand
  stay inside that group.
- Without the Google client env vars, Google Calendar's direct connection
  lasts about an hour, because Supabase hands over Google's token only once.
  Add them (see DEPLOY.md) or use the calendar's secret iCal address.
- Refreshing happens while Waddle is open. Nothing syncs in the background
  while it's closed, except that a booking link re-reads its calendar links
  whenever a guest opens it.
- Nobody is emailed about bookings. Guests get a cancel link on screen; if
  you cancel one, tell them yourself.
- Calendar entries are converted from the timezone they were written in,
  including Outlook's Windows zone names. Entries with no timezone at all
  ("floating" times) and zones the server doesn't recognise are read in the
  viewer's own timezone.
- Everyone in one workspace shares one grid of hours and one week layout
  (Settings), and all times are displayed in each viewer's own timezone.
- A friend request notifies nobody by email — it waits in the app until the
  recipient signs in. Tell them it's there, or just send the invite link.
  `supabase/rls-test.sql` checks the friend-request policies against a real
  database.
