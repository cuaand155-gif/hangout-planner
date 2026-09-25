# Deploy Waddle

Waddle has no build step. Deploy the project folder as-is, with `index.html`
at the site root. It works immediately in demo mode; the steps below turn it
into a shared planner.

## 1. Connect the database

Without this, the app shows a sample workspace and keeps changes on each
visitor's own device. Nothing is shared between people.

1. Create a [Supabase](https://supabase.com) project.
2. Open [`supabase/schema.sql`](supabase/schema.sql), click **Raw**, and copy
   the SQL. Paste the SQL itself into a new query in the Supabase SQL editor and
   click **Run** — paste the file's contents, not its path.
3. Give the host the project URL and the service-role key, either way:
   - **Supabase → Settings → Integrations → Install Vercel integration.** It
     provisions the variables itself (`NEXT_PUBLIC_SUPABASE_URL`,
     `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY` and others).
   - **Or by hand**, using the names in [`.env.example`](.env.example):
     `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Settings → API Keys).

   Every handler in `api/` accepts either naming (through `api/_supabase.js`).
   Note that Vercel cannot rename an
   existing variable and will not reveal a secret's value, so correcting a
   wrongly-named one means deleting it and adding a new one.
4. Redeploy. Variables only apply to the environments they are scoped to, so
   scope them to Preview as well if you want preview URLs to persist too.

The service-role key must stay server-side. It is only read by
`api/_supabase.js`, on behalf of the handlers in `api/`; never put it in
`app.js` or any other file the browser downloads. The `workspaces` and
`google_tokens` tables have row level security on with no policy, so that key
is the only way in, and the API validates and size-limits every write before
it lands.

To confirm it worked, open the site: the header next to the date reads `LIVE`
rather than `DEMO`, and a change made in one browser shows up in another.

## 2. Google sign-in

Once the database is connected, opening any group except the demo
(`weekend-crew`) needs a Google sign-in: without it the API answers 401 and
the app shows a sign-in screen. Sign-in also carries a person's profile,
groups and sharing choices between devices, and is what friends, free now,
booking links and workspace locking are built on.

1. In Google Cloud Console, create an OAuth client and copy its **Client ID**
   and **Client Secret**.
2. In Supabase → Authentication → Providers → Google, paste both, and add your
   deployed URL to the redirect allow list.
3. In [`app.js`](app.js), set `AUTH_CONFIG` to your project (the repository
   ships with the live project's values):

   ```js
   const AUTH_CONFIG = {
     provider: "supabase",
     configured: true,
     supabaseUrl: "https://<project-ref>.supabase.co",
     supabaseAnonKey: "<publishable / anon key>",
     redirectUrl: window.location.origin + window.location.pathname,
   };
   ```

   The publishable (anon) key is designed to be in browser code; the
   service-role key is not. Only ever put the publishable one here.

## 3. Friends, sharing, free now and booking links

These ride on the same accounts as sign-in and need no extra configuration,
just their tables from `supabase/schema.sql` (step 1): `friend_requests`,
`calendar_shares` and `sharing_settings` for friends and who sees what,
`presence` for free now, and `booking_pages` and `bookings` for booking links.
If you ran an earlier version of the schema, run it again; every statement is
safe to repeat.

[`supabase/rls-shares-test.sql`](supabase/rls-shares-test.sql) checks the
`calendar_shares` policies the same way as the test below.

To confirm the policies are doing their job, run
[`supabase/rls-test.sql`](supabase/rls-test.sql) in the SQL editor. It creates
throwaway accounts inside a transaction, tries every way one account might
reach another's requests, prints a pass/fail row for each, and rolls back.

Three things worth knowing about how it is secured:

- A request is addressed to an **email**, so you can invite somebody who has
  not signed up yet. The read policy therefore matches on the email inside the
  caller's own token, which means nobody can read requests by guessing at
  someone else's address.
- Only the recipient can accept or decline.
- A policy cannot compare against the old row, so "answering cannot rewrite who
  the request was from" is enforced with column privileges: a signed-in caller
  may only update `status`, `recipient_id` and `responded_at`. Without that, a
  recipient could accept a request and restate it as coming from somebody else,
  inventing a friendship that person would then see in their own list.

The schema also adds a trigger that creates a `profiles` row for every new
account, so requests show a name rather than a bare email address. Nobody is
emailed: a request waits in the app until the recipient next signs in.

## 4. Google Calendar import (optional)

Add the Calendar scope `https://www.googleapis.com/auth/calendar.readonly` to
the same Google OAuth client. Waddle requests it only when somebody clicks
**Connect** under Calendar links, and only ever reads.

Supabase returns Google's tokens once, on the sign-in callback. On its own the
browser's access token lasts about an hour, then people are asked to connect
again. To keep syncing going:

1. Run the `google_tokens` part of `supabase/schema.sql` (only the service role
   can read that table).
2. In Vercel → Settings → Environment Variables add `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`: the same values you gave Supabase's Google provider.
   Redeploy.

After that, **Connect** hands Google's refresh token to `api/google.js`, which
stores it encrypted (AES-256-GCM, key derived from the client secret) and uses
it to fetch events. Only title, place and times leave the server. Removing the
Google calendar in the app deletes the stored token; so does Google revoking
access. Changing the client secret makes stored tokens unreadable, so everyone
connects once more.

ICS links (iCloud, Outlook, Google's secret address) need no setup at all.
`api/calendar.js` fetches them server-side because calendar feeds do not allow
direct browser requests. That handler only follows `https`, re-checks every
redirect, and refuses hosts that resolve to private or loopback addresses so
the URL box cannot be used to probe your own network.

## Hosting

### Vercel

1. Import the repository and choose the project root.
2. Leave **Framework Preset** as **Other**, and leave **Build Command** and
   **Output Directory** blank.
3. Add the two environment variables from step 1 (and, optionally, the two
   Google ones from step 4).
4. Deploy. `vercel.json` enables clean URLs and serves `/book/<handle>` from
   `book.html`; `api/*.js` become serverless functions automatically.

### Netlify

Set **Publish directory** to `.` and leave the build command empty. The
handlers in `api/` are written for Vercel's signature; to get shared
persistence on Netlify, wrap each one in a Netlify Function and redirect
`/api/*` to them, and rewrite `/book/*` to `/book.html`. Without that, the app
runs in demo mode and booking links do not open.

### GitHub Pages

Pages can host the frontend but cannot run the API, so the app will stay in
demo mode: a sample workspace with changes kept per device, and no booking
links. Choose **Deploy from a branch** and the `/ (root)` folder.

## Local preview

```bash
npm run dev     # http://localhost:4173, static files plus the /api handlers
npm test        # unit and API tests
```

`npm run dev` picks up `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
environment if you want to test against a real database:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run dev
```

A plain static server such as `python3 -m http.server` also serves the page,
but not `/api`, so the app will report demo mode.
