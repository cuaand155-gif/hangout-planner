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
} from "../lib/sharing.js";

const EVENTS = [
  { start: "2026-09-24T13:00:00Z", end: "2026-09-24T14:00:00Z", title: "Soccer" },
  { start: "2026-09-24T16:00:00Z", end: "2026-09-24T17:00:00Z", title: "Therapy" },
  { start: "2026-09-25T00:00:00Z", end: "2026-09-26T00:00:00Z", title: "Mom's birthday", allDay: true },
];

test("the default is the private choice", () => {
  assert.deepEqual(defaultSharing(), { friends: "busy", perFriend: {}, groups: "busy", picked: [] });
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

test("all shows every name and nothing beyond start, end, all-day and title", () => {
  const shared = eventsForLevel([{ ...EVENTS[0], location: "Field 3", notes: "bring cleats" }], "all", defaultSharing());
  assert.deepEqual(shared, [{ start: "2026-09-24T13:00:00.000Z", end: "2026-09-24T14:00:00.000Z", title: "Soccer" }]);
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

test("the share store writes one row per owner and viewer", async () => {
  const calls = [];
  const chain = (name) => {
    const api = {
      upsert: (row, options) => (calls.push([name, "upsert", row, options]), Promise.resolve({ error: null })),
      delete: () => (calls.push([name, "delete"]), api),
      select: () => api,
      eq: (column, value) => (calls.push([name, "eq", column, value]), api),
      maybeSingle: () => Promise.resolve({ data: { events: [] }, error: null }),
      then: (resolve) => resolve({ error: null }),
    };
    return api;
  };
  const store = createShareStore({ from: chain });
  await store.publish("owner", "viewer", [{ start: "a", end: "b" }]);
  assert.equal(calls[0][2].owner_id, "owner");
  assert.equal(calls[0][2].viewer_id, "viewer");
  assert.deepEqual(calls[0][3], { onConflict: "owner_id,viewer_id" });

  calls.length = 0;
  await store.revoke("owner", "viewer");
  assert.deepEqual(calls.map((call) => call.slice(1)), [["delete"], ["eq", "owner_id", "owner"], ["eq", "viewer_id", "viewer"]]);

  const { data } = await store.sharedWithMe("owner", "me");
  assert.deepEqual(data, { events: [] });
});
