// Shared workspace persistence.
//
//   GET  /api/workspace?slug=weekend-crew  -> { slug, state, rev, persisted }
//   PUT  /api/workspace?slug=weekend-crew  -> { slug, state, rev, persisted }
//   POST /api/workspace?slug=weekend-crew  -> one action (below)
//
// Without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY the handler answers with
// a demo workspace and reports persisted:false, which is what makes the app
// usable on static hosting without pretending that edits are being saved.
//
// With a database, every group except the demo needs either a signed-in caller
// or the group's invite link:
//
//   * Signed in (Authorization: Bearer <Supabase token>): the whole group, as
//     before. Members save with PUT.
//   * Invite link (X-Waddle-Invite: <code>): a guest. Without a guest token the
//     answer is only { join: { name } } so they can enter a name; with a valid
//     one (X-Waddle-Guest: <token>) it is the guest view from lib/guests.js:
//     busy/free and the plan, never event names, places, emails or secrets.
//   * Neither: 401 with signIn:true and nothing about the group, not even
//     whether it exists. The demo stays open so people can try the app.
//
// Guests never write the whole document. They POST one action, which the
// server applies to their own row and votes only:
//   { action: "guest-join",   invite, token, name, memberId? }
//   { action: "guest-update", invite, token, self?, timeVotes?, rsvp?, ideaVotes? }
// Owners (signed in) manage the link and guests:
//   { action: "invite-revoke" } | { action: "invite-renew" } | { action: "guest-remove", memberId }
//
// `rev` is the row's updated_at. A PUT sends the rev it read and the update
// only lands if the row still carries it, so two people editing at once get a
// 409 with the current state instead of silently overwriting each other.
// Actions do the same compare-and-swap and simply retry.

import { createDemoState, normalizeWorkspaceState, slugify, stateTooLarge, LIMITS } from "../lib/planner.js";
import { DEMO_SLUG, placeholderName } from "../lib/checklist.js";
import {
  GUEST_LIMITS,
  addGuest,
  applyGuestUpdate,
  countWrite,
  guestForToken,
  guestView,
  hashToken,
  inviteIsLive,
  isGuestToken,
  memberView,
  newInviteCode,
  removeGuest,
} from "../lib/guests.js";
import { bearer, config, restHeaders, send, userFromToken } from "./_supabase.js";

// Room for a full-size state (LIMITS.stateBytes) plus the request wrapper.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// An action carries at most one person's week of busy blocks and some votes.
const MAX_ACTION_BYTES = 256 * 1024;

function freshInvite(now = new Date()) {
  return { code: newInviteCode(), revoked: false, createdAt: now.toISOString() };
}

/** A new workspace starts empty; the default slug keeps the sample crew. */
function seedFor(slug) {
  if (slug === DEMO_SLUG) return normalizeWorkspaceState(createDemoState());
  return normalizeWorkspaceState({ name: placeholderName(slug), invite: freshInvite() });
}

async function readBody(request, limit = MAX_BODY_BYTES) {
  if (request.body !== undefined && request.body !== null && request.body !== "") {
    if (typeof request.body === "string") {
      if (request.body.length > limit) throw new Error("too-large");
      return JSON.parse(request.body);
    }
    if (JSON.stringify(request.body).length > limit) throw new Error("too-large");
    return request.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("too-large");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bodyError(response, error) {
  const tooLarge = error instanceof Error && error.message === "too-large";
  return send(response, tooLarge ? 413 : 400, { error: tooLarge ? "Workspace is too large" : "Invalid JSON body" });
}

function header(request, name) {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
  return typeof value === "string" ? value.trim() : "";
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

/** Saves `state` only if the row still carries `rev`. Returns the saved row, or null when someone else saved first. */
async function saveIfUnchanged(url, key, slug, rev, state) {
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
async function updateRow(url, key, slug, change) {
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

/** Owners manage the link and guests. A group nobody owns yet lets any signed-in member. */
function canManage(state, userId) {
  if (!userId) return false;
  if (state.ownerId) return state.ownerId === userId;
  return state.members.some((member) => member.userId === userId);
}

/* ---------------------------------------------------------------- guests */

/** The first thing a guest's browser asks: may I join, or who am I here? */
async function guestRead(response, { url, key, slug, invite, token }) {
  const { row, error } = await loadRow(url, key, slug);
  if (error) return send(response, 502, { error: "Unable to load workspace", detail: error });
  const stored = row ? normalizeWorkspaceState(row.state) : null;
  // A wrong code, a group that doesn't exist and a link that was turned off all look the same.
  if (!stored || !inviteIsLive(stored, invite)) {
    return send(response, 403, { error: "This invite link doesn't work any more. Ask for a new one, or sign in.", inviteRevoked: true, signIn: true });
  }
  if (stored.settings.locked) {
    return send(response, 403, { error: "This group only lets signed-in members in.", locked: true, signIn: true });
  }
  const memberId = await guestForToken(stored, token);
  if (!memberId) {
    return send(response, 200, { slug, join: { name: stored.name, people: stored.members.length, full: stored.members.length >= LIMITS.members }, persisted: true });
  }
  return send(response, 200, { slug, guest: { memberId }, state: guestView(stored), rev: row.updated_at, persisted: true });
}

async function guestAction(response, body, { url, key, slug }) {
  const { action, invite, token } = body;
  if (!isGuestToken(token)) return send(response, 400, { error: "Missing guest token." });
  const hash = await hashToken(token);
  let joinedId = null;

  const outcome = await updateRow(url, key, slug, async (stored) => {
    if (!inviteIsLive(stored, invite)) return { status: 403, body: { error: "This invite link doesn't work any more.", inviteRevoked: true, signIn: true } };
    if (stored.settings.locked) return { status: 403, body: { error: "This group only lets signed-in members in.", locked: true, signIn: true } };
    const existing = await guestForToken(stored, token);
    const reply = (state, rev) => ({ slug, guest: { memberId: joinedId || existing }, state: guestView(state), rev, persisted: true });

    if (action === "guest-join") {
      if (existing) return { state: null, reply };
      const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
      if (!name) return { status: 400, body: { error: "Add your name to join." } };
      if (name.length > GUEST_LIMITS.name) return { status: 400, body: { error: "That name is too long." } };
      if (stored.members.length >= LIMITS.members) return { status: 409, body: { error: "This group is full." } };
      const joins = countWrite(stored.invite.joins, Date.now(), { limit: GUEST_LIMITS.joins, windowMs: GUEST_LIMITS.joinWindowMs });
      if (!joins) return { status: 429, body: { error: "Lots of people just joined. Try again in a little while." } };
      const added = addGuest({ ...stored, invite: { ...stored.invite, joins } }, { name, hash, id: body.memberId });
      joinedId = added.memberId;
      return { state: added.state, reply };
    }

    // guest-update
    if (!existing) return { status: 403, body: { error: "You're not in this group any more.", guestUnknown: true } };
    const counter = countWrite(stored.guests?.[existing], Date.now());
    if (!counter) return { status: 429, body: { error: "That's a lot of changes at once. Wait a minute, then try again." } };
    const applied = applyGuestUpdate(stored, existing, body, new Date());
    if (!applied) return { status: 403, body: { error: "You're not in this group any more.", guestUnknown: true } };
    const next = normalizeWorkspaceState({ ...applied.state, guests: { ...applied.state.guests, [existing]: { ...stored.guests[existing], ...counter } } });
    return { state: next, reply };
  });
  return send(response, outcome.status === 200 && action === "guest-join" && joinedId ? 201 : outcome.status, outcome.body);
}

async function ownerAction(request, response, body, { url, key, slug }) {
  const userId = await userFromToken(url, key, bearer(request));
  if (!userId) return send(response, 401, { error: "Sign in first.", signIn: true });
  const outcome = await updateRow(url, key, slug, async (stored) => {
    if (!canManage(stored, userId)) return { status: 403, body: { error: "Only the group's owner can do that." } };
    const reply = (state, rev) => ({ slug, state: memberView(state), rev, persisted: true });
    if (body.action === "invite-revoke") {
      if (!stored.invite || stored.invite.revoked) return { state: null, reply };
      return { state: normalizeWorkspaceState({ ...stored, invite: { ...stored.invite, revoked: true }, activity: [{ message: "Invite link turned off", at: new Date().toISOString() }, ...stored.activity] }), reply };
    }
    if (body.action === "invite-renew") {
      return { state: normalizeWorkspaceState({ ...stored, invite: freshInvite(), activity: [{ message: "New invite link made", at: new Date().toISOString() }, ...stored.activity] }), reply };
    }
    // guest-remove
    const next = removeGuest(stored, String(body.memberId || ""));
    if (!next) return { status: 404, body: { error: "That guest isn't in this group." } };
    return { state: next, reply };
  });
  return send(response, outcome.status, outcome.body);
}

async function handleAction(request, response, settings, slug) {
  let body;
  try {
    body = await readBody(request, MAX_ACTION_BYTES);
  } catch (error) {
    return bodyError(response, error);
  }
  if (!body || typeof body !== "object") return send(response, 400, { error: "Invalid JSON body" });
  if (slug === DEMO_SLUG) return send(response, 400, { error: "The demo group has no invite link." });
  const context = { ...settings, slug };
  if (body.action === "guest-join" || body.action === "guest-update") return guestAction(response, body, context);
  if (["invite-revoke", "invite-renew", "guest-remove"].includes(body.action)) return ownerAction(request, response, body, context);
  return send(response, 400, { error: "Unknown action." });
}

/* ------------------------------------------------------------- handler */

async function handle(request, response) {
  const slug = slugify(request.query?.slug);
  const settings = config();
  const allow = "GET, PUT, POST, OPTIONS";

  if (request.method === "OPTIONS") {
    response.setHeader("Allow", allow);
    return send(response, 204, {});
  }

  if (!["GET", "PUT", "POST"].includes(request.method)) {
    response.setHeader("Allow", allow);
    return send(response, 405, { error: "Method not allowed" });
  }

  // No database configured: echo the caller's own state back so the app keeps
  // working on this device, and say plainly that nothing was stored.
  if (!settings) {
    if (request.method === "POST") return send(response, 503, { error: "Invite links need the database to be set up." });
    let state = seedFor(slug);
    if (request.method === "PUT") {
      try {
        const payload = await readBody(request);
        state = normalizeWorkspaceState(payload?.state ?? payload);
      } catch (error) {
        return bodyError(response, error);
      }
      if (stateTooLarge(state)) return send(response, 413, { error: "Workspace is too large" });
    }
    // Nothing is stored, so there is no invite link to hand out either.
    const { invite: _unused, ...demoState } = memberView(state);
    return send(response, 200, {
      slug,
      state: demoState,
      rev: null,
      persisted: false,
      reason: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to share this workspace.",
    });
  }

  const { url, key } = settings;

  if (request.method === "POST") return handleAction(request, response, settings, slug);

  // Groups require an account or the invite link; checked before anything is read or written.
  let authenticatedUser;
  if (slug !== DEMO_SLUG) {
    authenticatedUser = await userFromToken(url, key, bearer(request));
    if (!authenticatedUser) {
      const invite = header(request, "x-waddle-invite");
      if (invite && request.method === "GET") return guestRead(response, { url, key, slug, invite, token: header(request, "x-waddle-guest") });
      return send(response, 401, { error: "Sign in to open this group.", signIn: true });
    }
  }

  if (request.method === "GET") {
    const { row, error } = await loadRow(url, key, slug);
    if (error) return send(response, 502, { error: "Unable to load workspace", detail: error });
    if (row) {
      const stored = normalizeWorkspaceState(row.state);
      // Groups made before invite links get one the first time a member opens them.
      if (!stored.invite && slug !== DEMO_SLUG) {
        const saved = await saveIfUnchanged(url, key, slug, row.updated_at, normalizeWorkspaceState({ ...stored, invite: freshInvite() }));
        if (saved.row) return send(response, 200, { slug, state: memberView(normalizeWorkspaceState(saved.row.state)), rev: saved.row.updated_at, persisted: true });
      }
      return send(response, 200, { slug, state: memberView(stored), rev: row.updated_at, persisted: true });
    }
    // First visit to a slug creates it, so an invite link works immediately.
    const seeded = seedFor(slug);
    const created = await insertRow(url, key, slug, seeded);
    if (created.error) return send(response, 502, { error: "Unable to create workspace", detail: created.error });
    return send(response, 201, {
      slug,
      state: memberView(normalizeWorkspaceState(created.row?.state || seeded)),
      rev: created.row?.updated_at || null,
      persisted: true,
    });
  }

  let payload;
  try {
    payload = await readBody(request);
  } catch (error) {
    return bodyError(response, error);
  }

  const incoming = normalizeWorkspaceState(payload?.state ?? payload);
  if (stateTooLarge(incoming)) return send(response, 413, { error: "Workspace is too large" });

  const current = await loadRow(url, key, slug);
  if (current.error) return send(response, 502, { error: "Unable to load workspace", detail: current.error });

  if (!current.row) {
    // The invite link is the server's to make, never the browser's.
    const fresh = normalizeWorkspaceState({ ...incoming, invite: slug === DEMO_SLUG ? null : freshInvite(), guests: null });
    const created = await insertRow(url, key, slug, fresh);
    if (created.error) return send(response, 502, { error: "Unable to create workspace", detail: created.error });
    return send(response, 201, { slug, state: memberView(normalizeWorkspaceState(created.row?.state || fresh)), rev: created.row?.updated_at || null, persisted: true });
  }

  const stored = normalizeWorkspaceState(current.row.state);

  // A locked workspace only accepts writes from a signed-in member.
  if (stored.settings.locked) {
    if (authenticatedUser === undefined) authenticatedUser = await userFromToken(url, key, bearer(request));
    const userId = authenticatedUser;
    const allowed = userId && (stored.ownerId === userId || stored.members.some((member) => member.userId === userId));
    if (!allowed) {
      return send(response, 403, {
        error: "This workspace is locked to its signed-in members.",
        slug,
        state: memberView(stored),
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
      state: memberView(stored),
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

  // The invite link and the guests' token hashes are the server's: a member's
  // save can never change or drop them (normalizing prunes removed guests).
  const next = normalizeWorkspaceState({ ...incoming, invite: stored.invite || null, guests: stored.guests || null });

  const saved = await saveIfUnchanged(url, key, slug, rev ? rev : null, next);
  if (saved.error) return send(response, 502, { error: "Unable to save workspace", detail: saved.error });
  if (!saved.row) {
    // The rev filter matched nothing, so somebody else saved in between.
    const latest = await loadRow(url, key, slug);
    return send(response, 409, {
      error: "Workspace changed since it was loaded",
      slug,
      state: memberView(normalizeWorkspaceState(latest.row?.state || stored)),
      rev: latest.row?.updated_at || null,
      persisted: true,
    });
  }
  return send(response, 200, { slug, state: memberView(normalizeWorkspaceState(saved.row.state)), rev: saved.row.updated_at, persisted: true });
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
