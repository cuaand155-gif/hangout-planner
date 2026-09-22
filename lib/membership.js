// Deciding which member row belongs to the person at the keyboard.
//
// This is the one place that can create a duplicate person, so it is kept pure
// and tested. The rules, in order:
//
//   1. A row already carrying this account's user id is this person.
//   2. A pending invite addressed to this account's email is this person,
//      claimed rather than duplicated.
//   3. The row this browser created before is this person.
//   4. Otherwise there is no row yet and one is created.
//
// When two rows turn out to be the same person (an anonymous row made before
// signing in, plus an invite waiting for that email), the older row is absorbed
// into the claimed one instead of both being left behind.

import { initialsFor } from "./planner.js";

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hasAvailability(member) {
  return Boolean(member && ((member.busy && member.busy.length) || (member.weekly && member.weekly.length)));
}

/**
 * Works out which member row to use. Returns a plan rather than mutating, so
 * it can be recomputed against fresh state when a save has to be retried.
 */
export function resolveMembership({ members = [], localMemberId = null, user = null } = {}) {
  const email = normalizeEmail(user?.email);
  const local = members.find((member) => member.id === localMemberId) || null;

  if (user) {
    const byAccount = members.find((member) => member.userId === user.id);
    if (byAccount) {
      const absorb = local && local.id !== byAccount.id ? local.id : null;
      return { action: "reuse", id: byAccount.id, absorb };
    }

    if (email) {
      const invited = members.find(
        (member) => member.pending && normalizeEmail(member.email) === email && member.id !== localMemberId
      );
      if (invited) {
        return { action: "claim", id: invited.id, absorb: local ? local.id : null };
      }
    }
  }

  if (local) return { action: "attach", id: local.id, absorb: null };
  return { action: "create", id: null, absorb: null };
}

/** The same decision for somebody with no account, claiming an invite by hand. */
export function planManualClaim({ members = [], localMemberId = null, targetId }) {
  const target = members.find((member) => member.id === targetId);
  if (!target) return null;
  if (target.id === localMemberId) return null;
  if (!target.pending) return null;
  const local = members.find((member) => member.id === localMemberId) || null;
  return { action: "claim", id: target.id, absorb: local ? local.id : null };
}

/**
 * Carries one row's availability and votes over to another, then drops it.
 * Availability only moves into a row that has none, so claiming an invite
 * never overwrites times the invite already collected.
 */
export function absorbMember(draft, fromId, intoId) {
  if (!fromId || fromId === intoId) return;
  const source = draft.members.find((member) => member.id === fromId);
  const target = draft.members.find((member) => member.id === intoId);
  if (!source || !target) return;

  if (!hasAvailability(target) && hasAvailability(source)) {
    target.busy = source.busy || [];
    target.weekly = source.weekly || [];
    if (source.coverage) target.coverage = source.coverage;
  }
  if (!target.email && source.email) target.email = source.email;

  for (const idea of draft.ideas || []) {
    if (!Array.isArray(idea.votes)) continue;
    idea.votes = [...new Set(idea.votes.map((vote) => (vote === fromId ? intoId : vote)))];
  }
  if (draft.ownerId === fromId) draft.ownerId = intoId;
  draft.members = draft.members.filter((member) => member.id !== fromId);
}

/**
 * Finds the row that already represents a person before adding them again.
 * An account id or email is proof; a matching name only counts when nobody has
 * claimed that row with an account, since two accounts may share a name.
 */
export function findMemberForParty(members = [], party = {}) {
  const email = normalizeEmail(party.email);
  const name = String(party.name || "").trim().toLowerCase();

  return (
    (party.id && members.find((member) => member.userId === party.id)) ||
    (email && members.find((member) => normalizeEmail(member.email) === email)) ||
    (name && members.find((member) => !member.userId && String(member.name).trim().toLowerCase() === name)) ||
    null
  );
}

/** Links an existing row to an account instead of adding a second row. */
export function linkMemberToParty(member, party) {
  if (!member || !party) return member;
  if (party.id) member.userId = party.id;
  if (party.email) member.email = normalizeEmail(party.email);
  member.updatedAt = new Date().toISOString();
  return member;
}

/**
 * Applies a plan to a draft workspace and returns the member id to use from
 * now on. `createId` is injected so tests stay deterministic.
 */
export function applyMembership(draft, plan, { user = null, name, sharesSchedule = true, palettes = [], createId } = {}) {
  if (!plan) return null;
  const now = new Date().toISOString();

  if (plan.action === "create") {
    const id = createId();
    draft.members.push({
      id,
      name,
      initials: initialsFor(name),
      palette: palettes[draft.members.length % palettes.length],
      ...(user ? { userId: user.id } : {}),
      ...(user?.email ? { email: normalizeEmail(user.email) } : {}),
      sharesSchedule,
      pending: false,
      weekly: [],
      busy: [],
      updatedAt: now,
    });
    if (user && !draft.ownerId) draft.ownerId = user.id;
    return id;
  }

  const member = draft.members.find((entry) => entry.id === plan.id);
  if (!member) return null;

  if (plan.absorb) absorbMember(draft, plan.absorb, member.id);

  // A claimed invite keeps its place in the group but takes the new person's
  // own name, rather than whatever the inviter typed.
  if (name) {
    member.name = name;
    member.initials = initialsFor(name);
  }
  member.pending = false;
  member.sharesSchedule = sharesSchedule;
  if (user) {
    member.userId = user.id;
    if (user.email) member.email = normalizeEmail(user.email);
    if (!draft.ownerId) draft.ownerId = user.id;
  }
  member.updatedAt = now;
  return member.id;
}
