// Who sees what on your calendar.
//
// Your full calendar, event names included, only ever lives in your own
// browser. What leaves it is decided here, once per audience:
//
//   nothing  they cannot open your calendar at all
//   busy     they see when you're busy, never what
//   some     they see the names of events you've picked; the rest read "Busy"
//   all      they see every event name
//
// Friends get a level each (a default plus per-friend overrides). Groups get
// one level for all of them, and a group must also allow event details before
// any name reaches it, because everyone holding a group's link can read it.

export const LEVELS = ["nothing", "busy", "some", "all"];
export const GROUP_LEVELS = ["busy", "some", "all"];

export const LEVEL_LABELS = {
  nothing: "Nothing",
  busy: "Busy / free only",
  some: "Only events I pick",
  all: "Everything",
};

const MAX_PICKED = 200;
const MAX_OVERRIDES = 200;
const MAX_EVENTS = 600;
const MAX_TITLE = 120;

/** Case- and spacing-insensitive key, so "Soccer" and " soccer " are one pick. */
export function titleKey(title) {
  return String(title || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, MAX_TITLE);
}

export function defaultSharing() {
  return { friends: "busy", perFriend: {}, groups: "busy", picked: [] };
}

/** Repairs whatever was stored, falling back to the most private choice. */
export function normalizeSharing(raw) {
  const base = defaultSharing();
  if (!raw || typeof raw !== "object") return base;
  const perFriend = {};
  for (const [id, level] of Object.entries(raw.perFriend || {}).slice(0, MAX_OVERRIDES)) {
    if (typeof id === "string" && id && LEVELS.includes(level)) perFriend[id] = level;
  }
  const picked = [...new Set((Array.isArray(raw.picked) ? raw.picked : []).map(titleKey).filter(Boolean))].slice(0, MAX_PICKED);
  return {
    friends: LEVELS.includes(raw.friends) ? raw.friends : base.friends,
    perFriend,
    groups: GROUP_LEVELS.includes(raw.groups) ? raw.groups : base.groups,
    picked,
  };
}

/** The level one friend gets: their override, or the default for friends. */
export function levelForFriend(sharing, friendId) {
  return (friendId && sharing.perFriend[friendId]) || sharing.friends;
}

export function isPicked(sharing, title) {
  const key = titleKey(title);
  return Boolean(key) && sharing.picked.includes(key);
}

/** Adds or removes an event name from the picked list; returns a new object. */
export function togglePicked(sharing, title) {
  const key = titleKey(title);
  if (!key) return sharing;
  const picked = sharing.picked.includes(key) ? sharing.picked.filter((entry) => entry !== key) : [...sharing.picked, key].slice(0, MAX_PICKED);
  return { ...sharing, picked };
}

/** Whether an event's name may be shown at this level. */
export function showsTitle(sharing, level, title) {
  if (!title) return false;
  if (level === "all") return true;
  if (level === "some") return isPicked(sharing, title);
  return false;
}

/**
 * The events one viewer is allowed to see, or null when they see nothing.
 * Titles are dropped unless the level allows them; nothing else about an
 * event (location, notes, which calendar) is ever included.
 */
export function eventsForLevel(events, level, sharing) {
  if (!LEVELS.includes(level) || level === "nothing") return null;
  return (events || [])
    .filter((event) => event && event.start && event.end)
    .slice(0, MAX_EVENTS)
    .map((event) => ({
      start: new Date(event.start).toISOString(),
      end: new Date(event.end).toISOString(),
      ...(event.allDay ? { allDay: true } : {}),
      ...(showsTitle(sharing, level, event.title) ? { title: String(event.title).slice(0, MAX_TITLE) } : {}),
    }));
}

/** Validates events read back from somebody else's share before showing them. */
export function cleanSharedEvents(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_EVENTS)
    .map((event) => {
      const start = new Date(event?.start);
      const end = new Date(event?.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
      const title = typeof event.title === "string" ? event.title.trim().slice(0, MAX_TITLE) : "";
      return { start, end, allDay: event.allDay === true, ...(title ? { title } : {}) };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

/**
 * Merges events that are the same appointment seen twice (a multi-day event
 * listed on each day, or one event in two synced calendars).
 */
export function dedupeEvents(events) {
  const seen = new Map();
  for (const event of events || []) {
    const key = `${new Date(event.start).getTime()}|${new Date(event.end).getTime()}|${titleKey(event.title)}`;
    if (!seen.has(key)) seen.set(key, event);
  }
  return [...seen.values()].sort((a, b) => new Date(a.start) - new Date(b.start));
}

/** Events that touch the given day, for an agenda column. */
export function eventsOnDay(events, date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return (events || []).filter((event) => new Date(event.start) < dayEnd && new Date(event.end) > dayStart);
}

/**
 * The Supabase calls for calendar shares, behind one small interface so the
 * UI can be driven by a stub in tests. One row per (owner, viewer); row level
 * security lets only the owner write it and only those two read it.
 */
export function createShareStore(client) {
  const table = "calendar_shares";
  return {
    async publish(ownerId, viewerId, events) {
      return client
        .from(table)
        .upsert({ owner_id: ownerId, viewer_id: viewerId, events, updated_at: new Date().toISOString() }, { onConflict: "owner_id,viewer_id" });
    },
    async revoke(ownerId, viewerId) {
      return client.from(table).delete().eq("owner_id", ownerId).eq("viewer_id", viewerId);
    },
    async sharedWithMe(ownerId, viewerId) {
      const { data, error } = await client
        .from(table)
        .select("events, updated_at")
        .eq("owner_id", ownerId)
        .eq("viewer_id", viewerId)
        .maybeSingle();
      return { data, error };
    },
  };
}
