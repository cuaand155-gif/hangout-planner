// Stand-in for supabase-js in the browser tests: an in-memory database.
//
// Like a real database it outlives a page load: every write is kept in
// localStorage ("fake-db"), so a reload reads back what was saved. Each
// browser context starts empty.
//
// Who is signed in: localStorage "fake-user" = "alexi" (default), "sam" or
// "jordan". Alexi and Sam are friends; Jordan is not yet.
//
// Rows can be seeded before a page load: localStorage "fake-seed" =
// {"<table>": [...], ...}. A seeded table replaces that table once, on the
// next load (then the seed is used up and the saved database carries on).
(function () {
  const ME = "11111111-1111-1111-1111-111111111111";
  const SAM = "22222222-2222-2222-2222-222222222222";
  const JORDAN = "33333333-3333-3333-3333-333333333333";
  const USERS = {
    alexi: { id: ME, email: "alexi@example.com", user_metadata: { full_name: "Alexi" } },
    sam: { id: SAM, email: "sam@example.com", user_metadata: { full_name: "Sam Rivera" } },
    jordan: { id: JORDAN, email: "jordan@example.com", user_metadata: { full_name: "Jordan Lee" } },
  };
  const now = Date.now();
  const read = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  };
  const user = USERS[localStorage.getItem("fake-user")] || USERS.alexi;
  const seed = window.__seed || read("fake-seed") || {};
  localStorage.removeItem("fake-seed");
  const saved = read("fake-db") || {};
  const defaults = {
    friend_requests: [{ id: "fr1", requester_id: ME, recipient_id: SAM, recipient_email: "sam@example.com", status: "accepted", created_at: new Date(now - 864e5).toISOString() }],
    profiles: [{ id: SAM, display_name: "Sam Rivera", photo_url: "" }, { id: ME, display_name: "Alexi", photo_url: "" }, { id: JORDAN, display_name: "Jordan Lee", photo_url: "" }],
    sharing_settings: [],
    presence: [{ user_id: SAM, until: new Date(now + 2 * 3600e3).toISOString(), note: "up for coffee" }],
    // What Sam shares with Alexi: an event on right now.
    calendar_shares: [{
      owner_id: SAM,
      viewer_id: ME,
      events: [{ start: new Date(now - 30 * 60e3).toISOString(), end: new Date(now + 90 * 60e3).toISOString(), title: "Lunch with Jo" }],
      fallback_events: null,
      expires_at: null,
      updated_at: new Date(now - 600e3).toISOString(),
    }],
    booking_pages: [],
    bookings: [],
    workspaces: [],
  };
  const db = {};
  for (const table of Object.keys(defaults)) db[table] = seed[table] || saved[table] || defaults[table];
  const persist = () => localStorage.setItem("fake-db", JSON.stringify(db));
  persist();

  const calls = (window.__calls = []);
  window.__fakeDb = db;
  function query(table) {
    let rows = () => db[table] || [];
    const filters = [];
    let op = "select";
    let payload = null;
    const apply = () => rows().filter((row) => filters.every((f) => f(row)));
    const api = {
      select() { return api; },
      eq(col, val) { filters.push((row) => row[col] === val); return api; },
      in(col, vals) { filters.push((row) => vals.includes(row[col])); return api; },
      gt(col, val) { filters.push((row) => row[col] > val); return api; },
      gte(col, val) { filters.push((row) => row[col] >= val); return api; },
      order() { return api; },
      limit() { return api; },
      insert(row) { op = "insert"; payload = row; return api; },
      update(row) { op = "update"; payload = row; return api; },
      upsert(row, options) { op = "upsert"; payload = row; calls.push([table, "upsert", row, options]); return api; },
      delete() { op = "delete"; return api; },
      maybeSingle() { return run().then((r) => ({ data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error })); },
      single() { return api.maybeSingle(); },
      then(resolve, reject) { return run().then(resolve, reject); },
    };
    function run() {
      if (op === "select") return Promise.resolve({ data: apply(), error: null });
      if (op === "insert" || op === "update") {
        // Like PostgREST with .select(): hand back the written rows.
        let written;
        if (op === "insert") {
          written = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ id: crypto.randomUUID(), feed_token: "f".repeat(32), created_at: new Date().toISOString(), ...row }));
          db[table] = rows().concat(written);
        } else {
          written = apply().map((row) => Object.assign(row, payload));
        }
        calls.push([table, op, payload]);
        persist();
        return Promise.resolve({ data: written, error: null });
      }
      if (op === "upsert") {
        const key = table === "presence" || table === "sharing_settings" ? "user_id" : "id";
        db[table] = rows().filter((row) => row[key] !== payload[key]).concat([payload]);
        persist();
        return Promise.resolve({ data: null, error: null });
      }
      if (op === "delete") {
        const gone = apply();
        calls.push([table, "delete", gone.length]);
        db[table] = rows().filter((row) => !gone.includes(row));
        persist();
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
    return api;
  }

  const friendsWith = (a, b) => db.friend_requests.some((row) => row.status === "accepted" && ((row.requester_id === a && row.recipient_id === b) || (row.requester_id === b && row.recipient_id === a)));
  const live = (row, at) => !row.expires_at || new Date(row.expires_at).getTime() > at;

  window.supabase = {
    createClient() {
      return {
        auth: {
          // Coming back from "Connect Google Calendar" (?calendar) carries a Google token, like the real callback.
          async getSession() { return { data: { session: { user, access_token: "fake-token", ...(location.search.includes("calendar") ? { provider_token: "fake-google-token", provider_refresh_token: "fake-google-refresh" } : {}) } } }; },
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithOAuth() { return { error: null }; },
          async signOut() { return { error: null }; },
        },
        from: query,
        // The two share functions follow supabase/schema.sql: publish_share checks the
        // friendship and keeps a fallback for temporary shares; shared_calendars picks
        // events or fallback by the clock and shows only what was shared with you.
        async rpc(name, args) {
          calls.push(["rpc", name, args]);
          if (name === "publish_share") {
            if (args.p_viewer === user.id) return { data: null, error: { message: "cannot share with yourself" } };
            if (!friendsWith(user.id, args.p_viewer)) return { data: null, error: { message: "only friends can be shared with" } };
            db.calendar_shares = db.calendar_shares
              .filter((row) => !(row.owner_id === user.id && row.viewer_id === args.p_viewer))
              .concat([{ owner_id: user.id, viewer_id: args.p_viewer, events: args.p_events || [], fallback_events: args.p_expires ? args.p_fallback : null, expires_at: args.p_expires || null, updated_at: new Date().toISOString() }]);
            persist();
            return { data: null, error: null };
          }
          if (name === "shared_calendars") {
            const at = Date.now();
            const rows = db.calendar_shares
              .filter((row) => row.viewer_id === user.id && (!args.p_owner || row.owner_id === args.p_owner))
              .filter((row) => live(row, at) || row.fallback_events)
              .map((row) => ({
                owner_id: row.owner_id,
                events: live(row, at) ? row.events : row.fallback_events,
                updated_at: row.updated_at,
                shared_until: row.expires_at && live(row, at) ? row.expires_at : null,
              }));
            return { data: rows, error: null };
          }
          return { data: null, error: null };
        },
        __db: db,
      };
    },
  };
})();
