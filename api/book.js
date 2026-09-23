// Public booking links.
//
//   GET  /api/book?handle=alexi-7fq2x      -> { page, slots: [{ start, end }] }
//   GET  /api/book?booking=<cancel token>  -> { booking } (for the cancel screen)
//   GET  /api/book?feed=<feed token>       -> text/calendar of the owner's bookings
//   POST /api/book { action: "book", handle, start, name, email, note }
//   POST /api/book { action: "cancel", token }
//
// Visitors never sign in and never see why a time is unavailable: busy blocks
// and calendar links stay on the server, and only computed open slots leave
// it. A booking is re-checked against open slots when it is made, and the
// database refuses overlapping confirmed bookings, so two people clicking the
// same time at once cannot both get it.

import { config, restHeaders, send } from "./_supabase.js";
import { fetchFeed, normalizeFeedUrl } from "./calendar.js";
import { parseIcs } from "../lib/ics.js";
import {
  buildGuestIcs,
  buildOwnerFeed,
  busyFromIcsBlocks,
  normalizeBookingSettings,
  normalizeGuest,
  normalizeHandle,
  openSlots,
} from "../lib/booking.js";

const FEED_CACHE_MS = 5 * 60 * 1000;
const MAX_ACTIVE_PER_EMAIL = 3;
const TOKEN = /^[a-f0-9]{24,64}$/;
const feedCache = new Map();

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

async function loadPage(db, handle) {
  const query = new URLSearchParams({
    select: "id,handle,title,owner_name,settings,busy,ics_urls",
    handle: `eq.${handle}`,
    active: "is.true",
    limit: "1",
  });
  const result = await rest(db, `booking_pages?${query}`);
  if (!result.ok) throw new Error(`db-${result.status}`);
  return Array.isArray(result.body) ? result.body[0] || null : null;
}

async function confirmedBookings(db, pageId, now) {
  const query = new URLSearchParams({
    select: "start_at,end_at",
    page_id: `eq.${pageId}`,
    status: "eq.confirmed",
    end_at: `gt.${now.toISOString()}`,
  });
  const result = await rest(db, `bookings?${query}`);
  if (!result.ok) throw new Error(`db-${result.status}`);
  return (result.body || []).map((row) => ({ start: row.start_at, end: row.end_at }));
}

/** Busy time from the owner's calendar links, cached briefly per URL. A failing feed is skipped, not fatal. */
async function feedBusy(urls, settings, now) {
  const from = now;
  const to = new Date(now.getTime() + (settings.windowDays + 1) * 24 * 3600 * 1000);
  const busy = [];
  for (const raw of (urls || []).slice(0, 3)) {
    const { url } = normalizeFeedUrl(raw);
    if (!url) continue;
    const cached = feedCache.get(url.href);
    let blocks = cached && now.getTime() - cached.at < FEED_CACHE_MS ? cached.blocks : null;
    if (!blocks) {
      try {
        blocks = parseIcs(await fetchFeed(url), { from, to });
        feedCache.set(url.href, { at: now.getTime(), blocks });
      } catch {
        continue;
      }
    }
    busy.push(...busyFromIcsBlocks(blocks, settings.timeZone));
  }
  return busy;
}

async function availability(db, page, now) {
  const settings = normalizeBookingSettings(page.settings);
  const published = Array.isArray(page.busy) ? page.busy : [];
  const [bookings, fromFeeds] = await Promise.all([confirmedBookings(db, page.id, now), feedBusy(page.ics_urls, settings, now)]);
  return { settings, slots: openSlots(settings, { busy: [...published, ...fromFeeds], bookings, now }) };
}

const publicPage = (page, settings) => ({
  handle: page.handle,
  title: page.title,
  ownerName: page.owner_name,
  duration: settings.duration,
  timeZone: settings.timeZone,
});

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

async function book(db, payload, response, now) {
  const handle = normalizeHandle(payload.handle);
  if (!handle) return send(response, 400, { error: "That booking link is not valid." });
  if (payload.website) return send(response, 400, { error: "Could not book that time." }); // honeypot
  const guest = normalizeGuest(payload);
  if (guest.error) return send(response, 400, { error: guest.error });
  const start = new Date(payload.start);
  if (Number.isNaN(start.getTime())) return send(response, 400, { error: "Pick a time first." });

  const page = await loadPage(db, handle);
  if (!page) return send(response, 404, { error: "This booking link does not exist or is turned off." });
  const { settings, slots } = await availability(db, page, now);
  const slot = slots.find((entry) => entry.start === start.toISOString());
  if (!slot) return send(response, 409, { error: "That time was just taken. Pick another one.", slots });

  const mine = await rest(
    db,
    `bookings?${new URLSearchParams({ select: "id", page_id: `eq.${page.id}`, guest_email: `eq.${guest.email}`, status: "eq.confirmed", end_at: `gt.${now.toISOString()}` })}`
  );
  if (mine.ok && Array.isArray(mine.body) && mine.body.length >= MAX_ACTIVE_PER_EMAIL) {
    return send(response, 429, { error: `You already have ${MAX_ACTIVE_PER_EMAIL} upcoming bookings here. Cancel one first.` });
  }

  const inserted = await rest(db, "bookings?select=id,start_at,end_at,status,cancel_token,created_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      page_id: page.id,
      start_at: slot.start,
      end_at: slot.end,
      guest_name: guest.name,
      guest_email: guest.email,
      note: guest.note,
    }),
  });
  // 23P01 = the no-overlap constraint: someone else confirmed this time first.
  if (inserted.status === 409 || inserted.body?.code === "23P01") {
    const fresh = await availability(db, page, now);
    return send(response, 409, { error: "That time was just taken. Pick another one.", slots: fresh.slots });
  }
  if (!inserted.ok || !Array.isArray(inserted.body) || !inserted.body[0]) throw new Error(`db-${inserted.status}`);

  const booking = inserted.body[0];
  return send(response, 201, {
    booking: { start: booking.start_at, end: booking.end_at, status: booking.status, cancelToken: booking.cancel_token },
    page: publicPage(page, settings),
    ics: buildGuestIcs(booking, { ownerName: page.owner_name, pageTitle: page.title }),
  });
}

async function cancel(db, payload, response, now) {
  const token = String(payload.token || "");
  if (!TOKEN.test(token)) return send(response, 400, { error: "That cancel link is not valid." });
  const result = await rest(
    db,
    `bookings?${new URLSearchParams({ cancel_token: `eq.${token}`, status: "eq.confirmed", select: "start_at,end_at,status" })}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "cancelled", cancelled_at: now.toISOString() }) }
  );
  if (!result.ok) throw new Error(`db-${result.status}`);
  if (!Array.isArray(result.body) || !result.body.length) return send(response, 404, { error: "That booking is already cancelled or does not exist." });
  return send(response, 200, { booking: { start: result.body[0].start_at, end: result.body[0].end_at, status: "cancelled" } });
}

async function bookingByToken(db, token, response) {
  if (!TOKEN.test(token)) return send(response, 400, { error: "That link is not valid." });
  const query = new URLSearchParams({
    select: "start_at,end_at,status,page:booking_pages(title,owner_name,handle)",
    cancel_token: `eq.${token}`,
    limit: "1",
  });
  const result = await rest(db, `bookings?${query}`);
  if (!result.ok) throw new Error(`db-${result.status}`);
  const row = Array.isArray(result.body) ? result.body[0] : null;
  if (!row) return send(response, 404, { error: "We could not find that booking." });
  return send(response, 200, {
    booking: { start: row.start_at, end: row.end_at, status: row.status },
    page: { title: row.page?.title || "", ownerName: row.page?.owner_name || "", handle: row.page?.handle || "" },
  });
}

async function ownerFeed(db, token, response, now) {
  if (!TOKEN.test(token)) {
    response.status(404);
    return response.end("Not found");
  }
  const pages = await rest(db, `booking_pages?${new URLSearchParams({ select: "id,title", feed_token: `eq.${token}`, limit: "1" })}`);
  const page = pages.ok && Array.isArray(pages.body) ? pages.body[0] : null;
  if (!page) {
    response.status(404);
    return response.end("Not found");
  }
  const since = new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString();
  const rows = await rest(
    db,
    `bookings?${new URLSearchParams({ select: "id,start_at,end_at,status,guest_name,guest_email,note,created_at,cancelled_at", page_id: `eq.${page.id}`, end_at: `gt.${since}`, order: "start_at.asc" })}`
  );
  if (!rows.ok) throw new Error(`db-${rows.status}`);
  response.setHeader("Content-Type", "text/calendar; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.status(200);
  return response.end(buildOwnerFeed(rows.body || [], { pageTitle: page.title }));
}

async function handle(request, response) {
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "GET, POST, OPTIONS");
    return send(response, 204, {});
  }
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST, OPTIONS");
    return send(response, 405, { error: "Method not allowed" });
  }
  const db = config();
  if (!db) return send(response, 503, { error: "Booking links are not set up on this server yet." });
  const now = new Date();
  const query = request.query || {};

  if (request.method === "GET") {
    if (query.feed) return ownerFeed(db, String(query.feed), response, now);
    if (query.booking) return bookingByToken(db, String(query.booking), response);
    const handleName = normalizeHandle(query.handle);
    if (!handleName) return send(response, 400, { error: "That booking link is not valid." });
    const page = await loadPage(db, handleName);
    if (!page) return send(response, 404, { error: "This booking link does not exist or is turned off." });
    const { settings, slots } = await availability(db, page, now);
    return send(response, 200, { page: publicPage(page, settings), slots });
  }

  const payload = readBody(request);
  if (!payload) return send(response, 400, { error: "Invalid JSON body" });
  if (payload.action === "cancel") return cancel(db, payload, response, now);
  if (payload.action === "book") return book(db, payload, response, now);
  return send(response, 400, { error: "Unknown action." });
}

/** Same guarantee as the other handlers: never crash the function, never leak internals. */
export default async function handler(request, response) {
  try {
    return await handle(request, response);
  } catch (error) {
    console.error("book handler failed:", error);
    if (response.headersSent) return undefined;
    return send(response, 502, { error: "Booking is unavailable right now. Try again in a moment.", detail: error?.name || "Error" });
  }
}
