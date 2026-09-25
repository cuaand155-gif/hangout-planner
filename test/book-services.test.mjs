// api/book.js with its two optional services: Google freeBusy (busy times while
// Waddle is closed) and Resend (booking emails). Every outside call is a faked
// fetch; nothing here reaches Google or sends an email.

import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/book.js";
import { sealToken } from "../api/google.js";
import { escapeHtml, formatWhen } from "../api/_email.js";

const SECRET = "client-secret";
const ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "BOOKING_EMAIL_FROM",
  "SITE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
];

function mockResponse() {
  const captured = { headers: {}, status: null, body: null };
  return {
    captured,
    headersSent: false,
    setHeader(name, value) { captured.headers[name] = value; },
    status(code) { captured.status = code; return this; },
    json(body) { captured.body = body; return this; },
    end() { return this; },
  };
}

const call = async (request) => {
  const response = mockResponse();
  await handler({ method: "GET", query: {}, headers: {}, ...request }, response);
  return response.captured;
};

function withEnv(t, { google = false, email = false } = {}) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  if (google) {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = SECRET;
  }
  if (email) {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.BOOKING_EMAIL_FROM = "Waddle <bookings@example.com>";
    process.env.SITE_URL = "https://waddle.example";
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// api/google.js caches access tokens per user for the life of the module, so
// every test gets its own owner.
let owners = 0;
const nextOwner = () => `${String(++owners).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

const pageFor = (ownerId, extra = {}) => ({
  id: "page-1",
  owner_id: ownerId,
  handle: "alexi-7fq2x",
  title: "Coffee <chat>",
  owner_name: "Alexi & co",
  // Every day, all day, so the test does not depend on today's date or weekday.
  settings: { duration: 30, noticeHours: 0, windowDays: 2, dayStart: 0, dayEnd: 24, weekdays: [0, 1, 2, 3, 4, 5, 6], timeZone: "UTC", useCalendars: true },
  busy: [],
  ics_urls: [],
  ...extra,
});

/**
 * Fake Supabase (PostgREST + auth), Google and Resend. Records every call.
 * `freeBusy` is the busy list Google returns, or a function (init) -> Response.
 */
function fakeServices(t, { page, token = null, freeBusy = [], resendStatus = 200, ownerAddress = "alexi@example.com", signedIn = null, cancelled = null }) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const href = String(url);
    const method = init.method || "GET";
    calls.push({ href, method, body: init.body, headers: init.headers || {} });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (href.includes("/rest/v1/booking_pages")) return json(200, page ? [page] : []);
    if (href.includes("/rest/v1/google_tokens")) return json(200, token ? [{ refresh_token: token }] : []);
    if (href.includes("/rest/v1/bookings") && method === "GET") return json(200, []);
    if (href.includes("/rest/v1/bookings") && method === "POST") {
      const row = JSON.parse(init.body);
      return json(201, [{ id: "b1", start_at: row.start_at, end_at: row.end_at, status: "confirmed", cancel_token: "c".repeat(36), created_at: new Date().toISOString() }]);
    }
    if (href.includes("/rest/v1/bookings") && method === "PATCH") return json(200, cancelled ? [cancelled] : []);
    if (href.includes("/auth/v1/admin/users/")) return ownerAddress ? json(200, { id: page?.owner_id, email: ownerAddress }) : json(404, {});
    if (href.endsWith("/auth/v1/user")) return signedIn && init.headers?.Authorization === "Bearer owner-token" ? json(200, { id: signedIn }) : json(401, {});
    if (href === "https://oauth2.googleapis.com/token") return json(200, { access_token: "fresh-access", expires_in: 3599 });
    if (href === "https://www.googleapis.com/calendar/v3/freeBusy") {
      if (typeof freeBusy === "function") return freeBusy(init);
      return json(200, { calendars: { primary: { busy: freeBusy } } });
    }
    if (href === "https://api.resend.com/emails") return json(resendStatus, resendStatus === 200 ? { id: "email-1" } : { message: "nope" });
    return json(404, {});
  });
  return calls;
}

const googleCalls = (calls) => calls.filter((entry) => entry.href.startsWith("https://www.googleapis.com/") || entry.href.startsWith("https://oauth2."));
const emails = (calls) => calls.filter((entry) => entry.href === "https://api.resend.com/emails").map((entry) => ({ ...JSON.parse(entry.body), auth: entry.headers.Authorization }));
const open = (handle = "alexi-7fq2x") => call({ query: { handle } });
const bookIt = (start, extra = {}) => call({ method: "POST", body: { action: "book", handle: "alexi-7fq2x", start, name: "Sam <b>Rivera</b>", email: "sam@x.co", note: "Bring the <script>alert(1)</script> deck", timeZone: "America/Toronto", ...extra } });

/* ------------------------------------------------------------ Google freeBusy */

test("without Google env vars the booking page never calls Google", async (t) => {
  withEnv(t, { google: false });
  const owner = nextOwner();
  const calls = fakeServices(t, { page: pageFor(owner), token: sealToken("1//refresh", SECRET) });
  const result = await open();
  assert.equal(result.status, 200);
  assert.ok(result.body.slots.length > 0);
  assert.equal(googleCalls(calls).length, 0);
  assert.ok(!calls.some((entry) => entry.href.includes("google_tokens")));
});

test("an owner who never connected Google gets the usual slots and no Google call", async (t) => {
  withEnv(t, { google: true });
  const owner = nextOwner();
  const calls = fakeServices(t, { page: pageFor(owner), token: null });
  const result = await open();
  assert.equal(result.status, 200);
  assert.ok(result.body.slots.length > 0);
  assert.equal(googleCalls(calls).length, 0);
  assert.ok(calls.some((entry) => entry.href.includes(`google_tokens?`) && entry.href.includes(`user_id=eq.${owner}`)));
});

test("Google busy time closes a slot, times only, over the booking window", async (t) => {
  withEnv(t, { google: true });
  const owner = nextOwner();
  const token = sealToken("1//refresh", SECRET);
  // First, what's open with an empty Google calendar.
  fakeServices(t, { page: pageFor(owner), token, freeBusy: [] });
  const before = await open();
  const target = before.body.slots[3];
  assert.ok(target);

  const calls = fakeServices(t, { page: pageFor(owner), token, freeBusy: [{ start: target.start, end: target.end }] });
  const after = await open();
  assert.equal(after.status, 200);
  assert.ok(!after.body.slots.some((slot) => slot.start === target.start), "the busy slot is gone");
  assert.equal(after.body.slots.length, before.body.slots.length - 1);
  assert.ok(!JSON.stringify(after.body).includes("busy"));

  const request = calls.find((entry) => entry.href === "https://www.googleapis.com/calendar/v3/freeBusy");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer fresh-access");
  const body = JSON.parse(request.body);
  assert.deepEqual(body.items, [{ id: "primary" }]);
  const span = new Date(body.timeMax) - new Date(body.timeMin);
  assert.equal(Math.round(span / 864e5), 3, "windowDays + 1");
  // The cached access token is reused: no second trip to Google's token endpoint.
  assert.equal(calls.filter((entry) => entry.href === "https://oauth2.googleapis.com/token").length, 0);

  // And booking that time is refused.
  const booked = await bookIt(target.start);
  assert.equal(booked.status, 409);
});

test("a Google error, bad reply or timeout falls back to the usual slots", async (t) => {
  withEnv(t, { google: true });
  const token = sealToken("1//refresh", SECRET);
  const failures = [
    () => new Response("oops", { status: 500 }),
    () => new Response(JSON.stringify({ calendars: { primary: { errors: [{ reason: "notFound" }] } } }), { status: 200 }),
    () => new Response("not json", { status: 200 }),
    () => { throw new TypeError("fetch failed"); },
    (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
  ];
  let baseline = null;
  for (const freeBusy of failures) {
    const owner = nextOwner();
    fakeServices(t, { page: pageFor(owner), token, freeBusy });
    const started = Date.now();
    const result = await open();
    assert.equal(result.status, 200, "never a failed booking page because of Google");
    assert.ok(result.body.slots.length > 0);
    baseline ??= result.body.slots.length;
    assert.equal(result.body.slots.length, baseline);
    assert.ok(Date.now() - started < 6000, "bounded by the timeout");
  }
});

test("a long booking window is asked for in pieces of at most 30 days", async (t) => {
  withEnv(t, { google: true });
  const owner = nextOwner();
  const page = pageFor(owner, { settings: { ...pageFor(owner).settings, windowDays: 60 } });
  const calls = fakeServices(t, { page, token: sealToken("1//refresh", SECRET), freeBusy: [] });
  const result = await open();
  assert.equal(result.status, 200);
  const ranges = calls.filter((entry) => entry.href.endsWith("/freeBusy")).map((entry) => JSON.parse(entry.body)).map((body) => [new Date(body.timeMin), new Date(body.timeMax)]);
  assert.equal(ranges.length, 3, "61 days: 30 + 30 + 1");
  for (const [start, end] of ranges) assert.ok(end - start <= 30 * 864e5);
  for (let index = 1; index < ranges.length; index += 1) assert.equal(ranges[index][0].getTime(), ranges[index - 1][1].getTime(), "no gaps");
});

test("with calendars turned off for the link, Google is not asked", async (t) => {
  withEnv(t, { google: true });
  const owner = nextOwner();
  const page = pageFor(owner, { settings: { ...pageFor(owner).settings, useCalendars: false } });
  const calls = fakeServices(t, { page, token: sealToken("1//refresh", SECRET), freeBusy: [{ start: new Date().toISOString(), end: new Date(Date.now() + 864e5).toISOString() }] });
  const result = await open();
  assert.equal(result.status, 200);
  assert.ok(result.body.slots.length > 0);
  assert.equal(googleCalls(calls).length, 0);
});

/* ------------------------------------------------------------ booking emails */

test("without Resend env vars nothing is emailed and the page says so", async (t) => {
  withEnv(t, { email: false });
  const calls = fakeServices(t, { page: pageFor(nextOwner()) });
  const page = await open();
  assert.equal(page.body.page.emails, false);
  const booked = await bookIt(page.body.slots[0].start);
  assert.equal(booked.status, 201);
  assert.equal(booked.body.emailed, false);
  assert.equal(emails(calls).length, 0);
  assert.ok(!calls.some((entry) => entry.href.includes("/auth/v1/admin/")));
});

test("a key without a sender (or a site address) keeps emails off", async (t) => {
  withEnv(t, { email: true });
  delete process.env.BOOKING_EMAIL_FROM;
  const calls = fakeServices(t, { page: pageFor(nextOwner()) });
  const page = await open();
  assert.equal(page.body.page.emails, false);
  process.env.BOOKING_EMAIL_FROM = "Waddle <bookings@example.com>";
  delete process.env.SITE_URL;
  assert.equal((await open()).body.page.emails, false);
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "waddle.example";
  assert.equal((await open()).body.page.emails, true);
  assert.equal(emails(calls).length, 0);
});

test("a booking emails the guest a cancel link and the owner a notice, all escaped", async (t) => {
  withEnv(t, { email: true });
  const owner = nextOwner();
  const calls = fakeServices(t, { page: pageFor(owner) });
  const page = await open();
  assert.equal(page.body.page.emails, true);
  const start = page.body.slots[0].start;
  const booked = await bookIt(start);
  assert.equal(booked.status, 201);
  assert.equal(booked.body.emailed, true);

  const sent = emails(calls);
  assert.equal(sent.length, 2);
  for (const mail of sent) {
    assert.equal(mail.from, "Waddle <bookings@example.com>");
    assert.equal(mail.auth, "Bearer re_test_key");
    assert.ok(!mail.html.includes("<script>") && !mail.html.includes("<chat>") && !mail.html.includes("<b>"));
  }
  const guest = sent.find((mail) => mail.to[0] === "sam@x.co");
  assert.ok(guest);
  assert.match(guest.subject, /^Booked: Coffee <chat> with Alexi & co$/);
  assert.ok(guest.html.includes("https://waddle.example/book/alexi-7fq2x?cancel=" + "c".repeat(36)));
  assert.ok(guest.text.includes("https://waddle.example/book/alexi-7fq2x?cancel=" + "c".repeat(36)));
  assert.ok(guest.html.includes("Coffee &lt;chat&gt;") && guest.html.includes("Alexi &amp; co"));
  assert.ok(!guest.html.includes("Sam") && !guest.html.includes("deck"), "nothing the guest typed goes to the guest address");
  assert.ok(guest.text.includes(formatWhen(start, booked.body.booking.end, "America/Toronto")), "in the guest's zone");
  assert.equal(guest.reply_to, undefined, "the owner's address is never handed to guests");

  const notice = sent.find((mail) => mail.to[0] === "alexi@example.com");
  assert.ok(notice);
  assert.equal(notice.reply_to, "sam@x.co");
  assert.match(notice.subject, /^New booking: Sam <b>Rivera<\/b>, /);
  assert.ok(notice.html.includes("Sam &lt;b&gt;Rivera&lt;/b&gt;"));
  assert.ok(notice.html.includes("Bring the &lt;script&gt;alert(1)&lt;/script&gt; deck"));
  assert.ok(notice.text.includes(formatWhen(start, booked.body.booking.end, "UTC")), "in the owner's zone");
  const lookup = calls.find((entry) => entry.href.includes("/auth/v1/admin/users/"));
  assert.ok(lookup.href.endsWith(`/auth/v1/admin/users/${owner}`));
  assert.equal(lookup.headers.Authorization, "Bearer service-role-key");
});

test("an email failure never fails the booking", async (t) => {
  withEnv(t, { email: true });
  const warn = t.mock.method(console, "warn", () => {});
  fakeServices(t, { page: pageFor(nextOwner()), resendStatus: 500, ownerAddress: null });
  const page = await open();
  const booked = await bookIt(page.body.slots[0].start);
  assert.equal(booked.status, 201);
  assert.equal(booked.body.emailed, false);
  assert.ok(warn.mock.calls.length >= 2);
  assert.ok(!warn.mock.calls.flatMap((entry) => entry.arguments).join(" ").includes("re_test_key"), "the key is never logged");

  t.mock.method(globalThis, "fetch", wrap(globalThis.fetch, (url) => {
    if (String(url) === "https://api.resend.com/emails") throw new TypeError("fetch failed");
  }));
  const again = await bookIt((await open()).body.slots[1].start);
  assert.equal(again.status, 201);
  assert.equal(again.body.emailed, false);
});

test("a guest cancelling emails both sides", async (t) => {
  withEnv(t, { email: true });
  const owner = nextOwner();
  const row = { start_at: "2030-01-02T15:00:00.000Z", end_at: "2030-01-02T15:30:00.000Z", status: "cancelled", guest_name: "Sam <i>", guest_email: "sam@x.co", page_id: "page-1" };
  const calls = fakeServices(t, { page: pageFor(owner), cancelled: row });
  const result = await call({ method: "POST", body: { action: "cancel", token: "c".repeat(36), timeZone: "Europe/Paris" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.emailed, true);
  const sent = emails(calls);
  assert.deepEqual(sent.map((mail) => mail.to[0]).sort(), ["alexi@example.com", "sam@x.co"]);
  const guest = sent.find((mail) => mail.to[0] === "sam@x.co");
  assert.match(guest.subject, /^Cancelled: Coffee <chat> with Alexi & co$/);
  assert.ok(guest.html.includes("You cancelled it.") && guest.html.includes("https://waddle.example/book/alexi-7fq2x"));
  assert.ok(guest.text.includes(formatWhen(row.start_at, row.end_at, "Europe/Paris")));
  const notice = sent.find((mail) => mail.to[0] === "alexi@example.com");
  assert.ok(notice.html.includes("Sam &lt;i&gt; cancelled it."));
  assert.ok(!notice.html.includes("/book/alexi-7fq2x"), "no rebook link for the owner");
});

test("a guest cancelling without email set up sends nothing", async (t) => {
  withEnv(t, { email: false });
  const row = { start_at: "2030-01-02T15:00:00.000Z", end_at: "2030-01-02T15:30:00.000Z", status: "cancelled", guest_name: "Sam", guest_email: "sam@x.co", page_id: "page-1" };
  const calls = fakeServices(t, { page: pageFor(nextOwner()), cancelled: row });
  const result = await call({ method: "POST", body: { action: "cancel", token: "c".repeat(36) } });
  assert.equal(result.status, 200);
  assert.equal(result.body.emailed, false);
  assert.equal(emails(calls).length, 0);
  assert.equal(calls.filter((entry) => entry.href.includes("booking_pages")).length, 0, "no extra lookups when email is off");
});

test("the owner cancels through the server, only their own bookings, and the guest is told", async (t) => {
  withEnv(t, { email: true });
  const owner = nextOwner();
  const id = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
  const row = { start_at: "2030-01-02T15:00:00.000Z", end_at: "2030-01-02T15:30:00.000Z", status: "cancelled", guest_name: "Sam", guest_email: "sam@x.co", page_id: "page-1" };
  const calls = fakeServices(t, { page: pageFor(owner), cancelled: row, signedIn: owner });

  assert.equal((await call({ method: "POST", body: { action: "owner-cancel", id } })).status, 401, "needs the owner's token");
  assert.equal((await call({ method: "POST", headers: { authorization: "Bearer owner-token" }, body: { action: "owner-cancel", id: "../x" } })).status, 400);

  const result = await call({ method: "POST", headers: { authorization: "Bearer owner-token" }, body: { action: "owner-cancel", id } });
  assert.equal(result.status, 200);
  assert.equal(result.body.emailed, true);
  const patch = calls.find((entry) => entry.method === "PATCH");
  assert.ok(patch.href.includes(`id=eq.${id}`) && patch.href.includes("page_id=eq.page-1") && patch.href.includes("status=eq.confirmed"));
  const pageLookup = calls.find((entry) => entry.href.includes("booking_pages?"));
  assert.ok(pageLookup.href.includes(`owner_id=eq.${owner}`));
  const guest = emails(calls).find((mail) => mail.to[0] === "sam@x.co");
  assert.ok(guest.html.includes("Alexi &amp; co cancelled it."));
});

test("too many bookings from one email in a day are refused", async (t) => {
  withEnv(t);
  const page = pageFor(nextOwner());
  const calls = fakeServices(t, { page });
  t.mock.method(globalThis, "fetch", wrap(globalThis.fetch, (url, init = {}) => {
    const href = String(url);
    if (href.includes("/rest/v1/bookings") && href.includes("created_at=gt.") && (init.method || "GET") === "GET") {
      return new Response(JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ id: `b${index}` }))), { status: 200 });
    }
  }));
  const result = await bookIt((await open()).body.slots[0].start);
  assert.equal(result.status, 429);
  assert.ok(!calls.some((entry) => entry.method === "POST"));
});

test("escapeHtml covers the five HTML specials", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

/** Lets `override` answer a request first; anything it returns undefined for goes to `inner`. */
function wrap(inner, override) {
  return async (url, init) => (await override(url, init)) ?? inner(url, init);
}
