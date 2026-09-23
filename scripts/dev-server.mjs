// Local preview server: serves the static files and runs the /api handlers with
// a small stand-in for the Vercel request/response objects, so the app behaves
// the same way locally as it does deployed.
//
//   node scripts/dev-server.mjs [port]

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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
};

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
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const route = ROUTES[url.pathname];

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
  console.log(configured ? "Persistence: Supabase" : "Persistence: demo mode (no SUPABASE_* env vars set)");
});
