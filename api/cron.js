// Scheduled notifications, called by the database's scheduler (Supabase
// pg_cron + pg_net, see supabase/schema.sql) with a shared secret:
//
//   POST /api/cron?job=reminders   every 15 minutes: "Dinner starts in 45 minutes"
//                                  for plans starting within the hour
//   POST /api/cron?job=weekly      Thursdays: "Who's free this weekend?" to people
//                                  who opted in
//   Authorization: Bearer <CRON_SECRET>
//
// Each reminder goes out once (notification_log). Nothing is sent without
// VAPID keys; the answer then says so.

import { normalizeWorkspaceState } from "../lib/planner.js";
import { nextOccurrence } from "../lib/hangout.js";
import { config, restHeaders, send } from "./_supabase.js";
import { claimOnce, notifyUsers, pushConfig, sendPush, subscriptionsFor, whenText } from "./_push.js";
import { sameSecret } from "../lib/guests.js";

const REMINDER_MINUTES = 60;

/** Plans starting within the hour, one entry per group. */
export function dueReminders(rows, now = new Date()) {
  const due = [];
  for (const row of rows) {
    const state = normalizeWorkspaceState(row.state);
    const plan = state.plan;
    const occurrence = plan && nextOccurrence(plan, now);
    if (!occurrence) continue;
    const minutes = Math.round((occurrence.start - now) / 60000);
    if (minutes <= 0 || minutes > REMINDER_MINUTES) continue;
    const userIds = state.members.filter((member) => member.userId).map((member) => member.userId);
    due.push({ slug: row.slug, state, plan, occurrence, minutes, userIds });
  }
  return due;
}

/** "2026-W40": one weekly nudge per person per week. */
export function isoWeek(date = new Date()) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function reminders(settings, now) {
  const result = await fetch(`${settings.url}/rest/v1/workspaces?${new URLSearchParams({ select: "slug,state", "state->plan": "not.is.null" })}`, { headers: restHeaders(settings.key) });
  if (!result.ok) return { checked: 0, sent: 0 };
  const rows = await result.json();
  let sent = 0;
  const due = dueReminders(rows, now);
  for (const item of due) {
    if (!item.userIds.length) continue;
    if (!(await claimOnce(settings, `soon:${item.slug}:${item.plan.id || item.plan.activity}:${item.occurrence.start.toISOString()}`))) continue;
    sent += await notifyUsers(settings, item.userIds, {
      title: `${item.plan.activity} starts in ${item.minutes} minutes`,
      body: `${whenText(item.occurrence.start, item.plan.timeZone)} · ${item.state.name}`,
      url: `/?w=${encodeURIComponent(item.slug)}#plan`,
      tag: `soon:${item.slug}`,
    });
  }
  return { checked: rows.length, due: due.length, sent };
}

async function weekly(settings, now) {
  const subscriptions = await subscriptionsFor(settings, [], { weekly: true });
  const byUser = new Map();
  for (const subscription of subscriptions) byUser.set(subscription.user_id, [...(byUser.get(subscription.user_id) || []), subscription]);
  let sent = 0;
  for (const [userId, list] of byUser) {
    if (!(await claimOnce(settings, `weekly:${userId}:${isoWeek(now)}`))) continue;
    sent += await sendPush(settings, list, {
      title: "Who's free this weekend?",
      body: "Mark your weekend so your groups can find a time.",
      url: "/",
      tag: "weekly",
    });
  }
  return { people: byUser.size, sent };
}

export default async function handler(request, response) {
  try {
    const secret = process.env.CRON_SECRET || "";
    const given = String(request.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    if (!secret || !given || !sameSecret(given, secret)) return send(response, 401, { error: "Not allowed." });
    const settings = config();
    if (!settings) return send(response, 503, { error: "No database." });
    const job = request.query?.job;
    const now = new Date();
    if (job === "reminders") return send(response, 200, { job, push: Boolean(pushConfig()), ...(await reminders(settings, now)) });
    if (job === "weekly") return send(response, 200, { job, push: Boolean(pushConfig()), ...(await weekly(settings, now)) });
    return send(response, 400, { error: "Unknown job." });
  } catch (error) {
    console.error("cron failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, { error: "The job failed." });
  }
}
