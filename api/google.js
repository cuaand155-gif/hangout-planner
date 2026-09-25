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

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { bearer, config, restHeaders, send, userFromToken } from "./_supabase.js";

const MAX_RANGE_DAYS = 120;
const accessCache = new Map(); // userId -> { token, expires }

function google() {
  const id = process.env.GOOGLE_CLIENT_ID || "";
  const secret = process.env.GOOGLE_CLIENT_SECRET || "";
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

async function storedToken(db, userId) {
  const result = await rest(db, `google_tokens?${new URLSearchParams({ select: "refresh_token", user_id: `eq.${userId}`, limit: "1" })}`);
  if (!result.ok) throw new Error(`db-${result.status}`);
  return Array.isArray(result.body) && result.body[0] ? result.body[0].refresh_token : null;
}

async function forget(db, userId) {
  accessCache.delete(userId);
  await rest(db, `google_tokens?${new URLSearchParams({ user_id: `eq.${userId}` })}`, { method: "DELETE" });
}

/** A fresh access token, or null when Google no longer accepts the refresh token. */
async function accessToken(db, keys, userId) {
  const cached = accessCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.token;
  const sealed = await storedToken(db, userId);
  if (!sealed) return null;
  let refreshToken;
  try {
    refreshToken = openToken(sealed, keys.secret);
  } catch {
    await forget(db, userId); // sealed with an older secret: unusable
    return null;
  }
  const result = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: keys.id, client_secret: keys.secret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok || !body.access_token) {
    if (body.error === "invalid_grant") await forget(db, userId); // revoked or expired: ask to reconnect
    return null;
  }
  accessCache.set(userId, { token: body.access_token, expires: Date.now() + Math.max(60, (body.expires_in || 3600) - 120) * 1000 });
  return body.access_token;
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
  const keys = google();
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
  const token = await accessToken(db, keys, userId);
  if (!token) return send(response, 401, { error: "Connect Google Calendar again.", reconnect: true });

  const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "2500" });
  const result = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (result.status === 401 || result.status === 403) {
    accessCache.delete(userId);
    return send(response, 401, { error: "Google stopped sharing this calendar. Connect again.", reconnect: true });
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
