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
 * { page, context, errors, google, go(path), open(options) }; `open` starts a
 * second browser (another person with `as`, or another device) with the same
 * options plus the ones given. Page errors in any of them fail the test at the
 * end, except ones matching `allowErrors`.
 */
function browserTest(name, { allowErrors = null, ...options }, run) {
  test(name, async (t) => {
    if (state.skip) return t.skip(state.skip);
    const opened = [];
    const open = async (extra = {}) => {
      const session = await openSession({ playwright: state.playwright, browser: state.browser, blockServiceWorkers: true, ...options, ...extra });
      opened.push(session);
      const go = async (path, { app = true } = {}) => {
        await session.page.goto(new URL(path, state.base).href);
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
