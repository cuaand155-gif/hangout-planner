// Drives Waddle in headless Chromium. Reads one command per line from stdin.
//
//   node .claude/skills/run-hangout-planner/driver.mjs [--signed-in] [--group-events] [--theme dark] [--phone] [--base URL] < script
//
// --group-events seeds the (demo-mode) group so Jamie and Taylor share named
// events with places, and the group shows event details.
//
// --signed-in swaps supabase-js for fake-supabase.js (an in-memory database
// with you, a friend "Sam Rivera" and his "free now" status) and seeds two of
// your own calendar events, so friend and sharing features can be driven.
// Screenshots go to $SHOTS (default /tmp/waddle-shots).

import { chromium, devices } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = option("--base", "http://localhost:4173");
const theme = option("--theme", "light");
const shots = process.env.SHOTS || "/tmp/waddle-shots";
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext(flag("--phone") ? devices["iPhone 13"] : { viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
// Blocked fonts and (when not --signed-in) the unreachable Supabase CDN are expected noise.
const NOISE = /ERR_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CERT_AUTHORITY_INVALID/;
page.on("console", (message) => message.type() === "error" && !NOISE.test(message.text()) && errors.push(`console: ${message.text()}`));

// Google Fonts can't be reached from the sandbox; failing fast keeps runs quick and logs clean.
await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

if (flag("--signed-in")) {
  const fake = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fake-supabase.js"), "utf8");
  await context.route("https://cdn.jsdelivr.net/npm/@supabase/**", (route) => route.fulfill({ contentType: "text/javascript", body: fake }));
  // Google Calendar's events API, answered with two events tomorrow (nav /?calendar=1 to connect).
  await context.route("https://www.googleapis.com/calendar/v3/**", (route) => {
    const at = (hour) => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      date.setHours(hour, 0, 0, 0);
      return date.toISOString();
    };
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [
        { status: "confirmed", summary: "Team standup", location: "Zoom", start: { dateTime: at(10) }, end: { dateTime: at(11) } },
        { status: "confirmed", summary: "Dinner with Mo", location: "Pai, Duncan St", start: { dateTime: at(19) }, end: { dateTime: at(21) } },
      ] }),
    });
  });
}

await context.addInitScript(({ theme, signedIn, groupEvents }) => {
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
  const at = (hour) => {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const range = { from: new Date(Date.now() - 7 * 864e5).toISOString(), to: new Date(Date.now() + 21 * 864e5).toISOString() };
  localStorage.setItem(
    "gatherly-my-events",
    JSON.stringify({ "ics:https://example.com/cal.ics": { ...range, events: [{ start: at(9), end: at(10), title: "Therapy" }, { start: at(18), end: at(20), title: "Soccer", location: "Riverdale Park" }] } })
  );
}, { theme, signedIn: flag("--signed-in"), groupEvents: flag("--group-events") });

const commands = {
  // nav <path>: open a page (add ?nosw to skip the service worker)
  nav: async (path) => {
    await page.goto(new URL(path || "/", base).href);
    await page.waitForTimeout(1500); // the app renders after its first /api/workspace reply
  },
  click: (selector) => page.locator(selector).first().click(),
  fill: (rest) => {
    const [selector, ...text] = rest.split(" ");
    return page.locator(selector).first().fill(text.join(" "));
  },
  select: (rest) => {
    const [selector, value] = rest.split(" ");
    return page.selectOption(selector, value);
  },
  press: (key) => page.keyboard.press(key),
  wait: (ms) => page.waitForTimeout(Number(ms) || 500),
  "wait-for": (selector) => page.locator(selector).first().waitFor({ state: "visible", timeout: 10000 }),
  // Opens a <dialog> directly, e.g. `open settingsDialog`
  open: (id) => page.evaluate((id) => document.getElementById(id).showModal(), id),
  text: async (selector) => console.log((await page.locator(selector).first().innerText()).replace(/\s+/g, " ").trim()),
  eval: async (code) => console.log(JSON.stringify(await page.evaluate(code))),
  // shot <name> [selector]: full viewport, or one element
  shot: async (rest) => {
    const [name, ...selector] = rest.split(" ");
    const path = join(shots, `${name || "shot"}.png`);
    if (selector.length) await page.locator(selector.join(" ")).first().screenshot({ path });
    else await page.screenshot({ path });
    console.log(`saved ${path}`);
  },
  "shot-full": async (name) => {
    const path = join(shots, `${name || "full"}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`saved ${path}`);
  },
  errors: async () => console.log(errors.length ? errors.join("\n") : "no errors"),
  // With --signed-in: the database calls the page made (publish_share, upserts, …)
  calls: async () => console.log(JSON.stringify(await page.evaluate(() => window.__calls || []), null, 1)),
  toast: async () => console.log(await page.locator("#toast").innerText()),
};

const input = readFileSync(0, "utf8").split("\n");
for (const raw of input) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const [name, ...rest] = line.split(" ");
  const run = commands[name];
  if (!run) {
    console.log(`unknown command: ${name} (known: ${Object.keys(commands).join(", ")})`);
    continue;
  }
  try {
    await run(rest.join(" "));
    console.log(`ok  ${line}`);
  } catch (error) {
    console.log(`ERR ${line}\n    ${String(error.message).split("\n")[0]}`);
  }
}
await browser.close();
