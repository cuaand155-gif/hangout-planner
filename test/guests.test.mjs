import test from "node:test";
import assert from "node:assert/strict";

import {
  GUEST_LIMITS,
  addGuest,
  applyGuestUpdate,
  countWrite,
  guestForToken,
  guestUpdateFrom,
  guestView,
  hashToken,
  inviteIsLive,
  isGuestToken,
  isInviteCode,
  memberView,
  newGuestToken,
  newInviteCode,
  removeGuest,
  sameSecret,
} from "../lib/guests.js";
import { normalizeWorkspaceState } from "../lib/planner.js";
import workspaceHandler from "../api/workspace.js";
import { createFakeSupabase, installFakeSupabase } from "../scripts/fake-supabase.mjs";

const HOUR = 3600e3;
const future = (hours) => new Date(Math.ceil(Date.now() / HOUR) * HOUR + hours * HOUR).toISOString();

/** A group that shows event details, with named events, emails and a plan. */
function detailedGroup(code = newInviteCode()) {
  return normalizeWorkspaceState({
    name: "Book club",
    privacy: "details",
    ownerId: "user-1",
    invite: { code },
    members: [
      { id: "m_ada", name: "Ada Lovelace", userId: "user-1", email: "ada@example.com", coverage: { from: "2026-01-01", to: "2030-01-01" }, busy: [{ start: future(24), end: future(26), title: "Climbing", location: "Basecamp", source: "ics" }], weekly: [{ weekday: 1, start: "09:00", end: "10:00", title: "Therapy" }] },
      { id: "m_bo", name: "Bo", userId: "user-2", email: "bo@example.com" },
    ],
    ideas: [{ id: "idea_walk", title: "Walk", votes: ["m_ada"] }],
    plan: { id: "plan_1", activity: "Dinner", location: "Luma", timing: "week", chosen: future(48), chosenEnd: future(50), timeVotes: { [future(72)]: ["m_ada"] } },
  });
}

test("secrets: invite codes and guest tokens look right, and only a hash is stored", async () => {
  const code = newInviteCode();
  assert.ok(isInviteCode(code), code);
  assert.equal(code.length, 24);
  assert.notEqual(newInviteCode(), code);
  assert.ok(!isInviteCode("short"));
  const token = newGuestToken();
  assert.ok(isGuestToken(token));
  assert.ok(!isGuestToken("not-hex!"));
  const hash = await hashToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, token);
  assert.ok(sameSecret("abc", "abc"));
  assert.ok(!sameSecret("abc", "abd"));
  assert.ok(!sameSecret("abc", "abcd"));
});

test("an invite works only while it's live and matches", () => {
  const state = detailedGroup("A".repeat(24));
  assert.ok(inviteIsLive(state, "A".repeat(24)));
  assert.ok(!inviteIsLive(state, "B".repeat(24)));
  assert.ok(!inviteIsLive({ ...state, invite: { ...state.invite, revoked: true } }, "A".repeat(24)));
  assert.ok(!inviteIsLive(normalizeWorkspaceState({ name: "No link" }), "A".repeat(24)));
});

test("a guest sees busy/free and the plan, never names, places, emails or secrets, even when the group allows details", async () => {
  const token = newGuestToken();
  const { state } = addGuest(detailedGroup(), { name: "Casey", hash: await hashToken(token) });
  const view = guestView(state);
  const text = JSON.stringify(view);
  for (const secret of ["Climbing", "Basecamp", "Therapy", "ada@example.com", "bo@example.com", "user-1", state.invite.code, state.guests[Object.keys(state.guests)[0]].hash]) {
    assert.ok(!text.includes(secret), `the guest view leaks ${secret}`);
  }
  assert.equal(view.privacy, "busy");
  assert.equal(view.members[0].busy.length, 1, "the busy time itself is still there");
  assert.equal(view.plan.activity, "Dinner", "the plan itself is shown");
  assert.equal(view.plan.location, "Luma");
  assert.equal(view.members[0].hasAccount, true);
  // Members still get names (the group allows them) but never the token hashes.
  const members = JSON.stringify(memberView(state));
  assert.ok(members.includes("Climbing"));
  assert.ok(!members.includes('"guests"'));
});

test("a guest can change their own times, votes and RSVP, and nothing else", async () => {
  const { state, memberId } = addGuest(detailedGroup(), { name: "Casey", hash: await hashToken(newGuestToken()) });
  const at = state.plan.chosen;
  const suggested = future(96);
  const result = applyGuestUpdate(state, memberId, {
    self: { name: "Casey K", busy: [{ start: future(30), end: future(31), title: "Secret thing", location: "Home" }], coverage: { from: "2026-01-01", to: "2030-01-01" } },
    timeVotes: [future(72), suggested, "2001-01-01T00:00:00.000Z"],
    rsvp: { at, answer: "yes" },
    ideaVotes: ["idea_walk"],
    // Attempts to reach beyond their own row are ignored:
    plan: { activity: "Hijacked" },
    members: [],
    name: "Renamed group",
  });
  const next = result.state;
  const casey = next.members.find((member) => member.id === memberId);
  assert.equal(casey.name, "Casey K");
  assert.deepEqual(casey.busy.map((block) => Object.keys(block).sort()), [["end", "source", "start"]], "no names or places on a guest's busy time");
  assert.deepEqual(next.plan.timeVotes[future(72)], ["m_ada", memberId]);
  assert.deepEqual(next.plan.timeVotes[suggested], [memberId], "a new future time can be voted for");
  assert.equal(next.plan.timeVotes["2001-01-01T00:00:00.000Z"], undefined, "not a time in the past");
  assert.equal(next.plan.rsvp.answers[memberId], "yes");
  assert.deepEqual(next.ideas[0].votes, ["m_ada", memberId]);
  assert.equal(next.plan.activity, "Dinner");
  assert.equal(next.name, "Book club");
  assert.equal(next.members.length, 3);
  assert.equal(next.members[0].busy[0].title, "Climbing", "other people's rows are untouched");
  assert.equal(result.votes, 3);

  // An RSVP for some other date doesn't count; clearing works.
  const stale = applyGuestUpdate(next, memberId, { rsvp: { at: future(500), answer: "no" } }).state;
  assert.equal(stale.plan.rsvp.answers[memberId], "yes");
  const cleared = applyGuestUpdate(next, memberId, { rsvp: { at, answer: null }, timeVotes: [] }).state;
  assert.equal(cleared.plan.rsvp.answers[memberId], undefined);
  assert.deepEqual(cleared.plan.timeVotes[future(72)], ["m_ada"]);

  assert.equal(applyGuestUpdate(state, "m_ada", { self: { name: "x" } }), null, "a member row is not a guest's to change");
});

test("guestUpdateFrom reads back exactly what applyGuestUpdate takes", async () => {
  const { state, memberId } = addGuest(detailedGroup(), { name: "Casey", hash: await hashToken(newGuestToken()) });
  const edited = structuredClone(state);
  edited.plan.timeVotes[future(72)].push(memberId);
  edited.plan.rsvp = { at: state.plan.chosen, answers: { [memberId]: "maybe" } };
  const update = guestUpdateFrom(normalizeWorkspaceState(edited), memberId);
  assert.deepEqual(update.timeVotes, [future(72)]);
  assert.deepEqual(update.rsvp, { at: state.plan.chosen, answer: "maybe" });
  const applied = applyGuestUpdate(state, memberId, update).state;
  assert.equal(applied.plan.rsvp.answers[memberId], "maybe");
});

test("removing a guest takes their votes, RSVP and pass with them", async () => {
  const token = newGuestToken();
  const { state, memberId } = addGuest(detailedGroup(), { name: "Casey", hash: await hashToken(token) });
  const voted = applyGuestUpdate(state, memberId, { timeVotes: [future(72)], rsvp: { at: state.plan.chosen, answer: "yes" }, ideaVotes: ["idea_walk"] }).state;
  assert.equal(await guestForToken(voted, token), memberId);
  const removed = removeGuest(voted, memberId);
  assert.ok(!JSON.stringify(removed).includes(memberId), "no trace of their id");
  assert.deepEqual(removed.plan.timeVotes[future(72)], ["m_ada"]);
  assert.deepEqual(removed.ideas[0].votes, ["m_ada"]);
  assert.equal(await guestForToken(removed, token), null);
  assert.equal(removed.activity[0].message, "Casey was removed");
  assert.equal(removeGuest(voted, "m_ada"), null, "only guests are removed this way");
});

test("signing in turns a guest into a member, and their pass is dropped", async () => {
  const { state, memberId } = addGuest(detailedGroup(), { name: "Casey", hash: await hashToken(newGuestToken()) });
  const signedIn = normalizeWorkspaceState({ ...state, members: state.members.map((member) => (member.id === memberId ? { ...member, userId: "user-9" } : member)) });
  assert.equal(signedIn.members.find((member) => member.id === memberId).guest, undefined);
  assert.equal(signedIn.guests, undefined);
});

test("writes are counted in a window", () => {
  let counter = null;
  const now = 1_000_000;
  for (let index = 0; index < GUEST_LIMITS.writes; index += 1) counter = countWrite(counter, now + index);
  assert.equal(counter.count, GUEST_LIMITS.writes);
  assert.equal(countWrite(counter, now + 1000), null, "the next one is refused");
  assert.deepEqual(countWrite(counter, now + GUEST_LIMITS.windowMs), { since: now + GUEST_LIMITS.windowMs, count: 1 }, "a new window starts over");
});

/* ------------------------------------------------------------- the API */

function mockResponse() {
  const captured = { headers: {}, status: null, body: null };
  return {
    captured,
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
}

const ALEXI = { authorization: "Bearer fake-token" };
const SAM = { authorization: "Bearer fake-token-sam" };
const ALEXI_ID = "11111111-1111-1111-1111-111111111111";

/** The real handler, against the in-memory fake database. */
function api(t, tables = {}) {
  const fake = createFakeSupabase({ tables });
  t.after(installFakeSupabase(fake));
  const call = async (method, { slug = "book-club-ab2cd", headers = {}, body } = {}) => {
    const response = mockResponse();
    await workspaceHandler({ method, query: { slug }, headers, body }, response);
    return response.captured;
  };
  const row = (slug = "book-club-ab2cd") => fake.db.workspaces.find((entry) => entry.slug === slug);
  return { fake, call, row };
}

function seeded(code = "C".repeat(24), extra = {}) {
  return {
    workspaces: [{
      slug: "book-club-ab2cd",
      updated_at: "2026-09-26T10:00:00.000Z",
      state: { ...structuredClone(detailedGroup(code)), ownerId: ALEXI_ID, members: [{ ...detailedGroup(code).members[0], userId: ALEXI_ID }, detailedGroup(code).members[1]], ...extra },
    }],
  };
}

test("API: a member's first visit makes the invite link; a guest with it gets only the group's name until they join", async (t) => {
  const { call, row } = api(t);
  const created = await call("GET", { headers: ALEXI });
  assert.equal(created.status, 201);
  const code = created.body.state.invite.code;
  assert.ok(isInviteCode(code), "members get the code to share");

  const peek = await call("GET", { headers: { "x-waddle-invite": code } });
  assert.equal(peek.status, 200);
  assert.deepEqual(Object.keys(peek.body).sort(), ["join", "persisted", "slug"]);
  assert.equal(peek.body.join.name, "Book club ab2cd");

  const wrong = await call("GET", { headers: { "x-waddle-invite": "W".repeat(24) } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.inviteRevoked, true);
  assert.equal(wrong.body.state, undefined);

  const none = await call("GET", {});
  assert.equal(none.status, 401, "no link, no account: nothing");
  assert.ok(row().state.invite.code === code);
});

test("API: a guest joins with a name, votes and RSVPs, and never sees names or places even with event details on", async (t) => {
  const code = "C".repeat(24);
  const { call, row } = api(t, seeded(code));
  const token = newGuestToken();
  const joined = await call("POST", { body: { action: "guest-join", invite: code, token, name: "Casey" } });
  assert.equal(joined.status, 201);
  const guestId = joined.body.guest.memberId;
  const stored = row().state;
  assert.ok(!JSON.stringify(stored).includes(token), "the token itself is never stored");
  assert.equal(stored.guests[guestId].hash, await hashToken(token));

  const seen = await call("GET", { headers: { "x-waddle-invite": code, "x-waddle-guest": token } });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.guest.memberId, guestId);
  const text = JSON.stringify(seen.body);
  for (const secret of ["Climbing", "Basecamp", "Therapy", "ada@example.com", code, stored.guests[guestId].hash]) assert.ok(!text.includes(secret), `leaks ${secret}`);

  const at = seen.body.state.plan.chosen;
  const voted = await call("POST", { body: { action: "guest-update", invite: code, token, timeVotes: [future(72)], rsvp: { at, answer: "yes" }, plan: { activity: "Hijacked" } } });
  assert.equal(voted.status, 200);
  const after = row().state;
  assert.deepEqual(after.plan.timeVotes[future(72)], ["m_ada", guestId]);
  assert.equal(after.plan.rsvp.answers[guestId], "yes");
  assert.equal(after.plan.activity, "Dinner", "the plan itself is not a guest's to change");
  assert.ok(!JSON.stringify(voted.body).includes("Climbing"));

  const again = await call("POST", { body: { action: "guest-join", invite: code, token, name: "Casey" } });
  assert.equal(again.status, 200, "joining twice with the same pass is the same guest");
  assert.equal(again.body.guest.memberId, guestId);
  assert.equal(row().state.members.length, 3);
});

test("API: turning the link off (or making a new one) locks guests out; only the owner can", async (t) => {
  const code = "C".repeat(24);
  const { call, row } = api(t, seeded(code));
  const token = newGuestToken();
  await call("POST", { body: { action: "guest-join", invite: code, token, name: "Casey" } });

  const notOwner = await call("POST", { headers: SAM, body: { action: "invite-revoke" } });
  assert.equal(notOwner.status, 403);
  const anonymous = await call("POST", { body: { action: "invite-revoke" } });
  assert.equal(anonymous.status, 401);

  const revoked = await call("POST", { headers: ALEXI, body: { action: "invite-revoke" } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.state.invite.revoked, true);
  for (const attempt of [
    call("GET", { headers: { "x-waddle-invite": code, "x-waddle-guest": token } }),
    call("POST", { body: { action: "guest-update", invite: code, token, rsvp: { at: row().state.plan.chosen, answer: "no" } } }),
    call("POST", { body: { action: "guest-join", invite: code, token: newGuestToken(), name: "Someone new" } }),
  ]) {
    const result = await attempt;
    assert.equal(result.status, 403);
    assert.equal(result.body.inviteRevoked, true);
    assert.equal(result.body.state, undefined);
  }

  const renewed = await call("POST", { headers: ALEXI, body: { action: "invite-renew" } });
  const fresh = renewed.body.state.invite.code;
  assert.notEqual(fresh, code);
  assert.equal((await call("GET", { headers: { "x-waddle-invite": code } })).status, 403, "the old link stays dead");
  assert.equal((await call("GET", { headers: { "x-waddle-invite": fresh, "x-waddle-guest": token } })).status, 200, "the new link works");

  // A member's save can't bring the old code back or drop the guests' passes.
  const member = await call("GET", { headers: ALEXI });
  const put = await call("PUT", { headers: ALEXI, body: { rev: member.body.rev, state: { ...member.body.state, invite: { code } } } });
  assert.equal(put.status, 200);
  assert.equal(row().state.invite.code, fresh);
  assert.equal(Object.keys(row().state.guests).length, 1);
  assert.equal(put.body.state.guests, undefined, "passes never go to browsers");
});

test("API: removing a guest removes their votes, and their pass stops working", async (t) => {
  const code = "C".repeat(24);
  const { call, row } = api(t, seeded(code));
  const token = newGuestToken();
  const joined = await call("POST", { body: { action: "guest-join", invite: code, token, name: "Casey" } });
  const guestId = joined.body.guest.memberId;
  await call("POST", { body: { action: "guest-update", invite: code, token, timeVotes: [future(72)], ideaVotes: ["idea_walk"], rsvp: { at: row().state.plan.chosen, answer: "yes" } } });
  assert.ok(JSON.stringify(row().state.plan).includes(guestId));

  assert.equal((await call("POST", { headers: SAM, body: { action: "guest-remove", memberId: guestId } })).status, 403);
  const removed = await call("POST", { headers: ALEXI, body: { action: "guest-remove", memberId: guestId } });
  assert.equal(removed.status, 200);
  assert.ok(!JSON.stringify(row().state).includes(guestId), "no votes, RSVP or pass left");
  assert.deepEqual(row().state.plan.timeVotes[future(72)], ["m_ada"]);

  const update = await call("POST", { body: { action: "guest-update", invite: code, token, timeVotes: [future(72)] } });
  assert.equal(update.status, 403);
  assert.equal(update.body.guestUnknown, true);
  const read = await call("GET", { headers: { "x-waddle-invite": code, "x-waddle-guest": token } });
  assert.ok(read.body.join, "back to the join form");
});

test("API: guest writes are rate-limited, size-capped, and closed in a locked group or without a database", async (t) => {
  const code = "C".repeat(24);
  const { call, row } = api(t, seeded(code));
  const token = newGuestToken();
  await call("POST", { body: { action: "guest-join", invite: code, token, name: "Casey" } });
  let last;
  for (let index = 0; index <= GUEST_LIMITS.writes; index += 1) {
    last = await call("POST", { body: { action: "guest-update", invite: code, token, ideaVotes: index % 2 ? [] : ["idea_walk"] } });
  }
  assert.equal(last.status, 429);

  const huge = await call("POST", { body: { action: "guest-update", invite: code, token, self: { name: "x".repeat(300 * 1024) } } });
  assert.equal(huge.status, 413);

  assert.equal((await call("POST", { body: { action: "guest-join", invite: code, token: newGuestToken(), name: "" } })).status, 400);
  assert.equal((await call("POST", { body: { action: "guest-join", invite: code, token: "nope", name: "X" } })).status, 400);

  row().state.settings = { ...row().state.settings, locked: true };
  const locked = await call("GET", { headers: { "x-waddle-invite": code, "x-waddle-guest": token } });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.locked, true);
});

test("API: joining is limited per hour", async (t) => {
  const code = "C".repeat(24);
  const { call } = api(t, seeded(code));
  let status;
  for (let index = 0; index <= GUEST_LIMITS.joins; index += 1) {
    status = (await call("POST", { body: { action: "guest-join", invite: code, token: newGuestToken(), name: `Guest ${index}` } })).status;
  }
  assert.equal(status, 429);
});

test("API: without a database there are no invite links", async () => {
  const response = mockResponse();
  await workspaceHandler({ method: "POST", query: { slug: "book-club-ab2cd" }, headers: {}, body: { action: "guest-join" } }, response);
  assert.equal(response.captured.status, 503);
  const read = mockResponse();
  await workspaceHandler({ method: "GET", query: { slug: "book-club-ab2cd" }, headers: {} }, read);
  assert.equal(read.captured.body.state.invite, undefined, "demo mode hands out no code");
});

test("a guest adds and deletes only their own comments; the server stamps the time", async () => {
  const { state, memberId } = addGuest(detailedGroup(), { name: "Casey", hash: await hashToken(newGuestToken()) });
  const planId = state.plan.id;
  const withAda = normalizeWorkspaceState({ ...state, plan: { ...state.plan, comments: [{ id: "c_ada", memberId: "m_ada", text: "Booked a table", at: "2026-01-01T10:00:00Z" }] } });
  const now = new Date("2026-10-05T12:00:00Z");
  const added = applyGuestUpdate(withAda, memberId, {
    comments: { planId, keep: ["c_ada"], add: [{ id: "c_me", text: "  Can't wait ", at: "1999-01-01T00:00:00Z", memberId: "m_ada" }] },
  }, now).state;
  assert.deepEqual(added.plan.comments.map((c) => [c.id, c.memberId, c.text]), [["c_ada", "m_ada", "Booked a table"], ["c_me", memberId, "Can't wait"]]);
  assert.equal(added.plan.comments[1].at, now.toISOString(), "not the time the guest claimed");
  // Not keeping it deletes theirs, never Ada's.
  const cleared = applyGuestUpdate(added, memberId, { comments: { planId, keep: [], add: [] } }, now).state;
  assert.deepEqual(cleared.plan.comments.map((c) => c.id), ["c_ada"]);
  // Reading back: kept vs new, against the state the edit started from.
  assert.deepEqual(guestUpdateFrom(added, memberId, now, withAda).comments, { planId, keep: [], add: [{ id: "c_me", text: "Can't wait" }] });
  assert.deepEqual(guestUpdateFrom(added, memberId, now, added).comments, { planId, keep: ["c_me"], add: [] });
});

test("a stale guest page never brings comments back, and guests never push others' comments out", async () => {
  const { state, memberId } = addGuest(detailedGroup(), { name: "Casey", hash: await hashToken(newGuestToken()) });
  const now = new Date("2026-10-05T12:00:00Z");
  // A comment from an older plan, sent against a new plan: ignored.
  const other = applyGuestUpdate(state, memberId, { comments: { planId: "plan_old", keep: [], add: [{ id: "c_old", text: "hi" }] } }, now).state;
  assert.equal(other.plan.comments, undefined);
  // A full plan takes no more guest comments, so nobody's history is pushed out.
  const full = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, memberId: "m_ada", text: `#${i}`, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
  const busy = normalizeWorkspaceState({ ...state, plan: { ...state.plan, comments: full } });
  const after = applyGuestUpdate(busy, memberId, { comments: { planId: state.plan.id, keep: [], add: [{ id: "c_me", text: "late" }] } }, now).state;
  assert.equal(after.plan.comments.length, 100);
  assert.equal(after.plan.comments[0].id, "m0");
  // Ids are cut to 40 characters the same way when checked and when stored.
  const long = "x".repeat(60);
  const once = applyGuestUpdate(state, memberId, { comments: { planId: state.plan.id, keep: [], add: [{ id: long, text: "a" }] } }, now).state;
  const twice = applyGuestUpdate(once, memberId, { comments: { planId: state.plan.id, keep: [long], add: [{ id: long, text: "a" }] } }, new Date("2026-10-06T12:00:00Z")).state;
  assert.deepEqual(twice.plan.comments.map((c) => [c.id.length, c.at]), [[40, now.toISOString()]]);
});
