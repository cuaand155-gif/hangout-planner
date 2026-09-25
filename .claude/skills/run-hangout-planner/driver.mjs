// Drives Waddle in headless Chromium. Reads one command per line from stdin.
//
//   node .claude/skills/run-hangout-planner/driver.mjs [--signed-in] [--group-events] [--google-server] [--theme dark] [--phone] [--base URL] < script
//
// The flags are explained in session.mjs. Screenshots go to $SHOTS (default /tmp/waddle-shots).

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openSession } from "./session.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = option("--base", "http://localhost:4173");
const shots = process.env.SHOTS || "/tmp/waddle-shots";
mkdirSync(shots, { recursive: true });

// The browser setup (stubs, seeded storage, error collection) lives in session.mjs, shared with test/e2e.
const { browser, page, errors } = await openSession({
  signedIn: flag("--signed-in"),
  groupEvents: flag("--group-events"),
  googleServer: flag("--google-server"),
  theme: option("--theme", "light"),
  phone: flag("--phone"),
});

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
