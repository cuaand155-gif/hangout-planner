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

// Your whole set of choices must fit the account row (under 50 KB).
const MAX_PICKED = 150;
const MAX_HIDDEN = 200;
const MAX_GRANTS = 100;
const HASH = /^[a-f0-9]{64}$/;
const SALT = /^[a-z0-9]{16,64}$/;
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
  return { friends: "busy", perFriend: {}, groups: "busy", picked: [], hidden: [], grants: [], salt: "", updatedAt: null };
}

/** A random salt for private-event hashes, made once per person. */
export function newSalt(random = Math.random) {
  let salt = "";
  for (let index = 0; index < 24; index += 1) salt += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36) % 36];
  return salt;
}

function normalizeGrants(list, now) {
  if (!Array.isArray(list)) return [];
  const byFriend = new Map();
  for (const grant of list) {
    const until = new Date(grant?.until);
    if (typeof grant?.friendId !== "string" || !grant.friendId || !LEVELS.includes(grant.level) || grant.level === "nothing") continue;
    if (Number.isNaN(until.getTime()) || until <= now) continue;
    byFriend.set(grant.friendId, { friendId: grant.friendId, level: grant.level, until: until.toISOString() });
  }
  return [...byFriend.values()].slice(0, MAX_GRANTS);
}

/** Repairs whatever was stored, falling back to the most private choice. */
export function normalizeSharing(raw, now = new Date()) {
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
    hidden: [...new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter((hash) => typeof hash === "string" && HASH.test(hash)))].slice(0, MAX_HIDDEN),
    grants: normalizeGrants(raw.grants, now),
    salt: typeof raw.salt === "string" && SALT.test(raw.salt) ? raw.salt : "",
    updatedAt: raw.updatedAt && !Number.isNaN(new Date(raw.updatedAt).getTime()) ? new Date(raw.updatedAt).toISOString() : null,
  };
}

/**
 * Two copies of your choices (this device and your account): the one saved
 * most recently wins as a whole, so a hash list is never paired with the
 * wrong salt. A copy that was never saved loses to one that was.
 */
export function mergeSharing(local, remote) {
  const localAt = local?.updatedAt ? new Date(local.updatedAt).getTime() : 0;
  const remoteAt = remote?.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
  if (!remote) return { sharing: normalizeSharing(local), from: "local" };
  return remoteAt > localAt ? { sharing: normalizeSharing(remote), from: "remote" } : { sharing: normalizeSharing(local), from: "local" };
}

/* ---------------------------------------------------- limited-time shares */

/** The friend's temporary share, while it lasts. */
export function activeGrant(sharing, friendId, now = new Date()) {
  return (sharing.grants || []).find((grant) => grant.friendId === friendId && new Date(grant.until) > now) || null;
}

export const GRANT_LENGTHS = [
  { key: "today", label: "Until the end of today" },
  { key: "weekend", label: "Through this weekend" },
  { key: "day", label: "For 24 hours" },
  { key: "week", label: "For a week" },
];

/** When a temporary share started now should end, in local time. */
export function grantEnd(kind, now = new Date()) {
  const endOfDay = (date) => {
    const end = new Date(date);
    end.setHours(23, 59, 59, 0);
    return end;
  };
  if (kind === "today") return endOfDay(now);
  if (kind === "weekend") {
    const sunday = new Date(now);
    sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7));
    return endOfDay(sunday);
  }
  if (kind === "week") return new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  return new Date(now.getTime() + 24 * 3600 * 1000);
}

/** Starts (or replaces) a friend's temporary share; returns a new object. */
export function setGrant(sharing, friendId, level, until) {
  const grants = (sharing.grants || []).filter((grant) => grant.friendId !== friendId);
  return { ...sharing, grants: [...grants, { friendId, level, until: new Date(until).toISOString() }] };
}

export function clearGrant(sharing, friendId) {
  return { ...sharing, grants: (sharing.grants || []).filter((grant) => grant.friendId !== friendId) };
}

/* -------------------------------------------------------- private events */

/**
 * A private event's name is stored only as this hash, so the database never
 * holds it. The salt is yours, so the same name hashes differently for
 * someone else.
 */
export async function hideHash(salt, title) {
  const bytes = new TextEncoder().encode(`${salt}|${titleKey(title)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The title keys among `titles` that are private, found by hashing each one. */
export async function resolveHidden(sharing, titles) {
  const keys = new Set();
  if (!sharing.hidden?.length || !sharing.salt) return keys;
  const wanted = new Set(sharing.hidden);
  for (const key of new Set([...titles].map(titleKey).filter(Boolean))) {
    if (wanted.has(await hideHash(sharing.salt, key))) keys.add(key);
  }
  return keys;
}

export function isHidden(hiddenKeys, title) {
  const key = titleKey(title);
  return Boolean(key) && hiddenKeys.has(key);
}

/** Your events minus the private ones: what anyone else may learn about. */
export function withoutHidden(events, hiddenKeys) {
  if (!hiddenKeys?.size) return events || [];
  return (events || []).filter((event) => !isHidden(hiddenKeys, event.title));
}

/** Marks or unmarks a title as private; returns a new object (async: hashing). */
export async function toggleHidden(sharing, title) {
  const base = sharing.salt ? sharing : { ...sharing, salt: newSalt() };
  const hash = await hideHash(base.salt, title);
  const hidden = base.hidden.includes(hash) ? base.hidden.filter((entry) => entry !== hash) : [...base.hidden, hash].slice(0, MAX_HIDDEN);
  return { ...base, hidden };
}

/* ------------------------------------------------------------ free now */

/**
 * One friend at a glance: their own "free now" if they've set one, otherwise
 * what the calendar they share with you says about right now.
 */
export function friendStatus({ presence, events, now = new Date() } = {}) {
  if (presence && new Date(presence.until) > now) {
    return { kind: "free-now", until: new Date(presence.until), note: presence.note || "" };
  }
  if (!Array.isArray(events)) return null;
  const timed = events.filter((event) => !event.allDay).map((event) => ({ start: new Date(event.start), end: new Date(event.end) })).sort((a, b) => a.start - b.start);
  let busyUntil = null;
  for (const event of timed) {
    if (event.start <= (busyUntil || now) && event.end > (busyUntil || now)) busyUntil = event.end;
  }
  if (busyUntil) return { kind: "busy", until: busyUntil };
  const next = timed.find((event) => event.start > now);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 0);
  return { kind: "open", until: next && next.start <= endOfDay ? next.start : null };
}

/** The level one friend gets: a temporary share while it lasts, then their override, then the default. */
export function levelForFriend(sharing, friendId, now = new Date()) {
  return activeGrant(sharing, friendId, now)?.level || baseLevelForFriend(sharing, friendId);
}

/** The level ignoring any temporary share: what they fall back to. */
export function baseLevelForFriend(sharing, friendId) {
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
      ...(showsTitle(sharing, level, event.title)
        ? { title: String(event.title).slice(0, MAX_TITLE), ...(event.location ? { location: String(event.location).slice(0, MAX_TITLE) } : {}) }
        : {}),
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
      const location = title && typeof event.location === "string" ? event.location.trim().slice(0, MAX_TITLE) : "";
      return { start, end, allDay: event.allDay === true, ...(title ? { title } : {}), ...(location ? { location } : {}) };
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
    /**
     * Writes through publish_share(), which checks the friendship. With
     * `expires`, `events` shows until then and `fallback` afterwards (null:
     * nothing) — the database picks by its own clock, so a temporary share
     * ends on time even if this device is off.
     */
    async publish(viewerId, events, { fallback = null, expires = null } = {}) {
      return client.rpc("publish_share", {
        p_viewer: viewerId,
        p_events: events,
        p_fallback: expires ? fallback : null,
        p_expires: expires ? new Date(expires).toISOString() : null,
      });
    },
    async revoke(ownerId, viewerId) {
      return client.from(table).delete().eq("owner_id", ownerId).eq("viewer_id", viewerId);
    },
    /** What one friend currently shows you: { events, updated_at, shared_until } or null. */
    async sharedWithMe(ownerId) {
      const { data, error } = await client.rpc("shared_calendars", { p_owner: ownerId });
      return { data: Array.isArray(data) ? data[0] || null : null, error };
    },
    /** Every friend's current share with you, for the at-a-glance statuses. */
    async sharedWithMeAll() {
      const { data, error } = await client.rpc("shared_calendars", {});
      return { data: Array.isArray(data) ? data : [], error };
    },
  };
}

/** Your sharing choices, kept in your own row so they follow you between devices. */
export function createSharingSettingsStore(client) {
  const table = "sharing_settings";
  return {
    async load(userId) {
      const { data, error } = await client.from(table).select("settings, updated_at").eq("user_id", userId).maybeSingle();
      return { data, error };
    },
    async save(userId, settings) {
      return client.from(table).upsert({ user_id: userId, settings, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    },
  };
}
