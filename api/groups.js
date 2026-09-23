// The groups a signed-in person belongs to, so "My groups" follows them
// between devices.
//
//   GET /api/groups   (Authorization: Bearer <Supabase access token>)
//     -> { groups: [{ slug, name, at }], persisted }
//
// Membership lives inside each workspace's JSON, so this asks the database
// for workspaces whose member list contains the caller's account id. The id
// comes from verifying the token, never from the request, so nobody can list
// someone else's groups.

import { bearer, config, restHeaders, send, userFromToken } from "./_supabase.js";

const MAX_GROUPS = 50;

async function handle(request, response) {
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "GET, OPTIONS");
    return send(response, 204, {});
  }
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    return send(response, 405, { error: "Method not allowed" });
  }

  const settings = config();
  if (!settings) return send(response, 200, { groups: [], persisted: false });
  const { url, key } = settings;

  const userId = await userFromToken(url, key, bearer(request));
  if (!userId) return send(response, 401, { error: "Sign in to see your groups." });

  const contains = JSON.stringify({ members: [{ userId }] });
  const query = new URLSearchParams({
    select: "slug,name:state->>name,updated_at",
    state: `cs.${contains}`,
    order: "updated_at.desc",
    limit: String(MAX_GROUPS),
  });
  const result = await fetch(`${url}/rest/v1/workspaces?${query}`, { headers: restHeaders(key) });
  if (!result.ok) return send(response, 502, { error: "Unable to load your groups" });
  const rows = await result.json();

  return send(response, 200, {
    groups: (Array.isArray(rows) ? rows : []).map((row) => ({
      slug: row.slug,
      name: row.name || row.slug,
      at: row.updated_at,
    })),
    persisted: true,
  });
}

/** Never crash the function; see api/workspace.js. */
export default async function handler(request, response) {
  try {
    return await handle(request, response);
  } catch (error) {
    console.error("groups handler failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, { error: "Unable to load your groups", detail: error?.name || "Error" });
  }
}
