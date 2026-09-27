// Push notifications for moments in a group, sent by a signed-in member's
// browser right after they happen:
//
//   POST /api/notify { slug, kind: "plan-proposed" }  the caller proposed the plan
//   POST /api/notify { slug, kind: "time-chosen" }    a time was picked
//   POST /api/notify { slug, kind: "nudge" }          the proposer nudges people who haven't voted
//
// The server checks each claim against the saved group (the caller must be a
// member; for a proposal or a nudge, the plan's proposer) and sends each moment
// once (notification_log). A nudge can be sent once per 12 hours per plan: the
// time is saved on the plan, and the group's activity says it happened, so
// guests and people without notifications see it in the bell too.
// Recipients are members with an account and notifications on; the message
// holds the plan's title and time, never places or anyone's calendar.

import { normalizeWorkspaceState, slugify } from "../lib/planner.js";
import { NUDGE_COOLDOWN_MS, hasVotedOnTime, membersWithoutVote } from "../lib/notifications.js";
import { accountFromToken, bearer, config, jsonBody, send } from "./_supabase.js";
import { loadRow, updateRow } from "./_store.js";
import { claimOnce, notifyUsers, pushConfig, whenText } from "./_push.js";
import { memberView } from "../lib/guests.js";

const first = (member) => String(member?.name || "Someone").split(" ")[0];
const accountsOf = (members, except) => members.filter((member) => member.userId && member.userId !== except).map((member) => member.userId);

async function handle(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed" });
  }
  const settings = config();
  if (!settings) return send(response, 503, { error: "Notifications need the database to be set up." });
  let body;
  try {
    body = await jsonBody(request, 4 * 1024);
  } catch {
    return send(response, 400, { error: "Invalid JSON body" });
  }
  const account = await accountFromToken(settings.url, settings.key, bearer(request));
  if (!account) return send(response, 401, { error: "Sign in first.", signIn: true });
  const slug = slugify(body?.slug, "");
  const kind = body?.kind;
  if (!slug || !["plan-proposed", "time-chosen", "nudge"].includes(kind)) return send(response, 400, { error: "Unknown notification." });

  const { row, error } = await loadRow(settings.url, settings.key, slug);
  if (error) return send(response, 502, { error: "Unable to load the group." });
  if (!row) return send(response, 404, { error: "That group doesn't exist." });
  const state = normalizeWorkspaceState(row.state);
  const caller = state.members.find((member) => member.userId === account.id);
  if (!caller) return send(response, 403, { error: "Only members of this group can do that." });
  const plan = state.plan;
  if (!plan) return send(response, 409, { error: "There's no plan to talk about." });
  const link = `/?w=${encodeURIComponent(slug)}#plan`;
  const pushOn = Boolean(pushConfig());

  if (kind === "plan-proposed") {
    if (plan.createdBy !== caller.id) return send(response, 403, { error: "Only whoever proposed the plan can announce it." });
    if (!(await claimOnce(settings, `proposed:${slug}:${plan.id || plan.activity}`))) return send(response, 200, { sent: 0, already: true, push: pushOn });
    const sent = await notifyUsers(settings, accountsOf(state.members, account.id), {
      title: `${first(caller)} proposed a plan`,
      body: `${plan.activity} · vote on a time in ${state.name}`,
      url: link,
      tag: `plan:${slug}`,
    });
    return send(response, 200, { sent, push: pushOn });
  }

  if (kind === "time-chosen") {
    if (!plan.chosen) return send(response, 409, { error: "No time has been picked yet." });
    if (!(await claimOnce(settings, `chosen:${slug}:${plan.id || plan.activity}:${plan.chosen}`))) return send(response, 200, { sent: 0, already: true, push: pushOn });
    const sent = await notifyUsers(settings, accountsOf(state.members, account.id), {
      title: `${plan.activity}: time chosen`,
      body: `${whenText(plan.chosen, plan.timeZone)}. Tap to say if you're in.`,
      url: link,
      tag: `plan:${slug}`,
    });
    return send(response, 200, { sent, push: pushOn });
  }

  // nudge
  if (plan.createdBy !== caller.id) return send(response, 403, { error: "Only whoever proposed the plan can nudge." });
  if (plan.chosen) return send(response, 409, { error: "A time is already picked." });
  let waiting = [];
  const outcome = await updateRow(settings.url, settings.key, slug, async (stored) => {
    const current = stored.plan;
    if (!current || current.id !== plan.id) return { status: 409, body: { error: "The plan changed. Reload and try again." } };
    if (current.nudgedAt && Date.now() - new Date(current.nudgedAt).getTime() < NUDGE_COOLDOWN_MS) {
      return { status: 429, body: { error: "You already nudged in the last 12 hours.", nextAt: new Date(new Date(current.nudgedAt).getTime() + NUDGE_COOLDOWN_MS).toISOString() } };
    }
    waiting = membersWithoutVote(stored);
    const now = new Date().toISOString();
    const next = normalizeWorkspaceState({
      ...stored,
      plan: { ...current, nudgedAt: now },
      activity: [{ message: `${first(caller)} nudged people who haven't voted on ${current.activity}`, at: now }, ...stored.activity],
    });
    return { state: next, reply: (saved, rev) => ({ state: memberView(saved), rev }) };
  });
  if (outcome.status !== 200) return send(response, outcome.status, outcome.body);
  const sent = await notifyUsers(settings, waiting.filter((member) => !hasVotedOnTime(plan, member.id)).map((member) => member.userId).filter((id) => id && id !== account.id), {
    title: `Vote on a time for ${plan.activity}`,
    body: `${first(caller)} is waiting on your vote in ${state.name}.`,
    url: link,
    tag: `nudge:${slug}`,
  });
  return send(response, 200, { sent, waiting: waiting.length, push: pushOn, ...outcome.body });
}

export default async function handler(request, response) {
  try {
    return await handle(request, response);
  } catch (error) {
    console.error("notify handler failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, { error: "Couldn't send that right now." });
  }
}
