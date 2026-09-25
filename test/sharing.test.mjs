import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanSharedEvents,
  createShareStore,
  dedupeEvents,
  defaultSharing,
  eventsForLevel,
  eventsOnDay,
  isPicked,
  levelForFriend,
  normalizeSharing,
  showsTitle,
  titleKey,
  togglePicked,
  activeGrant,
  baseLevelForFriend,
  clearGrant,
  friendStatus,
  grantEnd,
  hideHash,
  isHidden,
  mergeSharing,
  resolveHidden,
  setGrant,
  toggleHidden,
  withoutHidden,
} from "../lib/sharing.js";
import { createPresenceStore, freeUntil } from "../lib/presence.js";

const EVENTS = [
  { start: "2026-09-24T13:00:00Z", end: "2026-09-24T14:00:00Z", title: "Soccer" },
  { start: "2026-09-24T16:00:00Z", end: "2026-09-24T17:00:00Z", title: "Therapy" },
  { start: "2026-09-25T00:00:00Z", end: "2026-09-26T00:00:00Z", title: "Mom's birthday", allDay: true },
];

test("the default is the private choice", () => {
  assert.deepEqual(defaultSharing(), { friends: "busy", perFriend: {}, groups: "busy", picked: [], hidden: [], grants: [], salt: "", updatedAt: null });
  assert.deepEqual(normalizeSharing(null), defaultSharing());
  assert.deepEqual(normalizeSharing("garbage"), defaultSharing());
});

test("normalizeSharing drops unknown levels and tidies picks", () => {
  const sharing = normalizeSharing({
    friends: "everything-please",
    groups: "nothing",
    perFriend: { a: "all", b: "bogus", "": "busy" },
    picked: ["  Soccer ", "soccer", "", 5],
  });
  assert.equal(sharing.friends, "busy", "unknown default falls back to busy");
  assert.equal(sharing.groups, "busy", "groups cannot be set to nothing — they need busy times to plan");
  assert.deepEqual(sharing.perFriend, { a: "all" });
  assert.deepEqual(sharing.picked, ["soccer", "5"]);
});

test("titleKey ignores case and spacing", () => {
  assert.equal(titleKey("  Book   Club "), "book club");
  assert.equal(titleKey(null), "");
});

test("a per-friend choice overrides the default", () => {
  const sharing = normalizeSharing({ friends: "some", perFriend: { sam: "nothing", jo: "all" } });
  assert.equal(levelForFriend(sharing, "sam"), "nothing");
  assert.equal(levelForFriend(sharing, "jo"), "all");
  assert.equal(levelForFriend(sharing, "someone-else"), "some");
  assert.equal(levelForFriend(sharing, null), "some");
});

test("togglePicked adds then removes, matching regardless of case", () => {
  let sharing = defaultSharing();
  sharing = togglePicked(sharing, "Soccer");
  assert.ok(isPicked(sharing, "SOCCER"));
  sharing = togglePicked(sharing, " soccer");
  assert.equal(isPicked(sharing, "Soccer"), false);
  assert.equal(togglePicked(sharing, "   "), sharing, "an untitled event cannot be picked");
});

test("showsTitle follows the level", () => {
  const sharing = normalizeSharing({ picked: ["soccer"] });
  assert.equal(showsTitle(sharing, "all", "Therapy"), true);
  assert.equal(showsTitle(sharing, "some", "Soccer"), true);
  assert.equal(showsTitle(sharing, "some", "Therapy"), false);
  assert.equal(showsTitle(sharing, "busy", "Soccer"), false);
  assert.equal(showsTitle(sharing, "all", ""), false);
});

test("nothing means no calendar at all", () => {
  assert.equal(eventsForLevel(EVENTS, "nothing", defaultSharing()), null);
  assert.equal(eventsForLevel(EVENTS, "made-up", defaultSharing()), null);
});

test("busy keeps the times and drops every name", () => {
  const shared = eventsForLevel(EVENTS, "busy", normalizeSharing({ picked: ["soccer"] }));
  assert.equal(shared.length, 3);
  assert.ok(shared.every((event) => !("title" in event)));
  assert.equal(shared[2].allDay, true);
});

test("some shows only the picked names", () => {
  const shared = eventsForLevel(EVENTS, "some", normalizeSharing({ picked: ["soccer"] }));
  assert.deepEqual(
    shared.map((event) => event.title || "Busy"),
    ["Soccer", "Busy", "Busy"]
  );
});

test("all shows every name and its place, and nothing beyond (no notes)", () => {
  const shared = eventsForLevel([{ ...EVENTS[0], location: "Field 3", notes: "bring cleats" }], "all", defaultSharing());
  assert.deepEqual(shared, [{ start: "2026-09-24T13:00:00.000Z", end: "2026-09-24T14:00:00.000Z", title: "Soccer", location: "Field 3" }]);
});

test("a place only travels with a name: busy-only drops both", () => {
  const busy = eventsForLevel([{ ...EVENTS[0], location: "Field 3" }], "busy", defaultSharing());
  assert.deepEqual(busy, [{ start: "2026-09-24T13:00:00.000Z", end: "2026-09-24T14:00:00.000Z" }]);
  const cleaned = cleanSharedEvents([{ start: "2026-09-24T13:00:00Z", end: "2026-09-24T14:00:00Z", location: "Home" }]);
  assert.equal(cleaned[0].location, undefined, "a location without a name is dropped");
});

test("cleanSharedEvents rejects malformed entries from a friend's share", () => {
  const cleaned = cleanSharedEvents([
    { start: "2026-09-24T13:00:00Z", end: "2026-09-24T14:00:00Z", title: "  Lunch  " },
    { start: "nope", end: "2026-09-24T14:00:00Z" },
    { start: "2026-09-24T15:00:00Z", end: "2026-09-24T14:00:00Z" },
    { start: "2026-09-24T09:00:00Z", end: "2026-09-24T10:00:00Z", title: { evil: true } },
    null,
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].title, undefined, "sorted by start, and a non-string title is dropped");
  assert.equal(cleaned[1].title, "Lunch");
  assert.deepEqual(cleanSharedEvents("not a list"), []);
});

test("dedupeEvents merges the same appointment from two calendars", () => {
  const merged = dedupeEvents([EVENTS[0], { ...EVENTS[0], title: "soccer " }, EVENTS[1]]);
  assert.equal(merged.length, 2);
});

test("eventsOnDay includes events that cross midnight", () => {
  const late = { start: new Date(2026, 8, 24, 23, 0), end: new Date(2026, 8, 25, 1, 0), title: "Late show" };
  assert.equal(eventsOnDay([late], new Date(2026, 8, 24)).length, 1);
  assert.equal(eventsOnDay([late], new Date(2026, 8, 25)).length, 1);
  assert.equal(eventsOnDay([late], new Date(2026, 8, 26)).length, 0);
});

test("the share store goes through the database functions, so friendship and expiry are enforced there", async () => {
  const calls = [];
  const chain = (name) => {
    const api = {
      delete: () => (calls.push([name, "delete"]), api),
      eq: (column, value) => (calls.push([name, "eq", column, value]), api),
      then: (resolve) => resolve({ error: null }),
    };
    return api;
  };
  const rpc = (name, args) => (calls.push(["rpc", name, args]), Promise.resolve({ data: [{ owner_id: "owner", events: [], shared_until: null }], error: null }));
  const store = createShareStore({ from: chain, rpc });

  await store.publish("viewer", [{ start: "a", end: "b" }]);
  assert.deepEqual(calls[0], ["rpc", "publish_share", { p_viewer: "viewer", p_events: [{ start: "a", end: "b" }], p_fallback: null, p_expires: null }]);

  calls.length = 0;
  await store.publish("viewer", [], { fallback: [{ start: "c", end: "d" }], expires: "2026-09-27T23:59:59Z" });
  assert.deepEqual(calls[0][2], { p_viewer: "viewer", p_events: [], p_fallback: [{ start: "c", end: "d" }], p_expires: "2026-09-27T23:59:59.000Z" });

  calls.length = 0;
  await store.publish("viewer", [], { fallback: [{ start: "c", end: "d" }] });
  assert.equal(calls[0][2].p_fallback, null, "a fallback only means something with an end time");

  calls.length = 0;
  await store.revoke("owner", "viewer");
  assert.deepEqual(calls.map((call) => call.slice(1)), [["delete"], ["eq", "owner_id", "owner"], ["eq", "viewer_id", "viewer"]]);

  calls.length = 0;
  const { data } = await store.sharedWithMe("owner");
  assert.deepEqual(calls[0], ["rpc", "shared_calendars", { p_owner: "owner" }]);
  assert.equal(data.owner_id, "owner");
  const all = await store.sharedWithMeAll();
  assert.equal(all.data.length, 1);
});

/* ------------------------------------------------------------ sharing v2 */

test("new fields are repaired: bad hashes, salts and expired or invalid time limits are dropped", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const good = "a".repeat(64);
  const repaired = normalizeSharing({
    hidden: [good, good, "nope", "B".repeat(64)],
    salt: "short",
    grants: [
      { friendId: "sam", level: "all", until: "2026-09-27T23:59:59Z" },
      { friendId: "old", level: "all", until: "2026-09-20T00:00:00Z" },
      { friendId: "odd", level: "nothing", until: "2026-09-27T00:00:00Z" },
      { friendId: "", level: "all", until: "2026-09-27T00:00:00Z" },
    ],
    updatedAt: "2026-09-24T10:00:00Z",
  }, now);
  assert.deepEqual(repaired.hidden, [good]);
  assert.equal(repaired.salt, "");
  assert.deepEqual(repaired.grants.map((grant) => grant.friendId), ["sam"]);
  assert.equal(repaired.updatedAt, "2026-09-24T10:00:00.000Z");
});

test("a time-limited share wins while it lasts, then the friend falls back", () => {
  const sharing = setGrant(normalizeSharing({ friends: "busy", perFriend: { sam: "some" } }), "sam", "all", "2026-09-27T23:59:59Z");
  assert.equal(levelForFriend(sharing, "sam", new Date("2026-09-26T12:00:00Z")), "all");
  assert.equal(levelForFriend(sharing, "sam", new Date("2026-09-28T00:00:00Z")), "some");
  assert.equal(baseLevelForFriend(sharing, "sam"), "some");
  assert.equal(levelForFriend(sharing, "jo", new Date("2026-09-26T12:00:00Z")), "busy", "others are untouched");
  assert.equal(activeGrant(clearGrant(sharing, "sam"), "sam", new Date("2026-09-26T12:00:00Z")), null);
  assert.equal(setGrant(sharing, "sam", "busy", "2026-09-25T00:00:00Z").grants.length, 1, "one limit per friend");
});

test("'this weekend' ends Sunday night, including when it's already Sunday", () => {
  const thursday = new Date(2026, 8, 24, 10, 0);
  const sunday = new Date(2026, 8, 27, 20, 0);
  for (const start of [thursday, sunday]) {
    const end = grantEnd("weekend", start);
    assert.equal(end.getDay(), 0);
    assert.equal(end.getDate(), 27);
    assert.equal(end.getHours(), 23);
  }
  assert.equal(grantEnd("today", thursday).getDate(), 24);
  assert.equal(grantEnd("week", thursday) - thursday, 7 * 24 * 3600 * 1000);
});

test("the most recently saved copy of your choices wins, whole", () => {
  const local = normalizeSharing({ friends: "all", salt: "localsalt0000000", updatedAt: "2026-09-24T10:00:00Z" });
  const remote = normalizeSharing({ friends: "some", salt: "remotesalt000000", updatedAt: "2026-09-24T11:00:00Z" });
  assert.equal(mergeSharing(local, remote).from, "remote");
  assert.equal(mergeSharing(local, remote).sharing.salt, "remotesalt000000");
  assert.equal(mergeSharing({ ...local, updatedAt: "2026-09-24T12:00:00Z" }, remote).from, "local");
  assert.equal(mergeSharing(normalizeSharing({}), remote).from, "remote", "a fresh device takes your account's copy");
  assert.equal(mergeSharing(local, null).from, "local");
});

test("private events are stored only as hashes, match however they're typed, and vanish for everyone", async () => {
  let sharing = await toggleHidden(normalizeSharing({}), "Therapy");
  assert.match(sharing.salt, /^[a-z0-9]{24}$/);
  assert.equal(sharing.hidden.length, 1);
  assert.ok(!JSON.stringify(sharing).toLowerCase().includes("therapy"), "the name itself is never stored");
  assert.equal(await hideHash(sharing.salt, " THERAPY "), sharing.hidden[0]);
  assert.notEqual(await hideHash("someoneelse00000", "Therapy"), sharing.hidden[0], "salted per person");

  const events = [
    { start: "2026-09-24T14:00:00Z", end: "2026-09-24T15:00:00Z", title: "therapy" },
    { start: "2026-09-24T18:00:00Z", end: "2026-09-24T20:00:00Z", title: "Soccer" },
  ];
  const keys = await resolveHidden(sharing, events.map((event) => event.title));
  assert.deepEqual([...keys], ["therapy"]);
  assert.ok(isHidden(keys, "Therapy"));
  assert.deepEqual(withoutHidden(events, keys).map((event) => event.title), ["Soccer"]);

  sharing = await toggleHidden(sharing, "therapy");
  assert.equal(sharing.hidden.length, 0, "toggling again makes it visible");
});

test("a friend at a glance: their own 'free now' first, else what their calendar says", () => {
  const now = new Date(2026, 8, 24, 13, 0);
  const at = (hours, minutes = 0) => new Date(2026, 8, 24, hours, minutes).toISOString();
  assert.deepEqual(friendStatus({ presence: { until: at(15), note: "coffee?" }, events: [], now }), { kind: "free-now", until: new Date(at(15)), note: "coffee?" });
  assert.equal(friendStatus({ presence: { until: at(12) }, events: null, now }), null, "an ended status and no calendar says nothing");
  const busy = friendStatus({ events: [{ start: at(12), end: at(14) }, { start: at(14), end: at(15, 30) }], now });
  assert.deepEqual(busy, { kind: "busy", until: new Date(at(15, 30)) }, "back-to-back events join up");
  assert.deepEqual(friendStatus({ events: [{ start: at(16), end: at(17) }], now }), { kind: "open", until: new Date(at(16)) });
  assert.deepEqual(friendStatus({ events: [{ start: at(9), end: at(10) }], now }), { kind: "open", until: null }, "nothing else today");
  assert.deepEqual(friendStatus({ events: [{ start: at(0), end: new Date(2026, 8, 25).toISOString(), allDay: true }], now }), { kind: "open", until: null }, "all-day events don't count as busy");
});

test("presence: lengths and the store's calls", async () => {
  const now = new Date(2026, 8, 24, 13, 0);
  assert.equal(freeUntil("1h", now) - now, 3600 * 1000);
  assert.equal(freeUntil("2h", now) - now, 2 * 3600 * 1000);
  assert.equal(freeUntil("today", now).getHours(), 23);
  const late = new Date(2026, 8, 24, 23, 30);
  assert.equal(freeUntil("today", late) - late, 3600 * 1000, "late at night it's at least an hour");

  const calls = [];
  const api = {
    upsert: (row, options) => (calls.push(["upsert", row, options]), Promise.resolve({ error: null })),
    delete: () => (calls.push(["delete"]), api),
    eq: (column, value) => (calls.push(["eq", column, value]), api),
    select: () => api,
    gt: (column, value) => (calls.push(["gt", column, value]), Promise.resolve({ data: [{ user_id: "sam" }], error: null })),
    then: (resolve) => resolve({ error: null }),
  };
  const store = createPresenceStore({ from: () => api });
  await store.set("me", "2026-09-24T15:00:00Z", "  coffee?  ");
  assert.equal(calls[0][1].note, "coffee?");
  assert.deepEqual(calls[0][2], { onConflict: "user_id" });
  const { data } = await store.listActive(now);
  assert.equal(data[0].user_id, "sam");
  assert.equal(calls.at(-1)[1], "until");
});
