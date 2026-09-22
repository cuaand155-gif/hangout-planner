# Deploy Gatherly

Gatherly has no build step. Deploy the project folder as-is, with `index.html`
at the site root. It works immediately in demo mode; the steps below turn it
into a shared planner.

## 1. Connect the database

Without this, the app shows a sample workspace and keeps changes on each
visitor's own device. Nothing is shared between people.

1. Create a [Supabase](https://supabase.com) project.
2. Open [`supabase/schema.sql`](supabase/schema.sql), click **Raw**, and copy
   the SQL. Paste the SQL itself into a new query in the Supabase SQL editor and
   click **Run** — paste the file's contents, not its path.
3. In your host, set two **server-side** environment variables (names in
   [`.env.example`](.env.example)):
   - `SUPABASE_URL` — the project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → service role key.
4. Redeploy.

The service-role key must stay server-side. It is only read by `api/workspace.js`;
never put it in `app.js` or any other file the browser downloads. The
`workspaces` table has row level security on with no policy, so that key is the
only way in, and the API validates and size-limits every write before it lands.

To confirm it worked, open the site: the header next to the date reads `LIVE`
rather than `DEMO`, and a change made in one browser shows up in another.

## 2. Google sign-in (optional)

Sign-in is not required — a workspace link works for people who never sign in.
It carries a person's profile between devices and enables workspace locking.

1. In Google Cloud Console, create an OAuth client and copy its **Client ID**
   and **Client Secret**.
2. In Supabase → Authentication → Providers → Google, paste both, and add your
   deployed URL to the redirect allow list.
3. In [`app.js`](app.js), set `AUTH_CONFIG` to your project:

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

## 3. Google Calendar import (optional)

Add the Calendar scope `https://www.googleapis.com/auth/calendar.readonly` to
the same Google OAuth client. Gatherly requests it only when somebody clicks
**Connect** under Calendar links, and only ever reads.

Supabase returns the Google access token once, on the sign-in callback, so the
connection lasts for that browser session. Gatherly keeps that token in
`sessionStorage` — never in local storage, and never in the shared workspace.

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
3. Add the two environment variables from step 1.
4. Deploy. `vercel.json` enables clean URLs; `api/*.js` become serverless
   functions automatically.

### Netlify

Set **Publish directory** to `.` and leave the build command empty. The
handlers in `api/` are written for Vercel's signature; to get shared
persistence on Netlify, wrap them in Netlify Functions and point the two
`fetch("/api/…")` calls in `app.js` at the new paths. Without that, the app
runs in demo mode.

### GitHub Pages

Pages can host the frontend but cannot run the API, so the app will stay in
demo mode: a sample workspace with changes kept per device. Choose **Deploy
from a branch** and the `/ (root)` folder. No rewrite rules are needed.

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
