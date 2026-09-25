// Browser tests: the key flows the run-hangout-planner driver covers, in
// headless Chromium. Run with `npm run test:e2e` (kept out of `npm test`).
//
// Starts its own dev server on a free port and stops it afterwards. Uses the
// same stubs as the driver (.claude/skills/run-hangout-planner/session.mjs):
// fake-supabase.js for a signed-in account, and routed /api/google and Google
// Calendar answers. Nothing reaches the network. If Playwright isn't
// installed, every test is skipped with a message instead of failing.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { PLAYWRIGHT_PATH, loadPlaywright, openSession } from "../../.claude/skills/run-hangout-planner/session.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const state = { playwright: null, browser: null, server: null, base: "", skip: "" };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  // A clean environment: demo mode, whatever the shell has set.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port) };
  const server = spawn(process.execPath, ["scripts/dev-server.mjs", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (chunk) => (log += chunk));
  server.stderr.on("data", (chunk) => (log += chunk));
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`dev server exited:\n${log}`);
    try {
      if ((await fetch(base)).ok) return { server, base };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  server.kill();
  throw new Error(`dev server did not start:\n${log}`);
}

before(async () => {
  state.playwright = await loadPlaywright();
  if (!state.playwright) {
    state.skip = `Playwright not found at ${PLAYWRIGHT_PATH} or as a "playwright" package; skipping browser tests.`;
    console.log(`# ${state.skip}`);
    return;
  }
  try {
    state.browser = await state.playwright.chromium.launch();
  } catch (error) {
    state.skip = `Playwright is installed but Chromium would not launch (${error.message.split("\n")[0]}); skipping browser tests.`;
    console.log(`# ${state.skip}`);
    return;
  }
  ({ server: state.server, base: state.base } = await startServer());
});

after(async () => {
  await state.browser?.close();
  if (state.server && state.server.exitCode === null) {
    const exited = new Promise((resolve) => state.server.once("exit", resolve));
    state.server.kill();
    await exited;
  }
});

/**
 * One browser context per test, with the driver's stubs. `run(session)` gets
 * { page, context, errors, google, go(path) }; page errors fail the test at the end,
 * except ones matching `allowErrors`.
 */
function browserTest(name, { allowErrors = null, ...options }, run) {
  test(name, async (t) => {
    if (state.skip) return t.skip(state.skip);
    const session = await openSession({ playwright: state.playwright, browser: state.browser, blockServiceWorkers: true, ...options });
    const go = async (path, { app = true } = {}) => {
      await session.page.goto(new URL(path, state.base).href);
      // The app renders the group after its first /api/workspace reply.
      if (app) await session.page.locator("#calendarGrid .slot").first().waitFor({ state: "attached", timeout: 10000 });
      await session.page.waitForLoadState("networkidle");
    };
    try {
      await run({ ...session, go });
      assert.deepEqual(session.errors.filter((error) => !allowErrors?.test(error)), [], "no page or console errors");
    } finally {
      await session.close();
    }
  });
}

const texts = (page, selector) => page.locator(selector).allInnerTexts();
const toast = (page) => page.locator("#toast").innerText();

/** A stand-in for /api/book: two open slots, one booking, cancel. Records requests. */
async function stubBookApi(context, { emails = false } = {}) {
  const calls = [];
  const start = new Date(Date.now() + 2 * 864e5);
  start.setUTCHours(15, 0, 0, 0);
  const slot = (offset) => ({ start: new Date(start.getTime() + offset * 30 * 60e3).toISOString(), end: new Date(start.getTime() + (offset + 1) * 30 * 60e3).toISOString() });
  const page = { handle: "alexi-7fq2x", title: "Coffee chat", ownerName: "Alexi", duration: 30, timeZone: "UTC", emails };
  const booking = { id: "b1", ...slot(1), status: "confirmed", createdAt: new Date().toISOString(), cancelToken: "c".repeat(36) };
  const bookings = { cancelled: false };
  await context.route("**/api/book**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "POST" ? JSON.parse(request.postData() || "{}") : null;
    calls.push({ method: request.method(), query: Object.fromEntries(url.searchParams), body });
    const json = (status, payload) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    if (request.method() === "GET" && url.searchParams.get("handle")) return json(200, { page, slots: [slot(0), slot(1)] });
    if (request.method() === "GET" && url.searchParams.get("booking")) {
      return json(200, { booking: { start: booking.start, end: booking.end, status: bookings.cancelled ? "cancelled" : "confirmed" }, page: { title: page.title, ownerName: page.ownerName, handle: page.handle } });
    }
    if (body?.action === "book") return json(201, { booking, page, emailed: emails });
    if (body?.action === "cancel") {
      bookings.cancelled = true;
      return json(200, { booking: { start: booking.start, end: booking.end, status: "cancelled" }, emailed: emails });
    }
    return json(400, { error: "Unknown action." });
  });
  return { calls, booking };
}

describe("group view", () => {
  browserTest("loads the demo group with no page errors", {}, async ({ page, go }) => {
    await go("/");
    assert.ok((await page.locator("#calendarGrid .slot").count()) > 20);
    assert.match(await page.locator("#peopleGrid").innerText(), /\S/);
  });

  browserTest("propose a plan, vote on a time, pick it, RSVP", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("[data-plan-idea]").first().click();
    await page.selectOption("#planRepeat", "weekly");
    await page.locator("#tentativePlanForm button[type=submit]").click();
    await page.locator(".time-option").first().waitFor();
    const vote = page.locator(".time-vote").first();
    await vote.click();
    await page.locator(".time-option [data-window]").first().click();
    await page.locator('[data-rsvp="yes"]').waitFor();
    await page.locator('[data-rsvp="yes"]').click();
    assert.match(await page.locator("#rsvpSummary").innerText(), /Going: You/);
    assert.match(await page.locator("#tentativePlanSection").innerText(), /week/i, "the plan repeats weekly");
  });

  browserTest("My availability: painting marks hours busy", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#mineViewTab").click();
    await page.waitForFunction(() => document.querySelector("#mineViewTab")?.getAttribute("aria-selected") === "true");
    const busyBefore = await page.locator("#calendarGrid .slot.mine-busy").count();
    const slots = page.locator("#calendarGrid .slot:not(.mine-busy)");
    const first = await slots.nth(0).boundingBox();
    // Paint down one column: the same day, three hours.
    const iso = await slots.nth(0).getAttribute("data-iso");
    const column = page.locator(`#calendarGrid .slot[data-iso="${iso}"]:not(.mine-busy)`);
    const last = await column.nth(2).boundingBox();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((before) => document.querySelectorAll("#calendarGrid .slot.mine-busy").length >= before + 3, busyBefore);
    const busyAfter = await page.locator("#calendarGrid .slot.mine-busy").count();
    assert.ok(busyAfter >= busyBefore + 3, `painted ${busyAfter - busyBefore} hours`);
  });
});

describe("calendars", () => {
  browserTest("Calendar links: connect Google via ?calendar=1, then disconnect", { signedIn: true }, async ({ page, go }) => {
    await go("/?calendar=1");
    await page.waitForFunction(() => /Synced/.test(document.querySelector("#googleCalendarButton")?.textContent || ""));
    await page.locator("#calendarButton").click();
    assert.match(await page.locator("#calendarSources").innerText(), /Google Calendar[\s\S]*2 busy blocks/);
    assert.match(await page.locator("#googleCalendarState").innerText(), /Connected/);
    await page.locator("[data-remove-source]").first().click();
    await page.waitForFunction(() => /Connect/.test(document.querySelector("#googleCalendarButton")?.textContent || ""));
    assert.match(await toast(page), /disconnected/i);
    assert.match(await page.locator("#calendarSources").innerText(), /No calendar links yet/);
    const sources = await page.evaluate(() => JSON.parse(localStorage.getItem("gatherly-calendar-sources") || "[]"));
    assert.equal(sources.length, 0);
  });

  browserTest("--google-server: syncs through the server, and disconnecting deletes the stored token", { signedIn: true, googleServer: true }, async ({ page, go, google }) => {
    await go("/");
    await page.waitForFunction(() => /Synced/.test(document.querySelector("#googleCalendarButton")?.textContent || ""));
    await page.locator("#calendarButton").click();
    assert.match(await page.locator("#calendarSources").innerText(), /Google Calendar[\s\S]*1 busy block/);
    assert.match(await page.locator("#googleCalendarState").innerText(), /Keeps syncing on its own/);
    const events = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("gatherly-my-events") || "{}")));
    assert.ok(events.includes("Server-synced brunch"));
    await page.locator("[data-remove-source]").first().click();
    await page.waitForFunction(() => /Connect/.test(document.querySelector("#googleCalendarButton")?.textContent || ""));
    assert.equal(google.deleted, 1);
  });

  browserTest("Who sees what: a private event disappears from a friend's preview", { signedIn: true }, async ({ page, go }) => {
    await go("/");
    await page.locator("#myAgenda [data-private-title=\"Therapy\"]").waitFor();
    await page.selectOption("#mycalPreview", "friends");
    const before = await page.locator("#myAgenda .agenda-event").count();
    assert.ok(before >= 2, "Therapy and Soccer show as busy");
    await page.selectOption("#mycalPreview", "me");
    await page.locator('#myAgenda [data-private-title="Therapy"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#myAgenda .agenda-row.is-private").length === 1);
    assert.match(await toast(page), /"Therapy" is private/);
    await page.selectOption("#mycalPreview", "friends");
    assert.equal(await page.locator("#myAgenda .agenda-event").count(), before - 1);
    assert.ok(!(await page.locator("#myAgenda").innerText()).includes("Therapy"));
  });

  browserTest("Free now strip shows a friend who is free", { signedIn: true }, async ({ page, go }) => {
    await go("/");
    const strip = page.locator("#freeNowStrip");
    await strip.waitFor();
    const text = await strip.innerText();
    assert.match(text, /Free now/i);
    assert.match(text, /Sam Rivera/);
    assert.match(text, /up for coffee/);
  });
});

describe("public booking page", () => {
  browserTest("pick a time, book it, then cancel it with the cancel link", {}, async ({ page, context, go }) => {
    const { calls, booking } = await stubBookApi(context);
    await go("/book/alexi-7fq2x", { app: false });
    await page.locator(".booking-time").first().waitFor();
    assert.match(await page.locator("#bookingTitle").innerText(), /Coffee chat/);
    await page.locator(".booking-time").nth(1).click();
    assert.match(await page.locator("#guestEmailHint").innerText(), /hasn't set up email/, "no email is promised");
    await page.fill("#guestName", "Sam Rivera");
    await page.fill("#guestEmail", "sam@example.com");
    await page.fill("#guestNote", "See you there");
    await page.locator("#bookingSubmit").click();
    await page.locator("#bookingDone").waitFor();
    assert.match(await page.locator("#doneTitle").innerText(), /You're booked/);
    assert.match(await page.locator("#doneCancelHint").innerText(), /no confirmation email is coming/);
    const sent = calls.find((entry) => entry.body?.action === "book");
    assert.equal(sent.body.start, booking.start);
    assert.equal(sent.body.email, "sam@example.com");
    assert.ok(sent.body.timeZone, "the visitor's zone goes along for the email");

    const cancelHref = await page.locator("#doneCancelHint a").getAttribute("href");
    assert.ok(cancelHref.includes(`cancel=${booking.cancelToken}`));
    await go(cancelHref, { app: false });
    await page.locator("[data-cancel]").click();
    await page.waitForFunction(() => document.querySelector("#messageTitle")?.textContent === "Cancelled.");
    assert.ok(!(await page.locator("#messageBody").innerText()).includes("emailed"));
    assert.ok(calls.some((entry) => entry.body?.action === "cancel" && entry.body.token === booking.cancelToken));
  });

  browserTest("with email set up, the page says a confirmation is on its way", {}, async ({ page, context, go }) => {
    await stubBookApi(context, { emails: true });
    await go("/book/alexi-7fq2x", { app: false });
    await page.locator(".booking-time").first().click();
    assert.match(await page.locator("#guestEmailHint").innerText(), /We'll email you a confirmation/);
    await page.fill("#guestName", "Sam");
    await page.fill("#guestEmail", "sam@example.com");
    await page.locator("#bookingSubmit").click();
    await page.locator("#bookingDone").waitFor();
    assert.match(await page.locator("#doneCancelHint").innerText(), /We emailed you a confirmation/);
  });
});

describe("booking link owner", () => {
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const seed = () => {
    const start = new Date(Date.now() + 2 * 864e5);
    start.setHours(15, 0, 0, 0);
    return {
      booking_pages: [{ id: "p1", owner_id: OWNER, handle: "alexi", title: "Coffee chat", owner_name: "Alexi", settings: { useCalendars: true }, busy: [], ics_urls: [], active: true, feed_token: "f".repeat(32) }],
      bookings: [{ id: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", page_id: "p1", start_at: start.toISOString(), end_at: new Date(start.getTime() + 30 * 60e3).toISOString(), guest_name: "Sam Rivera", guest_email: "sam@example.com", note: "", status: "confirmed" }],
    };
  };

  async function openBookings(page, go) {
    await go("/");
    await page.evaluate((rows) => localStorage.setItem("fake-seed", JSON.stringify(rows)), seed());
    await go("/");
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#bookingButton").click();
    await page.locator("[data-cancel-booking]").waitFor();
  }

  browserTest("cancelling without a booking server falls back to the database and says nobody was emailed", { signedIn: true, allowErrors: /status of 503/ }, async ({ page, go }) => {
    await openBookings(page, go);
    await page.locator("[data-cancel-booking]").click();
    await page.waitForFunction(() => /Booking cancelled/.test(document.querySelector("#toast")?.textContent || ""));
    assert.match(await toast(page), /No email went out/);
    const calls = await page.evaluate(() => window.__calls);
    assert.ok(calls.some(([table, op, row]) => table === "bookings" && op === "update" && row.status === "cancelled"));
    await page.waitForFunction(() => !document.querySelector("[data-cancel-booking]"));
  });

  browserTest("cancelling through the server, which emails the guest", { signedIn: true }, async ({ page, context, go }) => {
    const seen = [];
    await context.route("**/api/book", (route) => {
      seen.push({ body: JSON.parse(route.request().postData() || "{}"), auth: route.request().headers().authorization });
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ booking: { status: "cancelled" }, emailed: true }) });
    });
    await openBookings(page, go);
    await page.locator("[data-cancel-booking]").click();
    await page.waitForFunction(() => /Booking cancelled/.test(document.querySelector("#toast")?.textContent || ""));
    assert.match(await toast(page), /We emailed them/);
    assert.deepEqual(seen[0].body, { action: "owner-cancel", id: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" });
    assert.equal(seen[0].auth, "Bearer fake-token");
    const calls = await page.evaluate(() => window.__calls);
    assert.ok(!calls.some(([table, op]) => table === "bookings" && op === "update"), "the server did it, not the browser");
  });
});

describe("my availability", () => {
  browserTest("shows plain busy blocks, or your own event names with the switch on, and remembers it", { signedIn: true }, async ({ page, go }) => {
    await go("/");
    await page.locator("#mineViewTab").click();
    await page.locator(".busy-block").first().waitFor();
    assert.equal(await page.locator("#calendarGrid .event-chip").count(), 0, "busy blocks only by default");
    await page.locator("#mineDetailsToggle").check();
    await page.locator("#calendarGrid .event-chip").first().waitFor();
    const chips = await page.$$eval("#calendarGrid .event-chip", (list) => list.map((chip) => chip.innerText));
    assert.equal(await page.locator("#calendarGrid .busy-block").count(), 0);
    assert.ok(chips.some((text) => text.startsWith("Soccer") && text.includes("Riverdale Park") && /PM/.test(text)), "name, place and time");
    await go("/");
    await page.locator("#mineViewTab").click();
    await page.locator("#calendarGrid .event-chip").first().waitFor();
    assert.ok(await page.locator("#mineDetailsToggle").isChecked(), "remembered after reload");
    await page.locator("#groupViewTab").click();
    assert.ok(!(await page.locator("#mineDetailsToggle").isVisible()), "only on My availability");
  });
});

describe("group calendar", () => {
  browserTest("shows shared names and places only when the group allows event details", { signedIn: true, groupEvents: true }, async ({ page, go }) => {
    await go("/");
    await page.locator("#groupCalGrid .gc-event").first().waitFor({ state: "attached" });
    const names = async () => page.$$eval("#groupCalGrid .gc-event", (list) => list.map((item) => item.innerText));
    const withDetails = await names();
    assert.ok(withDetails.some((text) => text.includes("Lunch") && text.includes("Kensington Market")), "a friend's shared event shows its name and place");
    await page.evaluate(() => {
      const key = "gatherly-workspace:weekend-crew";
      const workspace = JSON.parse(localStorage.getItem(key));
      workspace.privacy = "busy";
      localStorage.setItem(key, JSON.stringify(workspace));
    });
    await go("/");
    await page.locator("#groupCalGrid .gc-event").first().waitFor({ state: "attached" });
    const busyOnly = (await names()).join(" ");
    for (const hidden of ["Lunch", "Kensington Market", "Climbing", "Basecamp", "Dentist", "Bloor St"]) {
      assert.ok(!busyOnly.includes(hidden), `"${hidden}" stays hidden in a busy-only group`);
    }
    assert.ok(busyOnly.includes("Therapy"), "your own events still show to you");
  });
});

describe("layout", () => {
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  browserTest("event chips never show a half-cut line; member badges don't cover the status dot", { signedIn: true, groupEvents: true }, async ({ page, go }) => {
    await go("/");
    await page.locator(".event-chip").first().waitFor();
    const chips = await page.$$eval(".event-chip", (list) => list.map((chip) => ({ text: chip.innerText, client: chip.clientHeight, scroll: chip.scrollHeight })));
    assert.ok(chips.length >= 4);
    for (const chip of chips) assert.ok(chip.scroll <= chip.client, `"${chip.text.replace(/\n/g, " | ")}" overflows (${chip.scroll} > ${chip.client})`);
    const therapy = chips.find((chip) => chip.text.startsWith("Therapy"));
    assert.equal(therapy.text.split("\n").length, 2, "a one-hour chip: title plus one meta line");

    const you = page.locator(".person-card.is-you");
    const badge = await you.locator(".person-badge").boundingBox();
    const dot = await you.locator(".presence").boundingBox();
    const box = (rect) => ({ left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height });
    assert.ok(!overlaps(box(badge), box(dot)), "YOU badge and status dot are apart");
  });

  browserTest("a friend row has no dead space and its avatar lines up with the name block", { signedIn: true }, async ({ page, go }) => {
    await go("/");
    await page.locator("#managePeople").click();
    await page.locator("#friendsTab").click();
    const row = page.locator(".friend-row").first();
    await row.waitFor();
    const layout = await row.evaluate((element) => {
      const text = element.querySelector(".avatar + div");
      const last = text.lastElementChild.getBoundingClientRect();
      const block = text.getBoundingClientRect();
      const avatar = element.querySelector(".avatar").getBoundingClientRect();
      return { gap: block.bottom - last.bottom, avatarMiddle: avatar.top + avatar.height / 2, top: block.top, bottom: block.bottom };
    });
    assert.ok(layout.gap <= 1, `${layout.gap}px empty under the text`);
    assert.ok(layout.avatarMiddle > layout.top && layout.avatarMiddle < layout.bottom, "avatar sits beside the name block");
  });

  browserTest("phone: hero buttons line up with the text, and the menu has a backdrop that closes it", { phone: true }, async ({ page, go }) => {
    await go("/");
    const copy = await page.locator(".hero-copy").boundingBox();
    const first = await page.locator("#tentativePlanButton").boundingBox();
    assert.ok(Math.abs(first.x - copy.x) <= 1, `first button starts ${first.x - copy.x}px from the text`);
    assert.equal(await page.locator("#menuBackdrop").isVisible(), false);
    await page.locator("#mobileMenu").click();
    await page.locator("#menuBackdrop").waitFor();
    assert.equal(await page.locator("#mobileMenu").getAttribute("aria-expanded"), "true");
    // Tap the dimmed page to the right of the drawer.
    const viewport = page.viewportSize();
    await page.mouse.click(viewport.width - 20, viewport.height / 2);
    await page.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("open"));
    assert.equal(await page.locator("#menuBackdrop").isVisible(), false);
    assert.equal(await page.locator("#mobileMenu").getAttribute("aria-expanded"), "false");
  });
});

describe("smoke", () => {
  browserTest("phone viewport: the menu opens and nothing scrolls sideways", { phone: true }, async ({ page, go }) => {
    await go("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page is ${overflow}px wider than the screen`);
    await page.locator("#mobileMenu").click();
    await page.locator("#calendarButton").click();
    await page.locator("#calendarDialog").waitFor();
    assert.equal(await page.locator("#calendarDialog").evaluate((dialog) => dialog.open), true);
  });

  browserTest("dark theme renders the group and the booking page", { theme: "dark" }, async ({ page, context, go }) => {
    const isDark = async () => {
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const [r, g, b] = background.match(/\d+/g).map(Number);
      assert.ok(r + g + b < 200, `body is dark (${background})`);
    };
    await go("/");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    await isDark();
    assert.ok((await texts(page, "#peopleGrid")).join("").trim().length > 0);
    await stubBookApi(context);
    await go("/book/alexi-7fq2x", { app: false });
    await page.locator(".booking-time").first().waitFor();
    await isDark();
  });
});
