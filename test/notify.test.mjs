import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";

import { hasVotedOnTime, membersWithoutVote, nextNudgeAt, notificationsFor, unseenCount, NUDGE_COOLDOWN_MS } from "../lib/notifications.js";
import { cleanSubscription, pushSupport, urlBase64ToUint8Array } from "../lib/push.js";
import { normalizeWorkspaceState } from "../lib/planner.js";
import pushHandler from "../api/push.js";
import notifyHandler from "../api/notify.js";
import cronHandler, { dueReminders, isoWeek } from "../api/cron.js";
import workspaceHandler from "../api/workspace.js";
import { FAKE_PUSH_ORIGIN, createFakeSupabase, installFakeSupabase } from "../scripts/fake-supabase.mjs";

const ALEXI = "11111111-1111-1111-1111-111111111111";
const SAM = "22222222-2222-2222-2222-222222222222";
const JORDAN = "33333333-3333-3333-3333-333333333333";
const MIN = 60e3;

/** A group: Alexi proposed Dinner; Sam voted; Jordan hasn't; a guest hasn't either. */
function group(plan = {}) {
  return normalizeWorkspaceState({
    name: "Book club",
    ownerId: ALEXI,
    members: [
      { id: "m_alexi", name: "Alexi", userId: ALEXI },
      { id: "m_sam", name: "Sam Rivera", userId: SAM },
      { id: "m_jordan", name: "Jordan Lee", userId: JORDAN },
      { id: "m_casey", name: "Casey", guest: true },
    ],
    plan: {
      id: "plan_dinner",
      activity: "Dinner",
      location: "Luma",
      timing: "week",
      createdBy: "m_alexi",
      createdAt: new Date(Date.now() - 3600e3).toISOString(),
      timeVotes: { [new Date(Date.now() + 48 * 3600e3).toISOString()]: ["m_sam"] },
      ...plan,
    },
  });
}

test("the bell: proposed, not voted yet, time chosen and starting soon, per person", () => {
  const now = new Date();
  const state = group();
  const forJordan = notificationsFor({ state, memberId: "m_jordan", now });
  assert.deepEqual(forJordan.map((item) => item.kind).sort(), ["proposed", "vote"]);
  assert.equal(forJordan.find((item) => item.kind === "proposed").title, "Alexi proposed a plan");
  assert.deepEqual(notificationsFor({ state, memberId: "m_sam", now }).map((item) => item.kind), ["proposed"], "Sam voted already");
  assert.deepEqual(notificationsFor({ state, memberId: "m_alexi", now }), [], "nothing about your own plan");

  const soon = group({ chosen: new Date(now.getTime() + 40 * MIN).toISOString(), chosenEnd: new Date(now.getTime() + 160 * MIN).toISOString(), chosenBy: "m_alexi" });
  const items = notificationsFor({ state: soon, memberId: "m_jordan", now });
  assert.deepEqual(items.map((item) => item.kind).sort(), ["chosen", "proposed", "soon"]);
  assert.match(items.find((item) => item.kind === "soon").title, /^Dinner starts in 40 minutes$/);
  assert.equal(items[0].kind, "soon", "what's about to start comes first");
  assert.equal(notificationsFor({ state: soon, memberId: "m_jordan", now: new Date(now.getTime() - 3 * 3600e3) }).some((item) => item.kind === "soon"), false, "not hours ahead");
  assert.ok(!JSON.stringify(items).includes("Luma"), "never the place");

  const ids = items.map((item) => item.id);
  assert.equal(unseenCount(items, ids.slice(1)), 1);
  assert.equal(unseenCount(items, ids), 0);
});

test("who hasn't voted, and when the proposer may nudge again", () => {
  const state = group();
  assert.ok(hasVotedOnTime(state.plan, "m_sam"));
  assert.deepEqual(membersWithoutVote(state).map((member) => member.id), ["m_jordan", "m_casey"], "not the proposer, not Sam");
  assert.equal(nextNudgeAt(state.plan), null);
  const nudged = group({ nudgedAt: new Date().toISOString() });
  assert.ok(nextNudgeAt(nudged.plan) > new Date());
  assert.equal(nextNudgeAt(group({ nudgedAt: new Date(Date.now() - NUDGE_COOLDOWN_MS - 1000).toISOString() }).plan), null);
});

test("push helpers: subscriptions are checked before they're stored", () => {
  const good = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
  assert.deepEqual(cleanSubscription(good), { endpoint: good.endpoint, p256dh: good.keys.p256dh, auth: good.keys.auth });
  assert.equal(cleanSubscription({ ...good, endpoint: "http://insecure.example/x" }), null);
  assert.equal(cleanSubscription({ ...good, keys: { p256dh: "<script>", auth: "x" } }), null);
  assert.equal(cleanSubscription(null), null);
  assert.deepEqual([...urlBase64ToUint8Array("AQID")], [1, 2, 3]);
  assert.deepEqual(pushSupport({ hasServiceWorker: true, hasPushManager: true, hasNotification: true }), { supported: true, reason: "" });
  assert.equal(pushSupport({ ios: true, hasServiceWorker: true, hasPushManager: true, hasNotification: true }).reason, "ios-home-screen");
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
    end(body) {
      captured.body = body;
      return this;
    },
  };
}

/** A real-looking browser subscription pointing at the fake push service. */
function deviceSubscription(name) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `${FAKE_PUSH_ORIGIN}/${name}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

function setup(t, { state = group(), vapid = true } = {}) {
  const fake = createFakeSupabase({ tables: { workspaces: [{ slug: "book-club-ab2cd", state, updated_at: "2026-09-26T10:00:00.000Z" }], push_subscriptions: [], notification_log: [] } });
  const restore = installFakeSupabase(fake);
  const previous = { ...process.env };
  if (vapid) {
    const keys = webpush.generateVAPIDKeys();
    Object.assign(process.env, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:test@example.com" });
  }
  process.env.CRON_SECRET = "cron-secret-for-tests";
  t.after(() => {
    restore();
    for (const key of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "CRON_SECRET"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const call = async (handler, { method = "POST", headers = {}, body, query = {} } = {}) => {
    const response = mockResponse();
    await handler({ method, headers, body, query }, response);
    return response.captured;
  };
  const as = (who) => ({ authorization: `Bearer ${who === "alexi" ? "fake-token" : `fake-token-${who}`}` });
  const subscribe = (who, name, weekly = false) => call(pushHandler, { headers: as(who), body: { subscription: deviceSubscription(name), weekly } });
  const sentTo = () => (fake.db._push || []).map((entry) => entry.endpoint.replace(`${FAKE_PUSH_ORIGIN}/`, ""));
  return { fake, call, as, subscribe, sentTo };
}

test("API /api/push: signed-in people save and remove their device; the account comes from the token", async (t) => {
  const { fake, call, as, subscribe } = setup(t);
  const info = await call(pushHandler, { method: "GET" });
  assert.equal(info.body.configured, true);
  assert.ok(info.body.publicKey);

  assert.equal((await call(pushHandler, { body: { subscription: deviceSubscription("x") } })).status, 401);
  assert.equal((await call(pushHandler, { headers: as("sam"), body: { subscription: { endpoint: "http://bad" } } })).status, 400);

  const saved = await subscribe("sam", "sam-phone", true);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { subscribed: true, weekly: true });
  assert.equal(fake.db.push_subscriptions.length, 1);
  assert.equal(fake.db.push_subscriptions[0].user_id, SAM);
  await subscribe("sam", "sam-phone", false);
  assert.equal(fake.db.push_subscriptions.length, 1, "the same device again updates, not duplicates");
  assert.equal(fake.db.analytics_daily.find((row) => row.metric === "push_opt_ins").count, 1, "an opt-in is counted once");

  const status = await call(pushHandler, { method: "GET", headers: as("sam"), query: { endpoint: `${FAKE_PUSH_ORIGIN}/sam-phone` } });
  assert.deepEqual([status.body.subscribed, status.body.weekly], [true, false]);
  await call(pushHandler, { method: "DELETE", headers: as("jordan"), body: { endpoint: `${FAKE_PUSH_ORIGIN}/sam-phone` } });
  assert.equal(fake.db.push_subscriptions.length, 1, "nobody else can remove your device");
  await call(pushHandler, { method: "DELETE", headers: as("sam"), body: { endpoint: `${FAKE_PUSH_ORIGIN}/sam-phone` } });
  assert.equal(fake.db.push_subscriptions.length, 0);
});

test("API /api/push without VAPID keys: nothing to turn on", async (t) => {
  const { call, as } = setup(t, { vapid: false });
  assert.equal((await call(pushHandler, { method: "GET" })).body.configured, false);
  assert.equal((await call(pushHandler, { headers: as("sam"), body: { subscription: deviceSubscription("x") } })).status, 503);
});

test("API /api/notify: a proposal reaches the others once; only the proposer can announce it", async (t) => {
  const { call, as, subscribe, sentTo } = setup(t);
  await subscribe("alexi", "alexi-laptop");
  await subscribe("sam", "sam-phone");
  await subscribe("jordan", "jordan-phone");
  assert.equal((await call(notifyHandler, { headers: as("sam"), body: { slug: "book-club-ab2cd", kind: "plan-proposed" } })).status, 403);
  const first = await call(notifyHandler, { headers: as("alexi"), body: { slug: "book-club-ab2cd", kind: "plan-proposed" } });
  assert.equal(first.status, 200);
  assert.equal(first.body.sent, 2);
  assert.deepEqual(sentTo().sort(), ["jordan-phone", "sam-phone"], "not the proposer's own device");
  const again = await call(notifyHandler, { headers: as("alexi"), body: { slug: "book-club-ab2cd", kind: "plan-proposed" } });
  assert.equal(again.body.already, true);
  assert.equal(sentTo().length, 2, "sent once");
  assert.equal((await call(notifyHandler, { headers: { authorization: "Bearer nope" }, body: { slug: "book-club-ab2cd", kind: "plan-proposed" } })).status, 401);
});

test("API /api/notify: nudging reaches only people who haven't voted, once per 12 hours", async (t) => {
  const { fake, call, as, subscribe, sentTo } = setup(t);
  await subscribe("sam", "sam-phone");
  await subscribe("jordan", "jordan-phone");
  assert.equal((await call(notifyHandler, { headers: as("jordan"), body: { slug: "book-club-ab2cd", kind: "nudge" } })).status, 403, "only the proposer");
  const nudge = await call(notifyHandler, { headers: as("alexi"), body: { slug: "book-club-ab2cd", kind: "nudge" } });
  assert.equal(nudge.status, 200);
  assert.equal(nudge.body.waiting, 2, "Jordan and the guest");
  assert.deepEqual(sentTo(), ["jordan-phone"], "Sam already voted; the guest has no account");
  const saved = fake.db.workspaces[0].state;
  assert.ok(saved.plan.nudgedAt);
  assert.match(saved.activity[0].message, /Alexi nudged people who haven't voted on Dinner/);
  const again = await call(notifyHandler, { headers: as("alexi"), body: { slug: "book-club-ab2cd", kind: "nudge" } });
  assert.equal(again.status, 429);
  assert.ok(new Date(again.body.nextAt) > new Date());
  assert.equal(sentTo().length, 1);
});

test("API /api/cron: an hour-before reminder goes out once; the weekly nudge only to people who asked", async (t) => {
  const start = new Date(Date.now() + 30 * MIN).toISOString();
  const { fake, call, subscribe, sentTo } = setup(t, { state: group({ chosen: start, chosenEnd: new Date(Date.now() + 150 * MIN).toISOString(), chosenBy: "m_alexi" }) });
  await subscribe("sam", "sam-phone", true);
  await subscribe("jordan", "jordan/gone");
  assert.equal((await call(cronHandler, { query: { job: "reminders" } })).status, 401, "needs the secret");
  assert.equal((await call(cronHandler, { query: { job: "reminders" }, headers: { authorization: "Bearer wrong" } })).status, 401);
  const secret = { authorization: "Bearer cron-secret-for-tests" };
  const run = await call(cronHandler, { query: { job: "reminders" }, headers: secret });
  assert.equal(run.status, 200);
  assert.equal(run.body.due, 1);
  assert.deepEqual(sentTo().sort(), ["jordan/gone", "sam-phone"]);
  assert.deepEqual(fake.db.push_subscriptions.map((row) => row.endpoint), [`${FAKE_PUSH_ORIGIN}/sam-phone`], "a device the push service says is gone is forgotten");
  await call(cronHandler, { query: { job: "reminders" }, headers: secret });
  assert.equal(sentTo().length, 2, "not twice");

  const weekly = await call(cronHandler, { query: { job: "weekly" }, headers: secret });
  assert.equal(weekly.body.people, 1, "only Sam asked");
  assert.equal(sentTo().filter((name) => name === "sam-phone").length, 2);
  await call(cronHandler, { query: { job: "weekly" }, headers: secret });
  assert.equal(sentTo().length, 3, "once a week");
});

test("cron helpers: which plans are due, and the week key", () => {
  const now = new Date();
  const soon = group({ chosen: new Date(now.getTime() + 20 * MIN).toISOString() });
  const later = group({ chosen: new Date(now.getTime() + 5 * 3600e3).toISOString() });
  const due = dueReminders([{ slug: "a", state: soon }, { slug: "b", state: later }, { slug: "c", state: group() }], now);
  assert.deepEqual(due.map((item) => item.slug), ["a"]);
  assert.deepEqual(due[0].userIds, [ALEXI, SAM, JORDAN]);
  assert.equal(isoWeek(new Date("2026-09-24T12:00:00Z")), "2026-W39");
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
});

test("a member's save can't claim someone else's plan; who proposed and who picked come from the account", async (t) => {
  const { fake, call, as } = setup(t, { state: normalizeWorkspaceState({ ...group(), plan: null }) });
  const read = await call(workspaceHandler, { method: "GET", headers: as("sam"), query: { slug: "book-club-ab2cd" } });
  const state = read.body.state;
  const put = await call(workspaceHandler, {
    method: "PUT",
    headers: as("sam"),
    query: { slug: "book-club-ab2cd" },
    body: { rev: read.body.rev, state: { ...state, plan: { id: "plan_x", activity: "Bowling", timing: "week", createdBy: "m_alexi", nudgedAt: new Date().toISOString() } } },
  });
  assert.equal(put.status, 200);
  const saved = fake.db.workspaces[0].state.plan;
  assert.equal(saved.createdBy, "m_sam", "Sam made it, whatever the browser said");
  assert.equal(saved.nudgedAt, undefined, "a new plan starts un-nudged");
  const picked = await call(workspaceHandler, {
    method: "PUT",
    headers: as("jordan"),
    query: { slug: "book-club-ab2cd" },
    body: { rev: put.body.rev, state: { ...put.body.state, plan: { ...put.body.state.plan, chosen: new Date(Date.now() + 86400e3).toISOString(), chosenBy: "m_alexi", createdBy: "m_jordan" } } },
  });
  assert.equal(picked.status, 200);
  assert.equal(fake.db.workspaces[0].state.plan.chosenBy, "m_jordan");
  assert.equal(fake.db.workspaces[0].state.plan.createdBy, "m_sam", "the proposer stays");
  const counts = Object.fromEntries(fake.db.analytics_daily.map((row) => [row.metric, row.count]));
  assert.deepEqual(counts, { plans_created: 1, plans_confirmed: 1 });
});
