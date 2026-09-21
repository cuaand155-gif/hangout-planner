const demoState = {
  privacy: "busy",
  members: [
    { name: "Jamie Miller", initials: "JM", status: "All set", updated: "12m ago" },
    { name: "Taylor Kim", initials: "TK", status: "All set", updated: "1h ago" },
    { name: "Riley Lee", initials: "RL", status: "Needs update", updated: "yesterday" },
  ],
  ideas: [
    { title: "Slow morning brunch", description: "Good coffee, no rush, extra syrup.", votes: 4 },
    { title: "Picnic in the park", description: "Fresh air and a blanket in the sun.", votes: 2 },
    { title: "Games night", description: "Bring your best strategy and snacks.", votes: 3 },
  ],
};

function send(response, status, body) {
  response.status(status).json(body);
}

export default async function handler(request, response) {
  const slug = request.query.slug || "weekend-crew";
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return send(response, 200, demoState);
  }

  const endpoint = `${url}/rest/v1/workspaces?slug=eq.${encodeURIComponent(slug)}&select=state`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  if (request.method === "GET") {
    const result = await fetch(endpoint, { headers });
    if (!result.ok) return send(response, 502, { error: "Unable to load workspace" });
    const rows = await result.json();
    return send(response, 200, rows[0]?.state || demoState);
  }

  if (request.method === "PUT") {
    const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    const result = await fetch(`${url}/rest/v1/workspaces?slug=eq.${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ state: body, updated_at: new Date().toISOString() }),
    });
    if (!result.ok) return send(response, 502, { error: "Unable to save workspace" });
    const rows = await result.json();
    return send(response, 200, rows[0]?.state || body);
  }

  response.setHeader("Allow", "GET, PUT");
  return send(response, 405, { error: "Method not allowed" });
}
