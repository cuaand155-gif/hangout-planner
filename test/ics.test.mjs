import test from "node:test";
import assert from "node:assert/strict";
import { formatStamp, parseContentLine, parseDuration, parseIcs, parseIcsDate, resolveZone, unfold, wallClockToUtc } from "../lib/ics.js";

const calendar = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const WINDOW = { from: "2026-09-21T00:00:00Z", to: "2026-09-28T00:00:00Z", padHours: 0 };

test("unfold rejoins folded lines", () => {
  assert.equal(unfold("SUMMARY:A very\r\n  long title"), "SUMMARY:A very long title");
  assert.equal(unfold("A:1\nB:2"), "A:1\nB:2");
});

test("parseContentLine splits name, params and value", () => {
  assert.deepEqual(parseContentLine("DTSTART;TZID=America/Toronto:20260921T100000"), {
    name: "DTSTART",
    params: { TZID: "America/Toronto" },
    value: "20260921T100000",
  });
  assert.deepEqual(parseContentLine('SUMMARY;X=":weird":Lunch: with Sam').value, "Lunch: with Sam");
  assert.equal(parseContentLine("no-colon-here"), null);
});

test("parseIcsDate reads dates, UTC stamps and floating stamps", () => {
  assert.deepEqual(parseIcsDate("20260921"), { year: 2026, month: 9, day: 21, hour: 0, minute: 0, second: 0, utc: false, allDay: true });
  assert.equal(parseIcsDate("20260921T100000Z").utc, true);
  assert.equal(parseIcsDate("20260921T100000").utc, false);
  assert.equal(parseIcsDate("garbage"), null);
});

test("formatStamp keeps UTC marked and floating unmarked", () => {
  assert.equal(formatStamp({ year: 2026, month: 9, day: 21, hour: 10, minute: 0, second: 0, utc: true }), "2026-09-21T10:00:00Z");
  assert.equal(formatStamp({ year: 2026, month: 9, day: 21, hour: 10, minute: 5, second: 0, utc: false }), "2026-09-21T10:05:00");
});

test("parseDuration handles the common ISO subset", () => {
  assert.equal(parseDuration("PT1H"), 3600 * 1000);
  assert.equal(parseDuration("P1DT2H30M"), (26 * 3600 + 30 * 60) * 1000);
  assert.equal(parseDuration("P1W"), 7 * 24 * 3600 * 1000);
  assert.equal(parseDuration("PT0S"), null);
  assert.equal(parseDuration("banana"), null);
});

test("a single timed event becomes one busy block", () => {
  const blocks = parseIcs(calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Dentist", "DTSTART:20260921T140000Z", "DTEND:20260921T150000Z", "END:VEVENT"), WINDOW);
  assert.deepEqual(blocks, [{ start: "2026-09-21T14:00:00Z", end: "2026-09-21T15:00:00Z", allDay: false }]);
});

test("titles are withheld unless details are requested", () => {
  const event = calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Therapy appointment", "DTSTART:20260921T140000Z", "DTEND:20260921T150000Z", "END:VEVENT");
  assert.equal(parseIcs(event, WINDOW)[0].title, undefined);
  assert.equal(parseIcs(event, { ...WINDOW, includeTitles: true })[0].title, "Therapy appointment");
});

test("DURATION fills in a missing DTEND, and a bare DTSTART gets an hour", () => {
  const withDuration = parseIcs(calendar("BEGIN:VEVENT", "UID:1", "DTSTART:20260921T140000Z", "DURATION:PT90M", "END:VEVENT"), WINDOW);
  assert.equal(withDuration[0].end, "2026-09-21T15:30:00Z");
  const bare = parseIcs(calendar("BEGIN:VEVENT", "UID:2", "DTSTART:20260921T140000Z", "END:VEVENT"), WINDOW);
  assert.equal(bare[0].end, "2026-09-21T15:00:00Z");
});

test("an all-day event covers the whole local day", () => {
  const blocks = parseIcs(calendar("BEGIN:VEVENT", "UID:1", "DTSTART;VALUE=DATE:20260922", "DTEND;VALUE=DATE:20260923", "END:VEVENT"), WINDOW);
  assert.deepEqual(blocks, [{ start: "2026-09-22T00:00:00", end: "2026-09-23T00:00:00", allDay: true }]);
});

test("a TZID event is converted to the real UTC instant", () => {
  const blocks = parseIcs(calendar("BEGIN:VEVENT", "UID:1", "DTSTART;TZID=America/Toronto:20260921T090000", "DTEND;TZID=America/Toronto:20260921T100000", "END:VEVENT"), WINDOW);
  assert.deepEqual(blocks, [{ start: "2026-09-21T13:00:00Z", end: "2026-09-21T14:00:00Z", allDay: false }]);

  const paris = parseIcs(calendar("BEGIN:VEVENT", "UID:2", "DTSTART;TZID=Europe/Paris:20260922T090000", "DTEND;TZID=Europe/Paris:20260922T100000", "END:VEVENT"), WINDOW);
  assert.equal(paris[0].start, "2026-09-22T07:00:00Z");
});

test("Windows and prefixed zone names resolve; unknown ones stay wall-clock", () => {
  assert.equal(resolveZone("Eastern Standard Time"), "America/New_York");
  assert.equal(resolveZone("/mozilla.org/20070129_1/Europe/Paris"), "Europe/Paris");
  assert.equal(resolveZone("Nowhere/Special"), null);
  const unknown = parseIcs(calendar("BEGIN:VEVENT", "UID:1", "DTSTART;TZID=Nowhere/Special:20260921T090000", "DTEND;TZID=Nowhere/Special:20260921T100000", "END:VEVENT"), WINDOW);
  assert.equal(unknown[0].start, "2026-09-21T09:00:00");
  const outlook = parseIcs(calendar("BEGIN:VEVENT", "UID:2", "DTSTART;TZID=Pacific Standard Time:20260921T090000", "DTEND;TZID=Pacific Standard Time:20260921T100000", "END:VEVENT"), WINDOW);
  assert.equal(outlook[0].start, "2026-09-21T16:00:00Z");
});

test("a zoned weekly event keeps its local time across a daylight-saving change", () => {
  const blocks = parseIcs(
    calendar("BEGIN:VEVENT", "UID:1", "DTSTART;TZID=America/Toronto:20261026T090000", "DTEND;TZID=America/Toronto:20261026T100000", "RRULE:FREQ=WEEKLY", "END:VEVENT"),
    { from: "2026-10-26T00:00:00Z", to: "2026-11-10T00:00:00Z", padHours: 0 }
  );
  assert.deepEqual(blocks.map((block) => block.start), ["2026-10-26T13:00:00Z", "2026-11-02T14:00:00Z", "2026-11-09T14:00:00Z"]);
});

test("UTC UNTIL and EXDATE apply to zoned occurrences by instant", () => {
  const blocks = parseIcs(
    calendar(
      "BEGIN:VEVENT", "UID:1", "DTSTART;TZID=America/Toronto:20260921T200000", "DTEND;TZID=America/Toronto:20260921T210000",
      "RRULE:FREQ=DAILY;UNTIL=20260924T000000Z", "EXDATE:20260923T000000Z", "END:VEVENT"
    ),
    WINDOW
  );
  // 8 PM Toronto is midnight UTC: the 22nd is excluded, and UNTIL keeps the 23rd.
  assert.deepEqual(blocks.map((block) => block.start), ["2026-09-22T00:00:00Z", "2026-09-24T00:00:00Z"]);
});

test("wallClockToUtc handles the skipped and repeated hours", () => {
  // 2:30 AM on 8 March 2026 does not exist in Toronto; 1:30 AM on 1 Nov 2026 happens twice.
  assert.equal(new Date(wallClockToUtc(Date.UTC(2026, 2, 8, 2, 30), "America/Toronto")).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(new Date(wallClockToUtc(Date.UTC(2026, 10, 1, 1, 30), "America/Toronto")).toISOString(), "2026-11-01T05:30:00.000Z");
});

test("a weekly rule expands across the window and keeps its duration", () => {
  const blocks = parseIcs(
    calendar("BEGIN:VEVENT", "UID:1", "DTSTART:20260907T130000Z", "DTEND:20260907T143000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "END:VEVENT"),
    WINDOW
  );
  assert.deepEqual(blocks.map((block) => block.start), ["2026-09-21T13:00:00Z", "2026-09-23T13:00:00Z"]);
  assert.equal(blocks[0].end, "2026-09-21T14:30:00Z");
});

test("UNTIL and COUNT stop a recurring event", () => {
  const until = parseIcs(calendar("BEGIN:VEVENT", "UID:1", "DTSTART:20260921T090000Z", "DTEND:20260921T100000Z", "RRULE:FREQ=DAILY;UNTIL=20260922T235959Z", "END:VEVENT"), WINDOW);
  assert.deepEqual(until.map((block) => block.start), ["2026-09-21T09:00:00Z", "2026-09-22T09:00:00Z"]);

  const counted = parseIcs(calendar("BEGIN:VEVENT", "UID:2", "DTSTART:20260919T090000Z", "DTEND:20260919T100000Z", "RRULE:FREQ=DAILY;COUNT=4", "END:VEVENT"), WINDOW);
  assert.deepEqual(counted.map((block) => block.start), ["2026-09-21T09:00:00Z", "2026-09-22T09:00:00Z"], "instances before the window still consume the count");
});

test("INTERVAL skips periods", () => {
  const blocks = parseIcs(
    calendar("BEGIN:VEVENT", "UID:1", "DTSTART:20260921T090000Z", "DTEND:20260921T100000Z", "RRULE:FREQ=DAILY;INTERVAL=3", "END:VEVENT"),
    WINDOW
  );
  assert.deepEqual(blocks.map((block) => block.start), ["2026-09-21T09:00:00Z", "2026-09-24T09:00:00Z", "2026-09-27T09:00:00Z"]);
});

test("EXDATE removes a single occurrence", () => {
  const blocks = parseIcs(
    calendar("BEGIN:VEVENT", "UID:1", "DTSTART:20260921T090000Z", "DTEND:20260921T100000Z", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE:20260922T090000Z", "END:VEVENT"),
    WINDOW
  );
  assert.deepEqual(blocks.map((block) => block.start), ["2026-09-21T09:00:00Z", "2026-09-23T09:00:00Z"]);
});

test("a RECURRENCE-ID override replaces the generated instance", () => {
  const blocks = parseIcs(
    calendar(
      "BEGIN:VEVENT", "UID:1", "DTSTART:20260921T090000Z", "DTEND:20260921T100000Z", "RRULE:FREQ=DAILY;COUNT=2", "END:VEVENT",
      "BEGIN:VEVENT", "UID:1", "RECURRENCE-ID:20260922T090000Z", "DTSTART:20260922T160000Z", "DTEND:20260922T170000Z", "END:VEVENT"
    ),
    WINDOW
  );
  assert.deepEqual(blocks.map((block) => block.start), ["2026-09-21T09:00:00Z", "2026-09-22T16:00:00Z"]);
});

test("cancelled and free-time events do not block the calendar", () => {
  const blocks = parseIcs(
    calendar(
      "BEGIN:VEVENT", "UID:1", "DTSTART:20260921T090000Z", "DTEND:20260921T100000Z", "STATUS:CANCELLED", "END:VEVENT",
      "BEGIN:VEVENT", "UID:2", "DTSTART:20260921T110000Z", "DTEND:20260921T120000Z", "TRANSP:TRANSPARENT", "END:VEVENT",
      "BEGIN:VEVENT", "UID:3", "DTSTART:20260921T130000Z", "DTEND:20260921T140000Z", "STATUS:CONFIRMED", "END:VEVENT"
    ),
    WINDOW
  );
  assert.deepEqual(blocks.map((block) => block.start), ["2026-09-21T13:00:00Z"]);
});

test("events outside the window are dropped, overlapping ones kept", () => {
  const blocks = parseIcs(
    calendar(
      "BEGIN:VEVENT", "UID:1", "DTSTART:20260801T090000Z", "DTEND:20260801T100000Z", "END:VEVENT",
      "BEGIN:VEVENT", "UID:2", "DTSTART:20260920T230000Z", "DTEND:20260921T010000Z", "END:VEVENT"
    ),
    WINDOW
  );
  assert.deepEqual(blocks.map((block) => block.start), ["2026-09-20T23:00:00Z"]);
});

test("other components and alarms are ignored", () => {
  const blocks = parseIcs(
    calendar(
      "BEGIN:VTIMEZONE", "TZID:America/Toronto", "BEGIN:STANDARD", "DTSTART:20261101T060000Z", "END:STANDARD", "END:VTIMEZONE",
      "BEGIN:VTODO", "UID:t1", "DTSTART:20260921T090000Z", "END:VTODO",
      "BEGIN:VEVENT", "UID:1", "SUMMARY:Real event", "DTSTART:20260921T150000Z", "DTEND:20260921T160000Z",
      "BEGIN:VALARM", "TRIGGER:-PT15M", "END:VALARM", "END:VEVENT"
    ),
    { ...WINDOW, includeTitles: true }
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, "Real event");
});

test("escaped text is unescaped and an empty calendar yields nothing", () => {
  const blocks = parseIcs(calendar("BEGIN:VEVENT", "UID:1", "SUMMARY:Dinner\\, then a walk\\nbring a coat", "DTSTART:20260921T180000Z", "DTEND:20260921T190000Z", "END:VEVENT"), { ...WINDOW, includeTitles: true });
  assert.equal(blocks[0].title, "Dinner, then a walk bring a coat");
  assert.deepEqual(parseIcs(calendar(), WINDOW), []);
  assert.deepEqual(parseIcs("not a calendar at all", WINDOW), []);
});

test("an invalid window is rejected", () => {
  assert.throws(() => parseIcs(calendar(), { from: "nope", to: "also nope" }), /Invalid window/);
});
