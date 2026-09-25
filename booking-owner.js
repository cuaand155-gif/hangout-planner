// The owner's side of booking links: set up the page, share it, subscribe to
// bookings, and see or cancel upcoming ones. Everything goes through Supabase
// with the signed-in user's own token, so row level security decides what is
// visible (see supabase/schema.sql); visitors use /api/book instead.

import { BUFFERS, DURATIONS, bookingLinks, busyForBooking, normalizeBookingSettings, normalizeHandle, sameBusy, suggestHandle, usesCalendars } from "./lib/booking.js";

const $ = (id) => document.getElementById(id);
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NOTICE = [0, 1, 2, 4, 12, 24, 48];
const WINDOWS = [7, 14, 30, 60];

const hourLabel = (hour) => new Date(2000, 0, 1, hour % 24).toLocaleTimeString([], { hour: "numeric" }) + (hour === 24 ? " (midnight)" : "");
const whenLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
// New rows get updated_at from the database default; owners may not set it on insert.
const withoutUpdatedAt = ({ updated_at: _ignored, ...rest }) => rest;
const PAGE_COLUMNS = "id,handle,title,owner_name,settings,busy,ics_urls,active,feed_token";
const options = (values, label, selected) =>
  values.map((value) => `<option value="${value}"${Number(value) === Number(selected) ? " selected" : ""}>${label(value)}</option>`).join("");

/**
 * Wires the booking dialog. `app` supplies what lives in app.js:
 * { supabase, user(), accessToken(), displayName(), calendarLinks(), calendarEvents(), hasCalendars(), googleOnServer(),
 *   showToast, openDialog, openAccount, svgIcon, escapeHtml }
 */
export function initBookingOwner(app) {
  const dialog = $("bookingDialog");
  // page: the owner's row once read (false: read, and there is none).
  const state = { page: null, picked: [], loading: false };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function renderMode() {
    const mode = document.querySelector('input[name="bookingMode"]:checked')?.value || "free";
    for (const option of dialog.querySelectorAll(".booking-modes .privacy-option")) {
      option.classList.toggle("active", option.querySelector("input").checked);
    }
    $("bookingFreeOptions").hidden = mode !== "free";
    $("bookingPickedOptions").hidden = mode !== "picked";
  }

  function renderPicked() {
    const upcoming = state.picked.filter((range) => new Date(range.end) > new Date());
    $("pickedList").innerHTML = upcoming.length
      ? upcoming
          .map(
            (range, index) =>
              `<div class="source-row"><div><strong>${app.escapeHtml(whenLabel.format(new Date(range.start)))} – ${app.escapeHtml(timeOnly.format(new Date(range.end)))}</strong></div>` +
              `<button type="button" data-remove-picked="${index}" aria-label="Remove this time">${app.svgIcon("x")}</button></div>`
          )
          .join("")
      : '<p class="form-hint">No times yet. Add a date and a from–until range.</p>';
    state.picked = upcoming;
  }

  function fillForm(page) {
    const settings = normalizeBookingSettings(page?.settings || { timeZone: zone });
    $("bookingHandle").value = page?.handle || suggestHandle(app.displayName());
    $("bookingOwnerName").value = page?.owner_name ?? app.displayName();
    $("bookingPageTitle").value = page?.title || "Coffee chat";
    for (const radio of document.querySelectorAll('input[name="bookingMode"]')) radio.checked = radio.value === settings.mode;
    $("bookingWeekdays").innerHTML = WEEKDAY_NAMES.map(
      (name, day) =>
        `<label class="weekday-chip"><input type="checkbox" value="${day}"${settings.weekdays.includes(day) ? " checked" : ""} /><span>${name}</span></label>`
    ).join("");
    const hours = Array.from({ length: 25 }, (_, hour) => hour);
    $("bookingDayStart").innerHTML = options(hours.slice(0, 24), hourLabel, settings.dayStart);
    $("bookingDayEnd").innerHTML = options(hours.slice(1), hourLabel, settings.dayEnd);
    $("bookingDuration").innerHTML = options(DURATIONS, (value) => `${value} min`, settings.duration);
    $("bookingBuffer").innerHTML = options(BUFFERS, (value) => (value ? `${value} min` : "None"), settings.buffer);
    $("bookingNotice").innerHTML = options(NOTICE, (value) => (value ? `${value} hour${value === 1 ? "" : "s"} from now` : "Any time"), settings.noticeHours);
    $("bookingWindow").innerHTML = options(WINDOWS, (value) => `${value} days`, settings.windowDays);
    $("bookingUseCalendars").checked = usesCalendars(page);
    $("bookingActive").checked = page ? page.active !== false : true;
    $("bookingZone").textContent = (page ? settings.timeZone : zone).replace(/_/g, " ");
    state.picked = settings.picked;
    renderMode();
    renderPicked();
    renderCalendarsNote();
  }

  function renderCalendarsNote() {
    const links = app.calendarLinks();
    const parts = [];
    if (links.length) {
      parts.push(`Your ${links.length} calendar link${links.length === 1 ? " is" : "s are"} checked by the server, so ${links.length === 1 ? "it stays" : "they stay"} fresh even while Waddle is closed.`);
    }
    if (app.googleOnServer()) {
      parts.push("The server also checks your Google Calendar directly, so it stays current while Waddle is closed.");
    }
    if (app.hasCalendars()) {
      parts.push("Busy times from every calendar you've connected are saved to the link too (times only, never names), and refresh whenever you open Waddle.");
    }
    $("bookingCalendarsNote").textContent = parts.length
      ? parts.join(" ")
      : "You haven't connected a calendar yet (sidebar → Calendar links). Until you do, only your hours and existing bookings count.";
  }

  /** Busy times to store with the page: none when the owner turned calendars off. */
  function busyFor(settings) {
    return settings.useCalendars ? busyForBooking(app.calendarEvents(), { windowDays: settings.windowDays }) : [];
  }

  function renderShare(page) {
    const links = page ? bookingLinks(window.location.origin, page.handle, page.feed_token) : null;
    $("bookingShare").hidden = !page;
    $("bookingFeed").hidden = !page;
    $("bookingUpcoming").hidden = !page;
    if (!page) return;
    $("bookingShareLink").value = links.page;
    $("bookingOffNote").hidden = page.active !== false;
    $("bookingFeedGoogle").href = links.google;
    $("bookingFeedApple").href = links.webcal;
    $("bookingFeedCopy").dataset.link = links.https;
  }

  async function loadBookings() {
    if (!state.page) return;
    const { data, error } = await app.supabase
      .from("bookings")
      .select("id,start_at,end_at,guest_name,guest_email,note,status")
      .eq("page_id", state.page.id)
      .eq("status", "confirmed")
      .gte("end_at", new Date().toISOString())
      .order("start_at");
    const list = $("bookingList");
    if (error) {
      list.innerHTML = '<p class="form-hint">Could not load bookings right now.</p>';
      return;
    }
    list.innerHTML = data.length
      ? data
          .map(
            (row) =>
              `<div class="friend-row"><div class="friend-meta"><strong>${app.escapeHtml(row.guest_name)}</strong>` +
              `<small>${app.escapeHtml(whenLabel.format(new Date(row.start_at)))} · ${app.escapeHtml(row.guest_email)}</small>` +
              `${row.note ? `<small class="booking-note">${app.escapeHtml(row.note)}</small>` : ""}</div>` +
              `<button class="outline-button danger" type="button" data-cancel-booking="${app.escapeHtml(row.id)}">Cancel</button></div>`
          )
          .join("")
      : '<p class="form-hint">No bookings yet. Share your link to get some.</p>';
  }

  async function load() {
    const user = app.user();
    $("bookingSignedOut").hidden = Boolean(user && app.supabase);
    $("bookingSettingsForm").hidden = !(user && app.supabase);
    if (!user || !app.supabase) {
      renderShare(null);
      return;
    }
    const { data, error } = await app.supabase
      .from("booking_pages")
      .select(PAGE_COLUMNS)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (error) app.showToast("Could not load your booking link.");
    state.page = data || (error ? null : false);
    fillForm(state.page);
    renderShare(state.page);
    loadBookings();
  }

  function readForm() {
    const mode = document.querySelector('input[name="bookingMode"]:checked')?.value || "free";
    const weekdays = [...$("bookingWeekdays").querySelectorAll("input:checked")].map((input) => Number(input.value));
    const useCalendars = $("bookingUseCalendars").checked;
    const settings = normalizeBookingSettings({
        mode,
        weekdays,
        dayStart: Number($("bookingDayStart").value),
        dayEnd: Number($("bookingDayEnd").value),
        duration: Number($("bookingDuration").value),
        buffer: Number($("bookingBuffer").value),
        noticeHours: Number($("bookingNotice").value),
        windowDays: Number($("bookingWindow").value),
        timeZone: state.page ? normalizeBookingSettings(state.page.settings).timeZone : zone,
        picked: state.picked,
        useCalendars,
      });
    return {
      handle: normalizeHandle($("bookingHandle").value),
      title: $("bookingPageTitle").value.trim().slice(0, 80) || "Book a time",
      owner_name: $("bookingOwnerName").value.trim().slice(0, 60),
      active: $("bookingActive").checked,
      ics_urls: useCalendars ? app.calendarLinks().slice(0, 3) : [],
      busy: busyFor(settings),
      busy_synced_at: new Date().toISOString(),
      settings,
      updated_at: new Date().toISOString(),
    };
  }

  $("bookingSettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = readForm();
    if (!values.handle) return app.showToast("Link name: 3–48 lowercase letters, numbers or dashes.");
    if (values.settings.mode === "free" && !values.settings.weekdays.length) return app.showToast("Pick at least one day.");
    if (values.settings.mode === "picked" && !values.settings.picked.length) return app.showToast("Add at least one time people can book.");
    const button = $("bookingSave");
    button.disabled = true;
    const query = state.page
      ? app.supabase.from("booking_pages").update(values).eq("id", state.page.id)
      : app.supabase.from("booking_pages").insert({ ...withoutUpdatedAt(values), owner_id: app.user().id });
    const { data, error } = await query.select(PAGE_COLUMNS).single();
    button.disabled = false;
    if (error) {
      return app.showToast(error.code === "23505" ? "That link name is taken — try another." : "Could not save your booking link.");
    }
    state.page = data;
    fillForm(data);
    renderShare(data);
    loadBookings();
    app.showToast("Booking link saved.");
  });

  dialog.addEventListener("change", (event) => {
    if (event.target.name === "bookingMode") renderMode();
  });

  $("pickedAdd").addEventListener("click", () => {
    const date = $("pickedDate").value;
    const start = new Date(`${date}T${$("pickedStart").value}`);
    const end = new Date(`${date}T${$("pickedEnd").value}`);
    if (!date || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return app.showToast("Pick a date and an end time after the start.");
    }
    if (end <= new Date()) return app.showToast("That time has already passed.");
    state.picked = normalizeBookingSettings({ picked: [...state.picked, { start: start.toISOString(), end: end.toISOString() }] }).picked;
    renderPicked();
  });

  $("pickedList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-picked]");
    if (!button) return;
    state.picked.splice(Number(button.dataset.removePicked), 1);
    renderPicked();
  });

  $("bookingList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-cancel-booking]");
    if (!button) return;
    if (!window.confirm("Cancel this booking? The time opens up again.")) return;
    const result = await cancelBooking(button.dataset.cancelBooking);
    if (!result.ok) return app.showToast(result.error || "Could not cancel that booking.");
    app.showToast(result.emailed ? "Booking cancelled. We emailed them." : "Booking cancelled. No email went out, so let them know yourself.");
    loadBookings();
  });

  /**
   * Cancels through the server, which also emails the guest when email is set
   * up. A server without a database (local demo) answers 503: then cancel
   * directly, which row level security allows for your own bookings.
   */
  async function cancelBooking(id) {
    try {
      const token = await app.accessToken();
      const response = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action: "owner-cancel", id }),
      });
      if (response.status !== 503) {
        const body = await response.json().catch(() => ({}));
        return { ok: response.ok, emailed: body.emailed === true, error: body.error };
      }
    } catch {
      /* Server unreachable: fall through to cancelling directly. */
    }
    const { error } = await app.supabase
      .from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", id);
    return { ok: !error, emailed: false };
  }

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      app.showToast(done);
    } catch {
      window.prompt("Copy this link:", text);
    }
  }
  $("bookingCopy").addEventListener("click", () => copy($("bookingShareLink").value, "Booking link copied."));
  $("bookingFeedCopy").addEventListener("click", (event) => copy(event.currentTarget.dataset.link, "Calendar link copied."));
  $("bookingSignIn").addEventListener("click", () => {
    dialog.close();
    app.openAccount();
  });

  $("bookingButton").addEventListener("click", () => {
    app.openDialog(dialog);
    load();
  });

  /**
   * Keeps the page's busy times in step with the owner's calendars, so a guest
   * cannot book over an event from a calendar the server cannot read itself
   * (Google, or links past the first three). Writes only when they changed.
   */
  async function publishBusy() {
    const user = app.user();
    if (!user || !app.supabase || state.loading) return;
    if (state.page === null) {
      state.loading = true;
      const { data, error } = await app.supabase.from("booking_pages").select(PAGE_COLUMNS).eq("owner_id", user.id).maybeSingle();
      state.loading = false;
      if (error) return;
      state.page = data || false;
    }
    const page = state.page;
    if (!page) return;
    const busy = busyFor(normalizeBookingSettings({ ...page.settings, useCalendars: usesCalendars(page) }));
    if (sameBusy(busy, page.busy)) return;
    const { error } = await app.supabase
      .from("booking_pages")
      .update({ busy, busy_synced_at: new Date().toISOString() })
      .eq("id", page.id);
    if (error) return console.warn("Booking link busy times not synced:", error.message);
    page.busy = busy;
  }

  return {
    reload: () => {
      // A different account (or none) means a different page.
      state.page = null;
      return dialog.open ? load() : undefined;
    },
    publishBusy,
  };
}

