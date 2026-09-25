// Public booking links.
//
//   GET  /api/book?handle=alexi-7fq2x      -> { page, slots: [{ start, end }] }
//   GET  /api/book?booking=<cancel token>  -> { booking } (for the cancel screen)
//   GET  /api/book?feed=<feed token>       -> text/calendar of the owner's bookings
//   POST /api/book { action: "book", handle, start, name, email, note, timeZone } -> { booking, page, emailed }
//   POST /api/book { action: "cancel", token, timeZone }                       -> { booking, emailed }
//   POST /api/book { action: "owner-cancel", id } + owner's Supabase token      -> { booking, emailed }
//
// Visitors never sign in and never see why a time is unavailable: busy blocks
// and calendar links stay on the server, and only computed open slots leave
// it. A booking is re-checked against open slots when it is made, and the
// database refuses overlapping confirmed bookings, so two people clicking the
// same time at once cannot both get it.
//
// Busy time comes from three places: what the owner's app last published
// (page.busy), the owner's calendar links (fetched here), and, when the server
// has the Google client env vars and the owner connected Google, Google's
// freeBusy for their primary calendar. The last two keep the link current
// while Waddle is closed; any of them failing just leaves it out.
//
// With RESEND_API_KEY and BOOKING_EMAIL_FROM set (see api/_email.js), guests
// get a confirmation with their cancel link, owners a notice, and both a note
// when a booking is cancelled. An email that fails never fails the booking.

import { bearer, config, restHeaders, send, userFromToken } from "./_supabase.js";
import { fetchFeed, normalizeFeedUrl } from "./calendar.js";
import { googleFreeBusy } from "./google.js";
import { cancelLink, cancellationNotice, emailBudget, guestConfirmation, mailConfig, ownerEmail, ownerNotice, sendEmail } from "./_email.js";
import { parseIcs } from "../lib/ics.js";
import {
  buildOwnerFeed,
  busyFromIcsBlocks,
  normalizeBookingSettings,
  normalizeGuest,
  isValidTimeZone,
  normalizeHandle,
  openSlots,
  usesCalendars,
} from "../lib/booking.js";

const FEED_CACHE_MS = 5 * 60 * 1000;
const MAX_ACTIVE_PER_EMAIL = 3;
// Bookings (cancelled ones too) one email address may make per page per day,
// so book-and-cancel can't be used to fill someone's inbox.
const MAX_DAILY_PER_EMAIL = 10;
const GOOGLE_TIMEOUT_MS = 4000;
const TOKEN = /^[a-f0-9]{24,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SELECT = "id,owner_id,handle,title,owner_name,settings,busy,ics_urls";
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
    select: PAGE_SELECT,
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

/** Busy time from the owner's Google Calendar, straight from Google. Empty when that isn't possible. */
async function googleBusy(db, page, settings, now) {
  if (!page.owner_id || !usesCalendars(page)) return [];
  const to = new Date(now.getTime() + (settings.windowDays + 1) * 24 * 3600 * 1000);
  return (await googleFreeBusy(db, page.owner_id, { from: now, to, timeoutMs: GOOGLE_TIMEOUT_MS })) || [];
}

async function availability(db, page, now) {
  const settings = normalizeBookingSettings(page.settings);
  const published = Array.isArray(page.busy) ? page.busy : [];
  const [bookings, fromFeeds, fromGoogle] = await Promise.all([
    confirmedBookings(db, page.id, now),
    feedBusy(page.ics_urls, settings, now),
    googleBusy(db, page, settings, now),
  ]);
  return { settings, slots: openSlots(settings, { busy: [...published, ...fromFeeds, ...fromGoogle], bookings, now }) };
}

const publicPage = (page, settings) => ({
  handle: page.handle,
  title: page.title,
  ownerName: page.owner_name,
  duration: settings.duration,
  timeZone: settings.timeZone,
  // Whether this server emails booking confirmations (true or false, nothing more).
  emails: Boolean(mailConfig()),
});

const zoneOr = (value, fallback) => (isValidTimeZone(value) ? value : fallback);

/** Guest confirmation and owner notice for a new booking. Resolves whether the guest's email went out. */
async function emailNewBooking(db, mail, { page, settings, booking, guest, guestZone }) {
  if (!mail) return false;
  const { signal, done } = emailBudget();
  const times = { start: booking.start_at, end: booking.end_at };
  const cancelUrl = cancelLink(mail.origin, page.handle, booking.cancel_token);
  const toOwner = (async () => {
    const address = await ownerEmail(db, page.owner_id, { signal });
    if (!address) return console.warn("Booking email not sent: no owner email found");
    await sendEmail(mail, { to: address, replyTo: guest.email, signal, ...ownerNotice({ page, booking: times, guest, ownerZone: settings.timeZone }) });
  })();
  try {
    const [sent] = await Promise.all([
      sendEmail(mail, { to: guest.email, signal, ...guestConfirmation({ page, booking: times, guestZone: zoneOr(guestZone, settings.timeZone), cancelUrl }) }),
      toOwner,
    ]);
    return sent;
  } finally {
    done();
  }
}

/** The cancellation notice to both sides. Resolves whether the guest's copy went out. */
async function emailCancellation(db, mail, { page, row, by, guestZone }) {
  if (!mail || !page) return false;
  const settings = normalizeBookingSettings(page.settings);
  const times = { start: row.start_at, end: row.end_at };
  const common = { page, booking: times, by, handle: page.handle, origin: mail.origin, guestName: row.guest_name };
  const { signal, done } = emailBudget();
  const toOwner = (async () => {
    const address = await ownerEmail(db, page.owner_id, { signal });
    if (!address) return console.warn("Booking email not sent: no owner email found");
    await sendEmail(mail, { to: address, signal, ...cancellationNotice({ ...common, zone: settings.timeZone, forOwner: true }) });
  })();
  try {
    const [sent] = await Promise.all([
      sendEmail(mail, { to: row.guest_email, signal, ...cancellationNotice({ ...common, zone: zoneOr(guestZone, settings.timeZone), forOwner: false }) }),
      toOwner,
    ]);
    return sent;
  } finally {
    done();
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
  const today = await rest(
    db,
    `bookings?${new URLSearchParams({ select: "id", page_id: `eq.${page.id}`, guest_email: `eq.${guest.email}`, created_at: `gt.${new Date(now.getTime() - 24 * 3600 * 1000).toISOString()}` })}`
  );
  if (today.ok && Array.isArray(today.body) && today.body.length >= MAX_DAILY_PER_EMAIL) {
    return send(response, 429, { error: "Too many bookings from this email today. Try again tomorrow." });
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
  const emailed = await emailNewBooking(db, mailConfig(), { page, settings, booking, guest, guestZone: payload.timeZone });
  return send(response, 201, {
    booking: { id: booking.id, start: booking.start_at, end: booking.end_at, status: booking.status, createdAt: booking.created_at, cancelToken: booking.cancel_token },
    page: publicPage(page, settings),
    emailed,
  });
}

async function pageById(db, pageId) {
  const result = await rest(db, `booking_pages?${new URLSearchParams({ select: PAGE_SELECT, id: `eq.${pageId}`, limit: "1" })}`);
  return result.ok && Array.isArray(result.body) ? result.body[0] || null : null;
}

const CANCELLED_SELECT = "start_at,end_at,status,guest_name,guest_email,page_id";

async function cancel(db, payload, response, now) {
  const token = String(payload.token || "");
  if (!TOKEN.test(token)) return send(response, 400, { error: "That cancel link is not valid." });
  const result = await rest(
    db,
    `bookings?${new URLSearchParams({ cancel_token: `eq.${token}`, status: "eq.confirmed", select: CANCELLED_SELECT })}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "cancelled", cancelled_at: now.toISOString() }) }
  );
  if (!result.ok) throw new Error(`db-${result.status}`);
  if (!Array.isArray(result.body) || !result.body.length) return send(response, 404, { error: "That booking is already cancelled or does not exist." });
  const row = result.body[0];
  const mail = mailConfig();
  const emailed = mail ? await emailCancellation(db, mail, { page: await pageById(db, row.page_id), row, by: "guest", guestZone: payload.timeZone }) : false;
  return send(response, 200, { booking: { start: row.start_at, end: row.end_at, status: "cancelled" }, emailed });
}

/** The owner cancels one of their bookings from the app; the guest is emailed when email is set up. */
async function ownerCancel(db, request, payload, response, now) {
  const id = String(payload.id || "");
  if (!UUID.test(id)) return send(response, 400, { error: "That booking is not valid." });
  const userId = await userFromToken(db.url, db.key, bearer(request));
  if (!userId) return send(response, 401, { error: "Sign in first." });
  const pages = await rest(db, `booking_pages?${new URLSearchParams({ select: PAGE_SELECT, owner_id: `eq.${userId}`, limit: "1" })}`);
  if (!pages.ok) throw new Error(`db-${pages.status}`);
  const page = Array.isArray(pages.body) ? pages.body[0] : null;
  if (!page) return send(response, 404, { error: "That booking is already cancelled or does not exist." });
  const result = await rest(
    db,
    `bookings?${new URLSearchParams({ id: `eq.${id}`, page_id: `eq.${page.id}`, status: "eq.confirmed", select: CANCELLED_SELECT })}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "cancelled", cancelled_at: now.toISOString() }) }
  );
  if (!result.ok) throw new Error(`db-${result.status}`);
  if (!Array.isArray(result.body) || !result.body.length) return send(response, 404, { error: "That booking is already cancelled or does not exist." });
  const row = result.body[0];
  const emailed = await emailCancellation(db, mailConfig(), { page, row, by: "owner" });
  return send(response, 200, { booking: { start: row.start_at, end: row.end_at, status: "cancelled" }, emailed });
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
  if (payload.action === "owner-cancel") return ownerCancel(db, request, payload, response, now);
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
