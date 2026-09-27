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
import { parseIcs } from "../../lib/ics.js";
import { createECDH, randomBytes } from "node:crypto";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const state = { playwright: null, browser: null, server: null, base: "", dbServer: null, dbBase: "", skip: "" };

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

async function startServer(extraEnv = {}) {
  const port = await freePort();
  // A clean environment: demo mode (or the in-memory fake database), whatever the shell has set.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), ...extraEnv };
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
  // Two servers: demo mode for most flows, and one that runs the real API
  // handlers against scripts/fake-supabase.mjs (tests with `db: true`).
  const [demo, withDb] = await Promise.all([startServer(), startServer({ WADDLE_FAKE_DB: "1" })]);
  ({ server: state.server, base: state.base } = demo);
  ({ server: state.dbServer, base: state.dbBase } = withDb);
});

after(async () => {
  await state.browser?.close();
  for (const server of [state.server, state.dbServer]) {
    if (!server || server.exitCode !== null) continue;
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await exited;
  }
});

/**
 * One browser context per test, with the driver's stubs. `run(session)` gets
 * { page, context, errors, google, go(path), open(options) }; `open` starts a
 * second browser (another person with `as`, or another device) with the same
 * options plus the ones given. Page errors in any of them fail the test at the
 * end, except ones matching `allowErrors`. `serviceWorkers: true` lets sw.js run.
 */
function browserTest(name, { allowErrors = null, serviceWorkers = false, db = false, ...options }, run) {
  test(name, async (t) => {
    if (state.skip) return t.skip(state.skip);
    const opened = [];
    const base = db ? state.dbBase : state.base;
    const open = async (extra = {}) => {
      const session = await openSession({ playwright: state.playwright, browser: state.browser, blockServiceWorkers: !serviceWorkers, ...options, ...extra });
      opened.push(session);
      const go = async (path, { app = true } = {}) => {
        await session.page.goto(new URL(path, base).href);
        // The app renders the group after its first /api/workspace reply.
        if (app) await session.page.locator("#calendarGrid .slot").first().waitFor({ state: "attached", timeout: 10000 });
        await session.page.waitForLoadState("networkidle");
      };
      return { ...session, go };
    };
    try {
      const first = await open();
      await run({ ...first, open });
      for (const session of opened) assert.deepEqual(session.errors.filter((error) => !allowErrors?.test(error)), [], "no page or console errors");
    } finally {
      for (const session of opened) await session.close();
    }
  });
}

const texts = (page, selector) => page.locator(selector).allInnerTexts();
const toast = (page) => page.locator("#toast").innerText();
const toastSays = (page, pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector("#toast")?.textContent || ""), pattern.source);

// The fake database's accounts (fake-supabase.js).
const ALEXI = "11111111-1111-1111-1111-111111111111";
const SAM = "22222222-2222-2222-2222-222222222222";
const JORDAN = "33333333-3333-3333-3333-333333333333";

/** Polls `check` until it returns something truthy. */
async function eventually(check, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** A day `offsetDays` from today in local time, as the grid's data-iso. */
const localIso = (offsetDays = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** `hour`:00 local, `offsetDays` from today, as a Date. */
const localAt = (offsetDays, hour) => {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(hour, 0, 0, 0);
  return date;
};

/** The planner's own formatting, run in the page: "Fri, Sep 25" and "6:00 PM". */
const pageFormat = (page, iso) =>
  page.evaluate(async (value) => {
    const { formatClock, formatDayStamp } = await import("/lib/planner.js");
    return { day: formatDayStamp(new Date(value)), clock: formatClock(new Date(value)) };
  }, iso);

/** A UTC time as an ICS / Google Calendar date: 20260925T180000Z. */
const icsUtc = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** This browser's own member row in the cached demo group. */
const myMember = (page, slug = "weekend-crew") =>
  page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(`gatherly-workspace:${key}`));
    return saved.members.find((member) => member.id === localStorage.getItem("gatherly-member-id"));
  }, slug);

/** A plain PNG of the given size, drawn in the page. */
async function pngOfSize(page, width, height) {
  const base64 = await page.evaluate(({ width: w, height: h }) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    context.fillStyle = "#2a7";
    context.fillRect(0, 0, w, h);
    context.fillStyle = "#fc3";
    context.fillRect(w / 4, h / 4, w / 2, h / 2);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width, height });
  return { name: "photo.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

/** The pixel size of an image data URL, decoded in the page. */
const imageSize = (page, url) =>
  page.evaluate((source) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
    image.onerror = reject;
    image.src = source;
  }), url);

/** Saves a plan (timing "this month", so there are times to pick on any day of the week) and picks its first suggested time. */
async function planAndPick(page, { activity = "Board games", location = "Snakes & Lattes", repeat = "none" } = {}) {
  await page.locator("#tentativePlanButton").click();
  await page.fill("#planActivity", activity);
  await page.fill("#planLocation", location);
  await page.locator('#tentativePlanDialog input[name="timing"][value="month"]').check();
  await page.selectOption("#planRepeat", repeat);
  await page.locator("#tentativePlanForm button[type=submit]").click();
  await page.locator(".time-option [data-window]").first().waitFor();
  await page.locator(".time-option [data-window]").first().click();
  await page.locator("#calendarAdd").waitFor();
  return page.evaluate(() => JSON.parse(localStorage.getItem("gatherly-workspace:weekend-crew")).plan);
}

/** The fake database's rows for one table. */
const fakeRows = (page, table) => page.evaluate((name) => JSON.parse(JSON.stringify(window.__fakeDb[name])), table);

/** What Alexi currently shares with one friend: the calendar_shares row, or null. */
const shareRow = (page, viewer) =>
  page.evaluate(({ owner, viewer: id }) => JSON.parse(JSON.stringify(window.__fakeDb.calendar_shares.find((row) => row.owner_id === owner && row.viewer_id === id) || null)), { owner: ALEXI, viewer });

/** Opens Friends → Calendar for one friend and returns the agenda for today, once loaded. */
async function openFriendCalendarFor(page, name) {
  await page.locator("#managePeople").click();
  await page.locator("#friendsTab").click();
  await page.locator(`#friendList [data-view-calendar][data-friend-name="${name}"]`).click();
  await page.locator("#friendCalendarDialog").waitFor();
  await page.waitForFunction(() => !/Loading/.test(document.querySelector("#friendAgenda")?.textContent || ""));
  return page.locator("#friendAgenda");
}

/** The events in today's column of an agenda, as [time, title] pairs. */
const todaysAgenda = (agenda) =>
  agenda.locator(".agenda-day.today .agenda-event").evaluateAll((items) => items.map((item) => [item.querySelector(".agenda-time").textContent, item.querySelector("strong").textContent]));

/** Sam's view of Alexi's calendar, given the row Alexi's device published (null: nothing shared). */
async function samSees(open, row) {
  const sam = await open({ as: "sam", seed: { calendar_shares: row ? [row] : [] } });
  await sam.go("/");
  const agenda = await openFriendCalendarFor(sam.page, "Alexi");
  const text = await agenda.innerText();
  return { text, today: row ? await todaysAgenda(agenda) : [], updated: await sam.page.locator("#friendCalendarUpdated").innerText() };
}

/** Sets "Friends see" (and optionally one friend's override) in Who sees what, and saves. */
async function setSharing(page, { friends, sam, groups } = {}) {
  await page.locator("#sharingButton").click();
  await page.locator("#sharingDialog").waitFor();
  if (friends) await page.selectOption("#shareFriendsDefault", friends);
  if (sam !== undefined) await page.selectOption(`[data-share-friend="${SAM}"]`, sam);
  if (groups) await page.selectOption("#shareGroups", groups);
  await page.locator("#saveSharing").click();
  await toastSays(page, /Sharing saved/);
}

/** Every PUT /api/workspace body the page sends (what the group receives). */
function recordWorkspaceSaves(page) {
  const saves = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/workspace")) saves.push(request.postDataJSON().state);
  });
  return saves;
}

/** A saved download's text. */
async function downloadText(download) {
  const { readFile } = await import("node:fs/promises");
  return readFile(await download.path(), "utf8");
}

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

describe("activity", () => {
  browserTest("the bell shows a dot for news, lists what changed, and clears once seen", {}, async ({ page, go }) => {
    await go("/");
    const dotHidden = () => page.locator("#activityDot").evaluate((dot) => dot.hidden);
    assert.equal(await dotHidden(), false, "joining the group is news");
    await page.locator("#activityButton").click();
    await page.locator("#activityDialog").waitFor();
    assert.deepEqual(await texts(page, "#activityList .activity-row strong"), ["You joined", "Workspace created"]);
    assert.equal(await dotHidden(), true, "opening the list marks it seen");
    await page.locator("#activityDialog .close-dialog").click();

    await page.locator("#managePeople").click();
    await page.locator('[data-people-tab="group"]').click();
    await page.fill("#groupName", "Book club");
    await page.locator("#groupForm button[type=submit]").click();
    await toastSays(page, /Group name saved/);
    await page.locator("#peopleDialog .close-dialog").click();
    assert.equal(await dotHidden(), false, "a new change brings the dot back");
    await page.locator("#activityButton").click();
    assert.equal((await texts(page, "#activityList .activity-row strong"))[0], "Group renamed to Book club");
    assert.match((await texts(page, "#activityList .activity-row small"))[0], /just now/i);

    await go("/");
    assert.equal(await dotHidden(), true, "still seen after a reload");
  });
});

describe("a friend's calendar", () => {
  const at = (days, hour) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const samShares = {
    owner_id: SAM,
    viewer_id: ALEXI,
    events: [
      { start: at(0, 12), end: at(0, 13), title: "Lunch with Jo" },
      { start: at(0, 15), end: at(0, 16) },
      { start: at(7, 10), end: at(7, 18), title: "Cabin trip" },
    ],
    fallback_events: null,
    expires_at: null,
    updated_at: new Date(Date.now() - 10 * 60e3).toISOString(),
  };

  browserTest("Friends → Calendar shows what they shared (names only where they chose), week by week", { signedIn: true, seed: { calendar_shares: [samShares] } }, async ({ page, go }) => {
    await go("/");
    const agenda = await openFriendCalendarFor(page, "Sam Rivera");
    assert.equal(await page.locator("#friendCalendarTitle").innerText(), "Sam Rivera's calendar");
    assert.deepEqual(await todaysAgenda(agenda), [["12:00 PM – 1:00 PM", "Lunch with Jo"], ["3:00 PM – 4:00 PM", "Busy"]]);
    assert.match(await page.locator("#friendCalendarUpdated").innerText(), /^Updated 1\dm ago$/, "about ten minutes ago (the seed is made when this file loads)");
    assert.ok(!(await agenda.innerText()).includes("Cabin trip"), "next week's event is on next week");

    const thisWeek = await page.locator("#friendWeekLabel").innerText();
    await page.locator("#friendNextWeek").click();
    assert.notEqual(await page.locator("#friendWeekLabel").innerText(), thisWeek);
    const next = await agenda.innerText();
    assert.ok(next.includes("Cabin trip") && !next.includes("Lunch with Jo"));
    await page.locator("#friendPrevWeek").click();
    assert.equal(await page.locator("#friendWeekLabel").innerText(), thisWeek);
    assert.ok((await agenda.innerText()).includes("Lunch with Jo"));
    await page.locator("#friendCalendarDialog .close-dialog").click();

    // The Free now strip opens the same view.
    await page.locator("#freeNowStrip [data-view-calendar]").click();
    await page.waitForFunction(() => document.querySelector("#friendCalendarDialog").open && /Lunch with Jo/.test(document.querySelector("#friendAgenda").textContent));
  });
});

describe("who sees what, as a friend sees it", () => {
  const titles = (today) => today.map(([, title]) => title);
  const onlyTimes = (event) => Object.keys(event).sort().join() === "end,start";

  browserTest("Busy / free only (the default): Sam sees two busy blocks, no names or places", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    const row = await eventually(async () => {
      const current = await shareRow(page, SAM);
      return current?.events.length === 2 && current;
    }, "Alexi's default share with Sam");
    assert.ok(row.events.every(onlyTimes), "only times leave the device");
    const sam = await samSees(open, row);
    assert.deepEqual(titles(sam.today), ["Busy", "Busy"]);
    assert.ok(!/Therapy|Soccer|Riverdale/.test(sam.text));
  });

  browserTest("Nothing: the share is withdrawn and Sam can't open the calendar at all", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await eventually(() => shareRow(page, SAM), "the default share");
    await setSharing(page, { friends: "nothing" });
    await eventually(async () => (await shareRow(page, SAM)) === null, "the share to be deleted");
    const sam = await samSees(open, null);
    assert.match(sam.text, /Alexi isn't sharing their calendar with you/);
    assert.ok(!/Busy|Therapy|Soccer/.test(sam.text));
  });

  browserTest("Only events I pick: the picked event shows its name and place, the rest read Busy", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await page.locator('#myAgenda [data-pick-title="Soccer"]').click();
    await toastSays(page, /"Soccer" can be seen/);
    await setSharing(page, { friends: "some" });
    const row = await eventually(async () => {
      const current = await shareRow(page, SAM);
      return current?.events.some((event) => event.title === "Soccer") && current;
    }, "the picked share");
    assert.equal(row.events.find((event) => event.title === "Soccer").location, "Riverdale Park", "a place travels with its name");
    assert.ok(onlyTimes(row.events.find((event) => event.title !== "Soccer")), "Therapy goes as a bare busy time");
    const sam = await samSees(open, row);
    assert.deepEqual(titles(sam.today), ["Busy", "Soccer"]);
    assert.ok(!sam.text.includes("Therapy"));
  });

  browserTest("Everything: Sam sees every name, except a private event, which isn't even busy", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await setSharing(page, { friends: "all" });
    const row = await eventually(async () => {
      const current = await shareRow(page, SAM);
      return current?.events.every((event) => event.title) && current;
    }, "the full share");
    assert.deepEqual(titles((await samSees(open, row)).today), ["Therapy", "Soccer"]);

    await page.locator('#myAgenda [data-private-title="Therapy"]').click();
    await toastSays(page, /"Therapy" is private/);
    const hidden = await eventually(async () => {
      const current = await shareRow(page, SAM);
      return current?.events.length === 1 && current;
    }, "the share without the private event");
    assert.ok(!JSON.stringify(hidden).includes("Therapy"));
    const sam = await samSees(open, hidden);
    assert.deepEqual(titles(sam.today), ["Soccer"], "no busy block where the private event is");
  });

  browserTest("a per-friend level beats the default, in both directions", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await setSharing(page, { sam: "all" });
    const row = await eventually(async () => {
      const current = await shareRow(page, SAM);
      return current?.events.every((event) => event.title) && current;
    }, "Sam's override");
    assert.deepEqual(titles((await samSees(open, row)).today), ["Therapy", "Soccer"]);
    // The preview agrees: any other friend still gets busy blocks.
    await page.selectOption("#mycalPreview", "friends");
    assert.deepEqual(titles(await todaysAgenda(page.locator("#myAgenda"))), ["Busy", "Busy"]);
    await page.selectOption("#mycalPreview", SAM);
    assert.deepEqual(titles(await todaysAgenda(page.locator("#myAgenda"))), ["Therapy", "Soccer"]);

    await setSharing(page, { friends: "all", sam: "nothing" });
    await eventually(async () => (await shareRow(page, SAM)) === null, "Sam's share to be withdrawn");
    assert.match((await samSees(open, null)).text, /isn't sharing their calendar/);
  });

  browserTest("groups: names reach the group only when the group allows details and your group level does", { signedIn: true }, async ({ page, go }) => {
    const saves = recordWorkspaceSaves(page);
    await go("/");
    const mine = (saved) => saved.members.find((member) => member.userId === ALEXI);
    const busyOf = (saved) => [...(mine(saved)?.busy || [])].sort((a, b) => new Date(a.start) - new Date(b.start));
    const sentAfter = async (from, check, what) => eventually(() => saves.slice(from).find((saved) => mine(saved) && check(busyOf(saved), saved)), what);

    // Your level says Everything, but this group is busy/free only: no names go out.
    await setSharing(page, { groups: "all" });
    assert.ok(saves.every((saved) => busyOf(saved).every((block) => !block.title)));

    let from = saves.length;
    await page.locator("#privacyButton").click();
    await page.locator('#privacyDialog .privacy-option:has(input[value="details"])').click();
    await page.locator("#savePrivacy").click();
    const detailed = await sentAfter(from, (busy) => busy.length === 2 && busy.every((block) => block.title), "names to reach the group");
    assert.deepEqual(busyOf(detailed).map((block) => [block.title, block.location || ""]), [["Therapy", ""], ["Soccer", "Riverdale Park"]]);

    from = saves.length;
    await page.locator('#myAgenda [data-pick-title="Soccer"]').click();
    await setSharing(page, { groups: "some" });
    const picked = await sentAfter(from, (busy) => busy.length === 2 && !busy[0].title && busy[1].title === "Soccer", "only the picked name");
    assert.equal(busyOf(picked)[0].location, undefined, "no place without its name");

    from = saves.length;
    await page.locator('#myAgenda [data-private-title="Therapy"]').click();
    await sentAfter(from, (busy) => busy.length === 1 && busy[0].title === "Soccer", "the private event to leave the group entirely");

    from = saves.length;
    await setSharing(page, { groups: "busy" });
    await sentAfter(from, (busy) => busy.length === 1 && !busy[0].title && !busy[0].location, "busy/free only for the group");

    // Back to Everything, then the group switches to busy/free only: the stricter one wins.
    await setSharing(page, { groups: "all" });
    from = saves.length;
    await page.locator("#privacyButton").click();
    await page.locator('#privacyDialog .privacy-option:has(input[value="busy"])').click();
    await page.locator("#savePrivacy").click();
    await sentAfter(from, (busy, saved) => saved.privacy === "busy" && busy.length === 1 && !busy[0].title && !busy[0].location, "names and places stripped with the group on busy only");
    assert.equal(await page.locator("#privacyStatus").innerText(), "Busy / free only");
  });

  browserTest("share more for a while: start shows 'until …', Sam sees more until then, then it falls back; stop ends it early", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await eventually(() => shareRow(page, SAM), "the default share");
    await page.locator("#sharingButton").click();
    const slot = page.locator(`[data-grant-slot="${SAM}"]`);
    await slot.locator("summary").click();
    await slot.locator("[data-grant-level]").selectOption("all");
    await slot.locator("[data-grant-length]").selectOption("day");
    await slot.locator(`[data-start-grant="${SAM}"]`).click();
    await toastSays(page, /Sam Rivera sees everything until .*then it goes back/);

    const row = await eventually(async () => {
      const current = await shareRow(page, SAM);
      return current?.expires_at && current;
    }, "the temporary share");
    const hoursLeft = (new Date(row.expires_at) - Date.now()) / 3600e3;
    assert.ok(hoursLeft > 23.8 && hoursLeft <= 24, `ends in 24 hours (${hoursLeft.toFixed(2)})`);
    assert.ok(row.events.every((event) => event.title), "for now: everything");
    assert.ok(row.fallback_events.length === 2 && row.fallback_events.every(onlyTimes), "afterwards: back to busy/free");
    const until = await page.evaluate(async (iso) => {
      const { formatClock, formatDayStamp } = await import("/lib/planner.js");
      return `${formatDayStamp(new Date(iso))}, ${formatClock(new Date(iso))}`;
    }, row.expires_at);
    assert.match(await slot.locator(".grant-on").innerText(), new RegExp(`Everything\\s+until ${until.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const during = await samSees(open, row);
    assert.deepEqual(titles(during.today), ["Therapy", "Soccer"]);
    assert.match(during.updated, /Shared with you until/);
    // Once the time is up the database shows the fallback by itself, with Alexi's phone off.
    const ended = await samSees(open, { ...row, expires_at: new Date(Date.now() - 60e3).toISOString() });
    assert.deepEqual(titles(ended.today), ["Busy", "Busy"]);
    assert.doesNotMatch(ended.updated, /Shared with you until/);

    // Still running after a reload; Stop ends it now.
    await go("/");
    await page.locator("#sharingButton").click();
    await slot.locator(`[data-stop-grant="${SAM}"]`).click();
    await toastSays(page, /Back to your usual setting for Sam Rivera/);
    await slot.locator("summary", { hasText: "Share more for a while" }).waitFor();
    const stopped = await eventually(async () => {
      const current = await shareRow(page, SAM);
      return current && !current.expires_at && current;
    }, "the share to go back");
    assert.ok(stopped.events.every(onlyTimes));
  });

  browserTest("sharing choices follow you to another device (the private name never leaves as text)", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await page.locator('#myAgenda [data-pick-title="Soccer"]').click();
    await page.locator('#myAgenda [data-private-title="Therapy"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#myAgenda .agenda-row.is-private").length === 1);
    await setSharing(page, { friends: "all", sam: "some" });
    const [saved] = await eventually(async () => {
      const rows = await fakeRows(page, "sharing_settings");
      return rows[0]?.settings.friends === "all" && rows[0].settings.perFriend[SAM] === "some" && rows[0].settings.hidden.length === 1 && rows;
    }, "the choices on the account");
    assert.ok(!/therapy/i.test(JSON.stringify(saved)), "only a hash of the private event's name");

    const other = await open({ seed: { sharing_settings: [saved] } });
    await other.go("/");
    await other.page.waitForFunction(() => /Therapy/.test(document.querySelector("#myAgenda .agenda-row.is-private")?.textContent || ""));
    assert.match(await other.page.locator("#myAgenda .agenda-event.is-picked").innerText(), /Soccer/);
    await other.page.locator("#sharingButton").click();
    assert.equal(await other.page.locator("#shareFriendsDefault").inputValue(), "all");
    assert.equal(await other.page.locator(`[data-share-friend="${SAM}"]`).inputValue(), "some");
  });
});

describe("friends", () => {
  browserTest("send a friend request, they accept it on their device, and both see the friendship", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await page.locator("#managePeople").click();
    await page.locator("#friendsTab").click();
    await page.fill("#friendRequestEmail", "alexi@example.com");
    await page.locator("#sendFriendRequest").click();
    await toastSays(page, /That is your own address/);
    await page.fill("#friendRequestEmail", "Jordan@Example.com");
    await page.locator("#sendFriendRequest").click();
    await toastSays(page, /Friend request sent/);
    await page.locator("#outgoingSection").waitFor();
    assert.match(await page.locator("#outgoingList").innerText(), /jordan@example\.com[\s\S]*Waiting for them to sign in[\s\S]*Withdraw/);
    await page.fill("#friendRequestEmail", "jordan@example.com");
    await page.locator("#sendFriendRequest").click();
    await toastSays(page, /already have a request waiting/);
    const requests = await fakeRows(page, "friend_requests");
    const sent = requests.filter((row) => row.recipient_email === "jordan@example.com");
    assert.equal(sent.length, 1, "one request, not two");
    assert.equal(sent[0].status, "pending");

    // Jordan signs in on their own phone.
    const jordan = await open({ as: "jordan", seed: { friend_requests: requests } });
    await jordan.go("/");
    await jordan.page.waitForFunction(() => document.querySelector("#friendBadge")?.textContent === "1" && !document.querySelector("#friendBadge").hidden);
    await jordan.page.locator("#managePeople").click();
    assert.equal(await jordan.page.locator("#friendsTab").innerText(), "Friends (1)");
    await jordan.page.locator("#friendsTab").click();
    assert.match(await jordan.page.locator("#incomingList").innerText(), /Alexi/);
    await jordan.page.locator("#incomingList [data-accept]").click();
    await toastSays(jordan.page, /You're now friends/);
    await jordan.page.waitForFunction(() => document.querySelector("#incomingSection").hidden && document.querySelector("#friendBadge").hidden);
    assert.match(await jordan.page.locator("#friendList").innerText(), /Alexi[\s\S]*Calendar/);
    const accepted = await fakeRows(jordan.page, "friend_requests");
    const row = accepted.find((entry) => entry.id === sent[0].id);
    assert.equal(row.status, "accepted");
    assert.equal(row.recipient_id, JORDAN);

    // Back on Alexi's device.
    const alexi = await open({ seed: { friend_requests: accepted } });
    await alexi.go("/");
    await alexi.page.locator("#managePeople").click();
    await alexi.page.locator("#friendsTab").click();
    await alexi.page.locator("#friendList [data-friend-name='Jordan Lee']").waitFor();
    assert.equal(await alexi.page.locator("#outgoingSection").isHidden(), true);
  });
});

describe("settings", () => {
  browserTest("locking needs an account; signed out the switch is off, and the day must end after it starts", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingLocked").isDisabled(), true);
    assert.match(await page.locator("#lockHint").innerText(), /Sign in with Google first/);
    assert.equal(await page.locator("#settingWorkspaceName").inputValue(), "Weekend crew");
    await page.selectOption("#settingDayStart", "20");
    await page.selectOption("#settingDayEnd", "10");
    await page.locator("#settingsForm button[type=submit]").click();
    await toastSays(page, /The day has to end after it starts/);
    assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => dialog.open), true);
  });

  browserTest("signed in: lock the group, and the saved group says who may edit", { signedIn: true }, async ({ page, go }) => {
    const saves = recordWorkspaceSaves(page);
    await go("/");
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingLocked").isDisabled(), false);
    assert.match(await page.locator("#lockHint").innerText(), /Locked workspaces accept edits from you and any signed-in member/);
    await page.locator("#settingLocked").check();
    await page.selectOption("#settingMinWindow", "2");
    const from = saves.length;
    await page.locator("#settingsForm button[type=submit]").click();
    await toastSays(page, /Settings saved/);
    const saved = await eventually(() => saves.slice(from).find((state) => state.settings.locked), "the locked group");
    assert.equal(saved.ownerId, ALEXI);
    assert.equal(saved.settings.minWindowHours, 2);
    assert.equal(saved.members.find((member) => member.userId === ALEXI)?.name, "Alexi");
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingLocked").isChecked(), true);
    assert.equal(await page.locator("#settingMinWindow").inputValue(), "2");
  });

  browserTest("export downloads the whole group as JSON", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#settingsButton").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#exportWorkspace").click()]);
    assert.equal(download.suggestedFilename(), "weekend-crew-waddle.json");
    assert.equal(await download.failure(), null);
    const exported = JSON.parse(await downloadText(download));
    assert.equal(exported.slug, "weekend-crew");
    assert.equal(exported.name, "Weekend crew");
    assert.deepEqual(exported.members.map((member) => member.name).slice(0, 3), ["Jamie Miller", "Taylor Kim", "Riley Lee"]);
    assert.ok(exported.ideas.length === 3 && exported.settings);
    await toastSays(page, /Workspace exported/);
  });

  browserTest("reset this device forgets you, your calendar links and their events, then reloads", {}, async ({ page, go }) => {
    await go("/");
    const today = (hour) => {
      const date = new Date();
      date.setHours(hour, 0, 0, 0);
      return date.toISOString();
    };
    await page.evaluate((events) => {
      localStorage.setItem("gatherly-calendar-sources", JSON.stringify([{ type: "ics", url: "https://example.com/me.ics", label: "example.com", syncedAt: new Date().toISOString(), blocks: 1 }]));
      localStorage.setItem("gatherly-my-events", JSON.stringify({ "ics:https://example.com/me.ics": { from: events.from, to: events.to, events: [{ start: events.start, end: events.end, title: "Dentist" }] } }));
      localStorage.setItem("gatherly-profile", JSON.stringify({ name: "Alexi", photo: "", shareSchedule: true }));
    }, { from: today(-24 * 7), to: today(24 * 21), start: today(14), end: today(15) });
    await go("/");
    assert.match(await page.locator("#myAgenda").innerText(), /Dentist/);
    assert.equal(await page.locator("#profileName").innerText(), "Alexi");
    const memberBefore = await page.evaluate(() => localStorage.getItem("gatherly-member-id"));

    await page.locator("#settingsButton").click();
    await Promise.all([page.waitForEvent("load"), page.locator("#resetLocal").click()]);
    await page.locator("#calendarGrid .slot").first().waitFor({ state: "attached" });
    await page.waitForLoadState("networkidle");
    const after = await page.evaluate(() => ({
      member: localStorage.getItem("gatherly-member-id"),
      sources: localStorage.getItem("gatherly-calendar-sources"),
      events: localStorage.getItem("gatherly-my-events"),
    }));
    assert.notEqual(after.member, memberBefore, "a new member id");
    assert.deepEqual(JSON.parse(after.sources || "[]"), [], "no calendar links");
    assert.ok(!after.events || !after.events.includes("Dentist"), "the imported events are gone too");
    assert.equal(await page.locator("#profileName").innerText(), "You");
    assert.match(await page.locator("#myAgenda").innerText(), /Connect a calendar to see it here/);
  });
});

describe("phone day strip", () => {
  browserTest("one day at a time: pick a day from the strip, or swipe one day over", { phone: true }, async ({ page, go }) => {
    await go("/");
    const pills = page.locator("#dayStrip .day-pill");
    assert.equal(await pills.count(), 7);
    const active = () => pills.evaluateAll((list) => list.findIndex((pill) => pill.getAttribute("aria-pressed") === "true"));
    const shown = () => page.locator("#calendarGrid .day strong").allInnerTexts();
    const pillDay = async (index) => pills.nth(index).locator("strong").innerText();
    const columns = () => page.$$eval("#calendarGrid .slot", (slots) => new Set(slots.map((slot) => slot.dataset.iso)).size);

    const today = await pills.evaluateAll((list) => list.findIndex((pill) => pill.classList.contains("today")));
    assert.equal(await active(), today, "starts on today");
    assert.deepEqual(await shown(), [await pillDay(today)]);
    assert.equal(await columns(), 1);

    for (const index of [0, 3, 6, 1]) {
      await pills.nth(index).click();
      assert.equal(await active(), index);
      assert.deepEqual(await shown(), [await pillDay(index)]);
      assert.equal(await columns(), 1);
    }

    const swipe = async (direction) => {
      const grid = page.locator("#calendarGrid");
      await grid.scrollIntoViewIfNeeded();
      const box = await grid.boundingBox();
      const y = box.y + Math.min(box.height / 2, 120);
      const [from, to] = direction === "left" ? [0.85, 0.2] : [0.2, 0.85];
      await page.mouse.move(box.x + box.width * from, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * to, y, { steps: 6 });
      await page.mouse.up();
    };
    await swipe("left");
    assert.equal(await active(), 2, "a swipe moves exactly one day");
    assert.deepEqual(await shown(), [await pillDay(2)]);
    await swipe("right");
    assert.equal(await active(), 1);
  });
});

describe("usual week", () => {
  browserTest("save as my usual week repeats your busy hours in weeks you haven't edited; I'm free all week clears this one", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#mineViewTab").click();
    await page.locator("#saveUsualWeek").click();
    await toastSays(page, /Mark some busy time first/);

    const cell = (iso, hour) => page.locator(`#calendarGrid .slot[data-iso="${iso}"][data-hour="${hour}"]`);
    const busy = (iso, hour) => page.waitForSelector(`#calendarGrid .slot.mine-busy[data-iso="${iso}"][data-hour="${hour}"]`, { state: "attached" });
    await cell(localIso(0), 10).click();
    await busy(localIso(0), 10);
    await page.locator("#saveUsualWeek").click();
    await toastSays(page, /Saved\. Weeks you have not edited now use this pattern/);
    const mine = await myMember(page);
    assert.deepEqual(mine.weekly.map(({ weekday, start, end }) => ({ weekday, start, end })), [{ weekday: new Date().getDay(), start: "10:00", end: "11:00" }]);

    await page.locator("#nextWeek").click();
    await busy(localIso(7), 10);
    assert.equal(await page.locator("#calendarGrid .slot.mine-busy").count(), 1, "only that hour, a week later");

    await page.locator("#thisWeek").click();
    await busy(localIso(0), 10);
    await page.locator("#clearMyWeek").click();
    await toastSays(page, /your group sees you as free all week/);
    await page.waitForFunction(() => document.querySelectorAll("#calendarGrid .slot.mine-busy").length === 0);
    assert.equal(await page.locator("#calendarGrid .slot.mine-free").count(), await page.locator("#calendarGrid .slot").count());
    await page.locator("#nextWeek").click();
    await busy(localIso(7), 10);
  });
});

describe("groups", () => {
  browserTest("create a group, rename it, switch between groups, and forget one", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#groupsButton").click();
    assert.deepEqual(await texts(page, "#groupList .group-row strong"), ["Weekend crew"]);
    assert.match(await page.locator("#groupList .group-row.current").innerText(), /OPEN/);

    await page.fill("#newGroupName", "Book club");
    await Promise.all([page.waitForURL(/\?w=book-club-[a-z2-9]{5}$/), page.locator("#newGroupForm button[type=submit]").click()]);
    const slug = new URL(page.url()).searchParams.get("w");
    await page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Book club");
    assert.equal(await page.locator("#peopleCount").innerText(), "1 PERSON", "a new group starts with just you");
    await page.locator("#activityButton").click();
    assert.equal((await texts(page, "#activityList .activity-row strong"))[0], "Group created: Book club");
    await page.locator("#activityDialog .close-dialog").click();

    await page.locator("#managePeople").click();
    await page.locator('[data-people-tab="group"]').click();
    assert.equal(await page.locator("#groupName").inputValue(), "Book club");
    await page.fill("#groupName", "Book club crew");
    await page.locator("#groupForm button[type=submit]").click();
    await toastSays(page, /Group name saved/);
    await page.locator("#peopleDialog .close-dialog").click();
    assert.equal(await page.locator("#workspaceName").innerText(), "Book club crew");
    assert.equal(await page.title(), "Book club crew — Waddle");

    // Switch from the breadcrumb.
    await page.locator("#switchGroup").click();
    assert.equal(await page.locator("#groupList .group-row.current strong").innerText(), "Book club crew");
    await Promise.all([page.waitForURL(`${state.base}/`), page.locator("#groupList .group-row:not(.current)").click()]);
    await page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Weekend crew");
    await page.locator("#groupsButton").click();
    assert.deepEqual(await texts(page, "#groupList .group-row strong"), ["Weekend crew", "Book club crew"], "the list shows the new name");
    await Promise.all([page.waitForURL(new RegExp(`\\?w=${slug}$`)), page.locator("#groupList .group-row:not(.current)").click()]);
    await page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Book club crew");

    // Forget it from this device's list.
    await go("/");
    await page.locator("#groupsButton").click();
    await page.locator(`[data-forget-group="${slug}"]`).click();
    assert.deepEqual(await texts(page, "#groupList .group-row strong"), ["Weekend crew"]);
  });

  browserTest("getting-started checklist: a new group ticks off name, times and invites, then it goes away", {}, async ({ page, go }) => {
    await go("/");
    assert.equal(await page.locator("#checklistCard").isHidden(), true, "never on the demo group");
    await go("/?w=ski-trip-ab2cd");
    const card = page.locator("#checklistCard");
    await card.waitFor();
    const count = () => page.locator("#checklistCount").innerText();
    const done = () => page.$$eval("#checklistSteps .checklist-step.is-done", (steps) => steps.map((step) => step.dataset.step));
    assert.equal(await count(), "0 of 3 done");

    await page.locator('[data-checklist-step="name"]').click();
    await page.locator("#settingsDialog").waitFor();
    await page.fill("#settingWorkspaceName", "Ski trip");
    await page.locator("#settingsForm button[type=submit]").click();
    await toastSays(page, /Settings saved/);
    await page.waitForFunction(() => document.querySelector("#checklistCount").textContent === "1 of 3 done");
    assert.deepEqual(await done(), ["name"]);

    await page.locator('[data-checklist-step="times"]').click();
    assert.equal(await page.locator("#mineViewTab").getAttribute("aria-selected"), "true", "opens My availability");
    await page.locator(`#calendarGrid .slot[data-iso="${localIso(0)}"][data-hour="12"]`).click();
    await page.waitForFunction(() => document.querySelector("#checklistCount").textContent === "2 of 3 done");

    await page.locator('[data-checklist-step="invite"]').click();
    await page.locator("#peopleDialog").waitFor();
    for (const name of ["Jordan Lee", "Casey Park"]) {
      await page.fill("#friendName", name);
      await page.locator("#friendForm button[type=submit]").click();
      await toastSays(page, new RegExp(`${name} added`));
    }
    await page.waitForFunction(() => document.querySelector("#checklistCard").hidden, null, { timeout: 5000 });

    // Dismissing hides it for good on this device.
    await go("/?w=book-club-xy3zq");
    await card.waitFor();
    await page.locator("#dismissChecklist").click();
    await page.waitForFunction(() => document.querySelector("#checklistCard").hidden);
    await go("/?w=book-club-xy3zq");
    assert.equal(await card.isHidden(), true);
  });
});

describe("people", () => {
  browserTest("invite link, a placeholder person, and removing people", {}, async ({ page, context, go }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: state.base });
    await go("/");
    await page.locator("#inviteButton").click();
    await toastSays(page, /Link copied/);
    assert.equal(await page.locator("#inviteLink").inputValue(), `${state.base}/`);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${state.base}/`, "the link is on the clipboard");

    await page.fill("#friendName", "Jordan Lee");
    await page.fill("#friendEmail", "jordan@example.com");
    await page.locator("#friendForm button[type=submit]").click();
    await toastSays(page, /Jordan Lee added\. Link copied/);
    assert.match(await page.locator("#savedPeople").innerText(), /Jordan Lee\s*Invited/);
    await page.fill("#friendName", "jordan lee");
    await page.locator("#friendForm button[type=submit]").click();
    await toastSays(page, /Jordan Lee is already in this group/);
    await page.locator("#peopleDialog .close-dialog").click();
    assert.equal(await page.locator("#peopleCount").innerText(), "5 PEOPLE");
    assert.match(await page.locator(".person-card.pending").innerText(), /Jordan Lee[\s\S]*Waiting for times/);
    assert.match(await page.locator("#groupCalGrid").innerText(), /Jordan Lee[\s\S]*Not joined yet/);

    // Remove the placeholder from the dialog, and a member from their card.
    await page.locator("#managePeople").click();
    const jordan = await page.evaluate(() => JSON.parse(localStorage.getItem("gatherly-workspace:weekend-crew")).members.find((member) => member.name === "Jordan Lee").id);
    await page.locator(`#savedPeople [data-remove-member="${jordan}"]`).click();
    await toastSays(page, /Jordan Lee removed from this group/);
    await page.locator("#peopleDialog .close-dialog").click();
    const gamesVotes = () => page.locator(".idea-card", { hasText: "Games night" }).locator(".idea-meta").innerText();
    assert.match(await gamesVotes(), /2 votes/);
    await page.locator('#peopleGrid [data-remove-member="demo_riley"]').click();
    await toastSays(page, /Riley Lee removed from this group/);
    assert.equal(await page.locator("#peopleCount").innerText(), "3 PEOPLE");
    assert.ok(!(await page.locator("#peopleGrid").innerText()).includes("Riley Lee"));
    assert.match(await gamesVotes(), /1 vote\b/, "their votes go with them");
    await page.locator("#activityButton").click();
    assert.deepEqual((await texts(page, "#activityList .activity-row strong")).slice(0, 2), ["Riley Lee was removed", "Jordan Lee was removed"]);
    await page.locator("#activityDialog .close-dialog").click();

    // Another group's link carries its code.
    await go("/?w=book-club-ab2cd");
    await page.locator("#inviteButton").click();
    assert.equal(await page.locator("#inviteLink").inputValue(), `${state.base}/g/book-club-ab2cd`, "a /g/ link, so chats show a preview");
  });
});

describe("plans", () => {
  browserTest("repeating plans roll on to the next date by themselves, with fresh RSVPs, and export as repeating", {}, async ({ page, go }) => {
    await go("/");
    const chosen = localAt(-6, 18);
    await page.evaluate(({ start, end, zone }) => {
      const key = "gatherly-workspace:weekend-crew";
      const saved = JSON.parse(localStorage.getItem(key));
      saved.plan = { id: "plan_pottery", activity: "Pottery", location: "Clay Studio", audience: "Weekend crew", timing: "week", repeat: "weekly", chosen: start, chosenEnd: end, timeZone: zone, rsvp: { at: start, answers: { demo_jamie: "yes" } }, updatedAt: start };
      localStorage.setItem(key, JSON.stringify(saved));
    }, { start: chosen.toISOString(), end: localAt(-6, 20).toISOString(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    await go("/");
    const next = await pageFormat(page, localAt(1, 18).toISOString());
    assert.equal(await page.locator("#tentativeTiming").innerText(), `Next up ${next.day} at 6:00 PM with Weekend crew · every week`);
    assert.equal(await page.locator("#tentativeBadge").innerText(), "Repeating");
    assert.equal(await page.locator("#rsvpSummary").innerText(), "4 haven’t answered", "last week's answers don't count");
    await page.locator('[data-rsvp="yes"]').click();
    await page.waitForFunction(() => document.querySelector("#rsvpSummary").textContent === "Going: You · 3 haven’t answered");

    const google = new URL(await page.locator("#addToGoogle").getAttribute("href"));
    assert.equal(google.searchParams.get("recur"), "RRULE:FREQ=WEEKLY");
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadIcs").click()]);
    const ics = await downloadText(download);
    assert.match(ics, /\r?\nRRULE:FREQ=WEEKLY\r?\n/);
    assert.match(ics, /SUMMARY:Pottery · Clay Studio/);

    await page.locator("#editTentativePlan").click();
    await page.selectOption("#planRepeat", "monthly");
    await page.locator("#tentativePlanForm button[type=submit]").click();
    await page.waitForFunction(() => /every month$/.test(document.querySelector("#tentativeTiming").textContent));
  });

  browserTest("add to calendar: an .ics file and a Google link for the picked time (the Google page itself is never opened)", {}, async ({ page, context, go }) => {
    await context.route("https://calendar.google.com/**", (route) => route.abort());
    await go("/");
    const plan = await planAndPick(page);
    const google = new URL(await page.locator("#addToGoogle").getAttribute("href"));
    assert.equal(`${google.origin}${google.pathname}`, "https://calendar.google.com/calendar/render");
    assert.equal(google.searchParams.get("action"), "TEMPLATE");
    assert.equal(google.searchParams.get("text"), "Board games · Snakes & Lattes");
    assert.equal(google.searchParams.get("location"), "Snakes & Lattes");
    assert.equal(google.searchParams.get("dates"), `${icsUtc(plan.chosen)}/${icsUtc(plan.chosenEnd)}`);
    assert.equal(google.searchParams.get("recur"), null, "a one-off plan doesn't repeat");

    // Tapping the link is remembered; the navigation itself is cancelled here.
    await page.evaluate(() => document.querySelector("#addToGoogle").addEventListener("click", (event) => event.preventDefault(), { capture: true }));
    await page.locator("#addToGoogle").click();
    assert.equal(await page.locator("#addToGoogle").innerText(), "Added to Google ✓");
    assert.match(await page.locator("#calendarAddNote").innerText(), /Already added to Google from this device/);

    const save = async () => {
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#downloadIcs").click()]);
      assert.equal(download.suggestedFilename(), "weekend-crew-plan.ics");
      return downloadText(download);
    };
    const ics = await save();
    assert.match(ics, /^BEGIN:VCALENDAR\r?\n/);
    assert.ok(ics.includes(`DTSTART:${icsUtc(plan.chosen)}`) && ics.includes(`DTEND:${icsUtc(plan.chosenEnd)}`));
    assert.match(ics, /SUMMARY:Board games · Snakes & Lattes/);
    assert.ok(!/RRULE/.test(ics));
    assert.equal(await page.locator("#downloadIcs").innerText(), "Downloaded ✓");
    const uid = /UID:(.+)/.exec(ics)[1].trim();
    assert.equal(/UID:(.+)/.exec(await save())[1].trim(), uid, "the same event again, not a duplicate");

    // A different time is a new event: both buttons are ready again.
    await page.locator(".time-option [data-window]").first().click();
    await page.waitForFunction(() => document.querySelector("#addToGoogle").textContent === "Google Calendar" && document.querySelector("#downloadIcs").textContent === "Apple / Outlook");
  });

  browserTest("best-time cards: pick one, see its window, and plan something right there", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#nextWeek").click(); // every window next week is still ahead
    const cards = page.locator("#bestTimes .best-card");
    await cards.first().waitFor();
    const count = await cards.count();
    assert.ok(count >= 1 && count <= 3, `${count} cards`);
    const card = cards.nth(count - 1);
    const [day, time] = [await card.locator("small").innerText(), await card.locator("strong").innerText()];
    assert.match(await card.locator("span").innerText(), /free · \d+ hrs?$/);
    await card.click();
    await page.waitForFunction(() => document.querySelectorAll("#bestTimes .best-card.active").length === 1);
    assert.equal(await page.locator("#bestTimes .best-card.active strong").innerText(), time);
    assert.equal(await page.locator("#selectedWindowTitle").innerText(), `${day} · ${time}`);
    const highlighted = await page.$$eval("#calendarGrid .slot.in-window", (slots) => [...new Set(slots.map((slot) => slot.dataset.iso))]);
    assert.equal(highlighted.length, 1, "one day's window is highlighted");
    assert.ok((await page.locator("#calendarGrid .slot.in-window").count()) >= 2, "at least the shortest window");

    await page.locator("#planButton").click();
    assert.ok((await page.locator("#planWhen").innerText()).startsWith(`${day}, ${time.split(" – ")[0]}`));
    await page.fill("#planActivity", "Picnic");
    await page.locator("#tentativePlanForm button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#tentativeBadge").textContent === "Pencilled in");
    assert.equal(await page.locator("#tentativeTiming").innerText(), `Pencilled in for ${day} at ${time.split(" – ")[0]} with Weekend crew`);
  });
});

describe("ideas", () => {
  browserTest("an idea with a photo: cropped to a card, kept after reload, and removable", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#addIdea").click();
    await page.fill("#ideaTitle", "Pottery night");
    await page.fill("#ideaDescription", "Wheels and wine");
    await page.fill("#ideaLocation", "Clay Studio");
    await page.fill("#ideaTag", "crafty");
    await page.setInputFiles("#ideaPhotoFile", { name: "notes.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    await toastSays(page, /That photo couldn.t be read/);
    assert.equal(await page.locator("#ideaPhotoData").inputValue(), "");

    await page.setInputFiles("#ideaPhotoFile", await pngOfSize(page, 1600, 900));
    await page.waitForFunction(() => document.querySelector("#ideaPhotoPreview").classList.contains("has-photo"));
    assert.equal(await page.locator("#chooseIdeaPhotoLabel").innerText(), "Change photo");
    const photo = await page.locator("#ideaPhotoData").inputValue();
    assert.match(photo, /^data:image\/jpeg;base64,/);
    assert.deepEqual(await imageSize(page, photo), [720, 450], "a 16:10 cover, scaled down");
    await page.locator("#ideaSubmit").click();
    await toastSays(page, /Idea added — your vote is on it/);

    const card = page.locator(".idea-card", { hasText: "Pottery night" });
    const tile = async () => card.locator(".idea-image").evaluate((element) => ({ photo: element.classList.contains("has-photo"), background: element.style.backgroundImage }));
    assert.deepEqual(await tile(), { photo: true, background: `url("${photo}")` });
    assert.match(await card.innerText(), /CRAFTY[\s\S]*Wheels and wine[\s\S]*Clay Studio[\s\S]*1 vote/);
    assert.equal(await card.locator(".heart").getAttribute("aria-pressed"), "true");

    await go("/");
    assert.equal((await tile()).photo, true, "kept after a reload");
    await card.locator(".idea-edit").click();
    await page.locator("#removeIdeaPhoto").click();
    await page.locator("#ideaSubmit").click();
    await toastSays(page, /Idea updated/);
    assert.deepEqual(await tile(), { photo: false, background: "" });
  });
});

describe("profile", () => {
  browserTest("profile name and photo show everywhere you appear; the colour palette is kept per device", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#accountButton").click();
    await page.fill("#profileDisplayName", "Alexi Morgan");
    await page.setInputFiles("#profilePhotoFile", await pngOfSize(page, 600, 400));
    await page.waitForFunction(() => /data:image\/jpeg/.test(document.querySelector("#profilePhotoPreview").style.backgroundImage));
    const photo = await page.locator("#profilePhotoUrl").inputValue();
    const [width, height] = await imageSize(page, photo);
    assert.equal(width, height, "cropped square");
    await page.locator("#profileForm button[type=submit]").click();
    await toastSays(page, /Profile saved/);

    assert.equal(await page.locator("#profileName").innerText(), "Alexi Morgan");
    assert.equal(await page.locator("#topAccountButton").evaluate((element) => element.style.backgroundImage), `url("${photo}")`);
    const you = page.locator(".person-card.is-you");
    assert.match(await you.innerText(), /Alexi Morgan/);
    assert.equal(await you.locator(".avatar").innerText(), "AM");
    assert.match(await page.locator("#groupCalGrid .gc-person.is-you").innerText(), /Alexi Morgan \(you\)/);

    await page.locator("#settingsButton").click();
    await page.locator('#palettePicker [data-palette="plum"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "plum");
    await go("/");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "plum", "kept after a reload");
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator('#palettePicker [data-palette="plum"]').getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("#profileName").innerText(), "Alexi Morgan");
  });
});

describe("calendar links", () => {
  const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const feed = () =>
    [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN",
      "BEGIN:VEVENT", "UID:a@test", `DTSTART:${stamp(localAt(0, 10))}`, `DTEND:${stamp(localAt(0, 11))}`, "SUMMARY:Dentist", "LOCATION:Bloor St", "DESCRIPTION:Bring the forms", "END:VEVENT",
      "BEGIN:VEVENT", "UID:b@test", `DTSTART:${stamp(localAt(0, 19))}`, `DTEND:${stamp(localAt(0, 21))}`, "SUMMARY:Book club", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

  browserTest("an ICS link: its events show with names only to you, the group gets busy times, and removing it takes them away", {}, async ({ page, context, go }) => {
    // The feed server: /api/calendar parses a real .ics with the app's own parser; only the download is faked.
    const asked = [];
    await context.route("**/api/calendar", (route) => {
      const body = route.request().postDataJSON();
      asked.push(body);
      const blocks = parseIcs(feed(), { from: body.from, to: body.to, includeTitles: body.details === true });
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ blocks, count: blocks.length, truncated: false }) });
    });
    const saves = recordWorkspaceSaves(page);
    await go("/");
    await page.locator("#calendarButton").click();
    await page.fill("#icsUrl", "webcal://calendar.example.com/me.ics");
    await page.locator("#icsSubmit").click();
    await toastSays(page, /Imported 2 busy blocks/);
    assert.equal(asked[0].url, "webcal://calendar.example.com/me.ics");
    assert.equal(asked[0].details, true, "names come back to this browser only");
    assert.match(await page.locator("#calendarSources").innerText(), /calendar\.example\.com[\s\S]*2 busy blocks/);
    await page.locator("#calendarDialog .close-dialog").click();

    assert.deepEqual(await todaysAgenda(page.locator("#myAgenda")), [["10:00 AM – 11:00 AM", "Dentist"], ["7:00 PM – 9:00 PM", "Book club"]]);
    const mine = await eventually(async () => {
      const id = await page.evaluate(() => localStorage.getItem("gatherly-member-id"));
      const saved = saves.at(-1)?.members.find((member) => member.id === id);
      return saved?.busy.filter((block) => block.source === "ics").length === 2 && saved;
    }, "the busy times in the group");
    assert.ok(!/Dentist|Book club|Bloor|forms/.test(JSON.stringify(mine)), "the group gets times only");

    await page.locator("#calendarButton").click();
    await page.locator("[data-remove-source]").click();
    await toastSays(page, /Calendar link removed from this device/);
    assert.match(await page.locator("#myAgenda").innerText(), /Connect a calendar to see it here/);
    await eventually(async () => {
      const id = await page.evaluate(() => localStorage.getItem("gatherly-member-id"));
      return saves.at(-1)?.members.find((member) => member.id === id)?.busy.every((block) => block.source !== "ics");
    }, "the busy times to leave the group");
  });
});

describe("booking link owner setup", () => {
  browserTest("set up a booking link, and every setting is still there after a reload", { signedIn: true }, async ({ page, go }) => {
    await go("/");
    await page.locator("#bookingButton").click();
    await page.locator("#bookingSettingsForm").waitFor();
    await page.waitForFunction(() => document.querySelector("#bookingHandle").value);
    assert.match(await page.locator("#bookingHandle").inputValue(), /^alexi-/);
    assert.equal(await page.locator("#bookingPageTitle").inputValue(), "Coffee chat");
    assert.equal(await page.locator("#bookingShare").isHidden(), true, "no link until it's saved");

    const setDays = async (days) => {
      for (let day = 0; day < 7; day += 1) {
        const input = page.locator(`#bookingWeekdays input[value="${day}"]`);
        if ((await input.isChecked()) !== days.includes(day)) await page.locator(`#bookingWeekdays .weekday-chip:has(input[value="${day}"]) span`).click();
      }
    };
    await setDays([]);
    await page.locator("#bookingSave").click();
    await toastSays(page, /Pick at least one day/);

    await page.fill("#bookingHandle", "alexi-chats");
    await page.fill("#bookingOwnerName", "Alexi M");
    await page.fill("#bookingPageTitle", "Intro call");
    await setDays([1, 3]);
    for (const [select, value] of [["#bookingDayStart", "10"], ["#bookingDayEnd", "16"], ["#bookingDuration", "45"], ["#bookingBuffer", "15"], ["#bookingNotice", "24"], ["#bookingWindow", "14"]]) {
      await page.selectOption(select, value);
    }
    await page.locator("#bookingSave").click();
    await toastSays(page, /Booking link saved/);
    assert.equal(await page.locator("#bookingShareLink").inputValue(), `${state.base}/book/alexi-chats`);
    assert.match(await page.locator("#bookingFeedGoogle").getAttribute("href"), /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/);

    const [saved] = await fakeRows(page, "booking_pages");
    assert.deepEqual(
      { handle: saved.handle, title: saved.title, owner: saved.owner_name, active: saved.active },
      { handle: "alexi-chats", title: "Intro call", owner: "Alexi M", active: true }
    );
    const { mode, weekdays, dayStart, dayEnd, duration, buffer, noticeHours, windowDays, useCalendars } = saved.settings;
    assert.deepEqual({ mode, weekdays, dayStart, dayEnd, duration, buffer, noticeHours, windowDays, useCalendars }, { mode: "free", weekdays: [1, 3], dayStart: 10, dayEnd: 16, duration: 45, buffer: 15, noticeHours: 24, windowDays: 14, useCalendars: true });
    assert.ok(saved.busy.every((range) => Object.keys(range).sort().join() === "end,start"), "busy times only");
    assert.ok(!/Therapy|Soccer|Riverdale/.test(JSON.stringify(saved)), "never event names or places");

    const reopen = async () => {
      await go("/");
      await page.locator("#bookingButton").click();
      await page.waitForFunction(() => document.querySelector("#bookingHandle").value === "alexi-chats");
    };
    await reopen();
    assert.equal(await page.locator("#bookingPageTitle").inputValue(), "Intro call");
    assert.equal(await page.locator("#bookingOwnerName").inputValue(), "Alexi M");
    assert.deepEqual(await page.$$eval("#bookingWeekdays input:checked", (inputs) => inputs.map((input) => Number(input.value))), [1, 3]);
    for (const [select, value] of [["#bookingDayStart", "10"], ["#bookingDayEnd", "16"], ["#bookingDuration", "45"], ["#bookingBuffer", "15"], ["#bookingNotice", "24"], ["#bookingWindow", "14"]]) {
      assert.equal(await page.locator(select).inputValue(), value, select);
    }

    // Only times I pick, and the link switched off.
    await page.locator('.booking-modes .privacy-option:has(input[value="picked"])').click();
    await page.locator("#bookingPickedOptions").waitFor();
    await page.locator("#pickedAdd").click();
    await toastSays(page, /Pick a date and an end time after the start/);
    await page.fill("#pickedDate", localIso(2));
    await page.fill("#pickedStart", "10:00");
    await page.fill("#pickedEnd", "12:00");
    await page.locator("#pickedAdd").click();
    assert.equal(await page.locator("#pickedList .source-row").count(), 1);
    await page.locator("#bookingActive").uncheck();
    await page.locator("#bookingSave").click();
    await toastSays(page, /Booking link saved/);
    await page.locator("#bookingOffNote").waitFor();

    await reopen();
    assert.equal(await page.locator('input[name="bookingMode"][value="picked"]').isChecked(), true);
    assert.equal(await page.locator("#pickedList .source-row").count(), 1);
    assert.equal(await page.locator("#bookingActive").isChecked(), false);
    assert.equal(await page.locator("#bookingOffNote").isVisible(), true);
    const [picked] = await fakeRows(page, "booking_pages");
    assert.deepEqual(picked.settings.picked, [{ start: new Date(`${localIso(2)}T10:00`).toISOString(), end: new Date(`${localIso(2)}T12:00`).toISOString() }]);
  });
});

describe("sign-in gate", () => {
  /** /api/workspace as it answers with a database: every group but the demo needs a valid token. */
  async function gatedWorkspace(context) {
    const seen = [];
    await context.route("**/api/workspace**", (route) => {
      const request = route.request();
      const slug = new URL(request.url()).searchParams.get("slug");
      seen.push({ method: request.method(), slug, auth: request.headers().authorization || null });
      if (slug === "weekend-crew" || request.headers().authorization === "Bearer fake-token") return route.continue();
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Sign in to open this group.", signIn: true }) });
    });
    return seen;
  }

  browserTest("signed out, a group shows the gate: nothing about it loads and nothing is saved", { allowErrors: /status of 401/ }, async ({ page, context, go }) => {
    const seen = await gatedWorkspace(context);
    await go("/?w=book-club-7fq2x");
    await page.locator("#signInGate").waitFor();
    assert.equal(await page.locator("#gateTitle").innerText(), "Sign in to join Book club");
    assert.equal(await page.locator(".main-content").isVisible(), false, "the planner stays hidden");
    assert.equal(await page.evaluate(() => localStorage.getItem("gatherly-workspace:book-club-7fq2x")), null);
    const listed = () => page.evaluate(() => JSON.parse(localStorage.getItem("gatherly-groups") || "[]"));
    assert.deepEqual(await listed(), [], "not listed under Your groups (its name isn't even known)");
    await page.locator("#gateSignIn").click();
    await toastSays(page, /Google sign-in needs provider credentials first/);
    assert.deepEqual(seen.filter((entry) => entry.slug === "book-club-7fq2x").map((entry) => entry.method), ["GET"], "one read, no saves");

    await Promise.all([page.waitForURL(`${state.base}/`), page.locator("#signInGate a").click()]);
    await page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Weekend crew");
    assert.equal(await page.locator("#signInGate").isHidden(), true, "the demo is open to everyone");
  });

  browserTest("signed in, the same group opens and you join it", { signedIn: true }, async ({ page, context, go }) => {
    const seen = await gatedWorkspace(context);
    await go("/?w=book-club-7fq2x");
    await page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Book club 7fq2x");
    assert.equal(await page.locator("#signInGate").isHidden(), true);
    assert.ok(seen.filter((entry) => entry.slug === "book-club-7fq2x").every((entry) => entry.auth === "Bearer fake-token"));
    assert.match(await page.locator(".person-card.is-you").innerText(), /Alexi/);
    const listed = await page.evaluate(() => JSON.parse(localStorage.getItem("gatherly-groups") || "[]"));
    assert.equal(listed.find((group) => group.slug === "book-club-7fq2x")?.name, "Book club 7fq2x");
  });
});

describe("home screen app", () => {
  browserTest("the service worker caches the shell, and the page opens with no connection", { serviceWorkers: true, allowErrors: /ERR_INTERNET_DISCONNECTED/ }, async ({ page, context, go }) => {
    await go("/");
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 10000 });
    const cached = await page.evaluate(async () => {
      const names = (await caches.keys()).filter((name) => name.startsWith("waddle-"));
      const cache = await caches.open(names[0]);
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    });
    for (const path of ["/", "/app.js", "/booking-owner.js", "/styles.css", "/lib/planner.js", "/lib/sharing.js", "/manifest.webmanifest", "/icons/icon-192.png"]) {
      assert.ok(cached.includes(path), `${path} is cached`);
    }
    assert.ok(!cached.some((path) => path.startsWith("/api/")), "the API is never cached");

    await context.setOffline(true);
    try {
      await page.reload();
      await page.locator("#calendarGrid .slot").first().waitFor({ state: "attached", timeout: 10000 });
      await page.waitForFunction(() => document.querySelector("#syncState")?.textContent === "OFFLINE");
      await toastSays(page, /Working offline — changes stay on this device/);
      assert.equal(await page.locator("#workspaceName").innerText(), "Weekend crew");
      assert.ok((await page.locator("#peopleGrid .person-card").count()) >= 4, "the group from this device's copy");
    } finally {
      await context.setOffline(false);
    }
  });

  browserTest("install: the Install button appears when the browser offers it", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#installCard").isHidden(), true, "desktop Chromium without an offer: nothing to show");
    await page.evaluate(() => {
      const offer = new Event("beforeinstallprompt", { cancelable: true });
      offer.prompt = async () => {
        window.__prompted = (window.__prompted || 0) + 1;
      };
      window.dispatchEvent(offer);
    });
    await page.locator("#installButton").click();
    assert.equal(await page.evaluate(() => window.__prompted), 1);
    assert.equal(await page.locator("#installButton").isHidden(), true, "offered once");
  });

  browserTest("install: iPhones get the Share → Add to Home Screen steps", { phone: true }, async ({ page, go }) => {
    await go("/");
    await page.locator("#mobileMenu").click();
    await page.locator("#settingsButton").click();
    await page.locator("#installCard").waitFor();
    assert.match(await page.locator("#installSteps").innerText(), /In Safari, tap Share\s+then Add to Home Screen/);
  });
});

const DANA = "44444444-4444-4444-4444-444444444444";

/** Monday of next week at `hour`:00 local, as the grid's data-iso and a Date. */
const nextMonday = (page, hour = 0) =>
  page.evaluate((h) => {
    const date = new Date();
    date.setHours(h, 0, 0, 0);
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { iso, time: date.getTime() };
  }, hour);

describe("friends without a group", () => {
  browserTest("the Friends page: a request by phone number, accepted by the person with that number", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await page.locator("#friendsButton").click();
    await page.locator("#friendsDialog").waitFor();
    assert.match(await page.locator("#friendList").innerText(), /Sam Rivera[\s\S]*Calendar[\s\S]*1-on-1/);

    await page.fill("#friendRequestEmail", "555-0123");
    await page.locator("#sendFriendRequest").click();
    await toastSays(page, /does not look like a phone number/);
    await page.fill("#friendRequestEmail", "(416) 555-0123");
    await page.locator("#sendFriendRequest").click();
    await toastSays(page, /Friend request sent/);
    assert.match(await page.locator("#outgoingList").innerText(), /\+1 416 555 0123[\s\S]*Waiting for them to sign in/);
    const requests = await fakeRows(page, "friend_requests");
    const sent = requests.filter((row) => row.recipient_phone);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].recipient_phone, "+14165550123", "stored in one format");
    assert.equal("recipient_email" in sent[0], false, "no email column for a phone request");
    await page.fill("#friendRequestEmail", "+1 416 555 0123");
    await page.locator("#sendFriendRequest").click();
    await toastSays(page, /already have a request waiting/);

    // Dana signed up with that number.
    const dana = await open({ as: "dana", seed: { friend_requests: requests } });
    await dana.go("/");
    await dana.page.waitForFunction(() => document.querySelector("#friendsNavBadge")?.textContent === "1" && !document.querySelector("#friendsNavBadge").hidden);
    await dana.page.locator("#friendsButton").click();
    assert.match(await dana.page.locator("#incomingList").innerText(), /Alexi/);
    await dana.page.locator("#incomingList [data-accept]").click();
    await toastSays(dana.page, /You're now friends/);
    assert.match(await dana.page.locator("#friendList").innerText(), /Alexi[\s\S]*1-on-1/);
    const row = (await fakeRows(dana.page, "friend_requests")).find((entry) => entry.id === sent[0].id);
    assert.equal(row.status, "accepted");
    assert.equal(row.recipient_id, DANA);
  });

  browserTest("sign in with a phone number and a texted code", { signedIn: true, as: "none" }, async ({ page, go }) => {
    await go("/");
    await page.locator("#friendsButton").click();
    assert.equal(await page.locator("#friendsSignedIn").isHidden(), true);
    await page.locator("#friendsSignInButton").click();
    await page.locator("#accountDialog").waitFor();
    await page.fill("#phoneNumber", "555");
    await page.locator("#phoneSendCode").click();
    await toastSays(page, /doesn't look like a phone number/);
    await page.fill("#phoneNumber", "416 555 0123");
    await page.locator("#phoneSendCode").click();
    await page.locator("#phoneCodeRow").waitFor();
    assert.match(await page.locator("#phoneHint").innerText(), /texted a code to \+1 416 555 0123/);
    const sends = await page.evaluate(() => window.__calls.filter((call) => call[1] === "signInWithOtp"));
    assert.deepEqual(sends, [["auth", "signInWithOtp", "+14165550123"]]);
    await page.fill("#phoneCode", "000000");
    await page.locator("#phoneVerify").click();
    await toastSays(page, /That code didn't work/);
    await page.fill("#phoneCode", "123 456");
    await page.locator("#phoneVerify").click();
    await toastSays(page, /Signed in/);
    await page.waitForFunction(() => !document.querySelector("#accountDialog").open);
    await page.locator("#friendsButton").click();
    await page.locator("#friendsSignedIn").waitFor();
    await page.locator("#friendsDialog .close-dialog").click();
    await page.locator("#accountButton").click();
    await page.locator("#openAccountFromProfile").click();
    assert.equal(await page.locator("#accountStatus").innerText(), "Signed in");
    assert.match(await page.locator("#accountStatusDetail").innerText(), /\+1 416 555 0123/);
    assert.equal(await page.locator("#phoneSignInForm").isHidden(), true);
  });

  browserTest("a 1-on-1 with a friend: free together, plan it, and it's the same space every time", { signedIn: true }, async ({ page, go, open }) => {
    await go("/");
    await page.locator("#friendsButton").click();
    await page.locator('#friendList [data-view-calendar][data-friend-name="Sam Rivera"]').click();
    await page.locator("#friendCalendarDialog").waitFor();
    await page.locator("#friendNextWeek").click();
    await page.locator("#freeTogether [data-together]").first().waitFor();
    assert.match(await page.locator("#freeTogether").innerText(), /You're both free/i);
    const [start] = (await page.locator("#freeTogether [data-together]").first().getAttribute("data-together")).split("-").map(Number);

    await Promise.all([page.waitForURL(/\?w=1on1-[a-f0-9]{16}$/), page.locator("#freeTogether [data-together]").first().click()]);
    const slug = new URL(page.url()).searchParams.get("w");
    await page.waitForFunction(() => document.querySelector("#tentativePlanDialog")?.open);
    assert.equal(await page.locator("#planWhen").isHidden(), false, "the plan opens at the time you picked");
    await page.fill("#planActivity", "Coffee");
    await page.locator("#tentativePlanForm button[type=submit]").click();
    await toastSays(page, /Tentative plan saved/);
    assert.equal(await page.locator("#groupKindLabel").innerText(), "1-on-1");
    assert.equal(await page.locator("#workspaceName").innerText(), "Alexi & Sam");
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(`gatherly-workspace:${key}`)), slug);
    assert.equal(saved.kind, "pair");
    assert.equal(saved.settings.locked, true, "only the two of you can change it");
    assert.deepEqual(saved.members.map((member) => member.userId).sort(), [ALEXI, SAM]);
    assert.equal(new Date(saved.plan.chosen).getTime(), start);

    // Starting it again opens the same space, without adding Sam twice.
    await page.locator("#friendsButton").click();
    await page.locator(`#friendList [data-one-on-one="${SAM}"]`).click();
    await toastSays(page, /This is your 1-on-1 with Sam/);
    assert.equal(new URL(page.url()).searchParams.get("w"), slug);
    const again = await page.evaluate((key) => JSON.parse(localStorage.getItem(`gatherly-workspace:${key}`)), slug);
    assert.equal(again.members.length, 2);
    // Groups offer "Add to this group"; a 1-on-1 has nobody else to add.
    assert.equal(await page.locator("#friendList [data-add-friend]").count(), 0);

    // Sam reaches the same space from their side.
    const sam = await open({ as: "sam" });
    await sam.go("/");
    await sam.page.locator("#friendsButton").click();
    await Promise.all([sam.page.waitForURL(new RegExp(`\\?w=${slug}$`)), sam.page.locator(`#friendList [data-one-on-one="${ALEXI}"]`).click()]);
  });
});

describe("organization groups", () => {
  browserTest("an organization group is free/busy only and can't be switched to event details", {}, async ({ page, go }) => {
    await go("/");
    await page.locator("#groupsButton").click();
    await page.fill("#newGroupName", "Robotics team");
    await page.locator('input[name="newGroupKind"][value="organization"]').check();
    await Promise.all([page.waitForURL(/\?w=robotics-team-[a-z2-9]{5}$/), page.locator("#newGroupForm button[type=submit]").click()]);
    const slug = new URL(page.url()).searchParams.get("w");
    await page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Robotics team");
    assert.equal(await page.locator("#groupKindLabel").innerText(), "Organization");
    assert.equal(await page.locator("#privacyStatus").innerText(), "Free / busy only, always");
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(`gatherly-workspace:${key}`)), slug);
    assert.equal(saved.kind, "organization");
    assert.equal(saved.privacy, "busy");

    await page.locator("#privacyButton").click();
    assert.equal(await page.locator('input[name="privacy"][value="details"]').isDisabled(), true);
    assert.equal(await page.locator("#privacyOrgNote").isHidden(), false);
    await page.locator("#privacyDialog .privacy-option").nth(1).click({ force: true });
    assert.equal(await page.locator('input[name="privacy"][value="busy"]').isChecked(), true, "details can't be picked");
    await page.locator("#privacyDialog .close-dialog").click();

    // Switching the type back to friends is a setting like any other.
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingGroupKind").inputValue(), "organization");
    await page.selectOption("#settingGroupKind", "friends");
    await page.locator("#settingsForm button[type=submit]").click();
    await toastSays(page, /Settings saved/);
    assert.equal(await page.locator("#groupKindLabel").innerText(), "Group");
    assert.equal(await page.locator('input[name="privacy"][value="details"]').isDisabled(), false);
  });
});

describe("always busy", () => {
  const bookingPage = { id: "p1", owner_id: ALEXI, handle: "alexi", title: "Coffee chat", owner_name: "Alexi", settings: { useCalendars: false }, busy: [], ics_urls: [], active: true, feed_token: "f".repeat(32) };
  browserTest("block the same hours every week: groups, friends, your booking link and your other devices get them, labels stay private", { signedIn: true, seed: { booking_pages: [bookingPage] } }, async ({ page, go }) => {
    await go("/");
    await page.locator("#blockedButton").click();
    await page.locator("#blockedDialog").waitFor();
    await page.locator('[data-blocked-preset="work"]').click();
    await toastSays(page, /Work: Mon–Fri · 9 am – 5 pm, blocked every week/);
    assert.match(await page.locator("#blockedList").innerText(), /Work\s+Mon–Fri · 9 am – 5 pm/);
    assert.equal(await page.locator('[data-blocked-preset="work"]').isDisabled(), true, "the same rule can't be added twice");

    // A custom overnight rule on Saturdays.
    for (const day of [1, 2, 3, 4, 5]) await page.locator(`#blockedDays input[value="${day}"]`).uncheck({ force: true });
    await page.locator('#blockedDays input[value="6"]').check({ force: true });
    await page.fill("#blockedStart", "23:00");
    await page.fill("#blockedEnd", "07:00");
    await page.fill("#blockedLabel", "Sleep in");
    await page.locator("#blockedForm button[type=submit]").click();
    await toastSays(page, /Sat · 11 pm – 7 am \(overnight\), blocked every week/);
    assert.equal(await page.locator("#blockedList .blocked-row").count(), 2);

    // The group gets the times on your row, never the labels.
    const mine = () => page.evaluate((id) => JSON.parse(localStorage.getItem("gatherly-workspace:weekend-crew")).members.find((member) => member.userId === id), ALEXI);
    await page.waitForFunction((id) => (JSON.parse(localStorage.getItem("gatherly-workspace:weekend-crew")).members.find((m) => m.userId === id)?.blocked || []).length === 2, ALEXI);
    assert.deepEqual((await mine()).blocked, [
      { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      { days: [6], start: "23:00", end: "07:00" },
    ]);
    assert.doesNotMatch(await page.evaluate(() => localStorage.getItem("gatherly-workspace:weekend-crew")), /Sleep in|"Work"/);

    // Friends see it as plain busy time.
    const monday = await nextMonday(page, 9);
    await page.waitForFunction(
      ({ sam, at }) => (window.__fakeDb.calendar_shares.find((row) => row.viewer_id === sam && row.owner_id !== sam)?.events || []).some((event) => new Date(event.start).getTime() === at),
      { sam: SAM, at: monday.time }
    );
    const shared = (await shareRow(page, SAM)).events.find((event) => new Date(event.start).getTime() === monday.time);
    assert.equal(new Date(shared.end).getHours(), 17);
    assert.equal("title" in shared, false);

    // Your booking link keeps them closed, even with calendars switched off for it.
    await page.waitForFunction((at) => (window.__fakeDb.booking_pages[0]?.busy || []).some((range) => new Date(range.start).getTime() === at), monday.time);
    const booked = (await fakeRows(page, "booking_pages"))[0].busy.find((range) => new Date(range.start).getTime() === monday.time);
    assert.deepEqual(Object.keys(booked).sort(), ["end", "start"], "times only");

    // Your other devices get the rules, labels included (your own settings row).
    await page.waitForFunction(() => (window.__fakeDb.sharing_settings[0]?.settings?.blocked || []).length === 2);

    await page.locator("#blockedDialog .close-dialog").click();
    await page.locator("#mineViewTab").click();
    await page.locator("#nextWeek").click();
    assert.match(await page.locator(`.slot[data-iso="${monday.iso}"][data-hour="10"]`).getAttribute("class"), /\bbusy\b/);
    assert.doesNotMatch(await page.locator(`.slot[data-iso="${monday.iso}"][data-hour="18"]`).getAttribute("class"), /\bbusy\b/);

    // Removing a rule frees those hours again.
    await page.locator("#mineBlockedButton").click();
    await page.locator("#blockedList [data-remove-blocked]").first().click();
    await toastSays(page, /Those hours are free again/);
    await page.waitForFunction((id) => (JSON.parse(localStorage.getItem("gatherly-workspace:weekend-crew")).members.find((m) => m.userId === id)?.blocked || []).length === 1, ALEXI);
    await page.locator("#blockedDialog .close-dialog").click();
    assert.doesNotMatch(await page.locator(`.slot[data-iso="${monday.iso}"][data-hour="10"]`).getAttribute("class"), /\bbusy\b/);
  });
});

describe("guests: invite links work without an account", () => {
  const CODE = "GuestLinkCode0123456789A";
  const SLUG = "book-club-gu3st";

  /** The fake database behind the `db: true` server. */
  const db = {
    async seed(tables) {
      const response = await fetch(`${state.dbBase}/__fake-db`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tables }) });
      assert.ok(response.ok);
    },
    async group(slug = SLUG) {
      const tables = await (await fetch(`${state.dbBase}/__fake-db`)).json();
      return tables.workspaces.find((row) => row.slug === slug)?.state || null;
    },
  };

  /** A group that allows event details, where Alexi shares a named event with a place, and a plan with a time picked. */
  function detailedGroup() {
    const coverage = { from: localIso(-7), to: localIso(21) };
    return {
      name: "Book club",
      privacy: "details",
      ownerId: ALEXI,
      invite: { code: CODE, revoked: false, createdAt: new Date().toISOString() },
      members: [
        { id: "m_alexi", name: "Alexi", userId: ALEXI, email: "alexi@example.com", coverage, busy: [{ start: localAt(0, 10).toISOString(), end: localAt(0, 12).toISOString(), title: "Climbing", location: "Basecamp", source: "ics" }] },
        { id: "m_sam", name: "Sam Rivera", userId: SAM, email: "sam@example.com", coverage, busy: [{ start: localAt(0, 14).toISOString(), end: localAt(0, 15).toISOString(), title: "Dentist", location: "Bloor St", source: "google" }] },
      ],
      ideas: [{ id: "idea_walk", title: "Walk by the lake", votes: ["m_alexi"] }],
      plan: {
        id: "plan_dinner",
        activity: "Dinner",
        location: "Luma",
        audience: "Book club",
        timing: "month",
        chosen: localAt(2, 18).toISOString(),
        chosenEnd: localAt(2, 20).toISOString(),
        timeVotes: { [localAt(3, 18).toISOString()]: ["m_alexi"] },
      },
      activity: [{ message: "Tentative plan: Dinner", at: new Date().toISOString() }],
    };
  }

  const seedGroup = (state = detailedGroup()) => db.seed({ workspaces: [{ slug: SLUG, state, updated_at: new Date().toISOString() }] });

  /** Every /api/workspace answer the page gets, as text. */
  function recordAnswers(page) {
    const answers = [];
    page.on("response", async (response) => {
      if (!response.url().includes("/api/workspace")) return;
      answers.push(await response.text().catch(() => ""));
    });
    return answers;
  }

  async function joinAs(page, go, name, link = `/?w=${SLUG}&i=${CODE}`) {
    await go(link);
    await page.locator("#guestJoinForm").waitFor();
    await page.fill("#guestName", name);
    await page.locator("#guestJoinForm button[type=submit]").click();
    await page.locator("#guestBanner").waitFor();
    await page.waitForFunction(() => document.querySelector("#signInGate").hidden);
  }

  const guestId = async (name = "Casey") => (await db.group()).members.find((member) => member.name === name)?.id;

  browserTest("a guest joins with just a name, marks busy hours, votes on a time and RSVPs", { db: true }, async ({ page, go }) => {
    await seedGroup();
    await go(`/?w=${SLUG}&i=${CODE}`);
    await page.locator("#guestJoinForm").waitFor();
    assert.equal(await page.locator("#gateTitle").innerText(), "Join Book club");
    assert.equal(await page.locator(".main-content").isVisible(), false, "nothing of the group before joining");
    await page.fill("#guestName", "Casey");
    await page.locator("#guestJoinForm button[type=submit]").click();
    await page.locator("#guestBanner").waitFor();
    assert.match(await page.locator("#guestBanner").innerText(), /You're in as Casey/);
    assert.match(await page.locator("#guestBanner").innerText(), /Sign in to save and connect your calendar/);
    const id = await guestId();
    assert.ok(id, "the server made Casey's row");
    assert.match(await page.locator(".person-card.is-you").innerText(), /Casey/);

    // Only what a guest may do is on screen.
    for (const selector of ["#tentativePlanButton", "#addIdea", "#privacyButton", "#editTentativePlan", ".card-remove"]) {
      assert.equal(await page.locator(selector).first().isVisible(), false, `${selector} is for members`);
    }

    // Vote on the other time, and RSVP to the picked one.
    await page.locator(".time-vote").first().click();
    await toastSays(page, /Vote added/);
    await eventually(async () => (await db.group()).plan.timeVotes[localAt(3, 18).toISOString()]?.includes(id), "the vote in the database");
    await page.locator('[data-rsvp="yes"]').click();
    await toastSays(page, /You’re going/);
    await eventually(async () => (await db.group()).plan.rsvp?.answers?.[id] === "yes", "the RSVP in the database");
    assert.match(await page.locator("#rsvpSummary").innerText(), /Going: Casey/);
    assert.equal(await page.locator(".time-option [data-window]").first().isDisabled(), true, "picking the time is the group's");

    // Mark an hour busy.
    await page.locator("#mineViewTab").click();
    await page.locator(`#calendarGrid .slot[data-iso="${localIso(0)}"][data-hour="9"]`).click();
    await eventually(async () => (await db.group()).members.find((member) => member.id === id).busy.length === 1, "Casey's busy hour");
    const [block] = (await db.group()).members.find((member) => member.id === id).busy;
    assert.deepEqual(Object.keys(block).sort(), ["end", "source", "start"]);

    // The pass is kept: coming back (even by the plain group link) needs no second join.
    await go(`/?w=${SLUG}`);
    await page.locator("#guestBanner").waitFor();
    assert.equal(await page.locator("#signInGate").isHidden(), true);
  });

  browserTest("a guest never sees event names or places, even though the group allows event details", { db: true }, async ({ page, go, open }) => {
    await seedGroup();
    const answers = recordAnswers(page);
    await joinAs(page, go, "Casey");
    const everything = await page.evaluate(() => document.body.innerText + JSON.stringify(localStorage));
    for (const secret of ["Climbing", "Basecamp", "Dentist", "Bloor St", "alexi@example.com", "sam@example.com"]) {
      assert.ok(!everything.includes(secret), `the page shows ${secret}`);
      assert.ok(!answers.some((text) => text.includes(secret)), `the API sent ${secret}`);
    }
    assert.match(await page.locator("#privacyStatus").innerText(), /Busy \/ free only/);
    assert.match(await page.locator("#groupCalGrid").innerText(), /Alexi[\s\S]*Busy/);
    assert.equal(await page.locator("#calendarGrid .event-chip").count(), 0, "no named blocks on the week");
    assert.match(await page.locator("#tentativeTitle").innerText(), /Dinner · Luma/, "the plan itself is shown");

    // The owner, signed in, still sees names: members keep today's behaviour.
    const alexi = await open({ signedIn: true });
    await alexi.go(`/?w=${SLUG}`);
    await alexi.page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Book club");
    assert.match(await alexi.page.locator("#groupCalGrid").innerText(), /Dentist[\s\S]*Bloor St/);
  });

  browserTest("turning the invite link off locks guests out and stops new ones; a new link works", { db: true, allowErrors: /status of 403/ }, async ({ page, go, open }) => {
    await seedGroup();
    await joinAs(page, go, "Casey");

    const alexi = await open({ signedIn: true });
    await alexi.go(`/?w=${SLUG}`);
    await alexi.page.locator("#managePeople").click();
    assert.equal(await alexi.page.locator("#inviteLink").inputValue(), `${state.dbBase}/g/${SLUG}?i=${CODE}`);
    assert.match(await alexi.page.locator("#savedPeople").innerText(), /Casey\s*Guest/);
    await alexi.page.locator("#revokeInvite").click();
    await toastSays(alexi.page, /Invite link turned off/);
    assert.equal((await db.group()).invite.revoked, true);
    assert.equal(await alexi.page.locator("#inviteLink").inputValue(), `${state.dbBase}/g/${SLUG}`, "no code to share while it's off");

    await go(`/?w=${SLUG}`, { app: true });
    await page.locator("#signInGate").waitFor();
    assert.equal(await page.locator("#gateTitle").innerText(), "This invite link doesn't work any more");
    assert.equal(await page.locator(".main-content").isVisible(), false);

    const stranger = await open();
    await stranger.go(`/?w=${SLUG}&i=${CODE}`);
    await stranger.page.locator("#signInGate").waitFor();
    assert.equal(await stranger.page.locator("#guestJoinForm").isHidden(), true, "nobody new can join");

    await alexi.page.locator("#renewInvite").click();
    await toastSays(alexi.page, /New invite link made/);
    const fresh = (await db.group()).invite.code;
    assert.notEqual(fresh, CODE);
    await go(`/?w=${SLUG}&i=${fresh}`);
    await page.locator("#guestBanner").waitFor();
    assert.match(await page.locator(".person-card.is-you").innerText(), /Casey/, "the same guest, back in with the new link");
  });

  browserTest("the owner removes a guest, and their votes disappear", { db: true, allowErrors: /status of 403/ }, async ({ page, go, open }) => {
    await seedGroup();
    await joinAs(page, go, "Casey");
    const id = await guestId();
    await page.locator(".time-vote").first().click();
    await toastSays(page, /Vote added/);
    await page.locator(".idea-card .heart").first().click();
    await toastSays(page, /Vote added/);
    await eventually(async () => (await db.group()).ideas[0].votes.includes(id), "Casey's idea vote");

    const alexi = await open({ signedIn: true });
    await alexi.go(`/?w=${SLUG}`);
    await alexi.page.locator("#managePeople").click();
    await alexi.page.locator(`#savedPeople [data-remove-member="${id}"]`).click();
    await toastSays(alexi.page, /Casey removed, with their votes/);
    const after = await db.group();
    assert.ok(!JSON.stringify(after).includes(id), "no row, vote, RSVP or pass left");
    assert.deepEqual(after.plan.timeVotes[localAt(3, 18).toISOString()], ["m_alexi"]);
    assert.deepEqual(after.ideas[0].votes, ["m_alexi"]);

    // Casey's next change is refused and the page says why.
    await page.locator(".time-vote").first().click();
    await page.locator("#guestJoinForm").waitFor();
    assert.match(await page.locator("#gateNote").innerText(), /no longer in this group/);
  });

  browserTest("a /p/ link: chats get the plan's preview with no names, and people land on the plan", { db: true }, async ({ page, go }) => {
    await seedGroup();
    const html = await (await fetch(`${state.dbBase}/p/${SLUG}?i=${CODE}`)).text();
    const tag = (name) => new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)"`).exec(html)?.[1];
    assert.equal(tag("og:title"), "Dinner · vote on a time");
    assert.equal(tag("twitter:card"), "summary_large_image");
    const head = html.slice(0, html.indexOf("</head>"));
    for (const secret of ["Alexi", "Sam Rivera", "Climbing", "Basecamp", "Dentist", "Luma", "alexi@example.com"]) assert.ok(!head.includes(secret), `the preview mentions ${secret}`);
    const image = await fetch(tag("og:image").replace(/&amp;/g, "&"));
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString("ascii", 1, 4), "PNG");

    await go(`/p/${SLUG}?i=${CODE}`);
    assert.equal(page.url(), `${state.dbBase}/?w=${SLUG}&i=${CODE}#plan`, "the app moves to its usual address");
    await page.locator("#guestJoinForm").waitFor();
    await page.fill("#guestName", "Casey");
    await page.locator("#guestJoinForm button[type=submit]").click();
    await page.locator("#tentativePlanSection").waitFor();
    assert.match(await page.locator("#tentativeTitle").innerText(), /Dinner/);
  });

  browserTest("the join card and guest banner on a phone, in dark mode", { db: true, phone: true, theme: "dark" }, async ({ page, go }) => {
    await seedGroup();
    await go(`/?w=${SLUG}&i=${CODE}`);
    await page.locator("#guestJoinForm").waitFor();
    const card = await page.locator(".signin-card").boundingBox();
    assert.ok(card.width <= 390, "fits the phone");
    await page.fill("#guestName", "Casey");
    await page.locator("#guestJoinForm button[type=submit]").click();
    await page.locator("#guestBanner").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "nothing scrolls sideways");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  });
});

describe("sharing links", () => {
  browserTest("share a group or a plan: the share sheet where there is one, otherwise the link is copied", {}, async ({ page, context, go }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: state.base });
    await go("/?w=pottery-sh4re");
    await page.locator("#tentativePlanButton").click();
    await page.fill("#planActivity", "Pottery night");
    await page.locator("#tentativePlanForm button[type=submit]").click();
    await page.locator("#tentativePlanSection").waitFor();

    // No share sheet on desktop Chromium: copied, with a toast.
    assert.equal(await page.evaluate(() => typeof navigator.share), "undefined");
    await page.locator("#sharePlan").click();
    await toastSays(page, /Plan link ready\. Link copied/);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${state.base}/p/pottery-sh4re`);
    await page.locator("#shareButton").click();
    await toastSays(page, /Group link ready\. Link copied/);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${state.base}/g/pottery-sh4re`);

    // A phone's share sheet gets the link, a title and a line of text.
    await page.evaluate(() => {
      window.__shared = [];
      navigator.share = async (data) => {
        window.__shared.push(data);
      };
    });
    await page.locator("#sharePlan").click();
    await page.locator("#shareButton").click();
    await page.waitForFunction(() => window.__shared.length === 2);
    const [plan, group] = await page.evaluate(() => window.__shared);
    assert.deepEqual(plan, { title: "Pottery night · vote on a time", text: "Vote on a time for Pottery night.", url: `${state.base}/p/pottery-sh4re` });
    assert.equal(group.url, `${state.base}/g/pottery-sh4re`);
    assert.match(group.title, /on Waddle$/);

    // Closing the share sheet is not an error and copies nothing.
    await page.evaluate(() => {
      navigator.share = async () => {
        throw new DOMException("cancelled", "AbortError");
      };
      return navigator.clipboard.writeText("untouched");
    });
    await page.locator("#sharePlan").click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "untouched");
  });

  browserTest("a /g/ link opens the group at its usual address (demo mode: no code, generic preview)", {}, async ({ page, go }) => {
    const html = await (await fetch(`${state.base}/g/pottery-sh4re`)).text();
    assert.match(html, /<meta property="og:title" content="Waddle · find a time that works for everyone"/);
    await go("/g/pottery-sh4re");
    assert.equal(page.url(), `${state.base}/?w=pottery-sh4re`);
    await page.waitForFunction(() => /Pottery/.test(document.querySelector("#workspaceName")?.textContent || ""));
  });
});

describe("notifications", () => {
  const SLUG = "book-club-n0t1f";
  const CODE = "NotifyLinkCode0123456789";
  const fakeDb = {
    async seed(tables) {
      const response = await fetch(`${state.dbBase}/__fake-db`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tables }) });
      assert.ok(response.ok);
    },
    async tables() {
      return (await fetch(`${state.dbBase}/__fake-db`)).json();
    },
  };

  /** Alexi proposed Dinner; Sam is in the group with an account. */
  function planGroup(plan = {}) {
    return {
      name: "Book club",
      ownerId: ALEXI,
      invite: { code: CODE, revoked: false, createdAt: new Date().toISOString() },
      members: [
        { id: "m_alexi", name: "Alexi", userId: ALEXI },
        { id: "m_sam", name: "Sam Rivera", userId: SAM },
      ],
      plan: { id: "plan_dinner", activity: "Dinner", location: "Luma", audience: "Book club", timing: "month", createdBy: "m_alexi", createdAt: new Date().toISOString(), timeVotes: { [localAt(3, 18).toISOString()]: ["m_sam"] }, ...plan },
    };
  }
  const seedGroup = (group, extra = {}) => fakeDb.seed({ workspaces: [{ slug: SLUG, state: group, updated_at: new Date().toISOString() }], ...extra });

  /** A browser subscription stand-in: real keys (so the server can encrypt), a fake push service endpoint. */
  function stubPushInBrowser(context, endpoint) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
    return context.addInitScript(({ endpoint: url, keys: subscriptionKeys }) => {
      // Headless Chromium can't show the permission prompt, so this stands in for it:
      // "default" until asked, then the person taps Allow.
      window.__permissionAsked = 0;
      let permission = "default";
      Object.defineProperty(Notification, "permission", { get: () => permission, configurable: true });
      Notification.requestPermission = async () => {
        window.__permissionAsked += 1;
        permission = "granted";
        return permission;
      };
      let current = null;
      const make = () => ({ endpoint: url, toJSON: () => ({ endpoint: url, keys: subscriptionKeys }), unsubscribe: async () => ((current = null), true) });
      PushManager.prototype.subscribe = async () => (current = make());
      PushManager.prototype.getSubscription = async () => current;
    }, { endpoint, keys });
  }

  browserTest("the bell: 'X proposed a plan' and 'you haven't voted', then 'time chosen' and 'starts in 40 minutes' (a guest sees them too)", { db: true }, async ({ page, go }) => {
    await seedGroup(planGroup());
    await go(`/g/${SLUG}?i=${CODE}`);
    await page.locator("#guestJoinForm").waitFor();
    await page.fill("#guestName", "Casey");
    await page.locator("#guestJoinForm button[type=submit]").click();
    await page.locator("#guestBanner").waitFor();
    assert.equal(await page.locator("#activityDot").isVisible(), true, "the bell has news");
    await page.locator("#activityButton").click();
    const titles = await texts(page, "#noticeList .notice-row strong");
    assert.deepEqual([...titles].sort(), ["Alexi proposed a plan", "You haven't voted yet"]);
    assert.equal(await page.locator("#noticeList .notice-row.unseen").count(), 2);
    assert.equal(await page.locator("#pushCard").isVisible(), true);
    assert.match(await page.locator("#pushCard").innerText(), /Sign in/, "guests are offered sign-in for notifications");
    await page.locator("#activityDialog .close-dialog").click();
    assert.equal(await page.locator("#activityDot").isVisible(), false, "seen");

    // Voting clears "you haven't voted".
    await page.locator(".time-vote").first().click();
    await toastSays(page, /Vote added/);
    await page.locator("#activityButton").click();
    assert.deepEqual(await texts(page, "#noticeList .notice-row strong"), ["Alexi proposed a plan"]);
    await page.locator("#activityDialog .close-dialog").click();

    // Alexi picks a time that starts in 40 minutes.
    const soon = new Date(Date.now() + 40 * 60e3);
    soon.setSeconds(0, 0);
    const tables = await fakeDb.tables();
    const group = tables.workspaces[0].state;
    group.plan = { ...group.plan, chosen: soon.toISOString(), chosenEnd: new Date(soon.getTime() + 2 * 3600e3).toISOString(), chosenBy: "m_alexi" };
    await seedGroup(group);
    await go(`/?w=${SLUG}`);
    await page.locator("#guestBanner").waitFor();
    await page.locator("#activityButton").click();
    const now = await texts(page, "#noticeList .notice-row strong");
    assert.ok(now.includes("Time chosen"), now.join(" | "));
    assert.ok(now.some((title) => /^Dinner starts in (39|40) minutes$/.test(title)), now.join(" | "));
    assert.ok(!(await page.locator("#noticeList").innerText()).includes("Luma"), "never the place");
  });

  browserTest("turn on notifications: asked only on a tap, the device is saved, and a new plan reaches it", { db: true, signedIn: true, serviceWorkers: true }, async ({ page, context, go, open }) => {
    await seedGroup({ ...planGroup(), plan: null });
    const sam = await open({ as: "sam" });
    await stubPushInBrowser(sam.context, "https://push.waddle.test/sam-browser");
    await sam.go(`/?w=${SLUG}`);
    await sam.page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Book club");
    assert.equal(await sam.page.evaluate(() => window.__permissionAsked), 0, "never asked on page load");
    await sam.page.locator("#activityButton").click();
    await sam.page.locator("#pushToggle").waitFor();
    assert.equal(await sam.page.locator("#pushToggle").innerText(), "Turn on notifications");
    await sam.page.locator("#pushToggle").click();
    await toastSays(sam.page, /Notifications are on for this device/);
    assert.equal(await sam.page.evaluate(() => window.__permissionAsked), 1);
    const saved = await eventually(async () => (await fakeDb.tables()).push_subscriptions?.find((row) => row.endpoint === "https://push.waddle.test/sam-browser"), "Sam's device saved");
    assert.equal(saved.user_id, SAM);
    assert.equal(await sam.page.locator("#pushToggle").innerText(), "Turn off");
    await sam.page.locator("#weeklyToggle").check();
    await toastSays(sam.page, /Thursdays/);
    await eventually(async () => (await fakeDb.tables()).push_subscriptions.find((row) => row.user_id === SAM)?.weekly_nudge === true, "weekly opt-in saved");

    // Alexi proposes a plan: Sam's device gets a push (through the fake push service).
    await go(`/?w=${SLUG}`);
    await page.waitForFunction(() => document.querySelector("#workspaceName")?.textContent === "Book club");
    await page.locator("#tentativePlanButton").click();
    await page.fill("#planActivity", "Bowling");
    await page.locator("#tentativePlanForm button[type=submit]").click();
    const pushed = await eventually(async () => (await fakeDb.tables())._push?.find((entry) => entry.endpoint.endsWith("/sam-browser")), "a push to Sam");
    assert.equal(pushed.encoding, "aes128gcm", "an encrypted Web Push message");
    assert.equal((await fakeDb.tables()).workspaces[0].state.plan.createdBy, "m_alexi");
  });

  browserTest("the proposer nudges people who haven't voted, once per 12 hours", { db: true, signedIn: true }, async ({ page, go }) => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    await seedGroup(planGroup({ timeVotes: {} }), {
      push_subscriptions: [{ id: "s1", user_id: SAM, endpoint: "https://push.waddle.test/sam-phone", p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"), weekly_nudge: false }],
      notification_log: [],
    });
    await go(`/?w=${SLUG}`);
    const nudge = page.locator("#nudgeVoters");
    await nudge.waitFor();
    assert.equal(await nudge.innerText(), "Nudge people who haven't voted (1)");
    await nudge.click();
    await toastSays(page, /Nudged 1 person: they'll see it in the bell\. 1 got a notification/);
    await page.waitForFunction(() => document.querySelector("#nudgeVoters").disabled);
    assert.match(await nudge.innerText(), /^Nudged · again /);
    const tables = await fakeDb.tables();
    assert.deepEqual(tables._push.map((entry) => entry.endpoint), ["https://push.waddle.test/sam-phone"]);
    assert.match(tables.workspaces[0].state.activity[0].message, /nudged people who haven't voted/);
    await go(`/?w=${SLUG}`);
    await nudge.waitFor();
    assert.equal(await nudge.isDisabled(), true, "still waiting after a reload");
  });
});
