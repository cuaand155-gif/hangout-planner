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

/* ------------------------------------------------- the best time, suggested */

const DAY_MS = 24 * 3600 * 1000;

/**
 * Picks the time to suggest from the plan's candidate times: the most votes
 * wins, then the most people free, then the soonest. `options` are
 * { start, end, voters: [ids], free: number } and `memberCount` is the size of
 * the group. Returns the winner with a short `reason`, or null when nothing is
 * still to come. Nothing is picked for the group: it is only a suggestion.
 */
export function suggestBestTime(options, { memberCount = 0, now = new Date() } = {}) {
  const ranked = (options || [])
    .filter((option) => option && new Date(option.start) > now)
    .map((option) => ({ ...option, votes: (option.voters || []).length, free: Number.isFinite(option.free) ? option.free : 0 }))
    .sort((a, b) => b.votes - a.votes || b.free - a.free || new Date(a.start) - new Date(b.start));
  if (!ranked.length) return null;
  const [best, next] = ranked;
  const parts = [];
  if (best.votes) parts.push(`${best.votes} vote${best.votes === 1 ? "" : "s"}`);
  if (memberCount && best.free >= memberCount) parts.push(memberCount === 1 ? "you're free" : "everyone's free");
  else if (memberCount) parts.push(`${best.free} of ${memberCount} free`);
  if (next && next.votes === best.votes && next.free === best.free) parts.push("soonest");
  return { ...best, reason: parts.join(" · ") };
}

/* ------------------------------------------------------- plan comments */

// plan.comments = [{ id, memberId, text, at }], oldest first.
export const COMMENT_LIMITS = { text: 500, perPlan: 100, perPerson: 30 };

function commentText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, COMMENT_LIMITS.text);
}

/** Tidies stored comments: valid ones only, by people still in the group, oldest first, the latest 100. */
export function normalizeComments(input, memberIds) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const comments = [];
  for (const raw of input) {
    const id = cleanId(raw?.id);
    const memberId = cleanId(raw?.memberId);
    const text = commentText(raw?.text);
    if (!id || !memberId || !text || !validDate(raw?.at) || seen.has(id)) continue;
    if (memberIds && !memberIds.has(memberId)) continue;
    seen.add(id);
    comments.push({ id, memberId, text, at: new Date(raw.at).toISOString() });
  }
  return comments.sort((a, b) => a.at.localeCompare(b.at)).slice(-COMMENT_LIMITS.perPlan);
}

/** Adds a comment (ignored when empty or the id is already there). Returns a new list. */
export function addComment(comments, { id, memberId, text, at = new Date() }) {
  const list = Array.isArray(comments) ? comments : [];
  const clean = commentText(text);
  if (!clean || !id || !memberId || list.some((comment) => comment.id === id)) return list;
  return [...list, { id, memberId, text: clean, at: new Date(at).toISOString() }].slice(-COMMENT_LIMITS.perPlan);
}

/** Removes a comment, but only one `memberId` wrote. Returns a new list. */
export function removeComment(comments, id, memberId) {
  return (Array.isArray(comments) ? comments : []).filter((comment) => !(comment.id === id && comment.memberId === memberId));
}

/**
 * The comments to keep when a signed-in member saves the whole group: the
 * stored ones from everyone else, untouched, plus the caller's own as they
 * sent them (only deletions and new ones; a new one gets the server's time).
 * A plan with a new id starts with no comments. `callerId` is the caller's
 * member id, or null when they have no row (then nothing of theirs is taken).
 */
export function mergeMemberComments(storedPlan, incomingPlan, callerId, now = new Date()) {
  const base = storedPlan && incomingPlan && storedPlan.id && storedPlan.id === incomingPlan.id ? storedPlan.comments || [] : [];
  const sent = (incomingPlan?.comments || []).filter((comment) => callerId && comment.memberId === callerId);
  const sentIds = new Set(sent.map((comment) => comment.id));
  const kept = base.filter((comment) => comment.memberId !== callerId || sentIds.has(comment.id));
  const added = sent
    .filter((comment) => !base.some((existing) => existing.id === comment.id))
    .map((comment) => ({ ...comment, at: new Date(now).toISOString() }));
  return [...kept, ...added].sort((a, b) => a.at.localeCompare(b.at));
}
