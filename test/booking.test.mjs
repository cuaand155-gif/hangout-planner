import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  buildGuestIcs,
  buildOwnerFeed,
  busyFromIcsBlocks,
  candidateSlots,
  normalizeBookingSettings,
  normalizeGuest,
  normalizeHandle,
  openSlots,
  stampToDate,
  zonedParts,
  zonedToUtc,
} from "../lib/booking.js";

const TZ = "America/Toronto";

test("wall-clock times convert to the right instant on both sides of DST", () => {
  // Summer (EDT, UTC-4) and winter (EST, UTC-5).
  assert.equal(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, TZ).toISOString(), "2026-07-01T13:00:00.000Z");
  assert.equal(zonedToUtc({ year: 2026, month: 12, day: 1, hour: 9 }, TZ).toISOString(), "2026-12-01T14:00:00.000Z");
  // 2026-11-01 01:30 happens twice in Toronto; the first (EDT) is used.
  assert.equal(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, TZ).toISOString(), "2026-11-01T05:30:00.000Z");
  // 2026-03-08 02:30 does not exist; it resolves to just after the jump.
  const skipped = zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, TZ);
  assert.equal(zonedParts(skipped, TZ).hour, 3);
});

test("ICS stamps: Z is UTC, floating is the owner's wall clock", () => {
  assert.equal(stampToDate("2026-09-28T14:00:00Z", TZ).toISOString(), "2026-09-28T14:00:00.000Z");
  assert.equal(stampToDate("2026-09-28T10:00:00", TZ).toISOString(), "2026-09-28T14:00:00.000Z");
  assert.ok(Number.isNaN(stampToDate("garbage", TZ).getTime()));
  const busy = busyFromIcsBlocks(
    [
      { start: "2026-09-28T10:00:00", end: "2026-09-28T11:00:00", allDay: false },
      { start: "2026-09-28T00:00:00", end: "2026-09-29T00:00:00", allDay: true },
    ],
    TZ
  );
  assert.equal(busy.length, 1, "all-day events do not block time");
});

test("settings are clamped to safe values", () => {
  const cleaned = normalizeBookingSettings({ duration: 7, buffer: 999, windowDays: 400, dayStart: 18, dayEnd: 9, weekdays: [9, 1, 1, "3"], timeZone: "Mars/Olympus", mode: "weird" });
  assert.equal(cleaned.duration, DEFAULT_SETTINGS.duration);
  assert.equal(cleaned.buffer, DEFAULT_SETTINGS.buffer);
  assert.equal(cleaned.windowDays, 60);
  assert.deepEqual([cleaned.dayStart, cleaned.dayEnd], [DEFAULT_SETTINGS.dayStart, DEFAULT_SETTINGS.dayEnd]);
  assert.deepEqual(cleaned.weekdays, [1, 3]);
  assert.equal(cleaned.timeZone, DEFAULT_SETTINGS.timeZone);
  assert.equal(cleaned.mode, "free");
});

test("free mode offers working hours on chosen weekdays only", () => {
  const now = new Date("2026-09-28T12:00:00Z"); // Monday 8 am in Toronto
  const slots = candidateSlots({ duration: 60, windowDays: 6, weekdays: [1, 3], dayStart: 9, dayEnd: 12, timeZone: TZ }, { now });
  const days = new Set(slots.map((slot) => zonedParts(slot.start, TZ).weekday));
  assert.deepEqual([...days].sort(), [1, 3]);
  const monday = slots.filter((slot) => zonedParts(slot.start, TZ).weekday === 1);
  // 60-minute meetings on a 30-minute grid between 9 and 12: 9:00, 9:30, 10:00, 10:30, 11:00.
  assert.equal(monday.length, 5);
  assert.equal(monday[0].start.toISOString(), "2026-09-28T13:00:00.000Z");
  assert.equal(monday.at(-1).end.toISOString(), "2026-09-28T16:00:00.000Z");
});

test("open slots skip busy time, notice period and the buffer around bookings", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const settings = { duration: 30, buffer: 15, noticeHours: 2, windowDays: 1, weekdays: [1], dayStart: 9, dayEnd: 13, timeZone: TZ };
  const open = openSlots(settings, {
    now,
    busy: [{ start: "2026-09-28T15:00:00Z", end: "2026-09-28T16:00:00Z" }], // 11–12 busy
    bookings: [{ start: "2026-09-28T16:00:00Z", end: "2026-09-28T16:30:00Z" }], // 12:00 booked
  });
  const times = open.map((slot) => zonedParts(slot.start, TZ)).map((p) => `${p.hour}:${String(p.minute).padStart(2, "0")}`);
  // Notice: nothing before 10:00 (now 8:00 + 2h). Busy 11–12. Booking 12:00–12:30 + 15 min buffer blocks 11:30–12:45 starts.
  assert.deepEqual(times, ["10:00", "10:30"]);
});

test("picked mode only offers the chosen ranges", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const open = openSlots(
    { mode: "picked", duration: 30, noticeHours: 0, picked: [{ start: "2026-09-30T18:00:00Z", end: "2026-09-30T19:00:00Z" }] },
    { now }
  );
  assert.deepEqual(open.map((slot) => slot.start), ["2026-09-30T18:00:00.000Z", "2026-09-30T18:30:00.000Z"]);
});

test("handles and guest details are validated", () => {
  assert.equal(normalizeHandle(" Alexi-7fq2x "), "alexi-7fq2x");
  assert.equal(normalizeHandle("a"), null);
  assert.equal(normalizeHandle("../etc"), null);
  assert.deepEqual(normalizeGuest({ name: "  Sam  Lee ", email: "SAM@x.co" }), { name: "Sam Lee", email: "sam@x.co", note: "" });
  assert.ok(normalizeGuest({ name: "Sam", email: "nope" }).error);
  assert.ok(normalizeGuest({ email: "a@b.co" }).error);
});

test("guest and owner calendar files share one UID per booking", () => {
  const booking = { id: "b1", start_at: "2026-09-30T18:00:00Z", end_at: "2026-09-30T18:30:00Z", guest_name: "Sam; Lee", guest_email: "sam@x.co", note: "", status: "confirmed", created_at: "2026-09-28T12:00:00Z" };
  const guest = buildGuestIcs(booking, { ownerName: "Alexi", pageTitle: "Chat", cancelUrl: "https://x/book?cancel=t" });
  assert.match(guest, /UID:booking-b1@gatherly/);
  assert.match(guest, /SUMMARY:Chat with Alexi/);
  assert.ok(guest.endsWith("\r\n"));
  const feed = buildOwnerFeed([booking, { ...booking, id: "b2", status: "cancelled" }], { pageTitle: "Chat" });
  assert.match(feed, /UID:booking-b1@gatherly/);
  assert.match(feed, /SUMMARY:Chat: Sam\; Lee/);
  assert.match(feed, /UID:booking-b2@gatherly[\s\S]*STATUS:CANCELLED/);
});

test("owner links: share page, webcal feed and Google subscribe link", async () => {
  const { bookingLinks, suggestHandle } = await import("../lib/booking.js");
  const links = bookingLinks("https://waddle.example/", "alexi-7fq2x", "abc123");
  assert.equal(links.page, "https://waddle.example/book/alexi-7fq2x");
  assert.equal(links.webcal, "webcal://waddle.example/api/book?feed=abc123");
  assert.ok(links.google.startsWith("https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fwaddle.example"));
  assert.equal(bookingLinks("https://w.example", "x-yz", "").webcal, "");
  let i = 0;
  const handle = suggestHandle("Alexi Cüa!", () => (i++ % 10) / 10);
  assert.match(handle, /^alexi-cua-[a-z0-9]{5}$/);
  assert.match(suggestHandle(""), /^me-[a-z0-9]{5}$/);
});
