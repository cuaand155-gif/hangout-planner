// Sending Web Push notifications (server only).
//
// Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT; without them
// nothing is sent and callers carry on (in-app notifications still work).
// The web-push package encrypts each message for its subscription; the request
// itself goes out through fetch, so tests can answer it with a fake push
// service and nothing reaches a real one. Subscriptions a push service says
// are gone (404/410) are deleted. Each moment is sent once: a key goes into
// notification_log first, and a key that's already there means "already sent".

import webpush from "web-push";
import { restHeaders } from "./_supabase.js";

export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const subject = process.env.VAPID_SUBJECT || "";
  return publicKey && privateKey && /^(mailto:|https:)/.test(subject) ? { publicKey, privateKey, subject } : null;
}

/** Push subscriptions of these accounts (weekly: only those who asked for the weekly nudge). */
export async function subscriptionsFor({ url, key }, userIds, { weekly = false } = {}) {
  const ids = [...new Set((userIds || []).filter((id) => /^[0-9a-f-]{36}$/i.test(String(id))))];
  if (!ids.length && !weekly) return [];
  const query = new URLSearchParams({ select: "endpoint,p256dh,auth,user_id" });
  if (ids.length) query.set("user_id", `in.(${ids.join(",")})`);
  if (weekly) query.set("weekly_nudge", "eq.true");
  const result = await fetch(`${url}/rest/v1/push_subscriptions?${query}`, { headers: restHeaders(key) });
  if (!result.ok) return [];
  return result.json();
}

/**
 * Claims a notification key. True the first time; false if it was already
 * sent (or the log can't be written, so nothing is sent twice by mistake).
 */
export async function claimOnce({ url, key }, logKey) {
  const result = await fetch(`${url}/rest/v1/notification_log`, {
    method: "POST",
    headers: restHeaders(key, { Prefer: "return=minimal" }),
    body: JSON.stringify({ key: String(logKey).slice(0, 300) }),
  });
  return result.ok;
}

/** Sends one payload to each subscription. Returns how many were delivered. */
export async function sendPush(settings, subscriptions, payload) {
  const vapid = pushConfig();
  if (!vapid || !subscriptions.length) return 0;
  const body = JSON.stringify(payload);
  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      const request = webpush.generateRequestDetails(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        body,
        { vapidDetails: vapid, TTL: 4 * 3600, urgency: "normal" }
      );
      const response = await fetch(request.endpoint, { method: request.method, headers: request.headers, body: request.body });
      if (response.ok) delivered += 1;
      else if (response.status === 404 || response.status === 410) {
        await fetch(`${settings.url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE", headers: restHeaders(settings.key) });
      }
    } catch (error) {
      console.error("push failed:", error?.message || error);
    }
  }
  return delivered;
}

/** Sends to everyone on the list who has notifications on. */
export async function notifyUsers(settings, userIds, payload) {
  if (!pushConfig()) return 0;
  return sendPush(settings, await subscriptionsFor(settings, userIds), payload);
}

/** "Sat, Sep 28 at 6:00 PM" in the plan's own time zone. */
export function whenText(iso, timeZone = "UTC") {
  const date = new Date(iso);
  const zone = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch {
      return "UTC";
    }
  })();
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} at ${time}`;
}
