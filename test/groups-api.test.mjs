import test from "node:test";
import assert from "node:assert/strict";
import groupsHandler from "../api/groups.js";

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

const call = async (request) => {
  const response = mockResponse();
  await groupsHandler({ query: {}, headers: {}, method: "GET", ...request }, response);
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

test("without a database the list is empty, not an error", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const result = await call({});
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { groups: [], persisted: false });
});

test("only GET is allowed", async () => {
  const result = await call({ method: "POST" });
  assert.equal(result.status, 405);
});

test("no token, or a bad one, is refused", async (t) => {
  withDb(t);
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ headers: { authorization: "Bearer nope" } })).status, 401);
});

test("the caller's groups come from their verified account id, not the request", async (t) => {
  withDb(t);
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(String(url));
    if (String(url).includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-123" }), { status: 200 });
    return new Response(
      JSON.stringify([
        { slug: "crew-7fq2x", name: "Weekend crew", updated_at: "2026-09-23T10:00:00+00:00" },
        { slug: "book-club-a8k3m", name: null, updated_at: "2026-09-20T10:00:00+00:00" },
      ]),
      { status: 200 }
    );
  });

  const result = await call({ headers: { authorization: "Bearer good" }, query: { userId: "someone-else" } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.groups, [
    { slug: "crew-7fq2x", name: "Weekend crew", at: "2026-09-23T10:00:00+00:00" },
    { slug: "book-club-a8k3m", name: "book-club-a8k3m", at: "2026-09-20T10:00:00+00:00" },
  ]);

  const query = new URL(asked.find((url) => url.includes("/rest/v1/workspaces"))).searchParams;
  assert.equal(query.get("state"), 'cs.{"members":[{"userId":"user-123"}]}', "filtered by the verified id");
  assert.doesNotMatch(asked.join(" "), /someone-else/, "a user id in the query string is ignored");
});

test("a database failure is a JSON 502, never a crash", async (t) => {
  withDb(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/auth/v1/user")) return new Response(JSON.stringify({ id: "u" }), { status: 200 });
    throw new TypeError("fetch failed");
  });
  const result = await call({ headers: { authorization: "Bearer good" } });
  assert.equal(result.status, 502);
});
