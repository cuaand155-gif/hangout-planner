import test from "node:test";
import assert from "node:assert/strict";

import { applyRsvp, nextOccurrence, normalizeTimeVotes, rruleFor, rsvpSummary, toggleTimeVote } from "../lib/hangout.js";
import { buildPlanIcs, googleCalendarUrl } from "../lib/calendar-export.js";
import { normalizeWorkspaceState } from "../lib/planner.js";
import { parseIcs } from "../lib/ics.js";

const zone = "America/Toronto";
// Thursday 1 Oct 2026, 7–9pm in Toronto (EDT, UTC-4).
const weekly = { id: "plan_1", activity: "Games night", chosen: "2026-10-01T23:00:00.000Z", chosenEnd: "2026-10-02T01:00:00.000Z", repeat: "weekly", timeZone: zone };

test("a one-off plan shows its own time, even after it has passed", () => {
  const once = { ...weekly, repeat: "none" };
  const later = nextOccurrence(once, new Date("2026-12-01T00:00:00Z"));
  assert.equal(later.start.toISOString(), once.chosen);
});

test("a weekly plan moves to the next week once this one ends, and keeps 7pm across the clock change", () => {
  const during = nextOccurrence(weekly, new Date("2026-10-02T00:00:00Z"));
  assert.equal(during.start.toISOString(), weekly.chosen, "still on while it's happening");
  const next = nextOccurrence(weekly, new Date("2026-10-02T02:00:00Z"));
  assert.equal(next.start.toISOString(), "2026-10-08T23:00:00.000Z");
  // Toronto falls back on 1 Nov 2026: 7pm EST is 00:00 UTC.
  const afterDst = nextOccurrence(weekly, new Date("2026-11-03T12:00:00Z"));
  assert.equal(afterDst.start.toISOString(), "2026-11-06T00:00:00.000Z");
  assert.equal(afterDst.end - afterDst.start, 2 * 3600 * 1000, "the length is kept");
});

test("every-2-weeks and monthly repeats land on the right dates", () => {
  const biweekly = nextOccurrence({ ...weekly, repeat: "biweekly" }, new Date("2026-10-03T00:00:00Z"));
  assert.equal(biweekly.start.toISOString(), "2026-10-15T23:00:00.000Z");
  const monthly = nextOccurrence({ ...weekly, repeat: "monthly" }, new Date("2026-10-03T00:00:00Z"));
  assert.equal(monthly.start.toISOString(), "2026-11-02T00:00:00.000Z", "1 Nov, 7pm EST");
});

test("a monthly plan on the 31st skips months without one, like calendars do", () => {
  const plan = { ...weekly, chosen: "2026-08-31T23:00:00.000Z", chosenEnd: "2026-09-01T01:00:00.000Z", repeat: "monthly" };
  assert.equal(nextOccurrence(plan, new Date("2026-09-05T00:00:00Z")).start.toISOString(), "2026-10-31T23:00:00.000Z");
});

test("RSVPs count only for the occurrence they were given for", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const first = nextOccurrence(weekly, new Date("2026-09-30T00:00:00Z"));
  let plan = { ...weekly, rsvp: applyRsvp(weekly, first, "a", "yes") };
  plan = { ...plan, rsvp: applyRsvp(plan, first, "b", "maybe") };
  const now = rsvpSummary(plan, first, members);
  assert.deepEqual(now.yes.map((m) => m.id), ["a"]);
  assert.deepEqual(now.maybe.map((m) => m.id), ["b"]);
  assert.deepEqual(now.waiting.map((m) => m.id), ["c"]);

  const toggled = applyRsvp(plan, first, "a", "yes");
  assert.equal(toggled.answers.a, undefined, "tapping your answer again clears it");

  const second = nextOccurrence(weekly, new Date("2026-10-03T00:00:00Z"));
  assert.equal(rsvpSummary(plan, second, members).waiting.length, 3, "next week starts fresh");
});

test("time votes toggle, and only current members' votes survive saving", () => {
  let votes = toggleTimeVote({}, "2026-10-01T23:00:00Z", "a");
  votes = toggleTimeVote(votes, "2026-10-01T23:00:00.000Z", "b");
  assert.deepEqual(votes["2026-10-01T23:00:00.000Z"], ["a", "b"]);
  votes = toggleTimeVote(votes, "2026-10-01T23:00:00Z", "a");
  assert.deepEqual(votes["2026-10-01T23:00:00.000Z"], ["b"]);
  assert.deepEqual(toggleTimeVote(votes, "2026-10-01T23:00:00Z", "b"), {});

  assert.deepEqual(normalizeTimeVotes({ nope: ["a"], "2026-10-01T23:00:00Z": ["a", "gone"] }, new Set(["a"])), { "2026-10-01T23:00:00.000Z": ["a"] });

  const state = normalizeWorkspaceState({
    members: [{ id: "a", name: "A" }],
    plan: { ...weekly, repeat: "sometimes", timeVotes: { "2026-10-01T23:00:00Z": ["a", "gone"] }, rsvp: { at: weekly.chosen, answers: { a: "yes", gone: "no", b: "perhaps" } } },
  });
  assert.equal(state.plan.repeat, undefined, "unknown repeats become one-offs");
  assert.deepEqual(state.plan.timeVotes, { "2026-10-01T23:00:00.000Z": ["a"] });
  assert.deepEqual(state.plan.rsvp.answers, { a: "yes" });
  assert.equal(state.plan.timeZone, zone);
});

test("a repeating plan exports one event with a rule, in its own time zone", () => {
  assert.equal(rruleFor("biweekly"), "FREQ=WEEKLY;INTERVAL=2");
  assert.equal(rruleFor("none"), null);
  const ics = buildPlanIcs(weekly, { slug: "crew", now: new Date("2026-09-23T12:00:00Z") });
  assert.match(ics, /DTSTART;TZID=America\/Toronto:20261001T190000/);
  assert.match(ics, /DTEND;TZID=America\/Toronto:20261001T210000/);
  assert.match(ics, /RRULE:FREQ=WEEKLY/);
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1, "one series, not one event per week");

  // Our own reader expands it at 7pm local on both sides of the clock change.
  const blocks = parseIcs(ics, { from: "2026-10-25T00:00:00Z", to: "2026-11-08T00:00:00Z" });
  assert.deepEqual(blocks.map((block) => block.start), ["2026-10-29T23:00:00Z", "2026-11-06T00:00:00Z"]);

  const link = new URL(googleCalendarUrl(weekly));
  assert.equal(link.searchParams.get("recur"), "RRULE:FREQ=WEEKLY");
  assert.equal(link.searchParams.get("ctz"), zone);
});
