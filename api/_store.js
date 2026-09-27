// Reading and saving one workspace row with the service role (server only).
// A save only lands if the row still carries the revision that was read, so
// two writers never silently overwrite each other; updateRow retries.

import { normalizeWorkspaceState, stateTooLarge } from "../lib/planner.js";
import { restHeaders } from "./_supabase.js";

export async function loadRow(url, key, slug) {
  const endpoint = `${url}/rest/v1/workspaces?slug=eq.${encodeURIComponent(slug)}&select=slug,state,updated_at`;
  const result = await fetch(endpoint, { headers: restHeaders(key) });
  if (!result.ok) return { error: await describe(result) };
  const rows = await result.json();
  return { row: rows[0] || null };
}

export async function describe(result) {
  try {
    const body = await result.text();
    return `${result.status} ${body.slice(0, 200)}`;
  } catch {
    return String(result.status);
  }
}

export async function insertRow(url, key, slug, state) {
  const result = await fetch(`${url}/rest/v1/workspaces`, {
    method: "POST",
    headers: restHeaders(key, { Prefer: "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify({ slug, state, updated_at: new Date().toISOString() }),
  });
  if (!result.ok) return { error: await describe(result) };
  const rows = await result.json();
  return { row: rows[0] || null };
}

/** Saves `state` only if the row still carries `rev`. Returns the saved row, or null when someone else saved first. */
export async function saveIfUnchanged(url, key, slug, rev, state) {
  const updatedAt = new Date().toISOString();
  const filter = rev
    ? `slug=eq.${encodeURIComponent(slug)}&updated_at=eq.${encodeURIComponent(rev)}`
    : `slug=eq.${encodeURIComponent(slug)}`;
  const result = await fetch(`${url}/rest/v1/workspaces?${filter}`, {
    method: "PATCH",
    headers: restHeaders(key, { Prefer: "return=representation" }),
    body: JSON.stringify({ state: { ...state, updatedAt }, updated_at: updatedAt }),
  });
  if (!result.ok) return { error: await describe(result) };
  const rows = await result.json();
  return { row: rows[0] || null };
}

/**
 * Read, change, compare-and-swap, retrying when somebody saved in between.
 * `change(stored)` returns { state } to save (null state: nothing to save) and
 * `reply(state, rev)` for the answer, or { status, body } to stop.
 */
export async function updateRow(url, key, slug, change) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { row, error } = await loadRow(url, key, slug);
    if (error) return { status: 502, body: { error: "Unable to load workspace", detail: error } };
    if (!row) return { status: 404, body: { error: "This group doesn't exist." } };
    const stored = normalizeWorkspaceState(row.state);
    const outcome = await change(stored);
    if (outcome.status) return outcome;
    if (!outcome.state) return { status: 200, body: outcome.reply(stored, row.updated_at) };
    if (stateTooLarge(outcome.state)) return { status: 413, body: { error: "Workspace is too large" } };
    const saved = await saveIfUnchanged(url, key, slug, row.updated_at, outcome.state);
    if (saved.error) return { status: 502, body: { error: "Unable to save workspace", detail: saved.error } };
    if (saved.row) return { status: 200, body: outcome.reply(normalizeWorkspaceState(saved.row.state), saved.row.updated_at) };
  }
  return { status: 409, body: { error: "Your group is busy saving right now. Try again in a moment." } };
}

