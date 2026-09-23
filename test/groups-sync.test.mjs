import test from "node:test";
import assert from "node:assert/strict";
import { GROUP_LIMIT, forgetGroup, mergeGroups, newGroupSlug, rememberGroup } from "../lib/groups.js";
import { dueForSync, sameBusy } from "../lib/sync.js";

test("a new group slug keeps the name readable and adds an unguessable suffix", () => {
  let n = 0;
  const seq = () => [0.1, 0.5, 0.9, 0.3, 0.7][n++ % 5];
  const slug = newGroupSlug("Book Club!", seq);
  assert.match(slug, /^book-club-[a-z2-9]{5}$/);
  assert.doesNotMatch(slug.slice(-5), /[01lo]/, "no look-alike characters");
  assert.match(newGroupSlug("", () => 0.2), /^group-[a-z2-9]{5}$/);
  assert.ok(newGroupSlug("x".repeat(200), Math.random).length <= 48, "fits the slug limit");
  assert.notEqual(newGroupSlug("crew"), newGroupSlug("crew"), "two groups with one name get different links");
});

test("remembering a group keeps one entry, newest first", () => {
  let list = rememberGroup([], { slug: "a", name: "A", at: "2026-09-20T00:00:00Z" });
  list = rememberGroup(list, { slug: "b", name: "B", at: "2026-09-21T00:00:00Z" });
  list = rememberGroup(list, { slug: "a", name: "A renamed", at: "2026-09-22T00:00:00Z" });
  assert.deepEqual(list.map((entry) => [entry.slug, entry.name]), [["a", "A renamed"], ["b", "B"]]);
  assert.deepEqual(rememberGroup(null, { slug: "" }), [], "junk in, empty out");
});

test("the local list is capped", () => {
  let list = [];
  for (let index = 0; index < GROUP_LIMIT + 5; index += 1) {
    list = rememberGroup(list, { slug: `g${index}`, name: `G${index}`, at: new Date(2026, 0, 1, 0, index).toISOString() });
  }
  assert.equal(list.length, GROUP_LIMIT);
  assert.equal(list[0].slug, `g${GROUP_LIMIT + 4}`, "the most recent survive");
});

test("forgetting removes only that group", () => {
  const list = [{ slug: "a" }, { slug: "b" }];
  assert.deepEqual(forgetGroup(list, "a").map((entry) => entry.slug), ["b"]);
});

test("merging local and account groups never lists a group twice", () => {
  const local = [
    { slug: "crew", name: "Crew (old name)", at: "2026-09-20T00:00:00Z" },
    { slug: "only-here", name: "Only here", at: "2026-09-19T00:00:00Z" },
  ];
  const remote = [
    { slug: "crew", name: "Crew", at: "2026-09-22T00:00:00Z" },
    { slug: "other-device", name: "Joined on my phone", at: "2026-09-21T00:00:00Z" },
  ];
  const merged = mergeGroups(local, remote);
  assert.deepEqual(merged.map((entry) => entry.slug), ["crew", "other-device", "only-here"]);
  assert.equal(merged[0].name, "Crew", "the fresher name wins");
  assert.equal(merged[0].onAccount, true);
  assert.equal(merged[2].onAccount, undefined, "a group only this browser knows is not claimed for the account");
});

test("a stale remote entry does not overwrite a fresher local name", () => {
  const merged = mergeGroups([{ slug: "a", name: "New", at: "2026-09-22T00:00:00Z" }], [{ slug: "a", name: "Old", at: "2026-09-01T00:00:00Z" }]);
  assert.equal(merged[0].name, "New");
  assert.equal(merged[0].onAccount, true);
});

test("a calendar is due when never synced or older than the interval", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  assert.equal(dueForSync(undefined, now), true);
  assert.equal(dueForSync("garbage", now), true);
  assert.equal(dueForSync("2026-09-23T11:45:00Z", now), false);
  assert.equal(dueForSync("2026-09-23T11:30:00Z", now), true);
  assert.equal(dueForSync("2026-09-23T11:59:00Z", now, 60 * 1000), true);
});

test("sameBusy ignores order but notices any real change", () => {
  const a = { start: "2026-09-21T10:00:00Z", end: "2026-09-21T11:00:00Z", source: "ics" };
  const b = { start: "2026-09-22T10:00:00Z", end: "2026-09-22T11:00:00Z", source: "ics" };
  assert.equal(sameBusy([a, b], [b, a]), true);
  assert.equal(sameBusy([a], [a, b]), false);
  assert.equal(sameBusy([a], [{ ...a, end: "2026-09-21T12:00:00Z" }]), false);
  assert.equal(sameBusy([a], [{ ...a, title: "Dentist" }]), false, "a title appearing is a change");
  assert.equal(sameBusy([], []), true);
});
