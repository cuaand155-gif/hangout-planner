# Gatherly

Find the time everyone is actually free, then fill it with something worth doing.

Gatherly is a small, dependency-free web app. A group shares one link; each
person marks when they're busy — by hand or by importing a calendar — and the
planner shows the windows where everybody is free, ranked longest first. The
group collects ideas and votes on them in the same place.

No build step, no frontend framework, no npm dependencies.

## Run it locally

```bash
npm run dev          # http://localhost:4173
npm test             # 49 unit and API tests, no dependencies
```

`npm run dev` serves the static files *and* the `/api` handlers, so the app
behaves the same locally as it does deployed. Without database credentials it
runs in demo mode: a sample workspace, with your changes kept in this browser.

## How it works

| File | What it does |
| --- | --- |
| `index.html` | The whole UI. Every dynamic region is an empty container the app renders into. |
| `app.js` | State, rendering and interactions. Loaded as an ES module. |
| `lib/planner.js` | Dates, overlap detection and state validation — shared by the browser and the API. |
| `lib/ics.js` | A small iCalendar reader (recurrence rules, exceptions, all-day events). |
| `api/workspace.js` | Loads and saves the shared workspace, with validation and conflict detection. |
| `api/calendar.js` | Fetches a calendar feed server-side, with the guards an inbound URL needs. |
| `supabase/schema.sql` | Two tables: `workspaces`, and `profiles` for people who sign in. |

### Availability

Each member carries two kinds of availability:

- **A usual week** — recurring busy blocks (`Mondays 9–12`). It applies to every
  week you haven't touched, so a workspace stays useful without constant upkeep.
- **Dated blocks** — a specific week you edited by hand, or times imported from
  a calendar. For the days they cover, they win over the usual week.

A member who has shared neither is *unknown* for that week rather than free, so
"everyone is free" never quietly includes somebody who simply hasn't answered.
The group grid shows three states: everyone free, some free, and busy.

### Sharing and privacy

- A workspace lives at `/?w=<slug>`. Anyone with the link can open it, add their
  times and edit — that is what makes the invite link work without accounts.
- **Settings → Only signed-in members can edit** locks a workspace once you've
  signed in, after which the API rejects writes that don't carry a member's token.
- Calendar links are kept in your browser's local storage and never uploaded.
  Only the resulting busy blocks are shared with the group.
- Event titles are stripped unless the group turns on **Show event details**.
  Switching back removes titles that were already imported.

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
  Auth to request read-only calendar access and then reads your primary
  calendar directly from the browser.

See [DEPLOY.md](DEPLOY.md) for hosting, database and Google sign-in setup.

## Known limitations

- Google Calendar access lasts for the browser session. Supabase hands over the
  Google token once, at sign-in, so after a reload you may need to reconnect
  before syncing again. ICS links re-sync at any time.
- Calendar entries carrying a timezone are read in *your* timezone. If your
  calendar is in a different timezone from the person reading it, those times
  will be off.
- Everyone in one workspace shares one grid of hours and one week layout
  (Settings), and all times are displayed in each viewer's own timezone.
