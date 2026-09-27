// A stand-in for the Supabase REST API (PostgREST) and Auth, in memory, for the
// server side. The api/ handlers call `fetch(SUPABASE_URL/...)`; with this
// installed those calls are answered here instead, so the real handlers run in
// tests and in the local dev server without touching any real database.
//
//   node --test ...                      createFakeSupabase().fetch as fetch
//   WADDLE_FAKE_DB=1 node scripts/dev-server.mjs   (see dev-server.mjs)
//
// Only what the handlers use is implemented: select (with `alias:col->>key`),
// filters eq/neq/gt/gte/lt/lte/in/is/cs, order, limit, insert (with
// merge-duplicates upsert), update, delete, rpc, /auth/v1/user and admin user
// deletion. Signed-in browsers in the fake (fake-supabase.js) send
// "fake-token" for Alexi and "fake-token-sam" / "fake-token-jordan".

export const FAKE_SUPABASE_URL = "https://fake-db.waddle.test";
export const FAKE_SERVICE_KEY = "fake-service-role-key";

export const FAKE_USERS = {
  "fake-token": { id: "11111111-1111-1111-1111-111111111111", email: "alexi@example.com", user_metadata: { full_name: "Alexi" } },
  "fake-token-sam": { id: "22222222-2222-2222-2222-222222222222", email: "sam@example.com", user_metadata: { full_name: "Sam Rivera" } },
  "fake-token-jordan": { id: "33333333-3333-3333-3333-333333333333", email: "jordan@example.com", user_metadata: { full_name: "Jordan Lee" } },
};

// Primary keys, for upserts. Anything not listed uses "id".
const KEYS = {
  workspaces: ["slug"],
  sharing_settings: ["user_id"],
  presence: ["user_id"],
  google_tokens: ["user_id"],
  calendar_shares: ["owner_id", "viewer_id"],
  push_subscriptions: ["endpoint"],
  analytics_daily: ["day", "metric"],
  notification_log: ["key"],
};

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function headerOf(init, name) {
  const headers = init?.headers || {};
  if (typeof headers.get === "function") return headers.get(name) || "";
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? String(headers[found]) : "";
}

/** jsonb @> : every part of `wanted` is found in `value`. */
export function contains(value, wanted) {
  if (Array.isArray(wanted)) return Array.isArray(value) && wanted.every((item) => value.some((entry) => contains(entry, item)));
  if (wanted && typeof wanted === "object") return value && typeof value === "object" && Object.entries(wanted).every(([key, item]) => contains(value[key], item));
  return value === wanted;
}

function readPath(row, expression) {
  const match = /^([a-z0-9_]+)(?:(->>?)([a-z0-9_]+))?$/i.exec(expression);
  if (!match) return undefined;
  const base = row[match[1]];
  if (!match[2]) return base;
  const inner = base?.[match[3]];
  if (match[2] === "->>") return inner === undefined || inner === null ? null : typeof inner === "string" ? inner : JSON.stringify(inner);
  return inner;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

function filterFor(column, raw) {
  if (raw.startsWith("not.")) {
    const inner = filterFor(column, raw.slice(4));
    return (row) => !inner(row);
  }
  const dot = raw.indexOf(".");
  const op = raw.slice(0, dot);
  const argument = raw.slice(dot + 1);
  const read = (row) => readPath(row, column);
  switch (op) {
    case "eq":
      return (row) => String(read(row)) === argument;
    case "neq":
      return (row) => String(read(row)) !== argument;
    case "gt":
      return (row) => compare(read(row), argument) > 0;
    case "gte":
      return (row) => compare(read(row), argument) >= 0;
    case "lt":
      return (row) => compare(read(row), argument) < 0;
    case "lte":
      return (row) => compare(read(row), argument) <= 0;
    case "is":
      return (row) => (argument === "null" ? read(row) === null || read(row) === undefined : String(read(row)) === argument);
    case "in": {
      const list = argument.replace(/^\(|\)$/g, "").split(",").map((item) => item.replace(/^"|"$/g, ""));
      return (row) => list.includes(String(read(row)));
    }
    case "cs": {
      const wanted = JSON.parse(argument);
      return (row) => contains(read(row), wanted);
    }
    default:
      throw new Error(`fake-supabase: unsupported filter ${op}`);
  }
}

function project(rows, select) {
  if (!select || select === "*") return rows.map((row) => structuredClone(row));
  const parts = select.split(",").map((part) => part.trim()).filter(Boolean);
  return rows.map((row) => {
    const out = {};
    for (const part of parts) {
      const [alias, expression] = part.includes(":") ? part.split(":") : [part.replace(/->>?.*$/, ""), part];
      if (expression === "*") Object.assign(out, structuredClone(row));
      else out[alias.includes("->") ? alias.split(/->>?/).pop() : alias] = structuredClone(readPath(row, expression));
    }
    return out;
  });
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

/**
 * Makes a fake. `tables` seeds rows, `users` maps bearer tokens to users, and
 * `rpc` maps function names to (args, db, user) => result.
 */
/** Database functions the server calls, as supabase/schema.sql defines them. */
const DEFAULT_RPC = {
  // Bumps today's count for one metric (analytics_daily).
  count_metric({ p_metric, p_amount = 1 }, db) {
    const day = new Date().toISOString().slice(0, 10);
    db.analytics_daily ||= [];
    const row = db.analytics_daily.find((entry) => entry.day === day && entry.metric === p_metric);
    if (row) row.count += p_amount;
    else db.analytics_daily.push({ day, metric: p_metric, count: p_amount });
    return null;
  },
};

export function createFakeSupabase({ tables = {}, users = FAKE_USERS, rpc = {} } = {}) {
  rpc = { ...DEFAULT_RPC, ...rpc };
  const db = { workspaces: [], ...structuredClone(tables) };
  const accounts = { ...users };
  const calls = [];

  const rowsOf = (table) => (db[table] ||= []);

  function matching(table, params) {
    const filters = [];
    for (const [column, value] of params) {
      if (RESERVED.has(column)) continue;
      filters.push(filterFor(column, value));
    }
    return rowsOf(table).filter((row) => filters.every((test) => test(row)));
  }

  function keyOf(table, row) {
    return (KEYS[table] || ["id"]).map((column) => String(row[column])).join("|");
  }

  async function handle(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });

    if (url.pathname === "/auth/v1/user") {
      const token = headerOf(init, "Authorization").replace(/^Bearer\s+/i, "");
      const user = accounts[token];
      return user ? json(200, user) : json(401, { message: "invalid token" });
    }
    const admin = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname);
    if (admin) {
      if (headerOf(init, "Authorization") !== `Bearer ${FAKE_SERVICE_KEY}`) return json(401, { message: "service role only" });
      if (method !== "DELETE") return json(405, {});
      const token = Object.keys(accounts).find((key) => accounts[key].id === admin[1]);
      if (!token) return json(404, { message: "User not found" });
      delete accounts[token];
      return json(200, {});
    }

    const rpcMatch = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (rpcMatch) {
      const fn = rpc[rpcMatch[1]];
      if (!fn) return json(404, { message: `function ${rpcMatch[1]} not found` });
      const token = headerOf(init, "Authorization").replace(/^Bearer\s+/i, "");
      try {
        return json(200, await fn(body || {}, db, accounts[token] || null));
      } catch (error) {
        return json(400, { message: error.message });
      }
    }

    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table) return json(404, { message: "not found" });
    const prefer = headerOf(init, "Prefer");
    const representation = /return=representation/.test(prefer);
    const params = [...url.searchParams.entries()];

    if (method === "GET") {
      let rows = matching(table, params);
      const order = url.searchParams.get("order");
      if (order) {
        const [column, direction] = order.split(".");
        rows = [...rows].sort((a, b) => compare(readPath(a, column), readPath(b, column)) * (direction === "desc" ? -1 : 1));
      }
      const limit = Number(url.searchParams.get("limit"));
      if (limit) rows = rows.slice(0, limit);
      return json(200, project(rows, url.searchParams.get("select")));
    }

    if (method === "POST") {
      const incoming = (Array.isArray(body) ? body : [body]).map((row) => ({ ...(KEYS[table] ? {} : { id: crypto.randomUUID() }), ...row }));
      const merge = /resolution=merge-duplicates/.test(prefer);
      const written = [];
      for (const row of incoming) {
        const existing = rowsOf(table).find((entry) => keyOf(table, entry) === keyOf(table, row));
        if (existing && !merge) return json(409, { code: "23505", message: `duplicate key value violates unique constraint on ${table}` });
        if (existing) {
          Object.assign(existing, structuredClone(row));
          written.push(existing);
        } else {
          const copy = structuredClone(row);
          rowsOf(table).push(copy);
          written.push(copy);
        }
      }
      return json(201, representation ? structuredClone(written) : undefined);
    }

    if (method === "PATCH") {
      const rows = matching(table, params);
      for (const row of rows) Object.assign(row, structuredClone(body));
      return json(200, representation ? structuredClone(rows) : undefined);
    }

    if (method === "DELETE") {
      const rows = matching(table, params);
      db[table] = rowsOf(table).filter((row) => !rows.includes(row));
      return json(200, representation ? structuredClone(rows) : undefined);
    }

    return json(405, { message: "method not allowed" });
  }

  return {
    db,
    calls,
    users: accounts,
    fetch: (input, init) => handle(input, init),
    reset(next = {}) {
      for (const key of Object.keys(db)) delete db[key];
      Object.assign(db, { workspaces: [] }, structuredClone(next));
      calls.length = 0;
    },
  };
}

/**
 * Routes every fetch to FAKE_SUPABASE_URL into `fake` and sets the env vars
 * the handlers read. Returns a function that puts everything back.
 */
// A stand-in push service: subscriptions made in tests point here, and every
// message the server sends is recorded in fake.db._push instead of delivered.
// An endpoint with "/gone" in it answers 410, as a real one does for a device
// that unsubscribed.
export const FAKE_PUSH_ORIGIN = "https://push.waddle.test";

function fakePush(fake, url, init = {}) {
  (fake.db._push ||= []).push({ endpoint: url, ttl: headerOf(init, "TTL"), encoding: headerOf(init, "Content-Encoding"), bytes: init.body ? init.body.length : 0, at: new Date().toISOString() });
  return new Response(null, { status: /\/gone/.test(url) ? 410 : 201 });
}

export function installFakeSupabase(fake = createFakeSupabase()) {
  const realFetch = globalThis.fetch;
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL };
  process.env.SUPABASE_URL = FAKE_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_SERVICE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  globalThis.fetch = (input, init) => {
    const url = String(input?.url || input);
    if (url.startsWith(FAKE_SUPABASE_URL)) return fake.fetch(url, init);
    if (url.startsWith(FAKE_PUSH_ORIGIN)) return Promise.resolve(fakePush(fake, url, init));
    return realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
