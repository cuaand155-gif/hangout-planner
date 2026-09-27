// "Always busy": times you never want to be booked or planned over, such as
// work 9–5 on weekdays or sleep 11 pm – 7 am every night.
//
// A rule is { id, days: [0..6], start: "HH:MM", end: "HH:MM", label }. Sunday
// is 0, like Date#getDay(). An end at or before the start runs past midnight
// into the next morning. The label is yours only: groups, friends and booking
// links get the busy time, never the label (see rulesForGroup).

export const BLOCK_LIMIT = 20;

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One-tap starting points for the most common rules. */
export const BLOCK_PRESETS = [
  { key: "work", label: "Work", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  { key: "school", label: "School", days: [1, 2, 3, 4, 5], start: "08:30", end: "15:30" },
  { key: "sleep", label: "Sleep", days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" },
];

const TIME = /^(\d{1,2}):(\d{2})$/;

/** Minutes after midnight for "HH:MM" (24:00 allowed as the end of a day), or null. */
export function toMinutes(value) {
  const match = TIME.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute > 0)) return null;
  return hour * 60 + minute;
}

function clock(minutes) {
  const value = minutes % (24 * 60);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function ruleId(rule) {
  return `b-${rule.days.join("")}-${rule.start.replace(":", "")}-${rule.end.replace(":", "")}`;
}

/**
 * Repairs a stored list: bad rules are dropped, days are sorted and unique,
 * and the same days and times never appear twice.
 */
export function normalizeBlocked(list, { labels = true } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const rules = [];
  for (const raw of list) {
    const days = [...new Set((Array.isArray(raw?.days) ? raw.days : []).map(Number))]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((a, b) => a - b);
    const start = toMinutes(raw?.start);
    const end = toMinutes(raw?.end);
    if (!days.length || start === null || end === null || start === end || start >= 24 * 60) continue;
    const rule = { days, start: clock(start), end: end === 24 * 60 ? "24:00" : clock(end) };
    const key = ruleId(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = labels ? String(raw?.label || "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
    rules.push({ id: key, ...rule, ...(label ? { label } : {}) });
    if (rules.length >= BLOCK_LIMIT) break;
  }
  return rules;
}

/** What a group or friend gets: the times, never your labels. */
export function rulesForGroup(rules) {
  return normalizeBlocked(rules, { labels: false }).map(({ days, start, end }) => ({ days, start, end }));
}

/** Adds a rule unless the same one is already there. Returns a new list. */
export function addRule(rules, rule) {
  return normalizeBlocked([...(Array.isArray(rules) ? rules : []), rule]);
}

export function removeRule(rules, id) {
  return normalizeBlocked((Array.isArray(rules) ? rules : []).filter((rule) => normalizeBlocked([rule])[0]?.id !== id));
}

function at(date, minutes) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  value.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return value;
}

/**
 * Busy blocks the rules put on one calendar day, as { start, end } in
 * milliseconds. An overnight rule shows up twice: its evening on the day it
 * starts, and the rest of the night on the next morning. Local clock times,
 * so 9–5 stays 9–5 across daylight-saving changes.
 */
export function blockedBlocksOn(rules, date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const weekday = day.getDay();
  const yesterday = (weekday + 6) % 7;
  const nextMidnight = new Date(day);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  const blocks = [];
  for (const rule of normalizeBlocked(rules, { labels: false })) {
    const start = toMinutes(rule.start);
    const end = toMinutes(rule.end);
    const overnight = end <= start;
    if (rule.days.includes(weekday)) {
      blocks.push({ start: at(day, start).getTime(), end: overnight ? nextMidnight.getTime() : at(day, end).getTime() });
    }
    if (overnight && end > 0 && rule.days.includes(yesterday)) {
      blocks.push({ start: day.getTime(), end: at(day, end).getTime() });
    }
  }
  return blocks.filter((block) => block.end > block.start).sort((a, b) => a.start - b.start);
}

/**
 * The rules as dated events between two dates, for friends and your booking
 * link. No titles: an always-busy time only ever reads as busy.
 */
export function blockedEvents(rules, from, to) {
  const events = [];
  if (!normalizeBlocked(rules).length) return events;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  const end = new Date(to).getTime();
  for (let guard = 0; day.getTime() < end && guard < 400; guard += 1) {
    for (const block of blockedBlocksOn(rules, day)) {
      events.push({ start: new Date(block.start).toISOString(), end: new Date(block.end).toISOString(), blocked: true });
    }
    day.setDate(day.getDate() + 1);
  }
  // An overnight block is split at midnight; join the halves back up.
  const joined = [];
  for (const event of events) {
    const last = joined[joined.length - 1];
    if (last && last.end === event.start) last.end = event.end;
    else joined.push({ ...event });
  }
  return joined;
}

function formatClockText(value) {
  const minutes = toMinutes(value);
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute ? `${twelve}:${String(minute).padStart(2, "0")} ${suffix}` : `${twelve} ${suffix}`;
}

/** "Mon–Fri", "Every day", "Weekends", "Mon, Wed, Fri". */
export function describeDays(days) {
  const list = [...new Set(days)].sort((a, b) => a - b);
  if (list.length === 7) return "Every day";
  if (list.join() === "0,6") return "Weekends";
  const consecutive = list.length > 2 && list.every((day, index) => index === 0 || day === list[index - 1] + 1);
  if (consecutive) return `${DAY_NAMES[list[0]]}–${DAY_NAMES[list[list.length - 1]]}`;
  return list.map((day) => DAY_NAMES[day]).join(", ");
}

/** "Mon–Fri · 9 am – 5 pm", with "(overnight)" when it runs past midnight. */
export function describeRule(rule) {
  const overnight = toMinutes(rule.end) <= toMinutes(rule.start);
  return `${describeDays(rule.days)} · ${formatClockText(rule.start)} – ${formatClockText(rule.end)}${overnight ? " (overnight)" : ""}`;
}
