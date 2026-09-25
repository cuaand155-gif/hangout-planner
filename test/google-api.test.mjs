import test from "node:test";
import assert from "node:assert/strict";
import handler, { openToken, sealToken } from "../api/google.js";

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

const USER = "11111111-1111-4111-8111-111111111111";
const SECRET = "client-secret";

const call = async (request) => {
  const response = mockResponse();
  await handler({ method: "GET", query: {}, headers: { authorization: "Bearer user-token" }, ...request }, response);
  return response.captured;
};

function withEnv(t, { google = true } = {}) {
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  if (google) {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = SECRET;
  } else {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** Fake Supabase auth + PostgREST + Google, recording every call. */
function fakeServices(t, { stored = null, tokenReply = { status: 200, body: { access_token: "fresh-access", expires_in: 3599 } }, eventsStatus = 200 } = {}) {
  const calls = [];
  const table = { row: stored };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const href = String(url);
    const method = init.method || "GET";
    calls.push({ href, method, body: init.body, headers: init.headers });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (href.endsWith("/auth/v1/user")) return init.headers.Authorization === "Bearer user-token" ? json(200, { id: USER }) : json(401, {});
    if (href.includes("/rest/v1/google_tokens")) {
      if (method === "GET") return json(200, table.row ? [{ refresh_token: table.row }] : []);
      if (method === "POST") {
        table.row = JSON.parse(init.body).refresh_token;
        return new Response(null, { status: 201 });
      }
      if (method === "DELETE") {
        table.row = null;
        return new Response(null, { status: 204 });
      }
    }
    if (href === "https://oauth2.googleapis.com/token") return json(tokenReply.status, tokenReply.body);
    if (href.startsWith("https://www.googleapis.com/calendar/v3/")) {
      return json(eventsStatus, { items: [{ status: "confirmed", summary: "Dinner", location: "Pai", description: "secret notes", attendees: [{ email: "a@b.c" }], start: { dateTime: "2026-10-01T19:00:00Z" }, end: { dateTime: "2026-10-01T21:00:00Z" } }] });
    }
    return json(404, {});
  });
  return { calls, table };
}

const RANGE = { from: "2026-09-24T00:00:00.000Z", to: "2026-10-24T00:00:00.000Z" };
let userCounter = 0;

test("sealed refresh tokens round-trip and can't be read with another secret", () => {
  const sealed = sealToken("1//refresh-token", SECRET);
  assert.ok(!sealed.includes("refresh-token"));
  assert.equal(openToken(sealed, SECRET), "1//refresh-token");
  assert.throws(() => openToken(sealed, "other-secret"));
  assert.notEqual(sealToken("1//refresh-token", SECRET), sealed, "fresh IV every time");
});

test("without Google credentials it reports not configured and touches nothing", async (t) => {
  withEnv(t, { google: false });
  const { calls } = fakeServices(t);
  const result = await call({});
  assert.deepEqual(result.body, { configured: false, connected: false });
  assert.equal(calls.length, 0);
});

test("signed-out callers are refused", async (t) => {
  withEnv(t);
  fakeServices(t);
  const result = await call({ headers: {} });
  assert.equal(result.status, 401);
});

test("storing a refresh token keeps it encrypted, then reports connected", async (t) => {
  withEnv(t);
  const { table } = fakeServices(t);
  const saved = await call({ method: "POST", body: { refreshToken: "1//refresh-token" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.connected, true);
  assert.ok(table.row && !table.row.includes("refresh-token"));
  assert.equal(openToken(table.row, SECRET), "1//refresh-token");
  const status = await call({});
  assert.deepEqual(status.body, { configured: true, connected: true });
});

test("a missing refresh token is refused", async (t) => {
  withEnv(t);
  fakeServices(t);
  assert.equal((await call({ method: "POST", body: {} })).status, 400);
  assert.equal((await call({ method: "POST", body: "not json" })).status, 400);
});

test("events come back through a refreshed token, with notes and guests left out", async (t) => {
  withEnv(t);
  // Unique user per test so the in-memory access cache starts empty.
  const id = `2222222${++userCounter}-2222-4222-8222-222222222222`;
  const { calls } = fakeServices(t, { stored: sealToken("1//refresh-token", SECRET) });
  t.mock.method(globalThis, "fetch", wrapUser(globalThis.fetch, id));
  const result = await call({ query: RANGE });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items[0], { status: "confirmed", transparency: undefined, summary: "Dinner", location: "Pai", start: { dateTime: "2026-10-01T19:00:00Z" }, end: { dateTime: "2026-10-01T21:00:00Z" } });
  const refresh = calls.find((entry) => entry.href === "https://oauth2.googleapis.com/token");
  assert.match(String(refresh.body), /refresh_token=1%2F%2Frefresh-token/);
  const events = calls.find((entry) => entry.href.startsWith("https://www.googleapis.com/"));
  assert.equal(events.headers.Authorization, "Bearer fresh-access");
});

test("a revoked grant forgets the stored token and asks to reconnect", async (t) => {
  withEnv(t);
  const id = `3333333${++userCounter}-3333-4333-8333-333333333333`;
  const { table } = fakeServices(t, { stored: sealToken("1//old", SECRET), tokenReply: { status: 400, body: { error: "invalid_grant" } } });
  t.mock.method(globalThis, "fetch", wrapUser(globalThis.fetch, id));
  t.mock.method(console, "warn", () => {});
  const result = await call({ query: RANGE });
  assert.equal(result.status, 401);
  assert.equal(result.body.reconnect, true);
  assert.equal(table.row, null);
});

test("keys pasted with a trailing newline still work", async (t) => {
  withEnv(t);
  process.env.GOOGLE_CLIENT_ID = "client-id\n";
  process.env.GOOGLE_CLIENT_SECRET = `${SECRET}\n`;
  const id = `4444444${++userCounter}-4444-4444-8444-444444444444`;
  const { calls } = fakeServices(t, { stored: sealToken("1//refresh-token", SECRET) });
  t.mock.method(globalThis, "fetch", wrapUser(globalThis.fetch, id));
  const result = await call({ query: RANGE });
  assert.equal(result.status, 200);
  const refresh = calls.find((entry) => entry.href === "https://oauth2.googleapis.com/token");
  assert.match(String(refresh.body), /client_id=client-id&client_secret=client-secret&/);
});

test("a wrong server client keeps the stored token and does not ask to reconnect", async (t) => {
  withEnv(t);
  const id = `5555555${++userCounter}-5555-4555-8555-555555555555`;
  const { table } = fakeServices(t, { stored: sealToken("1//kept", SECRET), tokenReply: { status: 401, body: { error: "invalid_client" } } });
  t.mock.method(globalThis, "fetch", wrapUser(globalThis.fetch, id));
  t.mock.method(console, "warn", () => {});
  const result = await call({ query: RANGE });
  assert.equal(result.status, 503);
  assert.equal(result.body.reason, "setup");
  assert.notEqual(result.body.reconnect, true);
  assert.ok(table.row, "the person's consent is kept");
});

test("calendar access left unticked on Google's consent screen says so", async (t) => {
  withEnv(t);
  const id = `6666666${++userCounter}-6666-4666-8666-666666666666`;
  fakeServices(t, { stored: sealToken("1//x", SECRET) });
  const inner = globalThis.fetch;
  t.mock.method(globalThis, "fetch", wrapUser(async (url, init) => {
    if (String(url).startsWith("https://www.googleapis.com/calendar/v3/")) {
      return new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 });
    }
    return inner(url, init);
  }, id));
  t.mock.method(console, "warn", () => {});
  const result = await call({ query: RANGE });
  assert.equal(result.status, 401);
  assert.equal(result.body.reconnect, true);
  assert.equal(result.body.reason, "scope");
  assert.match(result.body.error, /See your calendars/);
});

test("ranges longer than four months or backwards are refused", async (t) => {
  withEnv(t);
  fakeServices(t);
  assert.equal((await call({ query: { from: RANGE.to, to: RANGE.from } })).status, 400);
  assert.equal((await call({ query: { from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" } })).status, 400);
  assert.equal((await call({ query: { from: "nope", to: RANGE.to } })).status, 400);
});

test("disconnecting deletes the stored token", async (t) => {
  withEnv(t);
  const { table, calls } = fakeServices(t, { stored: sealToken("1//x", SECRET) });
  const result = await call({ method: "DELETE" });
  assert.deepEqual(result.body, { configured: true, connected: false });
  assert.equal(table.row, null);
  assert.ok(calls.some((entry) => entry.method === "DELETE" && entry.href.includes(`user_id=eq.${USER}`)));
});

test("other methods are not allowed", async (t) => {
  withEnv(t);
  fakeServices(t);
  assert.equal((await call({ method: "PUT" })).status, 405);
});

/** Answers the auth lookup with a different user id, passing everything else through. */
function wrapUser(inner, id) {
  return async (url, init = {}) => {
    if (String(url).endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id }), { status: 200 });
    return inner(url, init);
  };
}
