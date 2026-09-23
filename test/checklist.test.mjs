import test from "node:test";
import assert from "node:assert/strict";
import { checklistSteps, hasOwnTimes, isPlaceholderName, placeholderName, showChecklist } from "../lib/checklist.js";
import { newGroupSlug } from "../lib/groups.js";
import { normalizeWorkspaceState } from "../lib/planner.js";
import handler from "../api/workspace.js";

const member = (overrides = {}) => ({ id: "m1", name: "Sam", weekly: [], busy: [], ...overrides });
const done = (steps) => Object.fromEntries(steps.map((step) => [step.id, step.done]));

test("placeholder names come from the link, as the server seeds them", () => {
  assert.equal(placeholderName("book-club-7fq2x"), "Book club 7fq2x");
  assert.equal(placeholderName("test-checklist-1"), "Test checklist 1");
  assert.equal(placeholderName(""), "");
});

test("a group still carrying its link-derived name is unnamed", () => {
  const slug = newGroupSlug("Book club", () => 0);
  assert.equal(isPlaceholderName(placeholderName(slug), slug), true);
  assert.equal(isPlaceholderName("  book  CLUB aaaaa ", "book-club-aaaaa"), true);
  assert.equal(isPlaceholderName("", slug), true);
  assert.equal(isPlaceholderName("Book club", slug), false);
});

test("an empty name normalizes to the demo's, which is still a default elsewhere", () => {
  const blank = normalizeWorkspaceState({ name: "" });
  assert.equal(blank.name, "Weekend crew");
  assert.equal(isPlaceholderName(blank.name, "trivia-night"), true);
});

test("own times count weekly entries, busy entries or any calendar link", () => {
  assert.equal(hasOwnTimes(null), false);
  assert.equal(hasOwnTimes(member()), false);
  assert.equal(hasOwnTimes(member({ weekly: [{ day: 1, start: 9, end: 12 }] })), true);
  assert.equal(hasOwnTimes(member({ busy: [{ start: "2026-09-23T10:00:00Z", end: "2026-09-23T11:00:00Z" }] })), true);
  assert.equal(hasOwnTimes(member(), 1), true);
  assert.equal(hasOwnTimes(null, 2), true);
});

test("a brand-new group has nothing done", () => {
  const slug = "test-checklist-1";
  const state = normalizeWorkspaceState({ name: placeholderName(slug), members: [member()] });
  const steps = checklistSteps({ state, member: state.members[0], sourcesCount: 0, slug });
  assert.deepEqual(steps.map((step) => step.id), ["name", "times", "invite"]);
  assert.ok(steps.every((step) => typeof step.label === "string" && step.label.length));
  assert.deepEqual(done(steps), { name: false, times: false, invite: false });
  assert.equal(showChecklist(slug, steps), true);
});

test("each step completes independently", () => {
  const slug = "book-club-7fq2x";
  const three = [member(), member({ id: "m2" }), member({ id: "m3" })];
  const named = checklistSteps({ state: { name: "Book club", members: [member()] }, member: member(), slug });
  assert.deepEqual(done(named), { name: true, times: false, invite: false });

  const linked = checklistSteps({ state: { name: placeholderName(slug), members: [member()] }, member: member(), sourcesCount: 1, slug });
  assert.deepEqual(done(linked), { name: false, times: true, invite: false });

  const two = checklistSteps({ state: { name: placeholderName(slug), members: three.slice(0, 2) }, member: member(), slug });
  assert.equal(done(two).invite, false);
  const invited = checklistSteps({ state: { name: placeholderName(slug), members: three }, member: member(), slug });
  assert.equal(done(invited).invite, true);
});

test("the card hides once everything is done, and never shows in the demo", () => {
  const slug = "book-club-7fq2x";
  const members = [member({ weekly: [{ day: 2, start: 18, end: 22 }] }), member({ id: "m2" }), member({ id: "m3" })];
  const steps = checklistSteps({ state: { name: "Book club", members }, member: members[0], slug });
  assert.deepEqual(done(steps), { name: true, times: true, invite: true });
  assert.equal(showChecklist(slug, steps), false);

  const fresh = checklistSteps({ state: { name: "Weekend crew", members: [] }, member: null, slug: "weekend-crew" });
  assert.equal(showChecklist("weekend-crew", fresh), false);
  assert.equal(showChecklist("", fresh), false);
});

test("missing input is treated as nothing done rather than throwing", () => {
  assert.deepEqual(done(checklistSteps({ slug: "x" })), { name: false, times: false, invite: false });
  assert.deepEqual(done(checklistSteps()), { name: false, times: false, invite: false });
});

test("the server seeds new groups with exactly the placeholder name", async () => {
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let body = null;
    const response = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    await handler({ method: "GET", query: { slug: "trivia-night-ab2cd" }, headers: {} }, response);
    assert.equal(body.state.name, "Trivia night ab2cd");
    assert.equal(isPlaceholderName(body.state.name, "trivia-night-ab2cd"), true);
  } finally {
    if (previous.url !== undefined) process.env.SUPABASE_URL = previous.url;
    if (previous.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key;
  }
});
