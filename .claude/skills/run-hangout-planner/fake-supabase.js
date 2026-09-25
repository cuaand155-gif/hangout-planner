// Stand-in for supabase-js in the browser tests: an in-memory database.
(function () {
  const ME = "11111111-1111-1111-1111-111111111111";
  const SAM = "22222222-2222-2222-2222-222222222222";
  const now = Date.now();
  const seed = window.__seed || {};
  const db = {
    friend_requests: [{ id: "fr1", requester_id: ME, recipient_id: SAM, recipient_email: "sam@example.com", status: "accepted" }],
    profiles: [{ id: SAM, display_name: "Sam Rivera", photo_url: "" }, { id: ME, display_name: "Alexi", photo_url: "" }],
    sharing_settings: seed.sharing_settings || [],
    presence: [{ user_id: SAM, until: new Date(now + 2 * 3600e3).toISOString(), note: "up for coffee" }],
    calendar_shares: [],
    booking_pages: [],
    bookings: [],
    workspaces: [],
  };
  const calls = (window.__calls = []);
  const user = { id: ME, email: "alexi@example.com", user_metadata: { full_name: "Alexi" } };
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
        return Promise.resolve({ data: written, error: null });
      }
      if (op === "upsert") {
        const key = table === "presence" || table === "sharing_settings" ? "user_id" : "id";
        db[table] = rows().filter((row) => row[key] !== payload[key]).concat([payload]);
        return Promise.resolve({ data: null, error: null });
      }
      if (op === "delete") {
        const gone = apply();
        calls.push([table, "delete", gone.length]);
        db[table] = rows().filter((row) => !gone.includes(row));
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
    return api;
  }
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
        async rpc(name, args) {
          calls.push(["rpc", name, args]);
          if (name === "publish_share") {
            db.calendar_shares = db.calendar_shares.filter((row) => row.viewer_id !== args.p_viewer).concat([{ owner_id: ME, viewer_id: args.p_viewer, events: args.p_events, fallback: args.p_fallback, expires: args.p_expires }]);
            return { data: null, error: null };
          }
          if (name === "shared_calendars") {
            const samEvents = [
              { start: new Date(now - 30 * 60e3).toISOString(), end: new Date(now + 90 * 60e3).toISOString(), title: "Lunch with Jo" },
            ];
            const rows = [{ owner_id: SAM, events: samEvents, updated_at: new Date(now - 600e3).toISOString(), shared_until: new Date(now + 3 * 24 * 3600e3).toISOString() }];
            return { data: args.p_owner ? rows.filter((row) => row.owner_id === args.p_owner) : rows, error: null };
          }
          return { data: null, error: null };
        },
        __db: db,
      };
    },
  };
})();
