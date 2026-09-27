// Turning push notifications on and off for one device.
//
//   GET    /api/push                     -> { configured, publicKey }
//   GET    /api/push?endpoint=<url>      (signed in) -> also { subscribed, weekly }
//   POST   /api/push { subscription, weekly }   (signed in) saves this device
//   DELETE /api/push { endpoint }                (signed in) forgets it
//
// Rows live in push_subscriptions, one per device, tied to the caller's
// account (from the token, never the request body). Only the server sends.

import { accountFromToken, bearer, config, jsonBody, restHeaders, send } from "./_supabase.js";
import { pushConfig } from "./_push.js";
import { cleanSubscription } from "../lib/push.js";
import { countMetric } from "./_metrics.js";

async function handle(request, response) {
  const vapid = pushConfig();
  const settings = config();
  const configured = Boolean(vapid && settings);
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    return send(response, 204, {});
  }
  if (request.method === "GET" && !request.query?.endpoint) return send(response, 200, { configured, publicKey: configured ? vapid.publicKey : null });
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    return send(response, 405, { error: "Method not allowed" });
  }
  if (!configured) return send(response, 503, { error: "Notifications aren't set up on this server yet.", configured: false });

  const { url, key } = settings;
  const account = await accountFromToken(url, key, bearer(request));
  if (!account) return send(response, 401, { error: "Sign in to turn on notifications.", signIn: true });

  if (request.method === "GET") {
    const endpoint = String(request.query.endpoint);
    const result = await fetch(`${url}/rest/v1/push_subscriptions?${new URLSearchParams({ select: "weekly_nudge", endpoint: `eq.${endpoint}`, user_id: `eq.${account.id}` })}`, { headers: restHeaders(key) });
    const rows = result.ok ? await result.json() : [];
    return send(response, 200, { configured, publicKey: vapid.publicKey, subscribed: rows.length > 0, weekly: rows[0]?.weekly_nudge === true });
  }

  let body;
  try {
    body = await jsonBody(request, 8 * 1024);
  } catch {
    return send(response, 400, { error: "Invalid JSON body" });
  }

  if (request.method === "DELETE") {
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) return send(response, 400, { error: "Which device?" });
    await fetch(`${url}/rest/v1/push_subscriptions?${new URLSearchParams({ endpoint: `eq.${endpoint}`, user_id: `eq.${account.id}` })}`, { method: "DELETE", headers: restHeaders(key) });
    return send(response, 200, { subscribed: false });
  }

  const subscription = cleanSubscription(body?.subscription);
  if (!subscription) return send(response, 400, { error: "That isn't a push subscription this server can use." });
  // One device belongs to one account: re-subscribing after switching accounts moves it.
  const existing = await fetch(`${url}/rest/v1/push_subscriptions?${new URLSearchParams({ select: "user_id", endpoint: `eq.${subscription.endpoint}` })}`, { headers: restHeaders(key) });
  const known = existing.ok ? (await existing.json())[0] : null;
  const row = { ...subscription, user_id: account.id, weekly_nudge: body.weekly === true, updated_at: new Date().toISOString() };
  const saved = await fetch(`${url}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
    method: "POST",
    headers: restHeaders(key, { Prefer: "return=minimal,resolution=merge-duplicates" }),
    body: JSON.stringify(row),
  });
  if (!saved.ok) return send(response, 502, { error: "Couldn't save that. Try again in a moment." });
  if (!known) await countMetric("push_opt_ins");
  return send(response, 200, { subscribed: true, weekly: row.weekly_nudge });
}

export default async function handler(request, response) {
  try {
    return await handle(request, response);
  } catch (error) {
    console.error("push handler failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, { error: "Notifications are unavailable right now." });
  }
}
