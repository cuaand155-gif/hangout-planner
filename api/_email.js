// Booking emails through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
// Vercel does not turn files whose names start with an underscore into
// endpoints, so this is never reachable itself.
//
// Switched off until the server has both RESEND_API_KEY and BOOKING_EMAIL_FROM
// (a sender on a domain verified in Resend, e.g. "Waddle <bookings@example.com>").
// Without them nothing is sent and nothing is fetched. Links in the emails use
// SITE_URL, or on Vercel the production domain it exposes as
// VERCEL_PROJECT_PRODUCTION_URL; with neither, emails stay off too, because a
// link built from the request's own Host header could be pointed anywhere.
//
// Sending never throws: a failed email is logged and the booking goes ahead.

import { httpsBase, restHeaders } from "./_supabase.js";
import { isValidTimeZone } from "../lib/booking.js";

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 5000;

/**
 * One time budget for all the email work of a request (owner lookup plus
 * sends), so a slow Resend can't hold a booking up for longer than `ms`.
 * Returns { signal, done }; call done() when finished to clear the timer.
 */
export function emailBudget(ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Email took too long", "TimeoutError")), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export function siteOrigin() {
  const explicit = httpsBase(process.env.SITE_URL);
  if (explicit) return explicit;
  const vercel = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  return vercel ? httpsBase(`https://${vercel.replace(/^https?:\/\//, "")}`) : null;
}

/** { key, from, origin } when booking emails are switched on, else null. */
export function mailConfig() {
  const key = process.env.RESEND_API_KEY || "";
  const from = String(process.env.BOOKING_EMAIL_FROM || "").trim();
  const origin = siteOrigin();
  return key && from && origin ? { key, from, origin } : null;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** One line, no control characters: for subjects built from user text. */
const oneLine = (value, max = 120) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** "Tuesday, October 6, 2:00 – 2:30 PM EDT" in the given zone. */
export function formatWhen(start, end, timeZone) {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" }).format(new Date(start));
  const from = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(start));
  const until = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(end));
  return `${day}, ${from} – ${until}`;
}

export function cancelLink(origin, handle, token) {
  return `${origin}/book/${encodeURIComponent(handle)}?cancel=${encodeURIComponent(token)}`;
}

function layout(heading, rows, footer = "") {
  const body = rows.map((row) => `<p style="margin:0 0 12px">${row}</p>`).join("");
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f4ef;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f1d1a">` +
    `<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">` +
    `<h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>${body}` +
    (footer ? `<p style="margin:16px 0 0;font-size:13px;color:#6b665e">${footer}</p>` : "") +
    `</div></body></html>`
  );
}

/**
 * The guest's confirmation. It carries only what the owner wrote (page title,
 * owner name) plus the time and cancel link, never anything the guest typed:
 * a stranger could otherwise use the booking form to mail their own text to
 * any address.
 */
export function guestConfirmation({ page, booking, guestZone, cancelUrl }) {
  const host = oneLine(page.owner_name || "your host", 60);
  const title = oneLine(page.title || "Meeting", 80);
  const when = formatWhen(booking.start, booking.end, guestZone);
  return {
    subject: `Booked: ${title} with ${host}`,
    html: layout(
      `You're booked with ${escapeHtml(host)}.`,
      [`<strong>${escapeHtml(title)}</strong><br>${escapeHtml(when)}`, `Plans changed? <a href="${escapeHtml(cancelUrl)}">Cancel this booking</a>.`],
      "You got this because someone booked this time with your email address on Waddle. If it wasn't you, use the cancel link."
    ),
    text: `You're booked with ${host}.\n\n${title}\n${when}\n\nPlans changed? Cancel here: ${cancelUrl}\n\nYou got this because someone booked this time with your email address on Waddle. If it wasn't you, use the cancel link.\n`,
  };
}

/** The owner's "new booking" notice, with what the guest wrote (escaped). */
export function ownerNotice({ page, booking, guest, ownerZone }) {
  const title = oneLine(page.title || "Meeting", 80);
  const name = oneLine(guest.name, 80);
  const when = formatWhen(booking.start, booking.end, ownerZone);
  const rows = [`<strong>${escapeHtml(name)}</strong> (${escapeHtml(guest.email)}) booked <strong>${escapeHtml(title)}</strong>.`, escapeHtml(when)];
  if (guest.note) rows.push(`Their note:<br>${escapeHtml(guest.note).replace(/\r?\n/g, "<br>")}`);
  return {
    subject: `New booking: ${name}, ${when}`,
    html: layout("New booking", rows, "Open Waddle → Booking link to see or cancel it."),
    text: `New booking\n\n${name} (${guest.email}) booked ${title}.\n${when}\n${guest.note ? `\nTheir note:\n${guest.note}\n` : ""}\nOpen Waddle → Booking link to see or cancel it.\n`,
  };
}

/** The cancellation notice both sides get. `by` is "guest" or "owner". */
export function cancellationNotice({ page, booking, zone, by, handle, origin, forOwner, guestName }) {
  const host = oneLine(page.owner_name || "your host", 60);
  const title = oneLine(page.title || "Meeting", 80);
  const when = formatWhen(booking.start, booking.end, zone);
  const who = forOwner ? oneLine(guestName, 80) : host;
  const cancelledBy = by === "owner" ? (forOwner ? "You cancelled it." : `${host} cancelled it.`) : forOwner ? `${who} cancelled it.` : "You cancelled it.";
  const rebook = !forOwner && handle ? `${origin}/book/${encodeURIComponent(handle)}` : "";
  const rows = [`<strong>${escapeHtml(title)}</strong> with ${escapeHtml(who)}<br>${escapeHtml(when)}`, escapeHtml(cancelledBy)];
  if (rebook) rows.push(`<a href="${escapeHtml(rebook)}">Book another time</a>`);
  return {
    subject: `Cancelled: ${title} with ${who}`,
    html: layout("Booking cancelled", rows, forOwner ? "The time is open for bookings again." : "If you added it to your calendar, you can delete it there."),
    text: `Booking cancelled\n\n${title} with ${who}\n${when}\n${cancelledBy}\n${rebook ? `\nBook another time: ${rebook}\n` : ""}`,
  };
}

/** Sends one email. Resolves true when Resend accepted it, false otherwise; never throws. */
export async function sendEmail(mail, { to, subject, html, text, replyTo, signal }) {
  if (!mail || !to) return false;
  try {
    const result = await fetch(RESEND_URL, {
      method: "POST",
      signal: signal || AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${mail.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: mail.from, to: [to], subject: oneLine(subject, 200), html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!result.ok) {
      console.warn(`Booking email not sent: Resend answered ${result.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Booking email not sent:", error?.name || "Error");
    return false;
  }
}

/** The owner's sign-in email, looked up with the service role. Null when it can't be read. */
export async function ownerEmail(db, ownerId, { signal } = {}) {
  if (!db || !ownerId) return null;
  try {
    const result = await fetch(`${db.url}/auth/v1/admin/users/${encodeURIComponent(ownerId)}`, {
      headers: restHeaders(db.key),
      signal: signal || AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!result.ok) return null;
    const user = await result.json();
    return typeof user?.email === "string" && user.email ? user.email : null;
  } catch {
    return null;
  }
}
