# Deploy Hangout Planner

Hangout Planner has no frontend build step, but it now uses a small serverless API for shared workspace state. Deploy the project folder as-is, with `index.html` at the site root.

## Connect persistence

1. Create a Supabase project.
2. Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor.
3. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as server-side environment variables in your host. Copy the names from [`.env.example`](.env.example); never expose the service-role key in browser code.
4. Redeploy. Without these variables, the UI intentionally falls back to demo data and does not persist changes between visitors.

The schema also includes profiles (display name, photo URL, and schedule visibility), friend requests, and calendar connection records. Google Calendar OAuth still requires enabling the Google provider and Calendar scope in Supabase; the UI deliberately explains that requirement instead of pretending a calendar was connected. The current prototype keeps profile edits and friend invites in local storage until the signed-in Supabase user flow is connected to those tables.

## Vercel

1. Push this folder to a Git provider, or run `vercel` from the project directory.
2. In Vercel, import the repository and choose the project root.
3. Leave **Framework Preset** as **Other**, leave **Build Command** blank, and leave **Output Directory** blank.
4. Deploy. The included `vercel.json` enables clean URLs without changing the app's design.

## Netlify

### From a Git repository

1. Choose **Add new site → Import an existing project**.
2. Select the repository and set **Publish directory** to `.`.
3. Leave **Build command** empty, then deploy.

### Manual upload

1. Open Netlify's deploy page.
2. Drag the project folder into the deploy area.
3. Netlify serves `index.html` automatically. The included `api/workspace.js` is Vercel-style; to make shared persistence work on Netlify, move that handler to a Netlify Function and update the browser endpoint. Otherwise, this app uses device-local fallback storage.

## GitHub Pages

1. Push the project files to a GitHub repository.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select the publishing branch, and choose the `/ (root)` folder.
4. Save and wait for the Pages URL to appear.

GitHub Pages can host the frontend only. It cannot run the included serverless API, so it will use device-local fallback storage unless you host the API separately and update its URL in `app.js`. No rewrite configuration is required for the current hash routes.

## Google sign-in setup

The account entry point and **Continue with Google** action are present, but Google OAuth is intentionally not enabled in this repository. `app.js` contains the small `AUTH_CONFIG` section and currently keeps `configured: false`; clicking the action explains that credentials are missing instead of pretending that a user signed in.

For a static site or Vercel deployment, [Supabase Auth](https://supabase.com/docs/guides/auth/social-login/auth-google) is the recommended next step:

1. Create a Supabase project and copy its **Project URL** and **anon public key**.
2. In Supabase Authentication → Providers → Google, add the Google OAuth **Client ID** and **Client Secret** from Google Cloud Console. Add the deployed site URL to Supabase's redirect allow list.
3. The static page already loads the Supabase browser client from jsDelivr and `app.js` already wires `supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } })` plus session updates to the existing account UI.
4. Replace the placeholder values in `AUTH_CONFIG` with:

   ```js
   const AUTH_CONFIG = {
     provider: "supabase",
     configured: true,
     supabaseUrl: "https://<project-ref>.supabase.co",
     supabaseAnonKey: "<supabase-anon-public-key>",
     redirectUrl: window.location.origin,
   };
   ```

   For Vercel, store the same values as `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables and expose them through the static build/config step. Never put a Supabase service-role key or Google client secret in browser code.
5. Subscribe to `supabase.auth.onAuthStateChange` and update the account dialog/profile from the returned session. Keep the signed-out state as the fallback when there is no session.

The current app has no Supabase client, OAuth callback, backend session, or real Google credential. Until those steps are completed, the rest of the planner remains a local visual prototype and no account data is persisted remotely.

## Local preview

From this directory, run:

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>. Stop the server with `Ctrl+C`.
