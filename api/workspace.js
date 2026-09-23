// Shared workspace persistence.
//
//   GET  /api/workspace?slug=weekend-crew  -> { slug, state, rev, persisted }
//   PUT  /api/workspace?slug=weekend-crew  -> { slug, state, rev, persisted }
//
// Without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY the handler answers with
// a demo workspace and reports persisted:false, which is what makes the app
// usable on static hosting without pretending that edits are being saved.
//
// `rev` is the row's updated_at. A PUT sends the rev it read and the update
// only lands if the row still carries it, so two people editing at once get a
// 409 with the current state instead of silently overwriting each other.

import { createDemoState, normalizeWorkspaceState, slugify, stateTooLarge } from "../lib/planner.js";
import { bearer, config, restHeaders, send, userFromToken } from "./_supabase.js";

const MAX_BODY_BYTES = 512 * 1024;

/** A new workspace starts empty; the default slug keeps the sample crew. */
function seedFor(slug) {
  return normalizeWorkspaceState(
    slug === "weekend-crew" ? createDemoState() : { name: slug.replace(/-/g, " ").replace(/^./, (character) => character.toUpperCase()) }
  );
}

async function readBody(request) {
  if (request.body !== undefined && request.body !== null && request.body !== "") {
    if (typeof request.body === "string") {
      if (request.body.length > MAX_BODY_BYTES) throw new Error("too-large");
      return JSON.parse(request.body);
    }
    return request.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("too-large");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadRow(url, key, slug) {
  const endpoint = `${url}/rest/v1/workspaces?slug=eq.${encodeURIComponent(slug)}&select=slug,state,updated_at`;
  const result = await fetch(endpoint, { headers: restHeaders(key) });
  if (!result.ok) return { error: await describe(result) };
  const rows = await result.json();
  return { row: rows[0] || null };
}

async function describe(result) {
  try {
    const body = await result.text();
    return `${result.status} ${body.slice(0, 200)}`;
  } catch {
    return String(result.status);
  }
}

async function insertRow(url, key, slug, state) {
  const result = await fetch(`${url}/rest/v1/workspaces`, {
    method: "POST",
    headers: restHeaders(key, { Prefer: "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify({ slug, state, updated_at: new Date().toISOString() }),
  });
  if (!result.ok) return { error: await describe(result) };
  const rows = await result.json();
  return { row: rows[0] || null };
}

async function handle(request, response) {
  const slug = slugify(request.query?.slug);
  const settings = config();

  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "GET, PUT, OPTIONS");
    return send(response, 204, {});
  }

  if (request.method !== "GET" && request.method !== "PUT") {
    response.setHeader("Allow", "GET, PUT, OPTIONS");
    return send(response, 405, { error: "Method not allowed" });
  }

  // No database configured: echo the caller's own state back so the app keeps
  // working on this device, and say plainly that nothing was stored.
  if (!settings) {
    let state = seedFor(slug);
    if (request.method === "PUT") {
      try {
        const payload = await readBody(request);
        state = normalizeWorkspaceState(payload?.state ?? payload);
      } catch {
        return send(response, 400, { error: "Invalid JSON body" });
      }
    }
    return send(response, 200, {
      slug,
      state,
      rev: null,
      persisted: false,
      reason: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to share this workspace.",
    });
  }

  const { url, key } = settings;

  if (request.method === "GET") {
    const { row, error } = await loadRow(url, key, slug);
    if (error) return send(response, 502, { error: "Unable to load workspace", detail: error });
    if (row) {
      return send(response, 200, { slug, state: normalizeWorkspaceState(row.state), rev: row.updated_at, persisted: true });
    }
    // First visit to a slug creates it, so an invite link works immediately.
    const seeded = seedFor(slug);
    const created = await insertRow(url, key, slug, seeded);
    if (created.error) return send(response, 502, { error: "Unable to create workspace", detail: created.error });
    return send(response, 201, {
      slug,
      state: normalizeWorkspaceState(created.row?.state || seeded),
      rev: created.row?.updated_at || null,
      persisted: true,
    });
  }

  let payload;
  try {
    payload = await readBody(request);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "too-large";
    return send(response, tooLarge ? 413 : 400, { error: tooLarge ? "Workspace is too large" : "Invalid JSON body" });
  }

  const incoming = normalizeWorkspaceState(payload?.state ?? payload);
  if (stateTooLarge(incoming)) return send(response, 413, { error: "Workspace is too large" });

  const current = await loadRow(url, key, slug);
  if (current.error) return send(response, 502, { error: "Unable to load workspace", detail: current.error });

  if (!current.row) {
    const created = await insertRow(url, key, slug, incoming);
    if (created.error) return send(response, 502, { error: "Unable to create workspace", detail: created.error });
    return send(response, 201, { slug, state: normalizeWorkspaceState(created.row?.state || incoming), rev: created.row?.updated_at || null, persisted: true });
  }

  const stored = normalizeWorkspaceState(current.row.state);
  let authenticatedUser;

  // A locked workspace only accepts writes from a signed-in member.
  if (stored.settings.locked) {
    authenticatedUser = await userFromToken(url, key, bearer(request));
    const userId = authenticatedUser;
    const allowed = userId && (stored.ownerId === userId || stored.members.some((member) => member.userId === userId));
    if (!allowed) {
      return send(response, 403, {
        error: "This workspace is locked to its signed-in members.",
        slug,
        state: stored,
        rev: current.row.updated_at,
        persisted: true,
      });
    }
  }

  const rev = payload?.rev;
  if (rev && current.row.updated_at && rev !== current.row.updated_at) {
    return send(response, 409, {
      error: "Workspace changed since it was loaded",
      slug,
      state: stored,
      rev: current.row.updated_at,
      persisted: true,
    });
  }

  // Ownership is not reassignable by whoever writes last: once a workspace has
  // an owner, only that signed-in owner can change the field.
  if (stored.ownerId && incoming.ownerId !== stored.ownerId) {
    if (authenticatedUser === undefined) authenticatedUser = await userFromToken(url, key, bearer(request));
    if (authenticatedUser !== stored.ownerId) incoming.ownerId = stored.ownerId;
  }

  const updatedAt = new Date().toISOString();
  const filter = rev
    ? `slug=eq.${encodeURIComponent(slug)}&updated_at=eq.${encodeURIComponent(rev)}`
    : `slug=eq.${encodeURIComponent(slug)}`;
  const result = await fetch(`${url}/rest/v1/workspaces?${filter}`, {
    method: "PATCH",
    headers: restHeaders(key, { Prefer: "return=representation" }),
    body: JSON.stringify({ state: { ...incoming, updatedAt }, updated_at: updatedAt }),
  });
  if (!result.ok) return send(response, 502, { error: "Unable to save workspace", detail: await describe(result) });
  const rows = await result.json();
  if (!rows.length) {
    // The rev filter matched nothing, so somebody else saved in between.
    const latest = await loadRow(url, key, slug);
    return send(response, 409, {
      error: "Workspace changed since it was loaded",
      slug,
      state: normalizeWorkspaceState(latest.row?.state || stored),
      rev: latest.row?.updated_at || null,
      persisted: true,
    });
  }
  return send(response, 200, { slug, state: normalizeWorkspaceState(rows[0].state), rev: rows[0].updated_at, persisted: true });
}

/**
 * A throw here would surface as Vercel's opaque FUNCTION_INVOCATION_FAILED,
 * so failures (an unreachable or mistyped database URL, a non-JSON reply)
 * come back as a JSON 502 instead. Only the error's type is returned; the
 * full error goes to the function logs.
 */
export default async function handler(request, response) {
  try {
    return await handle(request, response);
  } catch (error) {
    console.error("workspace handler failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, {
      error: "The database could not be reached. Check the Supabase URL and key on the host.",
      detail: error?.name || "Error",
    });
  }
}
