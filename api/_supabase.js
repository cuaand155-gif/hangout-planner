// Helpers shared by the API routes. Vercel does not turn files whose names
// start with an underscore into endpoints, so this is never reachable itself.

export function send(response, status, body) {
  response.setHeader("Cache-Control", "no-store");
  response.status(status).json(body);
}

/** Returns the value as a base URL if it is a usable https URL, else null. */
export function httpsBase(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

// The Supabase/Vercel integration provisions NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SECRET_KEY; a hand-made setup usually has SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. The integration's URL is preferred because it is
// kept in sync automatically, and a value that is not a usable https URL is
// skipped rather than trusted.
export function config() {
  const url = httpsBase(process.env.NEXT_PUBLIC_SUPABASE_URL) || httpsBase(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return url && key ? { url, key } : null;
}

export function restHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

export function bearer(request) {
  const header = request.headers?.authorization || request.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match ? match[1].trim() : null;
}

/** Resolves a Supabase access token to its user id, or null when invalid. */
export async function userFromToken(url, key, token) {
  if (!token) return null;
  try {
    const result = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!result.ok) return null;
    const user = await result.json();
    return user?.id || null;
  } catch {
    return null;
  }
}
