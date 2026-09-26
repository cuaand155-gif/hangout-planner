// Local preview server: serves the static files and runs the /api handlers with
// a small stand-in for the Vercel request/response objects, so the app behaves
// the same way locally as it does deployed.
//
//   node scripts/dev-server.mjs [port]
//
// WADDLE_FAKE_DB=1 answers the handlers' database calls from an in-memory
// fake (scripts/fake-supabase.mjs) instead of demo mode, so signed-in and
// guest flows run end to end locally. GET /__fake-db shows its tables and
// POST /__fake-db { tables } replaces them (browser tests use both). Nothing
// real is ever called.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_DB = process.env.WADDLE_FAKE_DB === "1";
let fakeDb = null;
if (FAKE_DB) {
  const { createFakeSupabase, installFakeSupabase } = await import("./fake-supabase.mjs");
  fakeDb = createFakeSupabase();
  installFakeSupabase(fakeDb);
}

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const ROUTES = {
  "/api/workspace": () => import("../api/workspace.js"),
  "/api/calendar": () => import("../api/calendar.js"),
  "/api/groups": () => import("../api/groups.js"),
  "/api/book": () => import("../api/book.js"),
  "/api/google": () => import("../api/google.js"),
  "/api/page": () => import("../api/page.js"),
  "/api/og": () => import("../api/og.js"),
};

/** Mirrors vercel.json's rewrites for shareable links: /g/<group> and /p/<group>. */
function rewrite(url) {
  const pretty = /^\/([gp])\/([^/]+)$/.exec(url.pathname);
  if (!pretty) return url;
  const next = new URL(`/api/page${url.search}`, url);
  next.searchParams.set("kind", pretty[1]);
  next.searchParams.set("slug", decodeURIComponent(pretty[2]));
  return next;
}

/** Mimics the response helpers the handlers rely on (status/json/setHeader). */
function shimResponse(response) {
  let code = 200;
  return {
    setHeader: (name, value) => response.setHeader(name, value),
    status(next) {
      code = next;
      return this;
    },
    json(body) {
      const payload = JSON.stringify(body);
      response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      response.end(payload);
      return this;
    },
    end(body) {
      response.writeHead(code);
      response.end(body);
      return this;
    },
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function serveStatic(pathname, response) {
  const relative = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, relative);
  if (!file.startsWith(ROOT)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, "index.html") : file;
    const body = await readFile(target);
    response.writeHead(200, { "Content-Type": TYPES[extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    // Clean URLs: /overview -> /overview.html, otherwise fall back to the app.
    try {
      const body = await readFile(`${file}.html`);
      response.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
  }
}

const server = createServer(async (request, response) => {
  const url = rewrite(new URL(request.url, `http://localhost:${PORT}`));
  const route = ROUTES[url.pathname];

  if (fakeDb && url.pathname === "/__fake-db") {
    if (request.method === "POST") {
      const body = await readRequestBody(request);
      fakeDb.reset(body?.tables || {});
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(fakeDb.db));
    return;
  }

  if (route) {
    try {
      const { default: handler } = await route();
      const body = await readRequestBody(request);
      await handler(
        {
          method: request.method,
          headers: request.headers,
          query: Object.fromEntries(url.searchParams),
          body,
          url: request.url,
        },
        shimResponse(response)
      );
    } catch (error) {
      console.error(`${request.method} ${url.pathname} failed:`, error);
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Handler crashed", detail: String(error?.message || error) }));
      }
    }
    return;
  }

  // Mirrors the vercel.json rewrite for booking links.
  await serveStatic(/^\/book\/[^/]+$/.test(url.pathname) ? "/book.html" : url.pathname, response);
});

server.listen(PORT, () => {
  const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`Waddle running at http://localhost:${PORT}`);
  console.log(FAKE_DB ? "Persistence: in-memory fake database (WADDLE_FAKE_DB=1)" : configured ? "Persistence: Supabase" : "Persistence: demo mode (no SUPABASE_* env vars set)");
});
