// Reads a published calendar feed and returns busy blocks.
//
//   POST /api/calendar  { url, from, to, details? }
//     -> { blocks: [{ start, end, allDay, title? }], count, truncated }
//
// The browser cannot fetch most calendar feeds directly (no CORS headers), so
// this runs server side. That means it fetches a URL supplied by a visitor,
// which is only safe with the guards below: https/webcal only, no credentials
// in the URL, no hostname that resolves to a private or loopback address, and
// redirects re-checked hop by hop.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseIcs } from "../lib/ics.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10000;
const MAX_RANGE_DAYS = 120;
const MAX_BLOCKS = 800;

function send(response, status, body) {
  response.setHeader("Cache-Control", "no-store");
  response.status(status).json(body);
}

/** Blocks the address ranges that would let a feed URL reach inside the host. */
export function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true;
    // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

/** Normalizes webcal:// to https:// and rejects anything else. */
export function normalizeFeedUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return { error: "Add a calendar link first." };
  let parsed;
  try {
    parsed = new URL(raw.replace(/^webcal:\/\//i, "https://"));
  } catch {
    return { error: "That does not look like a calendar link." };
  }
  if (parsed.protocol !== "https:") return { error: "Calendar links must start with https:// or webcal://" };
  if (parsed.username || parsed.password) return { error: "Remove the username and password from the link." };
  return { url: parsed };
}

async function assertPublicHost(hostname) {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("blocked-host");
    return;
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(hostname)) throw new Error("blocked-host");
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error("blocked-host");
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error("blocked-host");
  }
}

/** Follows redirects manually so every hop gets the same host checks. */
async function fetchFeed(startUrl) {
  let target = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(target.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let result;
    try {
      result = await fetch(target.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/calendar, text/plain, */*", "User-Agent": "Gatherly/1.0 (+calendar import)" },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const location = result.headers.get("location");
      if (!location) throw new Error("bad-redirect");
      target = new URL(location, target);
      if (target.protocol !== "https:") throw new Error("bad-redirect");
      continue;
    }

    if (!result.ok) throw new Error(`upstream-${result.status}`);

    const length = Number(result.headers.get("content-length") || 0);
    if (length && length > MAX_BYTES) throw new Error("too-large");
    const text = await readCapped(result);
    return text;
  }
  throw new Error("too-many-redirects");
}

async function readCapped(result) {
  if (!result.body) return await result.text();
  const reader = result.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("too-large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const MESSAGES = {
  "blocked-host": "That link points somewhere this server will not fetch.",
  "bad-redirect": "That calendar link redirects somewhere unsupported.",
  "too-many-redirects": "That calendar link redirects too many times.",
  "too-large": "That calendar feed is too big to import.",
};

async function handle(request, response) {
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "POST, OPTIONS");
    return send(response, 204, {});
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, OPTIONS");
    return send(response, 405, { error: "Method not allowed" });
  }

  let payload = request.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return send(response, 400, { error: "Invalid JSON body" });
    }
  }
  payload = payload && typeof payload === "object" ? payload : {};

  const { url, error } = normalizeFeedUrl(payload.url);
  if (error) return send(response, 400, { error });

  const from = new Date(payload.from);
  const to = new Date(payload.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return send(response, 400, { error: "Give a valid date range to import." });
  }
  if (to - from > MAX_RANGE_DAYS * 24 * 3600 * 1000) {
    return send(response, 400, { error: `Import at most ${MAX_RANGE_DAYS} days at a time.` });
  }

  let text;
  try {
    text = await fetchFeed(url);
  } catch (caught) {
    const key = caught instanceof Error ? caught.message : "";
    if (MESSAGES[key]) return send(response, 400, { error: MESSAGES[key] });
    if (key.startsWith("upstream-")) {
      return send(response, 502, { error: `The calendar link returned ${key.replace("upstream-", "")}. Check that it is shared publicly.` });
    }
    if (caught?.name === "AbortError") return send(response, 504, { error: "The calendar link took too long to respond." });
    return send(response, 502, { error: "Could not read that calendar link." });
  }

  if (!/BEGIN:VCALENDAR/i.test(text)) {
    return send(response, 422, { error: "That link did not return calendar data. Use the ICS/secret address, not the web page." });
  }

  let blocks;
  try {
    blocks = parseIcs(text, { from, to, includeTitles: payload.details === true });
  } catch {
    return send(response, 422, { error: "That calendar could not be read." });
  }

  return send(response, 200, {
    blocks: blocks.slice(0, MAX_BLOCKS),
    count: blocks.length,
    truncated: blocks.length > MAX_BLOCKS,
  });
}

/** Same guarantee as the workspace handler: never crash the function. */
export default async function handler(request, response) {
  try {
    return await handle(request, response);
  } catch (error) {
    console.error("calendar handler failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, { error: "Could not read that calendar link.", detail: error?.name || "Error" });
  }
}
