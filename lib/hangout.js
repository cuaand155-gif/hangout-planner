// What happens around a pencilled-in plan: voting on candidate times,
// repeating it, and who's coming.
//
// All of it lives on `state.plan` in the shared group blob:
//   plan.timeVotes = { "<start ISO>": [memberId, …] }   votes on suggested windows
//   plan.repeat    = "none" | "weekly" | "biweekly" | "monthly"
//   plan.timeZone  = IANA zone the time was picked in, so a repeat keeps its
//                    wall-clock time across daylight-saving changes
//   plan.rsvp      = { at: "<occurrence ISO>", answers: { memberId: "yes"|"maybe"|"no" } }
//
// RSVPs belong to one occurrence: when a repeating plan moves on to its next
// date, or the time is changed, last time's answers stop counting.

import { isValidTimeZone, zonedParts, zonedToUtc } from "./booking.js";

export const REPEATS = [
  { key: "none", label: "Just once" },
  { key: "weekly", label: "Every week" },
  { key: "biweekly", label: "Every 2 weeks" },
  { key: "monthly", label: "Every month" },
];
export const RSVP_ANSWERS = ["yes", "maybe", "no"];
const MAX_TIME_OPTIONS = 12;
const REPEAT_KEYS = new Set(REPEATS.map((entry) => entry.key));

export function normalizeRepeat(value) {
  return REPEAT_KEYS.has(value) ? value : "none";
}

const validDate = (value) => value && !Number.isNaN(new Date(value).getTime());
const cleanId = (value) => String(value ?? "").trim().slice(0, 40);

/** Keeps at most a dozen voted times, each with unique voter ids. */
export function normalizeTimeVotes(input, memberIds) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const entries = Object.entries(input)
    .filter(([key, voters]) => validDate(key) && Array.isArray(voters))
    .map(([key, voters]) => [
      new Date(key).toISOString(),
      [...new Set(voters.map(cleanId).filter((id) => id && (!memberIds || memberIds.has(id))))],
    ])
    .filter(([, voters]) => voters.length)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, MAX_TIME_OPTIONS);
  return Object.fromEntries(entries);
}

export function normalizeRsvp(input, memberIds) {
  if (!input || typeof input !== "object" || !validDate(input.at)) return null;
  const answers = {};
  for (const [id, answer] of Object.entries(input.answers || {})) {
    const key = cleanId(id);
    if (!key || !RSVP_ANSWERS.includes(answer)) continue;
    if (memberIds && !memberIds.has(key)) continue;
    answers[key] = answer;
  }
  return { at: new Date(input.at).toISOString(), answers };
}

/** Adds weeks or months in wall-clock time; months that lack the day are skipped, as RRULE does. */
function step(parts, repeat, count) {
  if (repeat === "monthly") {
    const total = parts.month - 1 + count;
    const year = parts.year + Math.floor(total / 12);
    const month = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return parts.day > lastDay ? null : { ...parts, year, month };
  }
  const days = count * (repeat === "biweekly" ? 14 : 7);
  const moved = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { ...parts, year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/**
 * The occurrence to show: the chosen time itself, or for a repeating plan the
 * first one that hasn't ended yet. Returns { start, end } Dates, or null.
 */
export function nextOccurrence(plan, now = new Date()) {
  if (!validDate(plan?.chosen)) return null;
  const start = new Date(plan.chosen);
  const end = validDate(plan.chosenEnd) && new Date(plan.chosenEnd) > start ? new Date(plan.chosenEnd) : new Date(start.getTime() + 2 * 3600 * 1000);
  const repeat = normalizeRepeat(plan.repeat);
  if (repeat === "none" || end > now) return { start, end };
  const zone = isValidTimeZone(plan.timeZone) ? plan.timeZone : "UTC";
  const length = end - start;
  const first = zonedParts(start, zone);
  // Jump close to now, then walk forward; bounded so bad data can't spin.
  const perStep = repeat === "monthly" ? 28 : repeat === "biweekly" ? 14 : 7;
  let count = Math.max(1, Math.floor((now - end) / (perStep * 24 * 3600 * 1000)) - 1);
  for (let guard = 0; guard < 500; guard += 1, count += 1) {
    const parts = step(first, repeat, count);
    if (!parts) continue;
    const next = zonedToUtc(parts, zone);
    if (next.getTime() + length > now.getTime()) return { start: next, end: new Date(next.getTime() + length) };
  }
  return null;
}

export function rruleFor(repeat) {
  switch (normalizeRepeat(repeat)) {
    case "weekly":
      return "FREQ=WEEKLY";
    case "biweekly":
      return "FREQ=WEEKLY;INTERVAL=2";
    case "monthly":
      return "FREQ=MONTHLY";
    default:
      return null;
  }
}

export function repeatLabel(repeat) {
  return REPEATS.find((entry) => entry.key === normalizeRepeat(repeat)).label;
}

/** This occurrence's answers; answers given for an earlier date don't count. */
export function rsvpAnswers(plan, occurrence) {
  if (!plan?.rsvp || !occurrence) return {};
  return new Date(plan.rsvp.at).getTime() === occurrence.start.getTime() ? plan.rsvp.answers : {};
}

/** Counts plus who said what, for members still in the group. */
export function rsvpSummary(plan, occurrence, members) {
  const answers = rsvpAnswers(plan, occurrence);
  const groups = { yes: [], maybe: [], no: [], waiting: [] };
  for (const member of members) groups[answers[member.id] || "waiting"].push(member);
  return groups;
}

/** Sets (or, when repeated, clears) one member's answer for this occurrence. */
export function applyRsvp(plan, occurrence, memberId, answer) {
  const answers = { ...rsvpAnswers(plan, occurrence) };
  if (answers[memberId] === answer || !RSVP_ANSWERS.includes(answer)) delete answers[memberId];
  else answers[memberId] = answer;
  return { at: occurrence.start.toISOString(), answers };
}

/** Toggles a member's vote on a candidate time. */
export function toggleTimeVote(timeVotes, startIso, memberId) {
  const key = new Date(startIso).toISOString();
  const voters = new Set(timeVotes?.[key] || []);
  if (voters.has(memberId)) voters.delete(memberId);
  else voters.add(memberId);
  const next = { ...(timeVotes || {}) };
  if (voters.size) next[key] = [...voters];
  else delete next[key];
  return next;
}
