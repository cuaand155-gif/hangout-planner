// Friend requests between signed-in accounts.
//
// One table does the whole job: a request is a row, a friendship is a row whose
// status is "accepted". A request is addressed to an email rather than to a
// user id, so you can invite somebody who has not signed up yet — they see it
// waiting the first time they sign in with that address.
//
// The pure helpers here decide what belongs where; the Supabase calls live in
// createFriendStore() so the rest can be tested without a database.

import { normalizeEmail } from "./membership.js";

export const REQUEST_TABLE = "friend_requests";
export const STATUSES = ["pending", "accepted", "declined"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

/** True when this row is addressed to me, by id or by the email I signed in with. */
export function addressedToMe(row, { userId, email }) {
  const mine = normalizeEmail(email);
  return row.recipient_id === userId || (Boolean(mine) && normalizeEmail(row.recipient_email) === mine);
}

/**
 * Splits rows into the three lists the UI shows. A person appears at most
 * once per list even if several rows exist for them, newest first.
 */
export function partitionRequests(rows = [], { userId, email } = {}) {
  const incoming = [];
  const outgoing = [];
  const friends = [];

  const sorted = rows
    .filter((row) => row && STATUSES.includes(row.status))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  for (const row of sorted) {
    const isMine = row.requester_id === userId;
    const isForMe = addressedToMe(row, { userId, email });
    if (!isMine && !isForMe) continue;

    if (row.status === "accepted") {
      friends.push({ ...row, friendId: isMine ? row.recipient_id : row.requester_id, direction: isMine ? "sent" : "received" });
      continue;
    }
    if (row.status !== "pending") continue;
    if (isForMe && !isMine) incoming.push(row);
    else if (isMine) outgoing.push(row);
  }

  return {
    incoming: dedupe(incoming, (row) => row.requester_id || normalizeEmail(row.recipient_email)),
    outgoing: dedupe(outgoing, (row) => normalizeEmail(row.recipient_email) || row.recipient_id),
    friends: dedupe(friends, (row) => row.friendId || normalizeEmail(row.recipient_email)),
  };
}

function dedupe(rows, keyOf) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyOf(row);
    if (!key || seen.has(key)) return Boolean(!key);
    seen.add(key);
    return true;
  });
}

/** Everyone whose profile the UI needs to name a row. */
export function profileIdsFor(rows = []) {
  const ids = new Set();
  for (const row of rows) {
    if (row.requester_id) ids.add(row.requester_id);
    if (row.recipient_id) ids.add(row.recipient_id);
  }
  return [...ids];
}

/**
 * The display name and photo of the *other* person on a row.
 *
 * recipient_email is only their address on a request I sent. On one I
 * received it is my own address, and treating it as theirs would match me
 * everywhere a person is looked up by email.
 */
export function describeParty(row, { userId, profiles = {} } = {}) {
  const iSent = row.requester_id === userId;
  const otherId = iSent ? row.recipient_id : row.requester_id;
  const profile = otherId ? profiles[otherId] : null;
  const email = iSent ? normalizeEmail(row.recipient_email) : normalizeEmail(profile?.email);
  return {
    id: otherId || null,
    name: profile?.display_name || email || "Someone",
    photo: profile?.photo_url || "",
    email,
    pendingSignup: !otherId && iSent,
  };
}

/** Why a request cannot be sent, or null when it can. */
export function rejectionFor(target, { email, rows = [] } = {}) {
  const wanted = normalizeEmail(target);
  if (!wanted) return "Enter an email address first.";
  if (!isValidEmail(wanted)) return "That does not look like an email address.";
  if (wanted === normalizeEmail(email)) return "That is your own address.";

  const existing = rows.find(
    (row) =>
      normalizeEmail(row.recipient_email) === wanted &&
      (row.status === "pending" || row.status === "accepted")
  );
  if (existing?.status === "accepted") return "You are already friends.";
  if (existing) return "You already have a request waiting for them.";
  return null;
}

/**
 * The Supabase calls, kept behind one small interface so the UI can be driven
 * by a stub in tests. Every method returns { data, error } like the client.
 */
export function createFriendStore(client) {
  return {
    async list() {
      const { data, error } = await client.from(REQUEST_TABLE).select("*");
      return { data: data || [], error };
    },
    async profiles(ids) {
      if (!ids.length) return { data: {}, error: null };
      const { data, error } = await client.from("profiles").select("id, display_name, photo_url").in("id", ids);
      const byId = {};
      for (const row of data || []) byId[row.id] = row;
      return { data: byId, error };
    },
    async send({ requesterId, email, note }) {
      return client.from(REQUEST_TABLE).insert({
        requester_id: requesterId,
        recipient_email: normalizeEmail(email),
        note: note || null,
        status: "pending",
      });
    },
    async respond({ id, accept, userId }) {
      return client
        .from(REQUEST_TABLE)
        .update({
          status: accept ? "accepted" : "declined",
          recipient_id: userId,
          responded_at: new Date().toISOString(),
        })
        .eq("id", id);
    },
    async withdraw(id) {
      return client.from(REQUEST_TABLE).delete().eq("id", id);
    },
  };
}
