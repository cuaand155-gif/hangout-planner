import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_LIMIT,
  BLOCK_PRESETS,
  addRule,
  blockedBlocksOn,
  blockedEvents,
  describeRule,
  normalizeBlocked,
  removeRule,
  rulesForGroup,
  toMinutes,
} from "../lib/blocked.js";

const WORK = { days: [5, 1, 3, 2, 4, 4], start: "9:00", end: "17:00", label: "  Work  at   the office " };
const SLEEP = { days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00", label: "Sleep" };
// Monday 5 October 2026 (local time).
const MONDAY = new Date(2026, 9, 5);
const hours = (blocks) => blocks.map((block) => [new Date(block.start).getHours(), new Date(block.end).getHours()]);

test("toMinutes reads 24-hour clock times, with 24:00 as the end of a day", () => {
  assert.equal(toMinutes("09:30"), 570);
  assert.equal(toMinutes("24:00"), 1440);
  assert.equal(toMinutes("24:30"), null);
  assert.equal(toMinutes("9:75"), null);
  assert.equal(toMinutes("noon"), null);
});

test("normalizeBlocked tidies rules and never keeps the same one twice", () => {
  const rules = normalizeBlocked([WORK, { ...WORK, label: "again" }, { days: [9], start: "09:00", end: "10:00" }, { days: [1], start: "10:00", end: "10:00" }, null]);
  assert.deepEqual(rules, [{ id: "b-12345-0900-1700", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", label: "Work at the office" }]);
  assert.equal(normalizeBlocked("nope").length, 0);
  const many = Array.from({ length: 30 }, (_, index) => ({ days: [1], start: `${String(index % 24).padStart(2, "0")}:00`, end: `${String(index % 24).padStart(2, "0")}:30` }));
  assert.equal(normalizeBlocked(many).length, BLOCK_LIMIT);
});

test("groups and friends get the times, never the label", () => {
  assert.deepEqual(rulesForGroup([WORK, SLEEP]), [
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
    { days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" },
  ]);
});

test("addRule and removeRule return new lists and skip duplicates", () => {
  const one = addRule([], WORK);
  assert.equal(addRule(one, { ...WORK }).length, 1);
  const two = addRule(one, SLEEP);
  assert.equal(two.length, 2);
  assert.deepEqual(removeRule(two, one[0].id).map((rule) => rule.label), ["Sleep"]);
});

test("a weekday rule blocks weekdays only", () => {
  assert.deepEqual(hours(blockedBlocksOn([WORK], MONDAY)), [[9, 17]]);
  assert.deepEqual(blockedBlocksOn([WORK], new Date(2026, 9, 4)), [], "Sunday is free");
});

test("an overnight rule blocks the evening and the next morning", () => {
  const blocks = blockedBlocksOn([SLEEP], MONDAY);
  assert.deepEqual(hours(blocks), [[0, 7], [23, 0]]);
  assert.equal(new Date(blocks[1].end).getDate(), 6, "runs to midnight");
  // Friday nights only: Saturday morning is blocked, Friday morning is not.
  const friday = [{ days: [5], start: "22:00", end: "02:00" }];
  assert.deepEqual(hours(blockedBlocksOn(friday, new Date(2026, 9, 10))), [[0, 2]]);
  assert.deepEqual(hours(blockedBlocksOn(friday, new Date(2026, 9, 9))), [[22, 0]]);
});

test("blockedEvents dates the rules over a range and joins nights back together", () => {
  const events = blockedEvents([SLEEP], MONDAY, new Date(2026, 9, 7));
  // Mon 00–07 (from Sunday night), Mon 23 – Tue 07, Tue 23 – Wed 00 (range ends).
  assert.equal(events.length, 3);
  assert.equal(new Date(events[1].start).getHours(), 23);
  assert.equal(new Date(events[1].end).getDate(), 6);
  assert.equal(new Date(events[1].end).getHours(), 7);
  assert.ok(events.every((event) => event.blocked && !("title" in event)), "busy only, no titles");
  assert.deepEqual(blockedEvents([], MONDAY, new Date(2026, 9, 12)), []);
});

test("rules read naturally", () => {
  assert.equal(describeRule(normalizeBlocked([WORK])[0]), "Mon–Fri · 9 am – 5 pm");
  assert.equal(describeRule(normalizeBlocked([SLEEP])[0]), "Every day · 11 pm – 7 am (overnight)");
  assert.equal(describeRule({ days: [0, 6], start: "08:30", end: "12:00" }), "Weekends · 8:30 am – 12 pm");
  assert.equal(describeRule({ days: [1, 3], start: "18:00", end: "19:00" }), "Mon, Wed · 6 pm – 7 pm");
});

test("every preset is a valid rule", () => {
  for (const preset of BLOCK_PRESETS) assert.equal(normalizeBlocked([preset]).length, 1, preset.key);
});
