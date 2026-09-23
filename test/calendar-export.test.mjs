import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanIcs, escapeIcsText, foldLine, googleCalendarUrl, planEventWindow, planUid, toIcsUtc } from "../lib/calendar-export.js";
import { parseIcs } from "../lib/ics.js";

const plan = {
  id: "plan_abc",
  activity: "Dinner, then games",
  location: "Luma; Queen West",
  audience: "Weekend crew",
  chosen: "2026-09-26T22:00:00.000Z",
  chosenEnd: "2026-09-27T01:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

test("UTC stamps use the compact calendar form", () => {
  assert.equal(toIcsUtc("2026-09-26T22:05:09.000Z"), "20260926T220509Z");
});

test("text escaping covers the RFC 5545 specials", () => {
  assert.equal(escapeIcsText("a,b;c\\d\ne"), "a\\,b\;c\\\\d\\ne");
  assert.equal(escapeIcsText(null), "");
});

test("long lines fold at 75 octets without splitting a character", () => {
  const short = "SUMMARY:short";
  assert.equal(foldLine(short), short);
  const long = `SUMMARY:${"é".repeat(60)}`; // é is two bytes
  const folded = foldLine(long);
  for (const part of folded.split("\r\n")) assert.ok(new TextEncoder().encode(part).length <= 75);
  assert.equal(folded.split("\r\n").map((part, index) => (index ? part.slice(1) : part)).join(""), long, "unfolding restores the line");
});

test("the event window uses the chosen range, defaulting to two hours", () => {
  const window = planEventWindow(plan);
  assert.equal(window.start.toISOString(), plan.chosen);
  assert.equal(window.end.toISOString(), plan.chosenEnd);

  const noEnd = planEventWindow({ ...plan, chosenEnd: undefined });
  assert.equal(noEnd.end.getTime() - noEnd.start.getTime(), 2 * 3600 * 1000);
  const backwards = planEventWindow({ ...plan, chosenEnd: "2026-09-26T20:00:00.000Z" });
  assert.equal(backwards.end.getTime() - backwards.start.getTime(), 2 * 3600 * 1000, "an end before the start is ignored");
  assert.equal(planEventWindow({ ...plan, chosen: undefined }), null);
});

test("the UID depends on the plan and group, never on the time", () => {
  const moved = { ...plan, chosen: "2026-10-03T22:00:00.000Z", chosenEnd: "2026-10-04T01:00:00.000Z" };
  assert.equal(planUid(plan, "crew-7fq2x"), planUid(moved, "crew-7fq2x"), "moving the plan keeps its identity");
  assert.notEqual(planUid(plan, "crew-7fq2x"), planUid(plan, "other-group"));
  assert.match(planUid({ activity: "Old plan!" }, "g"), /^legacy-old-plan-\.g@gatherly$/, "plans saved before ids existed still get a stable one");
});

test("the .ics file is valid, round-trips through our own parser, and carries the details", () => {
  const ics = buildPlanIcs(plan, { slug: "crew-7fq2x", url: "https://example.com/?w=crew-7fq2x", now: new Date("2026-09-23T12:00:00Z") });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(ics, /UID:plan_abc\.crew-7fq2x@gatherly/);
  assert.match(ics, /SUMMARY:Dinner\\, then games · Luma\; Queen West/);
  assert.match(ics, /STATUS:TENTATIVE/);

  const blocks = parseIcs(ics, { from: "2026-09-20T00:00:00Z", to: "2026-10-01T00:00:00Z", includeTitles: true });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start, "2026-09-26T22:00:00Z");
  assert.equal(blocks[0].end, "2026-09-27T01:00:00Z");
  assert.equal(blocks[0].title, "Dinner, then games · Luma; Queen West");
});

test("a later update produces a higher SEQUENCE, so calendars take the new version", () => {
  const sequence = (value) => Number(/SEQUENCE:(\d+)/.exec(buildPlanIcs(value, { slug: "g" }))[1]);
  assert.ok(sequence({ ...plan, updatedAt: "2026-09-24T10:00:00.000Z" }) > sequence(plan));
});

test("no chosen time means no event", () => {
  assert.equal(buildPlanIcs({ ...plan, chosen: undefined }, { slug: "g" }), null);
  assert.equal(googleCalendarUrl({ ...plan, chosen: undefined }), null);
});

test("the Google link pre-fills title, times, place and details", () => {
  const link = new URL(googleCalendarUrl(plan, { url: "https://example.com/?w=g" }));
  assert.equal(link.origin + link.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(link.searchParams.get("action"), "TEMPLATE");
  assert.equal(link.searchParams.get("text"), "Dinner, then games · Luma; Queen West");
  assert.equal(link.searchParams.get("dates"), "20260926T220000Z/20260927T010000Z");
  assert.equal(link.searchParams.get("location"), "Luma; Queen West");
  assert.match(link.searchParams.get("details"), /Group: https:\/\/example\.com\/\?w=g/);
});
