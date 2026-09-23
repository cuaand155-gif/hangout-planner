import test from "node:test";
import assert from "node:assert/strict";
import { absorbMember, applyMembership, findMemberForParty, linkMemberToParty, planManualClaim, resolveMembership } from "../lib/membership.js";
import { AVATAR_PALETTES, normalizeWorkspaceState } from "../lib/planner.js";

const user = { id: "user-1", email: "Jordan@Example.com" };
let counter = 0;
const createId = () => `new_${++counter}`;
const apply = (draft, plan, extra = {}) =>
  applyMembership(draft, plan, { user, name: "Jordan Lee", palettes: AVATAR_PALETTES, createId, ...extra });

const workspace = (members, ideas = []) => normalizeWorkspaceState({ members, ideas });

test("an account that already has a row reuses it", () => {
  const state = workspace([{ id: "m1", name: "Jordan Lee", userId: "user-1" }, { id: "m2", name: "Sam" }]);
  const plan = resolveMembership({ members: state.members, localMemberId: "m1", user });
  assert.deepEqual(plan, { action: "reuse", id: "m1", absorb: null });
});

test("a pending invite for this email is claimed, not duplicated", () => {
  const state = workspace([
    { id: "host", name: "Alexi" },
    { id: "invite", name: "Jordan", email: "jordan@example.com", pending: true },
  ]);
  const plan = resolveMembership({ members: state.members, localMemberId: null, user });
  assert.deepEqual(plan, { action: "claim", id: "invite", absorb: null });

  const draft = structuredClone(state);
  const id = apply(draft, plan);
  assert.equal(id, "invite");
  assert.equal(draft.members.length, 2, "no second row for Jordan");
  assert.equal(draft.members[1].pending, false);
  assert.equal(draft.members[1].userId, "user-1");
  assert.equal(draft.members[1].name, "Jordan Lee", "the claimer's own name wins");
  assert.equal(draft.members[1].email, "jordan@example.com", "the email is stored lower cased");
});

test("email matching ignores case and surrounding space", () => {
  const state = workspace([{ id: "invite", name: "Jordan", email: "  JORDAN@example.COM ", pending: true }]);
  const plan = resolveMembership({ members: state.members, localMemberId: null, user });
  assert.equal(plan.action, "claim");
});

test("an already accepted member is not re-claimed by email", () => {
  const state = workspace([{ id: "m1", name: "Jordan", email: "jordan@example.com", pending: false }]);
  const plan = resolveMembership({ members: state.members, localMemberId: null, user });
  assert.equal(plan.action, "create", "only pending invites can be claimed");
});

test("signing in after adding times merges the two rows into one", () => {
  const state = workspace(
    [
      { id: "anon", name: "You", busy: [{ start: "2026-09-21T10:00:00Z", end: "2026-09-21T12:00:00Z", source: "manual" }], coverage: { from: "2026-09-21", to: "2026-09-27" } },
      { id: "invite", name: "Jordan", email: "jordan@example.com", pending: true },
    ],
    [{ id: "idea1", title: "Brunch", votes: ["anon"] }]
  );

  const plan = resolveMembership({ members: state.members, localMemberId: "anon", user });
  assert.deepEqual(plan, { action: "claim", id: "invite", absorb: "anon" });

  const draft = structuredClone(state);
  const id = apply(draft, plan);
  assert.equal(id, "invite");
  assert.deepEqual(draft.members.map((member) => member.id), ["invite"], "the anonymous row is gone");
  assert.equal(draft.members[0].busy.length, 1, "availability came across");
  assert.deepEqual(draft.members[0].coverage, { from: "2026-09-21", to: "2026-09-27" });
  assert.deepEqual(draft.ideas[0].votes, ["invite"], "votes follow the person");
});

test("claiming never overwrites times the invite already collected", () => {
  const state = workspace([
    { id: "anon", name: "You", busy: [{ start: "2026-09-21T10:00:00Z", end: "2026-09-21T11:00:00Z", source: "manual" }] },
    { id: "invite", name: "Jordan", email: "jordan@example.com", pending: true, weekly: [{ weekday: 2, start: "09:00", end: "10:00" }] },
  ]);
  const draft = structuredClone(state);
  apply(draft, resolveMembership({ members: state.members, localMemberId: "anon", user }));
  assert.equal(draft.members.length, 1);
  assert.deepEqual(draft.members[0].weekly, [{ weekday: 2, start: "09:00", end: "10:00" }], "the invite's own times are kept");
  assert.deepEqual(draft.members[0].busy, []);
});

test("signing in on a second device does not create a second row", () => {
  const state = workspace([
    { id: "mine", name: "Jordan Lee", userId: "user-1", busy: [{ start: "2026-09-21T10:00:00Z", end: "2026-09-21T11:00:00Z", source: "manual" }] },
    { id: "stray", name: "You" },
  ]);
  const plan = resolveMembership({ members: state.members, localMemberId: "stray", user });
  assert.deepEqual(plan, { action: "reuse", id: "mine", absorb: "stray" });

  const draft = structuredClone(state);
  const id = apply(draft, plan);
  assert.equal(id, "mine");
  assert.deepEqual(draft.members.map((member) => member.id), ["mine"]);
  assert.equal(draft.members[0].busy.length, 1, "the established row keeps its own times");
});

test("without an account the browser's own row is reused", () => {
  const state = workspace([{ id: "anon", name: "You" }]);
  const plan = resolveMembership({ members: state.members, localMemberId: "anon", user: null });
  assert.deepEqual(plan, { action: "attach", id: "anon", absorb: null });
  const draft = structuredClone(state);
  const id = applyMembership(draft, plan, { user: null, name: "Alexi", palettes: AVATAR_PALETTES, createId });
  assert.equal(id, "anon");
  assert.equal(draft.members[0].name, "Alexi");
  assert.equal(draft.members[0].userId, undefined, "no account, no user id");
});

test("a brand new visitor gets exactly one row", () => {
  const draft = workspace([{ id: "host", name: "Alexi" }]);
  const plan = resolveMembership({ members: draft.members, localMemberId: "missing", user });
  assert.equal(plan.action, "create");
  const id = apply(draft, plan);
  assert.equal(draft.members.length, 2);
  assert.equal(draft.members[1].id, id);
  assert.equal(draft.members[1].userId, "user-1");
  assert.equal(draft.ownerId, "user-1", "the first signed-in person owns the workspace");
});

test("repeating the resolve after applying it changes nothing", () => {
  const draft = workspace([{ id: "invite", name: "Jordan", email: "jordan@example.com", pending: true }]);
  const first = apply(draft, resolveMembership({ members: draft.members, localMemberId: null, user }));
  const second = apply(draft, resolveMembership({ members: draft.members, localMemberId: first, user }));
  assert.equal(first, second);
  assert.equal(draft.members.length, 1, "re-running is idempotent");
});

test("a manual claim works without an account, and refuses bad targets", () => {
  const state = workspace([
    { id: "anon", name: "You" },
    { id: "invite", name: "Jordan", pending: true },
    { id: "member", name: "Sam", pending: false },
  ]);
  assert.deepEqual(planManualClaim({ members: state.members, localMemberId: "anon", targetId: "invite" }), {
    action: "claim",
    id: "invite",
    absorb: "anon",
  });
  assert.equal(planManualClaim({ members: state.members, localMemberId: "anon", targetId: "member" }), null, "cannot take over an active member");
  assert.equal(planManualClaim({ members: state.members, localMemberId: "anon", targetId: "anon" }), null);
  assert.equal(planManualClaim({ members: state.members, localMemberId: "anon", targetId: "ghost" }), null);

  const draft = structuredClone(state);
  const id = applyMembership(draft, planManualClaim({ members: state.members, localMemberId: "anon", targetId: "invite" }), {
    user: null,
    name: "Jordan Lee",
    palettes: AVATAR_PALETTES,
    createId,
  });
  assert.equal(id, "invite");
  assert.deepEqual(draft.members.map((member) => member.name), ["Jordan Lee", "Sam"]);
});

test("absorbing hands over workspace ownership rather than losing it", () => {
  const draft = workspace([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
  draft.ownerId = "a";
  absorbMember(draft, "a", "b");
  assert.equal(draft.ownerId, "b");
  assert.deepEqual(draft.members.map((member) => member.id), ["b"]);
});

test("absorbing an unknown or identical row is a no-op", () => {
  const draft = workspace([{ id: "a", name: "A" }]);
  absorbMember(draft, "a", "a");
  absorbMember(draft, "ghost", "a");
  absorbMember(draft, "a", "ghost");
  assert.equal(draft.members.length, 1);
});

test("a person already in the group is found before being added twice", () => {
  const members = [
    { id: "a", name: "Riley Lee" },
    { id: "b", name: "Sam Ito", userId: "user-sam", email: "sam@example.com" },
    { id: "c", name: "Ada", email: "ada@example.com" },
    { id: "d", name: "Riley Lee", userId: "someone-else" },
  ];

  assert.equal(findMemberForParty(members, { id: "user-sam", name: "Different Name" })?.id, "b", "an account id is proof");
  assert.equal(findMemberForParty(members, { email: "ADA@example.com", name: "Nope" })?.id, "c", "an email is proof");
  assert.equal(findMemberForParty(members, { name: "riley lee" })?.id, "a", "an unclaimed row matching by name counts");
  assert.equal(findMemberForParty(members, { id: "new-account", name: "Riley Lee" })?.id, "a", "and is linked rather than duplicated");
  assert.equal(findMemberForParty(members, { name: "Nobody Here" }), null);
  assert.equal(findMemberForParty([], { name: "Anyone" }), null);
  assert.equal(findMemberForParty(members, {}), null, "nothing to match on finds nothing");
});

test("a name match never steals a row that belongs to another account", () => {
  const members = [{ id: "d", name: "Riley Lee", userId: "someone-else" }];
  assert.equal(findMemberForParty(members, { name: "Riley Lee" }), null);
  assert.equal(findMemberForParty(members, { id: "someone-else", name: "Riley Lee" })?.id, "d");
});

test("linking writes the account details onto the existing row", () => {
  const member = { id: "a", name: "Riley Lee", updatedAt: "2026-01-01T00:00:00.000Z" };
  linkMemberToParty(member, { id: "user-riley", email: "Riley@Example.com" });
  assert.equal(member.userId, "user-riley");
  assert.equal(member.email, "riley@example.com");
  assert.notEqual(member.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(linkMemberToParty(null, {}), null);
});
