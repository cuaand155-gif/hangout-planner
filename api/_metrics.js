// Privacy-friendly usage counts (server only): one number per metric per day
// in analytics_daily, bumped through the count_metric database function. No
// cookies, no user ids, no group names: only "how many". A failure never
// affects the request that counted it.

import { config, restHeaders } from "./_supabase.js";

export const METRICS = ["plans_created", "invites_opened", "guest_votes", "plans_confirmed", "push_opt_ins"];

export async function countMetric(metric, amount = 1) {
  if (!METRICS.includes(metric) || !(amount > 0)) return false;
  const settings = config();
  if (!settings) return false;
  try {
    const result = await fetch(`${settings.url}/rest/v1/rpc/count_metric`, {
      method: "POST",
      headers: restHeaders(settings.key),
      body: JSON.stringify({ p_metric: metric, p_amount: Math.min(Math.round(amount), 1000) }),
    });
    return result.ok;
  } catch {
    return false;
  }
}
