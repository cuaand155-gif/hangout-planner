// Invite links as a capability: somebody with the group's link can join with
// just a name, mark when they're busy, vote on times and RSVP, without an
// account. Pure and shared by the browser (app.js) and the server
// (api/workspace.js), so the rules are tested once and enforced server-side.
//
// How a guest is recognised:
//   * the link carries the group's invite code (state.invite.code);
//   * the guest's browser makes a random token and keeps it in localStorage;
//   * the server stores only a SHA-256 hash of that token (state.guests) and
//     accepts a guest's writes only while the invite code is still live.
// Turning the link off, or making a new one, locks every guest out at once;
// signed-in members are unaffected.
//
// What a guest sees (guestView): busy/free and the plan itself. Never event
// names or places (even when the group allows event details), never emails,
// account ids, the invite secret or anyone's token hash.

import { INVITE_CODE_PATTERN, createId, initialsFor, normalizeWorkspaceState } from "./planner.js";
import { COMMENT_LIMITS, RSVP_ANSWERS, addComment, nextOccurrence, rsvpAnswers } from "./hangout.js";

export const GUEST_TOKEN_PATTERN = /^[a-f0-9]{32,128}$/;
export const GUEST_LIMITS = {
  // Writes per guest within one window: generous for painting a week by hand.
  writes: 40,
  windowMs: 5 * 60 * 1000,
  // New guests per group per hour, so a leaked link can't flood the group.
  joins: 20,
  joinWindowMs: 60 * 60 * 1000,
  name: 60,
  timeOptions: 12,
};

/* ------------------------------------------------------------ secrets */

function randomBytes(count) {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** A random hex token (the guest's own proof, kept in their browser). */
export function newGuestToken() {
  return [...randomBytes(24)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A random URL-safe invite code (24 characters). */
export function newInviteCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return [...randomBytes(24)].map((byte) => alphabet[byte & 63]).join("");
}

export function isInviteCode(value) {
  return typeof value === "string" && INVITE_CODE_PATTERN.test(value);
}

export function isGuestToken(value) {
  return typeof value === "string" && GUEST_TOKEN_PATTERN.test(value);
}

/** SHA-256 of a token, as hex. Only this hash is ever stored. */
export async function hashToken(token) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without stopping at the first difference. */
export function sameSecret(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/* -------------------------------------------------------------- rules */

/** The link works: the group has a code, it matches, and it hasn't been turned off. */
export function inviteIsLive(state, code) {
  return Boolean(state?.invite?.code && !state.invite.revoked && isInviteCode(code) && sameSecret(code, state.invite.code));
}

/** The guest member a token belongs to, or null. */
export async function guestForToken(state, token) {
  if (!isGuestToken(token)) return null;
  const hash = await hashToken(token);
  for (const [memberId, entry] of Object.entries(state?.guests || {})) {
    if (sameSecret(entry.hash, hash) && state.members.some((member) => member.id === memberId && member.guest)) return memberId;
  }
  return null;
}

/**
 * Counts one write in a fixed window. Returns the updated counter, or null
 * when the limit is reached (nothing is written then).
 */
export function countWrite(counter, now = Date.now(), { limit = GUEST_LIMITS.writes, windowMs = GUEST_LIMITS.windowMs } = {}) {
  const since = Number(counter?.since) || 0;
  const count = Number(counter?.count) || 0;
  if (now - since >= windowMs) return { since: now, count: 1 };
  if (count >= limit) return null;
  return { since, count: count + 1 };
}

/* -------------------------------------------------------------- views */

/** Busy blocks without names or places: what a guest may see of anyone. */
function plainBusy(blocks) {
  return (blocks || []).map((block) => ({ start: block.start, end: block.end, source: block.source }));
}

function plainWeekly(blocks) {
  return (blocks || []).map((block) => ({ weekday: block.weekday, start: block.start, end: block.end }));
}

/**
 * The group as a guest may see it: everyone's busy/free and the plan, with
 * every event name and place removed (whatever the group's privacy setting),
 * and no emails, account ids, owner id, invite code or token hashes.
 */
export function guestView(state) {
  const copy = structuredClone(state);
  delete copy.invite;
  delete copy.guests;
  delete copy.ownerId;
  copy.privacy = "busy";
  copy.members = (copy.members || []).map((member) => {
    const { email, userId, ...rest } = member;
    return { ...rest, ...(userId ? { hasAccount: true } : {}), busy: plainBusy(member.busy), weekly: plainWeekly(member.weekly) };
  });
  return copy;
}

/** The group as a signed-in member sees it: everything except the guests' token hashes. */
export function memberView(state) {
  const copy = structuredClone(state);
  delete copy.guests;
  return copy;
}

/* -------------------------------------------------------------- writes */

/** A new guest's member row. `id` is used when it's free and well formed. */
export function addGuest(state, { name, hash, id, now = new Date() }) {
  const draft = structuredClone(state);
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, GUEST_LIMITS.name);
  const taken = new Set(draft.members.map((member) => member.id));
  const memberId = typeof id === "string" && /^member_[a-z0-9]{6,32}$/.test(id) && !taken.has(id) ? id : createId("member");
  draft.members.push({
    id: memberId,
    name: clean,
    initials: initialsFor(clean),
    guest: true,
    pending: false,
    sharesSchedule: true,
    weekly: [],
    busy: [],
    updatedAt: now.toISOString(),
  });
  draft.guests = { ...(draft.guests || {}), [memberId]: { hash, joinedAt: now.toISOString(), since: 0, count: 0 } };
  draft.activity = [{ message: `${clean} joined as a guest`, at: now.toISOString() }, ...(draft.activity || [])];
  return { state: normalizeWorkspaceState(draft), memberId };
}

const validDate = (value) => value !== null && value !== undefined && value !== "" && !Number.isNaN(new Date(value).getTime());

/**
 * Applies what a guest is allowed to change, and nothing else: their own busy
 * times and name, their own votes on times and ideas, their own RSVP for the
 * plan's next date, and their own comments on the plan (add or delete; the
 * server stamps the time of a new one). Everything else in `update` is ignored. Returns the
 * new state and how many votes changed (for counting), or null when the member
 * is not a guest.
 */
export function applyGuestUpdate(state, memberId, update = {}, now = new Date()) {
  const draft = structuredClone(state);
  const member = draft.members.find((entry) => entry.id === memberId && entry.guest);
  if (!member) return null;
  let votes = 0;

  const self = update.self && typeof update.self === "object" ? update.self : null;
  if (self) {
    // Guests paint busy time by hand: never a name or a place.
    if (Array.isArray(self.busy)) member.busy = self.busy.map((block) => ({ start: block?.start, end: block?.end, source: "manual" }));
    if (Array.isArray(self.weekly)) member.weekly = plainWeekly(self.weekly);
    if (self.coverage === null) delete member.coverage;
    else if (self.coverage && typeof self.coverage === "object") member.coverage = { from: self.coverage.from, to: self.coverage.to };
    if (typeof self.sharesSchedule === "boolean") member.sharesSchedule = self.sharesSchedule;
    const name = typeof self.name === "string" ? self.name.replace(/\s+/g, " ").trim().slice(0, GUEST_LIMITS.name) : "";
    if (name && name !== member.name) {
      member.name = name;
      member.initials = initialsFor(name);
    }
    member.updatedAt = now.toISOString();
  }

  if (draft.plan && Array.isArray(update.timeVotes)) {
    const wanted = new Set(update.timeVotes.filter(validDate).map((value) => new Date(value).toISOString()));
    const current = draft.plan.timeVotes || {};
    const next = {};
    for (const [key, voters] of Object.entries(current)) {
      const had = voters.includes(memberId);
      const kept = voters.filter((id) => id !== memberId);
      if (wanted.has(key)) kept.push(memberId);
      if (had !== wanted.has(key)) votes += 1;
      if (kept.length) next[key] = kept;
    }
    for (const key of wanted) {
      if (next[key] || current[key]) continue;
      // Only times that are still to come, and no more options than the plan holds.
      if (new Date(key) <= now || Object.keys(next).length >= GUEST_LIMITS.timeOptions) continue;
      next[key] = [memberId];
      votes += 1;
    }
    draft.plan.timeVotes = next;
  }

  if (draft.plan && update.rsvp && typeof update.rsvp === "object") {
    const occurrence = nextOccurrence(draft.plan, now);
    if (occurrence && validDate(update.rsvp.at) && new Date(update.rsvp.at).getTime() === occurrence.start.getTime()) {
      const answers = { ...rsvpAnswers(draft.plan, occurrence) };
      if (RSVP_ANSWERS.includes(update.rsvp.answer)) answers[memberId] = update.rsvp.answer;
      else delete answers[memberId];
      draft.plan.rsvp = { at: occurrence.start.toISOString(), answers };
    }
  }

  // `update.comments` = { planId, keep: [ids of the guest's comments still
  // there], add: [{ id, text }] new ones }. Only for the plan the guest saw,
  // so a stale page never brings old comments back or onto a new plan.
  const comments = update.comments && typeof update.comments === "object" ? update.comments : null;
  if (draft.plan && comments && comments.planId && comments.planId === draft.plan.id) {
    const current = draft.plan.comments || [];
    const keep = new Set((Array.isArray(comments.keep) ? comments.keep : []).map((id) => String(id).slice(0, 40)));
    let next = current.filter((comment) => comment.memberId !== memberId || keep.has(comment.id));
    for (const raw of (Array.isArray(comments.add) ? comments.add : []).slice(0, 5)) {
      const id = typeof raw?.id === "string" ? raw.id.slice(0, 40) : "";
      if (!id || typeof raw.text !== "string" || current.some((comment) => comment.id === id)) continue;
      // A guest never pushes other people's comments out: once the plan is
      // full, or they have their share, their new ones wait.
      if (next.length >= COMMENT_LIMITS.perPlan) break;
      if (next.filter((comment) => comment.memberId === memberId).length >= COMMENT_LIMITS.perPerson) break;
      next = addComment(next, { id, memberId, text: raw.text, at: now });
    }
    if (next.length !== current.length || next.some((comment, index) => comment.id !== current[index]?.id)) votes += 1;
    draft.plan.comments = next;
  }

  if (Array.isArray(update.ideaVotes)) {
    const wanted = new Set(update.ideaVotes.map(String));
    for (const idea of draft.ideas || []) {
      const had = idea.votes.includes(memberId);
      if (had === wanted.has(idea.id)) continue;
      idea.votes = had ? idea.votes.filter((id) => id !== memberId) : [...idea.votes, memberId];
      votes += 1;
    }
  }

  return { state: normalizeWorkspaceState(draft), votes };
}

/**
 * What the guest's browser sends after an edit: their own row and their own
 * votes, read from the state the edit produced (see app.js). `before` is the
 * state the edit started from, which tells new comments from old ones.
 */
export function guestUpdateFrom(state, memberId, now = new Date(), before = state) {
  const member = state.members.find((entry) => entry.id === memberId);
  const update = {
    self: member
      ? { busy: plainBusy(member.busy), weekly: plainWeekly(member.weekly), coverage: member.coverage || null, name: member.name, sharesSchedule: member.sharesSchedule !== false }
      : undefined,
    ideaVotes: (state.ideas || []).filter((idea) => idea.votes.includes(memberId)).map((idea) => idea.id),
  };
  if (state.plan) {
    update.timeVotes = Object.entries(state.plan.timeVotes || {}).filter(([, voters]) => voters.includes(memberId)).map(([key]) => key);
    // Comments: which of theirs are still there, and which are new since `before`.
    const mine = (state.plan.comments || []).filter((comment) => comment.memberId === memberId);
    const had = new Set(((before?.plan?.id === state.plan.id && before.plan.comments) || []).map((comment) => comment.id));
    update.comments = {
      planId: state.plan.id,
      keep: mine.filter((comment) => had.has(comment.id)).map((comment) => comment.id),
      add: mine.filter((comment) => !had.has(comment.id)).map(({ id, text }) => ({ id, text })),
    };
    const occurrence = nextOccurrence(state.plan, now);
    if (occurrence) update.rsvp = { at: occurrence.start.toISOString(), answer: rsvpAnswers(state.plan, occurrence)[memberId] || null };
  }
  return update;
}

/** Removes a guest; their votes and RSVP go with them (normalization drops votes by unknown ids). */
export function removeGuest(state, memberId, now = new Date()) {
  const member = state.members.find((entry) => entry.id === memberId && entry.guest);
  if (!member) return null;
  const draft = structuredClone(state);
  draft.members = draft.members.filter((entry) => entry.id !== memberId);
  if (draft.guests) delete draft.guests[memberId];
  draft.activity = [{ message: `${member.name} was removed`, at: now.toISOString() }, ...(draft.activity || [])];
  return normalizeWorkspaceState(draft);
}
