// Google Calendar that keeps syncing past Google's one-hour access tokens.
//
//   GET    /api/google                     -> { configured, connected }
//   GET    /api/google?from=ISO&to=ISO      -> { items: [{ status, transparency, summary, location, start, end }] }
//   POST   /api/google { refreshToken }     -> { connected: true }
//   DELETE /api/google                      -> { connected: false }
//
// After "Connect Google Calendar" the browser hands over the one-time refresh
// token; it is stored encrypted (AES-256-GCM) in google_tokens, a table only
// the service role can touch, and used here to fetch fresh access tokens and
// then the events. Every call needs the caller's Supabase token.
//
// It needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — the same OAuth client
// Supabase's Google sign-in uses. Without them every call answers
// { configured: false } and the app keeps its hourly reconnect.
//
// api/book.js also uses the stored token, through googleFreeBusy(), to keep an
// owner's booking link closed over their Google busy times while Waddle is
// closed. That asks Google for times only, never titles.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { bearer, config, restHeaders, send, userFromToken } from "./_supabase.js";

const MAX_RANGE_DAYS = 120;
const accessCache = new Map(); // userId -> { token, expires }

export function googleKeys() {
  // Trimmed: a value pasted with a trailing newline makes Google refuse every renewal (invalid_client).
  const id = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return id && secret ? { id, secret } : null;
}

function keyFrom(secret) {
  return createHash("sha256").update(`waddle-google-refresh:${secret}`).digest();
}

export function sealToken(token, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
}

export function openToken(sealed, secret) {
  const [iv, tag, body] = String(sealed).split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

async function rest(db, path, init = {}) {
  const result = await fetch(`${db.url}/rest/v1/${path}`, { ...init, headers: restHeaders(db.key, init.headers) });
  const text = await result.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: result.ok, status: result.status, body };
}

async function storedToken(db, userId, init = {}) {
  const result = await rest(db, `google_tokens?${new URLSearchParams({ select: "refresh_token", user_id: `eq.${userId}`, limit: "1" })}`, init);
  if (!result.ok) throw new Error(`db-${result.status}`);
  return Array.isArray(result.body) && result.body[0] ? result.body[0].refresh_token : null;
}

async function forget(db, userId) {
  accessCache.delete(userId);
  await rest(db, `google_tokens?${new URLSearchParams({ user_id: `eq.${userId}` })}`, { method: "DELETE" });
}

// Google's answers that mean this server's own OAuth client is wrong, not the
// person's consent: reconnecting can't fix these, so the token is kept.
const CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client"]);

/**
 * A fresh access token as { token }, or { token: null, reason } when there is
 * no stored token ("none"), Google no longer accepts it ("revoked"), or this
 * server's Google keys are wrong ("setup"). `signal` bounds the lookups.
 */
async function refreshAccess(db, keys, userId, { signal } = {}) {
  const cached = accessCache.get(userId);
  if (cached && cached.expires > Date.now()) return { token: cached.token };
  const sealed = await storedToken(db, userId, { signal });
  if (!sealed) return { token: null, reason: "none" };
  let refreshToken;
  try {
    refreshToken = openToken(sealed, keys.secret);
  } catch {
    console.warn("Google refresh token could not be opened (sealed with a different secret); forgetting it.");
    await forget(db, userId);
    return { token: null, reason: "revoked" };
  }
  const result = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: keys.id, client_secret: keys.secret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok || !body.access_token) {
    // Google's error code and description only: never the token or the keys.
    console.warn("Google token refresh failed:", result.status, body.error || "", body.error_description || "");
    if (body.error === "invalid_grant") {
      await forget(db, userId); // revoked or expired: ask to reconnect
      return { token: null, reason: "revoked" };
    }
    return { token: null, reason: CLIENT_ERRORS.has(body.error) ? "setup" : "unavailable" };
  }
  accessCache.set(userId, { token: body.access_token, expires: Date.now() + Math.max(60, (body.expires_in || 3600) - 120) * 1000 });
  return { token: body.access_token };
}

async function accessToken(db, keys, userId, options) {
  return (await refreshAccess(db, keys, userId, options)).token;
}

const FREE_BUSY_CHUNK_DAYS = 30;

/** One freeBusy request for the primary calendar: [{ start, end }], or null when Google didn't answer usefully. */
async function freeBusyPiece(token, userId, start, end, signal) {
  const result = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: [{ id: "primary" }] }),
  });
  if (result.status === 401 || result.status === 403) accessCache.delete(userId);
  if (!result.ok) return null;
  const calendar = (await result.json())?.calendars?.primary;
  if (!calendar || (Array.isArray(calendar.errors) && calendar.errors.length)) return null;
  return (Array.isArray(calendar.busy) ? calendar.busy : [])
    .map((range) => ({ start: new Date(range?.start), end: new Date(range?.end) }))
    .filter((range) => !Number.isNaN(range.start.getTime()) && !Number.isNaN(range.end.getTime()) && range.end > range.start)
    .map((range) => ({ start: range.start.toISOString(), end: range.end.toISOString() }));
}

/**
 * The owner's busy times from their primary Google calendar, as
 * [{ start, end }], via Google's freeBusy endpoint (times only, never titles).
 * Returns null, never throws, whenever it can't answer: Google isn't
 * configured, the owner never connected, the token was revoked, Google errors
 * or takes longer than `timeoutMs`. Callers then fall back to what they have.
 */
export async function googleFreeBusy(db, userId, { from, to, timeoutMs = 4000 } = {}) {
  const keys = googleKeys();
  if (!db || !keys || !userId) return null;
  // A plain timer rather than AbortSignal.timeout(): that one's timer doesn't
  // keep the process alive, and it is cleared as soon as Google answers.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Google took too long", "TimeoutError")), timeoutMs);
  const signal = controller.signal;
  try {
    const token = await accessToken(db, keys, userId, { signal });
    if (!token) return null;
    // Google limits how long one freeBusy range may be, so ask in pieces of at
    // most FREE_BUSY_CHUNK_DAYS (one piece for the usual two-week window).
    const pieces = [];
    for (let start = new Date(from).getTime(), end = new Date(to).getTime(); start < end; start += FREE_BUSY_CHUNK_DAYS * 864e5) {
      pieces.push([start, Math.min(end, start + FREE_BUSY_CHUNK_DAYS * 864e5)]);
    }
    const answers = await Promise.all(pieces.map(([start, end]) => freeBusyPiece(token, userId, start, end, signal)));
    if (answers.some((busy) => busy === null)) return null;
    return answers.flat();
  } catch (error) {
    console.warn("Google free/busy skipped:", error?.name || "Error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readBody(request) {
  let payload = request.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return payload && typeof payload === "object" ? payload : {};
}

async function handle(request, response) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST, DELETE");
    return send(response, 405, { error: "Method not allowed" });
  }
  const db = config();
  const keys = googleKeys();
  if (!db || !keys) return send(response, 200, { configured: false, connected: false });
  const userId = await userFromToken(db.url, db.key, bearer(request));
  if (!userId) return send(response, 401, { error: "Sign in first." });

  if (request.method === "POST") {
    const payload = readBody(request);
    const refreshToken = typeof payload?.refreshToken === "string" ? payload.refreshToken.trim() : "";
    if (!refreshToken || refreshToken.length > 2048) return send(response, 400, { error: "No refresh token." });
    const result = await rest(db, "google_tokens", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: userId, refresh_token: sealToken(refreshToken, keys.secret), updated_at: new Date().toISOString() }),
    });
    if (!result.ok) throw new Error(`db-${result.status}`);
    accessCache.delete(userId);
    return send(response, 200, { configured: true, connected: true });
  }

  if (request.method === "DELETE") {
    await forget(db, userId);
    return send(response, 200, { configured: true, connected: false });
  }

  const query = request.query || {};
  if (!query.from && !query.to) {
    return send(response, 200, { configured: true, connected: Boolean(await storedToken(db, userId)) });
  }
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to - from > MAX_RANGE_DAYS * 864e5) {
    return send(response, 400, { error: "Pick a range of up to four months." });
  }
  const { token, reason } = await refreshAccess(db, keys, userId);
  if (!token) {
    if (reason === "setup") return send(response, 503, { error: "Waddle's Google setup needs fixing; your connection is kept.", reason });
    if (reason === "unavailable") return send(response, 502, { error: "Could not reach Google Calendar.", reason });
    return send(response, 401, { error: "Connect Google Calendar again.", reconnect: true, reason });
  }

  const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "2500" });
  const result = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (result.status === 401 || result.status === 403) {
    accessCache.delete(userId);
    const detail = await result.json().catch(() => ({}));
    const why = detail?.error?.errors?.[0]?.reason || detail?.error?.status || "";
    console.warn("Google Calendar refused a fresh access token:", result.status, why);
    // Google's consent screen lets people untick calendar access; then the token works but can't read calendars.
    const scope = /insufficient|scope|PERMISSION_DENIED/i.test(why);
    return send(response, 401, {
      error: scope ? "Google didn't grant calendar access. Connect again and tick \"See your calendars\"." : "Google stopped sharing this calendar. Connect again.",
      reconnect: true,
      reason: scope ? "scope" : "revoked",
    });
  }
  if (!result.ok) return send(response, 502, { error: "Could not reach Google Calendar." });
  const payload = await result.json();
  // Only what the app uses leaves the server.
  const items = (payload.items || []).map((item) => ({
    status: item.status,
    transparency: item.transparency,
    summary: item.summary,
    location: item.location,
    start: item.start,
    end: item.end,
  }));
  return send(response, 200, { items });
}

export default async function handler(request, response) {
  try {
    return await handle(request, response);
  } catch (error) {
    console.error("google handler failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, { error: "Google Calendar sync is unavailable right now.", detail: error?.name || "Error" });
  }
}
