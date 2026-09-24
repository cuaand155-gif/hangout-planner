// "Free now": a status you switch on for a while so friends can see you're
// up for something. Row level security (supabase/schema.sql) lets only
// accepted friends read it, and caps it at a day.

export const FREE_LENGTHS = [
  { key: "1h", label: "For an hour" },
  { key: "2h", label: "For 2 hours" },
  { key: "today", label: "For the rest of today" },
];

/** When a "free now" started at `now` ends. */
export function freeUntil(kind, now = new Date()) {
  if (kind === "today") {
    const end = new Date(now);
    end.setHours(23, 59, 0, 0);
    // Late at night "the rest of today" is barely anything; give it an hour.
    return end - now < 3600 * 1000 ? new Date(now.getTime() + 3600 * 1000) : end;
  }
  return new Date(now.getTime() + (kind === "2h" ? 2 : 1) * 3600 * 1000);
}

export function createPresenceStore(client) {
  const table = "presence";
  return {
    async set(userId, until, note = "") {
      return client
        .from(table)
        .upsert({ user_id: userId, until: new Date(until).toISOString(), note: String(note || "").trim().slice(0, 80), updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    },
    async clear(userId) {
      return client.from(table).delete().eq("user_id", userId);
    },
    /** Every status you can see that hasn't ended: yours and your friends'. */
    async listActive(now = new Date()) {
      const { data, error } = await client.from(table).select("user_id, until, note").gt("until", now.toISOString());
      return { data: Array.isArray(data) ? data : [], error };
    },
  };
}
