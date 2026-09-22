import test from "node:test";
import assert from "node:assert/strict";
import calendarHandler, { isPrivateAddress, normalizeFeedUrl } from "../api/calendar.js";
import workspaceHandler from "../api/workspace.js";

/** Minimal stand-in for the Vercel response object. */
function mockResponse() {
  const captured = { headers: {}, status: null, body: null };
  return {
    captured,
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
}

const call = async (handler, request) => {
  const response = mockResponse();
  await handler({ query: {}, headers: {}, ...request }, response);
  return response.captured;
};

test("private, loopback and metadata addresses are refused", () => {
  for (const address of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "nonsense"]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be blocked`);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "17.253.144.10", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be allowed`);
  }
});

test("feed links are normalized and unsafe ones rejected", () => {
  assert.equal(normalizeFeedUrl("webcal://p1.calendar.icloud.com/published/x.ics").url.href, "https://p1.calendar.icloud.com/published/x.ics");
  assert.equal(normalizeFeedUrl("  https://calendar.google.com/basic.ics  ").url.protocol, "https:");
  assert.match(normalizeFeedUrl("http://example.com/a.ics").error, /https/);
  assert.match(normalizeFeedUrl("file:///etc/passwd").error, /https/);
  assert.match(normalizeFeedUrl("https://user:secret@example.com/a.ics").error, /username and password/);
  assert.match(normalizeFeedUrl("").error, /calendar link/);
  assert.match(normalizeFeedUrl("¯\\_(ツ)_/¯").error, /calendar link/);
});

test("the calendar endpoint validates method, url and range before fetching", async () => {
  const wrongMethod = await call(calendarHandler, { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.Allow, "POST, OPTIONS");

  const badJson = await call(calendarHandler, { method: "POST", body: "{oops" });
  assert.equal(badJson.status, 400);
  assert.match(badJson.body.error, /Invalid JSON/);

  const badRange = await call(calendarHandler, { method: "POST", body: { url: "https://example.com/a.ics", from: "2026-09-28", to: "2026-09-21" } });
  assert.equal(badRange.status, 400);
  assert.match(badRange.body.error, /valid date range/);

  const hugeRange = await call(calendarHandler, { method: "POST", body: { url: "https://example.com/a.ics", from: "2026-01-01", to: "2027-01-01" } });
  assert.equal(hugeRange.status, 400);
  assert.match(hugeRange.body.error, /at most/);

  const privateHost = await call(calendarHandler, { method: "POST", body: { url: "https://localhost/a.ics", from: "2026-09-21", to: "2026-09-28" } });
  assert.equal(privateHost.status, 400);
  assert.match(privateHost.body.error, /will not fetch/);

  const literalIp = await call(calendarHandler, { method: "POST", body: { url: "https://169.254.169.254/latest/meta-data", from: "2026-09-21", to: "2026-09-28" } });
  assert.equal(literalIp.status, 400);
  assert.match(literalIp.body.error, /will not fetch/);
});

test("the workspace endpoint serves a demo workspace when no database is configured", async () => {
  const previous = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const result = await call(workspaceHandler, { method: "GET", query: { slug: "Weekend Crew!" } });
    assert.equal(result.status, 200);
    assert.equal(result.slug, undefined);
    assert.equal(result.body.slug, "weekend-crew", "slugs are normalized");
    assert.equal(result.body.persisted, false);
    assert.match(result.body.reason, /SUPABASE_URL/);
    assert.equal(result.body.state.members.length, 3);
    assert.equal(result.headers["Cache-Control"], "no-store");
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previous;
  }
});

test("the workspace endpoint refuses unsupported methods", async () => {
  const result = await call(workspaceHandler, { method: "DELETE", query: { slug: "x" } });
  assert.equal(result.status, 405);
  assert.equal(result.headers.Allow, "GET, PUT, OPTIONS");
});

test("a workspace PUT normalizes whatever the client sends", async (t) => {
  const rows = [{ slug: "team", state: { name: "Team", members: [] }, updated_at: "2026-09-21T10:00:00.000Z" }];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  let patched = null;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (options.method === "PATCH") {
      patched = JSON.parse(options.body);
      return new Response(JSON.stringify([{ slug: "team", state: patched.state, updated_at: patched.updated_at }]), { status: 200 });
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  });

  const result = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    body: {
      rev: "2026-09-21T10:00:00.000Z",
      state: { name: "Team", privacy: "nonsense", members: [{ id: "a", name: "Ada" }], ideas: [{ title: "Walk", votes: ["a", "ghost"] }], secrets: "dropped" },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.state.privacy, "busy");
  assert.equal(result.body.state.secrets, undefined);
  assert.deepEqual(result.body.state.ideas[0].votes, ["a"]);
  assert.ok(patched.updated_at, "the row timestamp is refreshed on write");
});

test("a stale revision is reported as a conflict with the current state", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  let patchCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (options.method === "PATCH") {
      patchCalls += 1;
      return new Response("[]", { status: 200 });
    }
    return new Response(JSON.stringify([{ slug: "team", state: { name: "Team" }, updated_at: "2026-09-21T12:00:00.000Z" }]), { status: 200 });
  });

  const result = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    body: { rev: "2026-09-21T10:00:00.000Z", state: { name: "Team" } },
  });

  assert.equal(result.status, 409);
  assert.equal(patchCalls, 0, "a known-stale revision never reaches the database");
  assert.equal(result.body.rev, "2026-09-21T12:00:00.000Z");
  assert.equal(result.body.state.name, "Team");
});

test("a locked workspace rejects writes without a valid member token", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  const stored = {
    slug: "team",
    state: { name: "Team", ownerId: "user-1", settings: { locked: true }, members: [{ id: "a", name: "Ada", userId: "user-1" }] },
    updated_at: "2026-09-21T10:00:00.000Z",
  };
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).includes("/auth/v1/user")) {
      const token = String(options.headers.Authorization || "").replace("Bearer ", "");
      if (token === "good-token") return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      return new Response("{}", { status: 401 });
    }
    if (options.method === "PATCH") {
      return new Response(JSON.stringify([{ slug: "team", state: JSON.parse(options.body).state, updated_at: "2026-09-21T13:00:00.000Z" }]), { status: 200 });
    }
    return new Response(JSON.stringify([stored]), { status: 200 });
  });

  const anonymous = await call(workspaceHandler, { method: "PUT", query: { slug: "team" }, body: { rev: stored.updated_at, state: stored.state } });
  assert.equal(anonymous.status, 403);
  assert.match(anonymous.body.error, /locked/);

  const badToken = await call(workspaceHandler, { method: "PUT", query: { slug: "team" }, headers: { authorization: "Bearer nope" }, body: { rev: stored.updated_at, state: stored.state } });
  assert.equal(badToken.status, 403);

  const member = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    headers: { authorization: "Bearer good-token" },
    body: { rev: stored.updated_at, state: { ...stored.state, name: "Renamed" } },
  });
  assert.equal(member.status, 200);
  assert.equal(member.body.state.name, "Renamed");
});

test("ownership cannot be taken over by an anonymous writer", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  const stored = { slug: "team", state: { name: "Team", ownerId: "user-1", members: [] }, updated_at: "2026-09-21T10:00:00.000Z" };
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).includes("/auth/v1/user")) return new Response("{}", { status: 401 });
    if (options.method === "PATCH") {
      return new Response(JSON.stringify([{ slug: "team", state: JSON.parse(options.body).state, updated_at: "2026-09-21T13:00:00.000Z" }]), { status: 200 });
    }
    return new Response(JSON.stringify([stored]), { status: 200 });
  });

  const result = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    body: { rev: stored.updated_at, state: { name: "Team", ownerId: "attacker", members: [] } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.ownerId, "user-1", "the stored owner is kept");
});
