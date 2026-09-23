import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/book.js";

function mockResponse() {
  const captured = { headers: {}, status: null, body: null, text: null };
  return {
    captured,
    setHeader(name, value) { captured.headers[name] = value; },
    status(code) { captured.status = code; return this; },
    json(body) { captured.body = body; return this; },
    end(text) { captured.text = text; return this; },
  };
}

const call = async (request) => {
  const response = mockResponse();
  await handler({ method: "GET", query: {}, headers: {}, ...request }, response);
  return response.captured;
};

function withDb(t) {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, pub: process.env.NEXT_PUBLIC_SUPABASE_URL };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key], ["NEXT_PUBLIC_SUPABASE_URL", saved.pub]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const PAGE = {
  id: "page-1",
  handle: "alexi-7fq2x",
  title: "Coffee chat",
  owner_name: "Alexi",
  // Every day, all day, so the test does not depend on today's date or weekday.
  settings: { duration: 30, noticeHours: 0, windowDays: 2, dayStart: 0, dayEnd: 24, weekdays: [0, 1, 2, 3, 4, 5, 6], timeZone: "UTC" },
  busy: [],
  ics_urls: [],
};

/** A fake PostgREST: answers by table and method, and records every call. */
function fakeDb(t, { page = PAGE, insert } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, method: init.method || "GET", body: init.body });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (href.includes("/rest/v1/booking_pages")) return json(200, page ? [page] : []);
    if (href.includes("/rest/v1/bookings") && (init.method || "GET") === "GET") return json(200, []);
    if (href.includes("/rest/v1/bookings") && init.method === "POST") return insert ? insert(init) : json(201, [{ id: "b1", start_at: JSON.parse(init.body).start_at, end_at: JSON.parse(init.body).end_at, status: "confirmed", cancel_token: "a".repeat(36), created_at: new Date().toISOString() }]);
    return json(404, {});
  });
  return calls;
}

test("without a database it says booking is not set up", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const result = await call({ query: { handle: "alexi-7fq2x" } });
  assert.equal(result.status, 503);
});

test("a bad handle is refused before touching the database", async (t) => {
  withDb(t);
  const calls = fakeDb(t);
  const result = await call({ query: { handle: "../../etc" } });
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
});

test("visitors get open slots and nothing about busy time or calendar links", async (t) => {
  withDb(t);
  fakeDb(t, { page: { ...PAGE, busy: [{ start: "2000-01-01T00:00:00Z", end: "2000-01-01T01:00:00Z" }], ics_urls: [] } });
  const result = await call({ query: { handle: "alexi-7fq2x" } });
  assert.equal(result.status, 200);
  assert.ok(result.body.slots.length > 0);
  assert.deepEqual(Object.keys(result.body.page).sort(), ["duration", "handle", "ownerName", "timeZone", "title"]);
  const text = JSON.stringify(result.body);
  assert.ok(!text.includes("ics_urls") && !text.includes("busy") && !text.includes("page-1"));
});

test("booking an offered slot succeeds and returns a cancel token", async (t) => {
  withDb(t);
  const calls = fakeDb(t);
  const open = await call({ query: { handle: "alexi-7fq2x" } });
  const start = open.body.slots[0].start;
  const result = await call({ method: "POST", body: { action: "book", handle: "alexi-7fq2x", start, name: "Sam", email: "sam@x.co" } });
  assert.equal(result.status, 201);
  assert.equal(result.body.booking.start, start);
  assert.match(result.body.booking.cancelToken, /^[a-f0-9]+$/);
  const insert = calls.find((entry) => entry.method === "POST");
  assert.equal(JSON.parse(insert.body).guest_email, "sam@x.co");
});

test("a time that is not offered, or already taken, gets a 409 with fresh slots", async (t) => {
  withDb(t);
  fakeDb(t, { insert: async () => new Response(JSON.stringify({ code: "23P01" }), { status: 409 }) });
  const notOffered = await call({ method: "POST", body: { action: "book", handle: "alexi-7fq2x", start: "2000-01-01T00:00:00Z", name: "Sam", email: "sam@x.co" } });
  assert.equal(notOffered.status, 409);
  const open = await call({ query: { handle: "alexi-7fq2x" } });
  const raced = await call({ method: "POST", body: { action: "book", handle: "alexi-7fq2x", start: open.body.slots[0].start, name: "Sam", email: "sam@x.co" } });
  assert.equal(raced.status, 409);
  assert.ok(Array.isArray(raced.body.slots));
});

test("guest details are validated and the honeypot blocks bots", async (t) => {
  withDb(t);
  fakeDb(t);
  const bad = await call({ method: "POST", body: { action: "book", handle: "alexi-7fq2x", start: new Date().toISOString(), name: "Sam", email: "nope" } });
  assert.equal(bad.status, 400);
  const bot = await call({ method: "POST", body: { action: "book", handle: "alexi-7fq2x", start: new Date().toISOString(), name: "Sam", email: "s@x.co", website: "spam" } });
  assert.equal(bot.status, 400);
});

test("the owner feed is a calendar file and bad tokens get 404", async (t) => {
  withDb(t);
  fakeDb(t);
  const missing = await call({ query: { feed: "not-a-token" } });
  assert.equal(missing.status, 404);
  const feed = await call({ query: { feed: "b".repeat(36) } });
  assert.equal(feed.status, 200);
  assert.match(feed.headers["Content-Type"], /text\/calendar/);
  assert.match(feed.text, /BEGIN:VCALENDAR/);
});

test("database failures never crash the function", async (t) => {
  withDb(t);
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const result = await call({ query: { handle: "alexi-7fq2x" } });
  assert.equal(result.status, 502);
  assert.ok(!JSON.stringify(result.body).includes("example.supabase.co"));
});
