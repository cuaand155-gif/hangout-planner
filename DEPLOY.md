# Deploy Hangout Planner

Hangout Planner is a dependency-free static site. There is no build step: deploy the project folder as-is, with `index.html` at the site root.

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
3. Netlify serves `index.html` automatically.

## GitHub Pages

1. Push the project files to a GitHub repository.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select the publishing branch, and choose the `/ (root)` folder.
4. Save and wait for the Pages URL to appear.

Because this is a single-page static prototype with hash navigation, no rewrite configuration is required for the current routes.

## Local preview

From this directory, run:

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>. Stop the server with `Ctrl+C`.
