import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  buildSlots,
  buildWeek,
  classifySlot,
  createDemoState,
  findOpenWindows,
  formatWeekLabel,
  hasVoted,
  initialsFor,
  isoDate,
  materializeWeek,
  normalizeWorkspaceState,
  parseIsoDate,
  rankIdeas,
  replaceBusyRange,
  slugify,
  startOfWeek,
  voteCount,
  widenCoverage,
} from "../lib/planner.js";

const local = (year, month, day, hour = 0) => new Date(year, month - 1, day, hour, 0, 0, 0);

/** A member whose only busy time is a dated block on the given day. */
const datedMember = (id, day, startHour, endHour) => ({
  id,
  name: id,
  coverage: { from: isoDate(day), to: isoDate(day) },
  busy: [{ start: local(day.getFullYear(), day.getMonth() + 1, day.getDate(), startHour).toISOString(), end: local(day.getFullYear(), day.getMonth() + 1, day.getDate(), endHour).toISOString(), source: "manual" }],
});

test("startOfWeek is Monday based by default and Sunday based on request", () => {
  const sunday = local(2026, 9, 20);
  assert.equal(isoDate(startOfWeek(sunday)), "2026-09-14");
  assert.equal(isoDate(startOfWeek(sunday, 0)), "2026-09-20");
  assert.equal(isoDate(startOfWeek(local(2026, 9, 14))), "2026-09-14");
});

test("buildWeek labels seven days and marks today", () => {
  const week = buildWeek(local(2026, 9, 21), { today: local(2026, 9, 23) });
  assert.equal(week.length, 7);
  assert.deepEqual(week.map((day) => day.label), ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
  assert.deepEqual(week.filter((day) => day.isToday).map((day) => day.iso), ["2026-09-23"]);
  assert.deepEqual(week.filter((day) => day.isWeekend).map((day) => day.label), ["SAT", "SUN"]);
});

test("formatWeekLabel collapses a shared month and spans a boundary", () => {
  assert.equal(formatWeekLabel(local(2026, 9, 21)), "Sep 21 – 27, 2026");
  assert.equal(formatWeekLabel(local(2026, 9, 28)), "Sep 28 – Oct 4, 2026");
});

test("parseIsoDate reads a calendar day in local time, not UTC", () => {
  const parsed = parseIsoDate("2026-09-21");
  assert.equal(parsed.getDate(), 21);
  assert.equal(parsed.getHours(), 0);
  assert.equal(parseIsoDate("nope"), null);
});

test("initialsFor and slugify handle messy input", () => {
  assert.equal(initialsFor("Alex Morgan"), "AM");
  assert.equal(initialsFor("  jamie   rose  miller "), "JM");
  assert.equal(initialsFor("cher"), "CH");
  assert.equal(initialsFor(""), "??");
  assert.equal(slugify("Weekend Crew!! "), "weekend-crew");
  assert.equal(slugify(""), "weekend-crew");
  assert.equal(slugify("---"), "weekend-crew");
});

test("classifySlot separates free, busy and unshared members", () => {
  const day = local(2026, 9, 21);
  const members = [
    datedMember("busy-one", day, 10, 12),
    datedMember("free-one", day, 15, 16),
    { id: "silent", name: "silent" },
    { id: "private", name: "private", sharesSchedule: false, weekly: [{ weekday: 1, start: "09:00", end: "10:00" }] },
  ];

  const at10 = classifySlot(members, day, 10);
  assert.equal(at10.state, "partial");
  assert.deepEqual(at10.busy.map((entry) => entry.member.id), ["busy-one"]);
  assert.deepEqual(at10.free.map((member) => member.id), ["free-one"]);
  assert.deepEqual(at10.unknown.map((member) => member.id), ["silent", "private"]);

  const at13 = classifySlot(members, day, 13);
  assert.equal(at13.state, "overlap");
  assert.equal(at13.shared, 2);

  const at15 = classifySlot(members, day, 15);
  assert.equal(at15.state, "partial");
});

test("classifySlot is busy when nobody shared anything", () => {
  const day = local(2026, 9, 21);
  const cell = classifySlot([{ id: "a", name: "a" }], day, 10);
  assert.equal(cell.state, "busy");
  assert.equal(cell.shared, 0);
});

test("a weekly pattern applies to every matching weekday", () => {
  const member = { id: "pattern", name: "pattern", weekly: [{ weekday: 1, start: "09:00", end: "11:00" }] };
  assert.equal(classifySlot([member], local(2026, 9, 21), 10).state, "busy");
  assert.equal(classifySlot([member], local(2026, 9, 28), 10).state, "busy");
  assert.equal(classifySlot([member], local(2026, 9, 22), 10).state, "overlap");
});

test("a dated week overrides the weekly pattern for that week only", () => {
  const monday = local(2026, 9, 21);
  const member = {
    id: "mixed",
    name: "mixed",
    weekly: [{ weekday: 1, start: "09:00", end: "11:00" }],
    coverage: { from: "2026-09-21", to: "2026-09-27" },
    busy: [{ start: local(2026, 9, 21, 14).toISOString(), end: local(2026, 9, 21, 15).toISOString(), source: "manual" }],
  };
  assert.equal(classifySlot([member], monday, 10).state, "overlap", "covered week ignores the pattern");
  assert.equal(classifySlot([member], monday, 14).state, "busy");
  assert.equal(classifySlot([member], local(2026, 9, 28), 10).state, "busy", "later weeks fall back to the pattern");
});

test("findOpenWindows returns runs at or over the minimum, longest first", () => {
  const week = buildWeek(local(2026, 9, 21), { today: local(2026, 9, 21) });
  const slots = buildSlots({ dayStart: 8, dayEnd: 18 });
  const members = [
    // Busy all Monday except 13:00-14:00 (a one hour gap, too short).
    { id: "a", name: "a", coverage: { from: "2026-09-21", to: "2026-09-27" }, busy: [
      { start: local(2026, 9, 21, 8).toISOString(), end: local(2026, 9, 21, 13).toISOString(), source: "manual" },
      { start: local(2026, 9, 21, 14).toISOString(), end: local(2026, 9, 21, 18).toISOString(), source: "manual" },
      { start: local(2026, 9, 22, 8).toISOString(), end: local(2026, 9, 22, 14).toISOString(), source: "manual" },
      { start: local(2026, 9, 23, 8).toISOString(), end: local(2026, 9, 23, 18).toISOString(), source: "manual" },
      { start: local(2026, 9, 24, 8).toISOString(), end: local(2026, 9, 24, 18).toISOString(), source: "manual" },
      { start: local(2026, 9, 25, 8).toISOString(), end: local(2026, 9, 25, 18).toISOString(), source: "manual" },
      { start: local(2026, 9, 26, 8).toISOString(), end: local(2026, 9, 26, 18).toISOString(), source: "manual" },
      { start: local(2026, 9, 27, 8).toISOString(), end: local(2026, 9, 27, 18).toISOString(), source: "manual" },
    ] },
  ];

  const windows = findOpenWindows(members, week, slots, { minHours: 2 });
  assert.equal(windows.length, 1, "the one hour Monday gap is filtered out");
  assert.equal(windows[0].hours, 4, "Tuesday 14:00-18:00 is the only long run");
  assert.equal(windows[0].start.getHours(), 14);
  assert.equal(isoDate(windows[0].start), "2026-09-22");
  assert.deepEqual(windows[0].memberIds, ["a"]);

  const relaxed = findOpenWindows(members, week, slots, { minHours: 1 });
  assert.equal(relaxed.length, 2);
  assert.equal(relaxed[0].hours, 4, "longest window sorts first");
  assert.equal(relaxed[1].hours, 1);
});

test("windows do not run across midnight", () => {
  const week = buildWeek(local(2026, 9, 21), { today: local(2026, 9, 21) });
  const slots = buildSlots({ dayStart: 20, dayEnd: 24 });
  const windows = findOpenWindows([{ id: "a", name: "a", weekly: [] }], week, slots, { minHours: 2 });
  assert.equal(windows.length, 0, "a member with an empty pattern is free but shares nothing to overlap");

  const sharing = [{ id: "a", name: "a", weekly: [{ weekday: 0, start: "20:00", end: "21:00" }] }];
  const runs = findOpenWindows(sharing, week, slots, { minHours: 2 });
  assert.equal(runs.length, 7);
  for (const window of runs) {
    assert.equal(isoDate(window.start), isoDate(window.end > window.start ? new Date(window.end.getTime() - 1) : window.start));
  }
});

test("replaceBusyRange swaps one source in place and leaves others alone", () => {
  const existing = [
    { start: "2026-09-21T10:00:00.000Z", end: "2026-09-21T11:00:00.000Z", source: "ics" },
    { start: "2026-09-21T12:00:00.000Z", end: "2026-09-21T13:00:00.000Z", source: "manual" },
    { start: "2026-09-29T09:00:00.000Z", end: "2026-09-29T10:00:00.000Z", source: "ics" },
  ];
  const incoming = [{ start: "2026-09-21T14:00:00.000Z", end: "2026-09-21T15:00:00.000Z" }];
  const first = replaceBusyRange(existing, incoming, { source: "ics", from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" });
  assert.deepEqual(first.map((block) => `${block.source}@${block.start}`), [
    "manual@2026-09-21T12:00:00.000Z",
    "ics@2026-09-21T14:00:00.000Z",
    "ics@2026-09-29T09:00:00.000Z",
  ]);

  const second = replaceBusyRange(first, incoming, { source: "ics", from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" });
  assert.deepEqual(second, first, "re-syncing the same range does not duplicate blocks");
});

test("replaceBusyRange keeps a shared event's place, but never a place without its name", () => {
  const range = { source: "ics", from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" };
  const [unnamed, named] = replaceBusyRange([], [
    { start: "2026-09-21T18:00:00.000Z", end: "2026-09-21T20:00:00.000Z", title: "Soccer", location: "Riverdale Park" },
    { start: "2026-09-21T09:00:00.000Z", end: "2026-09-21T10:00:00.000Z", location: "Clinic on Bloor" },
  ], range);
  assert.deepEqual(named, { start: "2026-09-21T18:00:00.000Z", end: "2026-09-21T20:00:00.000Z", title: "Soccer", location: "Riverdale Park", source: "ics" });
  assert.deepEqual(unnamed, { start: "2026-09-21T09:00:00.000Z", end: "2026-09-21T10:00:00.000Z", source: "ics" });
});

test("widenCoverage only ever grows the covered range", () => {
  const first = widenCoverage(null, local(2026, 9, 21), local(2026, 9, 27));
  assert.deepEqual(first, { from: "2026-09-21", to: "2026-09-27" });
  const grown = widenCoverage(first, local(2026, 9, 14), local(2026, 9, 20));
  assert.deepEqual(grown, { from: "2026-09-14", to: "2026-09-27" });
  const unchanged = widenCoverage(grown, local(2026, 9, 22), local(2026, 9, 23));
  assert.deepEqual(unchanged, grown);
});

test("materializeWeek turns a pattern into dated blocks for that week", () => {
  const week = buildWeek(local(2026, 9, 21), { today: local(2026, 9, 21) });
  const member = { id: "a", name: "a", weekly: [{ weekday: 1, start: "09:00", end: "11:00" }, { weekday: 3, start: "13:00", end: "14:00" }] };
  const blocks = materializeWeek(member, week);
  assert.equal(blocks.length, 2);
  assert.equal(new Date(blocks[0].start).getHours(), 9);
  assert.equal(isoDate(new Date(blocks[1].start)), "2026-09-23");
});

test("normalizeWorkspaceState rejects junk and keeps a usable shape", () => {
  const state = normalizeWorkspaceState({
    name: "   My   Crew   ",
    privacy: "everything",
    settings: { weekStartsOn: 5, dayStart: 30, dayEnd: 2, minWindowHours: 99, locked: "yes" },
    members: [
      { id: "a", name: "Jamie Miller", busy: [{ start: "nope", end: "also nope" }, { start: "2026-09-21T10:00:00Z", end: "2026-09-21T09:00:00Z" }] },
      { id: "a", name: "Duplicate" },
      { name: "", weekly: [{ weekday: 9, start: "99:99", end: "10:00" }, { weekday: 2, start: "10:00", end: "09:00" }] },
    ],
    ideas: [{ title: "  Brunch  ", votes: ["a", "a", "ghost"], style: "nonsense" }],
    plan: { activity: "Dinner", timing: "whenever", start: "bad" },
    activity: [{ message: "", at: "x" }, { message: "Something happened", at: "2026-09-21T10:00:00Z" }],
    junk: "dropped",
  });

  assert.equal(state.version, 2);
  assert.equal(state.name, "My Crew");
  assert.equal(state.privacy, "busy", "unknown privacy falls back to busy/free only");
  assert.equal(state.junk, undefined);
  assert.deepEqual(state.settings, { weekStartsOn: 1, dayStart: 8, dayEnd: 22, minWindowHours: 8, locked: false });
  assert.equal(state.members.length, 2, "duplicate ids are dropped");
  assert.deepEqual(state.members[0].busy, [], "invalid and reversed intervals are dropped");
  assert.deepEqual(state.members[1].weekly, [], "invalid weekday and reversed times are dropped");
  assert.match(state.members[1].name, /^Guest /);
  assert.equal(state.members[1].initials.length, 2);
  assert.equal(state.ideas[0].title, "Brunch");
  assert.deepEqual(state.ideas[0].votes, ["a"], "votes are deduped and limited to real members");
  assert.equal(state.plan.timing, "week");
  assert.equal(state.plan.start, undefined);
  assert.deepEqual(state.activity.map((entry) => entry.message), ["Something happened"]);
});

test("normalizeWorkspaceState caps list sizes", () => {
  const many = Array.from({ length: LIMITS.members + 25 }, (_, index) => ({ id: `m${index}`, name: `Member ${index}` }));
  const state = normalizeWorkspaceState({ members: many, ideas: Array.from({ length: LIMITS.ideas + 10 }, (_, index) => ({ id: `i${index}`, title: `Idea ${index}` })) });
  assert.equal(state.members.length, LIMITS.members);
  assert.equal(state.ideas.length, LIMITS.ideas);
});

test("normalizeWorkspaceState survives nothing at all", () => {
  for (const input of [undefined, null, "string", 42, []]) {
    const state = normalizeWorkspaceState(input);
    assert.equal(state.name, "Weekend crew");
    assert.deepEqual(state.members, []);
    assert.equal(state.plan, null);
  }
});

test("idea vote helpers agree with each other", () => {
  const idea = { id: "x", title: "x", votes: ["a", "b"] };
  assert.equal(voteCount(idea), 2);
  assert.equal(hasVoted(idea, "a"), true);
  assert.equal(hasVoted(idea, "z"), false);
  assert.equal(voteCount({}), 0);
  const ranked = rankIdeas([{ title: "one", votes: [] }, { title: "two", votes: ["a"] }]);
  assert.equal(ranked[0].title, "two");
});

test("the demo workspace is valid and has live overlaps this week", () => {
  const state = createDemoState();
  assert.equal(state.members.length, 3);
  assert.equal(state.ideas.length, 3);
  const week = buildWeek(startOfWeek(new Date()), { today: new Date() });
  const windows = findOpenWindows(state.members, week, buildSlots(), { minHours: 2 });
  assert.ok(windows.length > 0, "recurring demo patterns keep the sample workspace alive in any week");
  assert.equal(voteCount(state.ideas[0]), 3);
});
