// The public booking page: /book/<handle>, no sign-in.
//
// Shows open times in the visitor's own time zone, books one, and hands back a
// calendar file plus a private cancel link. /book/<handle>?cancel=<token> opens
// the cancel screen for a booking.

import { buildGuestIcs } from "./lib/booking.js";
import { toIcsUtc } from "./lib/calendar-export.js";
import { registerServiceWorker } from "./lib/pwa.js";

const $ = (id) => document.getElementById(id);
const pathHandle = decodeURIComponent(window.location.pathname.split("/")[2] || "");
const params = new URLSearchParams(window.location.search);
const handle = (pathHandle || params.get("h") || "").toLowerCase();
const cancelToken = params.get("cancel");

const state = { page: null, slots: [], day: null, chosen: null };

const dayKey = (iso) => new Date(iso).toLocaleDateString("en-CA"); // YYYY-MM-DD in the visitor's zone
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayNumber = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short" });
const timeLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const visitorZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "?";

function show(id) {
  for (const section of ["bookingLoading", "bookingPicker", "bookingForm", "bookingDone", "bookingMessage"]) {
    $(section).hidden = section !== id;
  }
}

function message(title, body, actions = "") {
  $("messageTitle").textContent = title;
  $("messageBody").textContent = body;
  $("messageActions").innerHTML = actions;
  show("bookingMessage");
}

async function api(init) {
  const response = await fetch(init?.url || "/api/book", init);
  let body = {};
  try {
    body = await response.json();
  } catch {
    /* non-JSON error page */
  }
  return { ok: response.ok, status: response.status, body };
}

/* ------------------------------------------------------------ picking */

function renderDays() {
  const byDay = new Map();
  for (const slot of state.slots) {
    const key = dayKey(slot.start);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(slot);
  }
  const days = [...byDay.keys()];
  $("bookingEmpty").hidden = days.length > 0;
  if (!days.includes(state.day)) state.day = days[0] || null;
  $("bookingDays").innerHTML = days
    .map((key) => {
      const date = new Date(byDay.get(key)[0].start);
      const active = key === state.day;
      return `<button type="button" class="booking-day${active ? " active" : ""}" role="tab" aria-selected="${active}" data-day="${key}">` +
        `<small>${dayLabel.format(date)}</small><strong>${dayNumber.format(date)}</strong><span>${monthLabel.format(date)}</span></button>`;
    })
    .join("");
  const times = state.day ? byDay.get(state.day) : [];
  $("bookingTimes").innerHTML = times
    .map((slot) => `<button type="button" class="booking-time" data-start="${slot.start}">${timeLabel.format(new Date(slot.start))}</button>`)
    .join("");
}

function renderPage() {
  const page = state.page;
  document.title = `${page.title} with ${page.ownerName || "them"} — Waddle`;
  $("bookingAvatar").textContent = initials(page.ownerName);
  $("bookingOwner").textContent = page.ownerName || "";
  $("bookingTitle").textContent = page.title;
  $("bookingMeta").textContent = `${page.duration} min · times shown in your time zone (${visitorZone.replace(/_/g, " ")})`;
  renderDays();
  show("bookingPicker");
}

async function loadSlots() {
  if (!handle) return message("This link is incomplete.", "Ask the person who sent it for their full booking link.");
  const result = await api({ url: `/api/book?handle=${encodeURIComponent(handle)}` });
  if (!result.ok) return message("We couldn't open this booking page.", result.body.error || "Try again in a moment.");
  state.page = result.body.page;
  state.slots = result.body.slots || [];
  renderPage();
}

$("bookingDays").addEventListener("click", (event) => {
  const button = event.target.closest("[data-day]");
  if (!button) return;
  state.day = button.dataset.day;
  renderDays();
});

$("bookingTimes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-start]");
  if (!button) return;
  state.chosen = state.slots.find((slot) => slot.start === button.dataset.start);
  if (!state.chosen) return;
  const start = new Date(state.chosen.start);
  $("bookingChosen").textContent = `${longDate.format(start)} · ${timeLabel.format(start)} – ${timeLabel.format(new Date(state.chosen.end))}`;
  $("bookingError").hidden = true;
  show("bookingForm");
  $("guestName").focus();
});

$("bookingBack").addEventListener("click", () => show("bookingPicker"));

/* ------------------------------------------------------------ booking */

function cancelUrl(token) {
  return `${window.location.origin}/book/${encodeURIComponent(handle)}?cancel=${encodeURIComponent(token)}`;
}

function googleUrl(booking, page) {
  const query = new URLSearchParams({
    action: "TEMPLATE",
    text: `${page.title} with ${page.ownerName || "your host"}`,
    dates: `${toIcsUtc(booking.start)}/${toIcsUtc(booking.end)}`,
    details: `Booked on Waddle. Need to cancel? ${cancelUrl(booking.cancelToken)}`,
  });
  return `https://calendar.google.com/calendar/render?${query}`;
}

function showDone(booking, page) {
  const start = new Date(booking.start);
  $("doneTitle").textContent = "You're booked.";
  $("doneWhen").textContent = `${longDate.format(start)}, ${timeLabel.format(start)} – ${timeLabel.format(new Date(booking.end))} with ${page.ownerName || "your host"}.`;
  $("doneGoogle").href = googleUrl(booking, page);
  $("doneIcs").onclick = () => {
    const ics = buildGuestIcs(
      { id: booking.id, start_at: booking.start, end_at: booking.end, status: "confirmed", created_at: booking.createdAt },
      { ownerName: page.ownerName, pageTitle: page.title, cancelUrl: cancelUrl(booking.cancelToken) }
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    link.download = "booking.ics";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  $("doneCancelHint").innerHTML = `Plans changed? <a href="${cancelUrl(booking.cancelToken)}">Cancel this booking</a>. Keep this link — it's the only way to cancel.`;
  show("bookingDone");
}

$("bookingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("bookingSubmit");
  const error = $("bookingError");
  error.hidden = true;
  button.disabled = true;
  button.textContent = "Booking…";
  const result = await api({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "book",
      handle,
      start: state.chosen?.start,
      name: $("guestName").value,
      email: $("guestEmail").value,
      note: $("guestNote").value,
      website: $("guestWebsite").value,
    }),
  });
  button.disabled = false;
  button.textContent = "Confirm booking";
  if (result.ok) return showDone(result.body.booking, result.body.page);
  if (result.status === 409 && Array.isArray(result.body.slots)) {
    state.slots = result.body.slots;
    renderDays();
    show("bookingPicker");
    return message("Someone just took that time.", "Pick another one — the list is up to date now.", '<button class="primary-button" type="button" data-back>See open times</button>');
  }
  error.textContent = result.body.error || "Could not book that time. Try again.";
  error.hidden = false;
});

$("messageActions").addEventListener("click", (event) => {
  if (event.target.closest("[data-back]")) show("bookingPicker");
  if (event.target.closest("[data-cancel]")) confirmCancel();
});

/* ------------------------------------------------------------ cancelling */

async function confirmCancel() {
  const result = await api({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cancel", token: cancelToken }),
  });
  if (!result.ok) return message("Couldn't cancel.", result.body.error || "Try again in a moment.");
  message("Cancelled.", "The time is free again. If you added it to your calendar, you can delete it there.", `<a class="outline-button" href="/book/${encodeURIComponent(handle)}">Book another time</a>`);
}

async function loadCancel() {
  const result = await api({ url: `/api/book?booking=${encodeURIComponent(cancelToken)}` });
  if (!result.ok) return message("We couldn't find that booking.", result.body.error || "The link may be incomplete.");
  const { booking, page } = result.body;
  const start = new Date(booking.start);
  const when = `${longDate.format(start)}, ${timeLabel.format(start)} with ${page.ownerName || "your host"}`;
  if (booking.status === "cancelled") return message("Already cancelled.", `${when} is no longer booked.`);
  message(`Cancel ${page.title}?`, when, '<button class="primary-button" type="button" data-cancel>Yes, cancel it</button>');
}

if (cancelToken) loadCancel();
else loadSlots();
registerServiceWorker();
