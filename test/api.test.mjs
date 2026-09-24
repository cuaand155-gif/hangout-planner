import test from "node:test";
import assert from "node:assert/strict";
import calendarHandler, { isPrivateAddress, normalizeFeedUrl } from "../api/calendar.js";
import workspaceHandler from "../api/workspace.js";
import { DEMO_SLUG } from "../lib/checklist.js";

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

/** Headers of a signed-in caller; withAuth resolves this token to user-1. */
const SIGNED_IN = { authorization: "Bearer good-token" };

/**
 * Puts a fake Supabase Auth in front of a fake PostgREST: "good-token" is
 * user-1, "other-token" is user-2 and anything else is rejected.
 */
function withAuth(rest) {
  return async (url, options = {}) => {
    if (String(url).includes("/auth/v1/user")) {
      const token = String(options.headers?.Authorization || "").replace("Bearer ", "");
      const users = { "good-token": "user-1", "other-token": "user-2" };
      return users[token] ? new Response(JSON.stringify({ id: users[token] }), { status: 200 }) : new Response("{}", { status: 401 });
    }
    return rest(url, options);
  };
}

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
  const previousPublic = process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
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
    if (previousPublic === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousPublic;
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
  t.mock.method(globalThis, "fetch", withAuth(async (url, options = {}) => {
    if (options.method === "PATCH") {
      patched = JSON.parse(options.body);
      return new Response(JSON.stringify([{ slug: "team", state: patched.state, updated_at: patched.updated_at }]), { status: 200 });
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  }));

  const result = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    headers: SIGNED_IN,
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
  t.mock.method(globalThis, "fetch", withAuth(async (url, options = {}) => {
    if (options.method === "PATCH") {
      patchCalls += 1;
      return new Response("[]", { status: 200 });
    }
    return new Response(JSON.stringify([{ slug: "team", state: { name: "Team" }, updated_at: "2026-09-21T12:00:00.000Z" }]), { status: 200 });
  }));

  const result = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    headers: SIGNED_IN,
    body: { rev: "2026-09-21T10:00:00.000Z", state: { name: "Team" } },
  });

  assert.equal(result.status, 409);
  assert.equal(patchCalls, 0, "a known-stale revision never reaches the database");
  assert.equal(result.body.rev, "2026-09-21T12:00:00.000Z");
  assert.equal(result.body.state.name, "Team");
});

test("with a database, a group answers only a signed-in caller and leaks nothing otherwise", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  const stored = {
    slug: "team",
    state: { name: "Team", members: [{ id: "a", name: "Ada", busy: [{ start: "2026-09-21T09:00:00.000Z", end: "2026-09-21T10:00:00.000Z" }] }] },
    updated_at: "2026-09-21T10:00:00.000Z",
  };
  const asked = [];
  t.mock.method(globalThis, "fetch", withAuth(async (url, options = {}) => {
    asked.push(`${options.method || "GET"} ${url}`);
    return new Response(JSON.stringify([stored]), { status: 200 });
  }));

  for (const headers of [{}, { authorization: "Bearer nope" }]) {
    for (const method of ["GET", "PUT"]) {
      const result = await call(workspaceHandler, { method, query: { slug: "team" }, headers, body: { rev: stored.updated_at, state: stored.state } });
      assert.equal(result.status, 401, `${method} with ${JSON.stringify(headers)}`);
      assert.deepEqual(result.body, { error: "Sign in to open this group.", signIn: true }, "no state, members or rev");
    }
  }
  assert.deepEqual(asked, [], "the workspace table is never touched without a signed-in caller");

  const member = await call(workspaceHandler, { method: "GET", query: { slug: "team" }, headers: SIGNED_IN });
  assert.equal(member.status, 200);
  assert.equal(member.body.persisted, true);
  assert.equal(member.body.state.members[0].name, "Ada");
});

test("the first signed-in visit to a new group still creates it", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  let inserted = null;
  t.mock.method(globalThis, "fetch", withAuth(async (url, options = {}) => {
    if (options.method === "POST") {
      inserted = JSON.parse(options.body);
      return new Response(JSON.stringify([{ ...inserted }]), { status: 201 });
    }
    return new Response("[]", { status: 200 });
  }));

  const result = await call(workspaceHandler, { method: "GET", query: { slug: "book-club-7fq2x" }, headers: SIGNED_IN });
  assert.equal(result.status, 201);
  assert.equal(inserted.slug, "book-club-7fq2x");
  assert.equal(result.body.state.name, "Book club 7fq2x");
});

test("the demo group stays open without an account", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  const stored = { slug: DEMO_SLUG, state: { name: "Weekend crew", members: [] }, updated_at: "2026-09-21T10:00:00.000Z" };
  t.mock.method(globalThis, "fetch", withAuth(async (url, options = {}) => {
    if (options.method === "PATCH") {
      return new Response(JSON.stringify([{ slug: DEMO_SLUG, state: JSON.parse(options.body).state, updated_at: "2026-09-21T13:00:00.000Z" }]), { status: 200 });
    }
    return new Response(JSON.stringify([stored]), { status: 200 });
  }));

  const read = await call(workspaceHandler, { method: "GET", query: { slug: DEMO_SLUG } });
  assert.equal(read.status, 200);
  assert.equal(read.body.persisted, true);

  const write = await call(workspaceHandler, { method: "PUT", query: { slug: DEMO_SLUG }, body: { rev: stored.updated_at, state: { ...stored.state, name: "Try it" } } });
  assert.equal(write.status, 200);
  assert.equal(write.body.state.name, "Try it");
});

test("a locked workspace rejects writes from anyone but a signed-in member", async (t) => {
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
  t.mock.method(globalThis, "fetch", withAuth(async (url, options = {}) => {
    if (options.method === "PATCH") {
      return new Response(JSON.stringify([{ slug: "team", state: JSON.parse(options.body).state, updated_at: "2026-09-21T13:00:00.000Z" }]), { status: 200 });
    }
    return new Response(JSON.stringify([stored]), { status: 200 });
  }));

  const anonymous = await call(workspaceHandler, { method: "PUT", query: { slug: "team" }, body: { rev: stored.updated_at, state: stored.state } });
  assert.equal(anonymous.status, 401, "signing in comes first");

  const badToken = await call(workspaceHandler, { method: "PUT", query: { slug: "team" }, headers: { authorization: "Bearer nope" }, body: { rev: stored.updated_at, state: stored.state } });
  assert.equal(badToken.status, 401);

  const outsider = await call(workspaceHandler, { method: "PUT", query: { slug: "team" }, headers: { authorization: "Bearer other-token" }, body: { rev: stored.updated_at, state: stored.state } });
  assert.equal(outsider.status, 403, "signed in, but not a member of this locked group");
  assert.match(outsider.body.error, /locked/);

  const member = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    headers: { authorization: "Bearer good-token" },
    body: { rev: stored.updated_at, state: { ...stored.state, name: "Renamed" } },
  });
  assert.equal(member.status, 200);
  assert.equal(member.body.state.name, "Renamed");
});

test("ownership cannot be taken over by another signed-in writer", async (t) => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  const stored = { slug: "team", state: { name: "Team", ownerId: "user-1", members: [] }, updated_at: "2026-09-21T10:00:00.000Z" };
  t.mock.method(globalThis, "fetch", withAuth(async (url, options = {}) => {
    if (options.method === "PATCH") {
      return new Response(JSON.stringify([{ slug: "team", state: JSON.parse(options.body).state, updated_at: "2026-09-21T13:00:00.000Z" }]), { status: 200 });
    }
    return new Response(JSON.stringify([stored]), { status: 200 });
  }));

  const result = await call(workspaceHandler, {
    method: "PUT",
    query: { slug: "team" },
    headers: { authorization: "Bearer other-token" },
    body: { rev: stored.updated_at, state: { name: "Team", ownerId: "user-2", members: [] } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.ownerId, "user-1", "the stored owner is kept");
});

test("either the integration's variable names or the hand-made ones work", async (t) => {
  // The Supabase/Vercel integration sets NEXT_PUBLIC_SUPABASE_URL and
  // SUPABASE_SECRET_KEY rather than SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
  const saved = { ...process.env };
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]) delete process.env[key];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "service-role-key";
  t.after(() => {
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  let asked = null;
  t.mock.method(globalThis, "fetch", withAuth(async (url) => {
    asked = String(url);
    return new Response(JSON.stringify([{ slug: "team", state: { name: "Team" }, updated_at: "2026-09-21T10:00:00.000Z" }]), { status: 200 });
  }));

  const result = await call(workspaceHandler, { method: "GET", query: { slug: "team" }, headers: SIGNED_IN });
  assert.equal(result.status, 200);
  assert.equal(result.body.persisted, true, "the integration's variable names are enough to persist");
  assert.match(asked, /^https:\/\/example\.supabase\.co\/rest\/v1\/workspaces/);
});

/** Sets env vars for one test and restores them afterwards. */
function withEnv(t, values) {
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test("an unreachable database is a JSON 502, not a crashed function", async (t) => {
  withEnv(t, { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", withAuth(async () => {
    throw new TypeError("fetch failed");
  }));
  const result = await call(workspaceHandler, { method: "GET", query: { slug: "team" }, headers: SIGNED_IN });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /database could not be reached/);
  assert.equal(result.body.detail, "TypeError");
  assert.doesNotMatch(JSON.stringify(result.body), /example\.supabase\.co|"k"/, "neither the URL nor the key leaks");
});

test("a non-JSON reply (a web page at the wrong URL) is a JSON 502, not a crash", async (t) => {
  withEnv(t, { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", withAuth(async () => new Response("<!doctype html><p>dashboard</p>", { status: 200 })));
  const result = await call(workspaceHandler, { method: "GET", query: { slug: "team" }, headers: SIGNED_IN });
  assert.equal(result.status, 502);
  assert.equal(result.body.detail, "SyntaxError");
});

test("a malformed SUPABASE_URL is skipped in favour of the integration's URL", async (t) => {
  withEnv(t, {
    SUPABASE_URL: "xgsskeblzggrhxumiwdl.supabase.co",
    NEXT_PUBLIC_SUPABASE_URL: "https://good.supabase.co/",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  });
  let asked = null;
  t.mock.method(globalThis, "fetch", withAuth(async (url) => {
    asked = String(url);
    return new Response(JSON.stringify([{ slug: "team", state: { name: "Team" }, updated_at: "2026-09-21T10:00:00.000Z" }]), { status: 200 });
  }));
  const result = await call(workspaceHandler, { method: "GET", query: { slug: "team" }, headers: SIGNED_IN });
  assert.equal(result.status, 200);
  assert.equal(result.body.persisted, true);
  assert.match(asked, /^https:\/\/good\.supabase\.co\/rest\/v1\//, "the trailing slash is trimmed and the good URL used");
});

test("the integration's URL wins when both look valid, since it is kept in sync", async (t) => {
  withEnv(t, {
    SUPABASE_URL: "https://stale.supabase.co",
    NEXT_PUBLIC_SUPABASE_URL: "https://current.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  });
  let asked = null;
  t.mock.method(globalThis, "fetch", withAuth(async (url) => {
    asked = String(url);
    return new Response("[]", { status: 200 });
  }));
  await call(workspaceHandler, { method: "GET", query: { slug: "team" }, headers: SIGNED_IN });
  assert.match(asked, /^https:\/\/current\.supabase\.co\//);
});

test("with no usable URL at all the API reports demo mode instead of failing", async (t) => {
  withEnv(t, { SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const result = await call(workspaceHandler, { method: "GET", query: { slug: "team" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.persisted, false);
  assert.match(result.body.reason, /SUPABASE_URL/);
});

test("the calendar endpoint also never crashes the function", async (t) => {
  t.mock.method(console, "error", () => {});
  // A body getter that throws stands in for any unexpected failure.
  const request = { method: "POST", headers: {}, query: {} };
  Object.defineProperty(request, "body", { get() { throw new Error("boom"); } });
  const response = mockResponse();
  await calendarHandler(request, response);
  assert.equal(response.captured.status, 502);
  assert.equal(response.captured.body.detail, "Error");
});
