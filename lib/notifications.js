// What the bell tells one person about a group's plan, worked out from the
// group itself so it works for everyone, guests included, with no server:
//
//   proposed  "Sam proposed a plan"          someone else proposed it
//   vote      "You haven't voted yet"        no time picked, and no vote from you
//   chosen    "Time chosen"                  someone else picked the time
//   soon      "Dinner starts in 40 minutes"  within the hour before it starts
//
// Each item has a stable id, so the bell can remember which ones were seen.
// Push notifications (api/notify.js, api/cron.js) send the same moments to
// people who turned them on; this module is the in-app half.

import { formatClock, formatDayStamp } from "./planner.js";
import { nextOccurrence } from "./hangout.js";

export const SOON_MINUTES = 60;
export const NUDGE_COOLDOWN_MS = 12 * 3600 * 1000;

const firstName = (member) => String(member?.name || "Someone").split(" ")[0];

/** Whether this member has voted for any time on the plan. */
export function hasVotedOnTime(plan, memberId) {
  return Object.values(plan?.timeVotes || {}).some((voters) => voters.includes(memberId));
}

/** Members who haven't voted on a time yet (not counting whoever proposed it). */
export function membersWithoutVote(state) {
  const plan = state?.plan;
  if (!plan) return [];
  return (state.members || []).filter((member) => !member.pending && member.id !== plan.createdBy && !hasVotedOnTime(plan, member.id));
}

/** When the proposer may nudge again, or null if they may now. */
export function nextNudgeAt(plan, now = new Date()) {
  if (!plan?.nudgedAt) return null;
  const next = new Date(new Date(plan.nudgedAt).getTime() + NUDGE_COOLDOWN_MS);
  return next > now ? next : null;
}

/** The bell's "For you" items, newest first. */
export function notificationsFor({ state, memberId, now = new Date() }) {
  const plan = state?.plan;
  if (!plan) return [];
  const members = state.members || [];
  const byId = (id) => members.find((member) => member.id === id);
  const items = [];
  const key = plan.id || plan.activity;

  if (plan.createdBy && plan.createdBy !== memberId && byId(plan.createdBy)) {
    items.push({ id: `proposed:${key}`, kind: "proposed", title: `${firstName(byId(plan.createdBy))} proposed a plan`, body: plan.activity, at: plan.createdAt || plan.updatedAt });
  }

  if (!plan.chosen && plan.createdBy !== memberId && byId(memberId) && !hasVotedOnTime(plan, memberId)) {
    const nudged = plan.nudgedAt && byId(plan.createdBy) ? ` ${firstName(byId(plan.createdBy))} is waiting on your vote.` : "";
    items.push({ id: `vote:${key}${plan.nudgedAt ? `:${plan.nudgedAt}` : ""}`, kind: "vote", title: "You haven't voted yet", body: `Vote on a time for ${plan.activity}.${nudged}`, at: plan.nudgedAt || plan.createdAt || plan.updatedAt });
  }

  const occurrence = nextOccurrence(plan, now);
  if (plan.chosen && plan.chosenBy && plan.chosenBy !== memberId) {
    const when = new Date(plan.chosen);
    items.push({ id: `chosen:${key}:${plan.chosen}`, kind: "chosen", title: "Time chosen", body: `${plan.activity}: ${formatDayStamp(when)} at ${formatClock(when)}.`, at: plan.updatedAt });
  }

  if (occurrence) {
    const minutes = Math.round((occurrence.start - now) / 60000);
    if (minutes > 0 && minutes <= SOON_MINUTES) {
      items.push({ id: `soon:${key}:${occurrence.start.toISOString()}`, kind: "soon", title: `${plan.activity} starts in ${minutes} minute${minutes === 1 ? "" : "s"}`, body: `${formatClock(occurrence.start)} today.`, at: now.toISOString(), urgent: true });
    }
  }

  // What's about to start comes first, then newest first.
  return items.sort((a, b) => Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) || String(b.at).localeCompare(String(a.at)));
}

/** How many items haven't been seen on this device. */
export function unseenCount(items, seen = []) {
  const known = new Set(seen);
  return items.filter((item) => !known.has(item.id)).length;
}
