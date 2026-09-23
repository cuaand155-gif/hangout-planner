// Booking links: the maths behind "pick a time with me".
//
// A booking page belongs to one person. Visitors only ever receive open
// slots, never the busy blocks or events behind them. Everything here is pure
// so the server (which decides what is open) and the tests share one copy.
//
// Times are stored and exchanged as UTC instants. Working hours are wall-clock
// hours in the owner's time zone, converted per day so daylight-saving changes
// move the instant, not the hour.

import { escapeIcsText, foldLine, toIcsUtc } from "./calendar-export.js";

export const DURATIONS = [15, 30, 45, 60, 90];
export const BUFFERS = [0, 5, 10, 15, 30];
export const MAX_PICKED = 200;
export const MAX_SLOTS = 400;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "free", // "free": all free time inside working hours; "picked": only times the owner chose
  duration: 30,
  buffer: 0,
  windowDays: 14,
  noticeHours: 4,
  dayStart: 9,
  dayEnd: 17,
  weekdays: [1, 2, 3, 4, 5],
  timeZone: "America/Toronto",
  picked: [],
});

export function isValidTimeZone(zone) {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const pick = (value, allowed, fallback) => (allowed.includes(Number(value)) ? Number(value) : fallback);
const clampInt = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
};

function normalizeRange(entry) {
  const start = new Date(entry?.start);
  const end = new Date(entry?.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  if (end - start > DAY) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Cleans settings from the owner's browser before they are stored or used. */
export function normalizeBookingSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const dayStart = clampInt(source.dayStart, 0, 23, DEFAULT_SETTINGS.dayStart);
  const dayEnd = clampInt(source.dayEnd, 1, 24, DEFAULT_SETTINGS.dayEnd);
  const weekdays = Array.isArray(source.weekdays)
    ? [...new Set(source.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : [...DEFAULT_SETTINGS.weekdays];
  const picked = Array.isArray(source.picked)
    ? source.picked.map(normalizeRange).filter(Boolean).sort((a, b) => (a.start < b.start ? -1 : 1)).slice(0, MAX_PICKED)
    : [];
  return {
    mode: source.mode === "picked" ? "picked" : "free",
    duration: pick(source.duration, DURATIONS, DEFAULT_SETTINGS.duration),
    buffer: pick(source.buffer, BUFFERS, DEFAULT_SETTINGS.buffer),
    windowDays: clampInt(source.windowDays, 1, 60, DEFAULT_SETTINGS.windowDays),
    noticeHours: clampInt(source.noticeHours, 0, 72, DEFAULT_SETTINGS.noticeHours),
    dayStart: dayEnd > dayStart ? dayStart : DEFAULT_SETTINGS.dayStart,
    dayEnd: dayEnd > dayStart ? dayEnd : DEFAULT_SETTINGS.dayEnd,
    weekdays,
    timeZone: isValidTimeZone(source.timeZone) ? source.timeZone : DEFAULT_SETTINGS.timeZone,
    picked,
  };
}

/* ------------------------------------------------------------ time zones */

const partsFormatters = new Map();
function formatterFor(timeZone) {
  if (!partsFormatters.has(timeZone)) {
    partsFormatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        weekday: "short",
      })
    );
  }
  return partsFormatters.get(timeZone);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of an instant in a time zone. */
export function zonedParts(date, timeZone) {
  const fields = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(date))) fields[part.type] = part.value;
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    second: Number(fields.second),
    weekday: WEEKDAYS[fields.weekday],
  };
}

function offsetAt(millis, timeZone) {
  const parts = zonedParts(millis, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(millis / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in a zone. A time skipped by a spring
 * DST jump resolves to the moment after the jump; a repeated autumn time
 * resolves to its first occurrence.
 */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = wall - offsetAt(wall, timeZone);
  const adjusted = wall - offsetAt(first, timeZone);
  if (first === adjusted) return new Date(first);
  // The two guesses straddle a transition: prefer the earlier valid instant.
  const candidates = [first, adjusted].filter((millis) => {
    const parts = zonedParts(millis, timeZone);
    return parts.hour === hour && parts.minute === minute;
  });
  return new Date(candidates.length ? Math.min(...candidates) : Math.max(first, adjusted));
}

/** Reads a parsed-ICS stamp: "…Z" is UTC, anything else is wall-clock in `timeZone`. */
export function stampToDate(stamp, timeZone) {
  const raw = String(stamp || "");
  if (/Z$/.test(raw)) return new Date(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return new Date(Number.NaN);
  return zonedToUtc(
    { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: +(match[6] || 0) },
    timeZone
  );
}

/** Busy blocks from a parsed feed as UTC ranges. All-day events do not block time. */
export function busyFromIcsBlocks(blocks, timeZone) {
  return (blocks || [])
    .filter((block) => !block.allDay)
    .map((block) => ({ start: stampToDate(block.start, timeZone), end: stampToDate(block.end, timeZone) }))
    .filter((range) => !Number.isNaN(range.start.getTime()) && !Number.isNaN(range.end.getTime()) && range.end > range.start);
}

/* ------------------------------------------------------------ slots */

const stepFor = (duration) => (duration >= 30 ? 30 : 15);

function chop(start, end, duration) {
  const slots = [];
  const step = stepFor(duration) * MINUTE;
  const length = duration * MINUTE;
  for (let at = start; at + length <= end; at += step) slots.push({ start: new Date(at), end: new Date(at + length) });
  return slots;
}

/** Every slot the owner offers before busy time and bookings are removed. */
export function candidateSlots(settings, { now = new Date() } = {}) {
  const config = normalizeBookingSettings(settings);
  const nowMillis = new Date(now).getTime();
  const horizon = nowMillis + config.windowDays * DAY;
  let slots = [];

  if (config.mode === "picked") {
    for (const range of config.picked) {
      const start = new Date(range.start).getTime();
      const end = Math.min(new Date(range.end).getTime(), horizon);
      if (end > nowMillis) slots.push(...chop(start, end, config.duration));
    }
  } else {
    const today = zonedParts(nowMillis, config.timeZone);
    for (let offset = 0; offset <= config.windowDays; offset += 1) {
      // Walk calendar days in the owner's zone (noon avoids DST edges when stepping).
      const noon = new Date(Date.UTC(today.year, today.month - 1, today.day + offset, 12));
      const date = { year: noon.getUTCFullYear(), month: noon.getUTCMonth() + 1, day: noon.getUTCDate() };
      const weekday = zonedParts(zonedToUtc({ ...date, hour: 12 }, config.timeZone), config.timeZone).weekday;
      if (!config.weekdays.includes(weekday)) continue;
      const start = zonedToUtc({ ...date, hour: config.dayStart }, config.timeZone).getTime();
      const end = config.dayEnd === 24
        ? zonedToUtc({ year: date.year, month: date.month, day: date.day + 1, hour: 0 }, config.timeZone).getTime()
        : zonedToUtc({ ...date, hour: config.dayEnd }, config.timeZone).getTime();
      slots.push(...chop(start, Math.min(end, horizon), config.duration));
    }
  }
  return slots;
}

const overlapsRange = (start, end, range) => start < new Date(range.end).getTime() && new Date(range.start).getTime() < end;

/**
 * Removes slots that are too soon, overlap busy time, or sit within the
 * buffer around an existing booking.
 */
export function openSlots(settings, { busy = [], bookings = [], now = new Date() } = {}) {
  const config = normalizeBookingSettings(settings);
  const earliest = new Date(now).getTime() + config.noticeHours * 60 * MINUTE;
  const buffer = config.buffer * MINUTE;
  const seen = new Set();
  const open = [];
  for (const slot of candidateSlots(config, { now })) {
    const start = slot.start.getTime();
    const end = slot.end.getTime();
    if (start < earliest || seen.has(start)) continue;
    if (busy.some((range) => overlapsRange(start, end, range))) continue;
    if (bookings.some((range) => overlapsRange(start - buffer, end + buffer, range))) continue;
    seen.add(start);
    open.push({ start: slot.start.toISOString(), end: slot.end.toISOString() });
    if (open.length >= MAX_SLOTS) break;
  }
  return open.sort((a, b) => (a.start < b.start ? -1 : 1));
}

/* ------------------------------------------------------------ handles + guests */

export function normalizeHandle(value) {
  const handle = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,47}$/.test(handle) ? handle : null;
}

export function normalizeGuest(input = {}) {
  const name = String(input.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(input.email || "").trim().toLowerCase().slice(0, 254);
  const note = String(input.note || "").trim().slice(0, 500);
  if (!name) return { error: "Add your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Add a valid email so they can reach you." };
  return { name, email, note };
}

/* ------------------------------------------------------------ calendar files */

export const bookingUid = (id) => `booking-${id}@gatherly`;

function eventLines(booking, { title, description = "", url = "" }) {
  const cancelled = booking.status === "cancelled";
  return [
    "BEGIN:VEVENT",
    `UID:${bookingUid(booking.id)}`,
    `DTSTAMP:${toIcsUtc(booking.cancelled_at || booking.created_at || new Date())}`,
    `SEQUENCE:${cancelled ? 1 : 0}`,
    `DTSTART:${toIcsUtc(booking.start_at)}`,
    `DTEND:${toIcsUtc(booking.end_at)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    ...(description ? [`DESCRIPTION:${escapeIcsText(description)}`] : []),
    ...(url ? [`URL:${url}`] : []),
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ];
}

function wrap(events, name) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Waddle//Bookings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...(name ? [`X-WR-CALNAME:${escapeIcsText(name)}`] : []),
    ...events,
    "END:VCALENDAR",
  ]
    .map(foldLine)
    .join("\r\n") + "\r\n";
}

/** The guest's copy of one booking. Same UID as the owner's feed, so re-adding updates in place. */
export function buildGuestIcs(booking, { ownerName, pageTitle, cancelUrl = "" }) {
  const title = `${pageTitle || "Meeting"} with ${ownerName || "your host"}`;
  const description = cancelUrl ? `Need to cancel? ${cancelUrl}` : "";
  return wrap(eventLines(booking, { title, description, url: cancelUrl }), null);
}

/** The owner's subscribed feed: every booking, cancelled ones marked so calendars drop them. */
export function buildOwnerFeed(bookings, { pageTitle }) {
  const events = bookings.flatMap((booking) =>
    eventLines(booking, {
      title: `${pageTitle || "Meeting"}: ${booking.guest_name}`,
      description: [booking.guest_email, booking.note].filter(Boolean).join("\n\n"),
    })
  );
  return wrap(events, "Waddle bookings");
}
