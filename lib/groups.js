// The list of groups a person belongs to.
//
// Two sources feed it: groups this browser has opened (kept locally, works
// with no account), and — for someone signed in — groups whose member list
// carries their account, fetched from /api/groups so the list follows them
// between devices. Merging never produces the same group twice.

import { slugify } from "./planner.js";

export const GROUP_LIMIT = 30;

const SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o, 1/l look-alikes

/**
 * A group link that can't be guessed: "book-club" becomes "book-club-7fq2x".
 * `random` is injectable so tests are deterministic.
 */
export function newGroupSlug(name, random = Math.random) {
  const base = slugify(name, "group").slice(0, 40).replace(/-+$/g, "") || "group";
  let suffix = "";
  for (let index = 0; index < 5; index += 1) {
    suffix += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length) % SUFFIX_ALPHABET.length];
  }
  return `${base}-${suffix}`;
}

function valid(entry) {
  return entry && typeof entry.slug === "string" && entry.slug.length > 0;
}

function newestFirst(a, b) {
  return new Date(b.at || 0) - new Date(a.at || 0);
}

/** Records a visit: one entry per group, newest first, capped. */
export function rememberGroup(list, { slug, name, at = new Date().toISOString() }) {
  if (!slug) return Array.isArray(list) ? list : [];
  const others = (Array.isArray(list) ? list : []).filter((entry) => valid(entry) && entry.slug !== slug);
  const previous = (Array.isArray(list) ? list : []).find((entry) => valid(entry) && entry.slug === slug);
  const entry = { ...previous, slug, name: name || previous?.name || slug, at };
  return [entry, ...others].sort(newestFirst).slice(0, GROUP_LIMIT);
}

export function forgetGroup(list, slug) {
  return (Array.isArray(list) ? list : []).filter((entry) => valid(entry) && entry.slug !== slug);
}

/**
 * Local visits plus account groups. For a group in both, the fresher name and
 * time win and it is marked as belonging to the account.
 */
export function mergeGroups(local, remote) {
  const bySlug = new Map();
  for (const entry of Array.isArray(local) ? local : []) {
    if (valid(entry)) bySlug.set(entry.slug, { ...entry });
  }
  for (const entry of Array.isArray(remote) ? remote : []) {
    if (!valid(entry)) continue;
    const existing = bySlug.get(entry.slug);
    const newer = !existing || new Date(entry.at || 0) >= new Date(existing.at || 0);
    bySlug.set(entry.slug, {
      ...existing,
      ...(newer ? entry : {}),
      slug: entry.slug,
      name: (newer ? entry.name : existing?.name) || existing?.name || entry.name || entry.slug,
      onAccount: true,
    });
  }
  return [...bySlug.values()].sort(newestFirst).slice(0, GROUP_LIMIT);
}
