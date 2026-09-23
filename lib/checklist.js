// The "Get started" checklist a new group sees until it is set up.
//
// Pure: the app passes in the workspace state, the current member and how many
// calendar links this device has, and gets back which steps are done.

export const DEMO_SLUG = "weekend-crew";

/** normalizeWorkspaceState's fallback when a workspace has no name at all. */
const FALLBACK_NAME = "Weekend crew";

/**
 * The name a brand-new workspace gets from its link: "book-club-7fq2x" becomes
 * "Book club 7fq2x". api/workspace.js seeds new groups with this, so a group
 * still carrying it has not been named by anyone yet.
 */
export function placeholderName(slug) {
  return String(slug || "").replace(/-/g, " ").replace(/^./, (character) => character.toUpperCase());
}

const comparable = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

/** True when the group still has the name it was seeded with. */
export function isPlaceholderName(name, slug) {
  const current = comparable(name);
  if (!current) return true;
  if (current === comparable(placeholderName(slug))) return true;
  // An empty name normalizes to the demo's; outside the demo that is a default too.
  return slug !== DEMO_SLUG && current === comparable(FALLBACK_NAME);
}

export function hasOwnTimes(member, sourcesCount = 0) {
  if (sourcesCount > 0) return true;
  return Boolean(member && ((member.weekly?.length ?? 0) > 0 || (member.busy?.length ?? 0) > 0));
}

export const INVITE_TARGET = 3;

/** The three setup steps, in order, each with whether it is done. */
export function checklistSteps({ state, member = null, sourcesCount = 0, slug } = {}) {
  const members = Array.isArray(state?.members) ? state.members : [];
  return [
    { id: "name", label: "Name your group", done: !isPlaceholderName(state?.name, slug) },
    { id: "times", label: "Add your times", done: hasOwnTimes(member, sourcesCount) },
    { id: "invite", label: "Invite two people", done: members.length >= INVITE_TARGET },
  ];
}

/** Whether the card belongs on the page at all (dismissal is checked separately). */
export function showChecklist(slug, steps) {
  if (!slug || slug === DEMO_SLUG) return false;
  return steps.some((step) => !step.done);
}
