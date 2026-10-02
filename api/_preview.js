// What a shared Waddle link shows when it's pasted into a group chat: the
// title, description and card text for /g/<group> and /p/<group> links (see
// api/page.js for the HTML, api/og.js for the image).
//
// Privacy: a preview is built from the plan's title or the group's name only.
// Never member names, the plan's place or audience, event names or places.
// And only for a link carrying the group's live invite code: without it (or
// once the link is turned off) every preview is the same generic Waddle card.

import { normalizeWorkspaceState, slugify } from "../lib/planner.js";
import { DEMO_SLUG } from "../lib/checklist.js";
import { inviteIsLive } from "../lib/guests.js";
import { config, restHeaders } from "./_supabase.js";

export const GENERIC_PREVIEW = Object.freeze({
  title: "Waddle · find a time that works for everyone",
  description: "Plan hangouts without sharing your whole calendar. Waddle shows when people are busy or free, never what they're doing.",
  headline: "Plan hangouts without sharing your whole calendar",
  action: "Find a time",
});

/** Plain one-line text: no control characters, collapsed spaces, capped. */
export function cleanText(value, max = 80) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** The preview for one group's state. `kind` is "p" (a plan link) or "g" (the group). */
export function previewFor(state, { kind = "g" } = {}) {
  const plan = state?.plan;
  const activity = cleanText(plan?.activity);
  const name = cleanText(state?.name, 60) || "Your group";
  const privacy = "No account needed. Waddle shares busy or free, never what anyone's doing.";
  if (kind === "p" && activity && plan?.chosen) {
    return {
      title: `${activity} · RSVP`,
      description: `A time is picked. RSVP in a tap. ${privacy}`,
      headline: activity,
      action: "RSVP",
    };
  }
  if (kind === "p" && activity) {
    return {
      title: `${activity} · vote on a time`,
      description: `Say when you're free, vote on a time and RSVP in a tap. ${privacy}`,
      headline: activity,
      action: "Vote on a time",
    };
  }
  return {
    title: `${name} · find a time on Waddle`,
    description: activity
      ? `Join with just your name and vote on a time for ${activity}. ${privacy}`
      : `Join with just your name and mark when you're free. ${privacy}`,
    headline: name,
    action: activity ? "Vote on a time" : "Add your times",
  };
}

/** Loads the group (service role, server only) and returns its preview, or the generic one. */
export async function loadPreview({ slug, invite, kind }) {
  const clean = slugify(slug, "");
  if (!clean || clean === DEMO_SLUG || !invite) return { ...GENERIC_PREVIEW };
  const settings = config();
  if (!settings) return { ...GENERIC_PREVIEW };
  try {
    const result = await fetch(`${settings.url}/rest/v1/workspaces?slug=eq.${encodeURIComponent(clean)}&select=state`, { headers: restHeaders(settings.key) });
    if (!result.ok) return { ...GENERIC_PREVIEW };
    const [row] = await result.json();
    if (!row) return { ...GENERIC_PREVIEW };
    const state = normalizeWorkspaceState(row.state);
    if (!inviteIsLive(state, invite)) return { ...GENERIC_PREVIEW };
    return previewFor(state, { kind });
  } catch {
    return { ...GENERIC_PREVIEW };
  }
}

/** Query values from a Vercel request (strings only). */
export function queryOf(request) {
  const query = request.query || {};
  const pick = (key) => (typeof query[key] === "string" ? query[key] : Array.isArray(query[key]) ? String(query[key][0]) : "");
  const kind = pick("kind") === "p" ? "p" : "g";
  const invite = /^[A-Za-z0-9_-]{16,64}$/.test(pick("i")) ? pick("i") : "";
  return { kind, slug: slugify(pick("slug"), ""), invite };
}

/** This deployment's own https origin. */
export function originOf(request) {
  const host = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "").split(",")[0].trim();
  const proto = String(request.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() || (/^localhost|^127\./.test(host) ? "http" : "https");
  return /^[a-z0-9.:-]+$/i.test(host) ? `${proto}://${host}` : "https://hangout-planner-omega.vercel.app";
}
