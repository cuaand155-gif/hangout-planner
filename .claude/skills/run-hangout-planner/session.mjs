// Shared browser setup for driving Waddle: used by driver.mjs (one command per
// line) and by the Playwright suite in test/e2e (npm run test:e2e).
//
// openSession({ signedIn, groupEvents, googleServer, theme, phone }) launches
// headless Chromium with the same stubs either way:
//
// --google-server / googleServer answers /api/google as a configured server
// with a stored Google refresh token (one event, two days out).
//
// --group-events / groupEvents seeds the (demo-mode) group so Jamie and Taylor
// share named events with places, and the group shows event details.
//
// --signed-in / signedIn swaps supabase-js for fake-supabase.js (an in-memory
// database with you, a friend "Sam Rivera" and his "free now" status) and
// seeds two of your own calendar events, so friend and sharing features can be
// driven.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH || "/opt/node22/lib/node_modules/playwright/index.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));

/** Playwright's { chromium, devices }, or null when it isn't installed. */
export async function loadPlaywright() {
  for (const specifier of [PLAYWRIGHT_PATH, "playwright"]) {
    try {
      const module = await import(specifier);
      const playwright = module.chromium ? module : module.default;
      if (playwright?.chromium) return playwright;
    } catch {
      /* try the next place */
    }
  }
  return null;
}

// Blocked fonts and (when not signed in) the unreachable Supabase CDN are expected noise.
export const NOISE = /ERR_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CERT_AUTHORITY_INVALID/;

/** A time `offsetDays` from today at `hour`:00 local, as ISO. */
export function at(offsetDays, hour) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

/** The Google Calendar events API, answered with two events tomorrow. */
async function routeGoogleEvents(context) {
  await context.route("https://www.googleapis.com/calendar/v3/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [
        { status: "confirmed", summary: "Team standup", location: "Zoom", start: { dateTime: at(1, 10) }, end: { dateTime: at(1, 11) } },
        { status: "confirmed", summary: "Dinner with Mo", location: "Pai, Duncan St", start: { dateTime: at(1, 19) }, end: { dateTime: at(1, 21) } },
      ] }),
    })
  );
}

/** api/google.js as if GOOGLE_CLIENT_ID/SECRET were set and a refresh token stored. Returns its state. */
async function routeGoogleServer(context) {
  const google = { connected: true, deleted: 0, posted: 0 };
  await context.route("**/api/google**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "DELETE") {
      google.connected = false;
      google.deleted += 1;
      return json(200, { configured: true, connected: false });
    }
    if (request.method() === "POST") {
      google.connected = true;
      google.posted += 1;
      return json(200, { configured: true, connected: true });
    }
    if (!url.searchParams.has("from")) return json(200, { configured: true, connected: google.connected });
    return json(200, { items: [{ status: "confirmed", summary: "Server-synced brunch", location: "Lady Marmalade", start: { dateTime: at(2, 11) }, end: { dateTime: at(2, 12) } }] });
  });
  return google;
}

function seedStorage({ theme, signedIn, groupEvents }) {
  if (sessionStorage.getItem("driver-seeded")) return;
  sessionStorage.setItem("driver-seeded", "1");
  localStorage.setItem("gatherly-appearance", theme);
  if (groupEvents) {
    // Demo mode keeps a cached group, so seed one whose members share named events.
    const day = (offset, hour) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      date.setHours(hour, 0, 0, 0);
      return date.toISOString();
    };
    const iso = (offset) => day(offset, 12).slice(0, 10);
    const coverage = { from: iso(-7), to: iso(21) };
    localStorage.setItem("gatherly-workspace:weekend-crew", JSON.stringify({
      name: "Weekend crew",
      privacy: "details",
      members: [
        { id: "m_jamie", name: "Jamie Miller", coverage, busy: [
          { start: day(0, 12), end: day(0, 13), title: "Lunch", location: "Kensington Market", source: "ics" },
          { start: day(1, 15), end: day(1, 17), title: "Climbing", location: "Basecamp", source: "ics" },
          { start: day(1, 19), end: day(1, 20), source: "ics" },
        ] },
        { id: "m_taylor", name: "Taylor Kim", coverage, busy: [
          { start: day(0, 12), end: day(0, 14), title: "Dentist", location: "Bloor St", source: "google" },
        ] },
      ],
    }));
  }
  if (!signedIn) return;
  const today = (hour) => {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const range = { from: new Date(Date.now() - 7 * 864e5).toISOString(), to: new Date(Date.now() + 21 * 864e5).toISOString() };
  localStorage.setItem(
    "gatherly-my-events",
    JSON.stringify({ "ics:https://example.com/cal.ics": { ...range, events: [{ start: today(9), end: today(10), title: "Therapy" }, { start: today(18), end: today(20), title: "Soccer", location: "Riverdale Park" }] } })
  );
}

/**
 * Opens a browser context with Waddle's stubs. Returns { browser, context, page, errors, google, close }:
 * `errors` collects page errors and console errors minus the known network noise;
 * `google` is the fake server's state with googleServer (else null). Pass `browser`
 * to reuse one (close() then only closes the context), and `blockServiceWorkers`
 * to keep sw.js from caching between loads.
 */
export async function openSession({ playwright, browser: shared = null, signedIn = false, groupEvents = false, googleServer = false, theme = "light", phone = false, blockServiceWorkers = false } = {}) {
  const { chromium, devices } = playwright || (await loadPlaywright()) || {};
  if (!chromium) throw new Error(`Playwright not found (looked for ${PLAYWRIGHT_PATH} and the "playwright" package).`);
  const browser = shared || (await chromium.launch());
  const context = await browser.newContext({
    ...(phone ? devices["iPhone 13"] : { viewport: { width: 1280, height: 900 } }),
    ...(blockServiceWorkers ? { serviceWorkers: "block" } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && !NOISE.test(message.text()) && errors.push(`console: ${message.text()}`));

  // Google Fonts can't be reached from the sandbox; failing fast keeps runs quick and logs clean.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  if (signedIn) {
    const fake = readFileSync(join(HERE, "fake-supabase.js"), "utf8");
    await context.route("https://cdn.jsdelivr.net/npm/@supabase/**", (route) => route.fulfill({ contentType: "text/javascript", body: fake }));
    await routeGoogleEvents(context);
  }
  const google = googleServer ? await routeGoogleServer(context) : null;
  await context.addInitScript(seedStorage, { theme, signedIn, groupEvents });
  const close = () => (shared ? context.close() : browser.close());
  return { browser, context, page, errors, google, close };
}
