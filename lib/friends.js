// Friend requests between signed-in accounts.
//
// One table does the whole job: a request is a row, a friendship is a row whose
// status is "accepted". A request is addressed to an email or a phone number
// rather than to a user id, so you can invite somebody who has not signed up
// yet — they see it waiting the first time they sign in with that address or
// number.
//
// The pure helpers here decide what belongs where; the Supabase calls live in
// createFriendStore() so the rest can be tested without a database.

import { normalizeEmail } from "./membership.js";
import { contactKind, formatPhone, normalizePhone, phoneDigits, samePhone } from "./phone.js";

export const REQUEST_TABLE = "friend_requests";
export const STATUSES = ["pending", "accepted", "declined"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

/** True when this row is addressed to me, by id or by the email or phone I signed in with. */
export function addressedToMe(row, { userId, email, phone }) {
  const mine = normalizeEmail(email);
  return (
    row.recipient_id === userId ||
    (Boolean(mine) && normalizeEmail(row.recipient_email) === mine) ||
    (Boolean(phoneDigits(phone)) && samePhone(row.recipient_phone, phone))
  );
}

/** Who a request I sent is addressed to, as one comparable key. */
function recipientKey(row) {
  return normalizeEmail(row.recipient_email) || (phoneDigits(row.recipient_phone) ? `tel:${phoneDigits(row.recipient_phone)}` : "");
}

/**
 * Splits rows into the three lists the UI shows. A person appears at most
 * once per list even if several rows exist for them, newest first.
 */
export function partitionRequests(rows = [], { userId, email, phone } = {}) {
  const incoming = [];
  const outgoing = [];
  const friends = [];

  const sorted = rows
    .filter((row) => row && STATUSES.includes(row.status))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  for (const row of sorted) {
    const isMine = row.requester_id === userId;
    const isForMe = addressedToMe(row, { userId, email, phone });
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
    incoming: dedupe(incoming, (row) => row.requester_id || recipientKey(row)),
    outgoing: dedupe(outgoing, (row) => recipientKey(row) || row.recipient_id),
    friends: dedupe(friends, (row) => row.friendId || recipientKey(row)),
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
  const phone = iSent && row.recipient_phone ? formatPhone(row.recipient_phone) : "";
  return {
    id: otherId || null,
    name: profile?.display_name || email || phone || "Someone",
    photo: profile?.photo_url || "",
    email,
    phone,
    pendingSignup: !otherId && iSent,
  };
}

/** { email } or { phone } for what was typed in the one box that takes both. */
export function recipientFor(target) {
  if (contactKind(target) === "phone") {
    const phone = normalizePhone(target);
    return phone ? { phone } : null;
  }
  const email = normalizeEmail(target);
  return isValidEmail(email) ? { email } : null;
}

/** Why a request cannot be sent, or null when it can. */
export function rejectionFor(target, { email, phone, rows = [] } = {}) {
  const kind = contactKind(target);
  if (!kind) return "Enter an email address or phone number first.";
  const recipient = recipientFor(target);
  if (!recipient) {
    return kind === "phone"
      ? "That does not look like a phone number. Include the country code if it's outside North America, like +44."
      : "That does not look like an email address.";
  }
  if (recipient.email && recipient.email === normalizeEmail(email)) return "That is your own address.";
  if (recipient.phone && samePhone(recipient.phone, phone)) return "That is your own number.";

  const live = (row) => row.status === "pending" || row.status === "accepted";
  const existing = rows.find(
    (row) =>
      live(row) &&
      (recipient.email ? normalizeEmail(row.recipient_email) === recipient.email : samePhone(row.recipient_phone, recipient.phone))
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
    async send({ requesterId, email, phone, note }) {
      // Only the column in use is sent, so email requests keep working on a
      // database that has not had the phone column added yet.
      return client.from(REQUEST_TABLE).insert({
        requester_id: requesterId,
        ...(phone ? { recipient_phone: normalizePhone(phone) } : { recipient_email: normalizeEmail(email) }),
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
