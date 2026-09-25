import {
  busyBlocksFor,
  AVATAR_PALETTES,
  IDEA_STYLES,
  addDays,
  buildSlots,
  buildWeek,
  classifySlot,
  createDemoState,
  createId,
  describeWindow,
  findOpenWindows,
  formatClock,
  formatDayStamp,
  formatHour,
  formatRelative,
  formatWeekLabel,
  formatWindow,
  hasVoted,
  initialsFor,
  isSharingOn,
  materializeWeek,
  normalizeWorkspaceState,
  rankIdeas,
  replaceBusyRange,
  slotRange,
  slugify,
  startOfWeek,
  stateTooLarge,
  timeZoneLabel,
  timeZoneOffsetLabel,
  voteCount,
  widenCoverage,
} from "./lib/planner.js";
import { applyMembership, findMemberForParty, linkMemberToParty, normalizeEmail, planManualClaim, resolveMembership } from "./lib/membership.js";
import { createFriendStore, describeParty, partitionRequests, profileIdsFor, rejectionFor } from "./lib/friends.js";
import { buildPlanIcs, googleCalendarUrl, planUid } from "./lib/calendar-export.js";
import { forgetGroup, mergeGroups, newGroupSlug, rememberGroup } from "./lib/groups.js";
import { dueForSync, sameBusy } from "./lib/sync.js";
import { IDEA_PHOTO_HEIGHT, IDEA_PHOTO_MAX_LENGTH, IDEA_PHOTO_WIDTH, coverCrop, isSafeImageDataUrl, squareCrop } from "./lib/avatar.js";
import { PALETTES, normalizePalette } from "./lib/palettes.js";
import {
  GROUP_LEVELS,
  LEVELS,
  LEVEL_LABELS,
  cleanSharedEvents,
  createShareStore,
  dedupeEvents,
  eventsForLevel,
  eventsOnDay,
  isPicked,
  levelForFriend,
  normalizeSharing,
  showsTitle,
  togglePicked,
  GRANT_LENGTHS,
  activeGrant,
  baseLevelForFriend,
  clearGrant,
  createSharingSettingsStore,
  friendStatus,
  grantEnd,
  isHidden,
  mergeSharing,
  resolveHidden,
  setGrant,
  toggleHidden,
  withoutHidden,
} from "./lib/sharing.js";
import { FREE_LENGTHS, createPresenceStore, freeUntil } from "./lib/presence.js";
import { DEMO_SLUG, checklistSteps, placeholderName, showChecklist } from "./lib/checklist.js";
import { APPEARANCES, THEME_COLORS, normalizeAppearance, resolveTheme } from "./lib/appearance.js";
import { initBookingOwner } from "./booking-owner.js";
import { installMode, isStandalone, registerServiceWorker } from "./lib/pwa.js";
import { REPEATS, applyRsvp, nextOccurrence, repeatLabel, rsvpAnswers, rsvpSummary, toggleTimeVote } from "./lib/hangout.js";

// Browser-safe credentials: the publishable (anon) key is designed to ship in
// client code. Row level security in supabase/schema.sql is what protects data.
const AUTH_CONFIG = {
  provider: "supabase",
  configured: true,
  supabaseUrl: "https://xgsskeblzggrhxumiwdl.supabase.co",
  supabaseAnonKey: "sb_publishable_zo4Vdwq349r56YVFls5LRw_ff1Mx9G_",
  redirectUrl: window.location.origin + window.location.pathname,
};

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const SYNC_WEEKS = 4;
const STORAGE = {
  // Keys keep the app's old name so data saved before the rename still loads.
  cache: (slug) => `gatherly-workspace:${slug}`,
  member: "gatherly-member-id",
  profile: "gatherly-profile",
  sources: "gatherly-calendar-sources",
  seen: (slug) => `gatherly-activity-seen:${slug}`,
  googleToken: "gatherly-google-token",
  groups: "gatherly-groups",
  added: "gatherly-calendar-added",
  pendingName: (slug) => `gatherly-new-group:${slug}`,
  palette: "gatherly-palette",
  myEvents: "gatherly-my-events",
  sharing: "gatherly-sharing",
  published: "gatherly-published-shares",
  checklistDismissed: (slug) => `gatherly-checklist-dismissed:${slug}`,
  appearance: "gatherly-appearance",
};

const supabaseClient = AUTH_CONFIG.configured && window.supabase
  ? window.supabase.createClient(AUTH_CONFIG.supabaseUrl, AUTH_CONFIG.supabaseAnonKey)
  : null;

const $ = (id) => document.getElementById(id);
const svgIcon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ------------------------------------------------------------- storage */

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private browsing or a full quota: the app still works for this session. */
  }
}

/* --------------------------------------------------------------- state */

const slug = slugify(new URLSearchParams(window.location.search).get("w") || "weekend-crew");

const session = {
  slug,
  state: normalizeWorkspaceState(readJson(STORAGE.cache(slug), null) || createDemoState()),
  rev: null,
  persisted: false,
  offline: true,
};

const ui = {
  weekOffset: 0,
  view: "group",
  selectedWindow: null,
  selectedSlot: null,
  dayIndex: null,
  paint: null,
  editingIdeaId: null,
  saving: false,
  user: null,
  myWeekOffset: 0,
  previewAs: "me",
  friendCalendar: null,
  workspaceLoaded: false,
};

let profile = {
  name: "",
  photo: "",
  shareSchedule: true,
  ...readJson(STORAGE.profile, {}),
};

let memberId = window.localStorage.getItem(STORAGE.member) || createId("member");
window.localStorage.setItem(STORAGE.member, memberId);

let calendarSources = readJson(STORAGE.sources, []);

// Your imported events with their names, per calendar. This never leaves the
// browser; groups and friends get filtered copies (see lib/sharing.js).
let myEvents = readJson(STORAGE.myEvents, {});
let sharing = normalizeSharing(readJson(STORAGE.sharing, null));

const friendStore = supabaseClient ? createFriendStore(supabaseClient) : null;
const friends = { rows: [], profiles: {}, loaded: false, busy: false };
const shareStore = supabaseClient ? createShareStore(supabaseClient) : null;
const sharingSettingsStore = supabaseClient ? createSharingSettingsStore(supabaseClient) : null;
const presenceStore = supabaseClient ? createPresenceStore(supabaseClient) : null;
// Title keys of your private events, found by hashing (see lib/sharing.js).
let hiddenKeys = new Set();
// Friends at a glance: their "free now" and what their shared calendar says.
const glance = { presence: new Map(), shares: new Map() };
// Server-side Google syncing (api/google.js): available here? consent stored?
const googleServer = { configured: false, connected: false, handedOver: null };

let demoNoticeShown = false;
const noteDemoMode = () => {
  if (demoNoticeShown) return;
  demoNoticeShown = true;
  showToast(session.offline
    ? "Working offline — changes stay on this device."
    : "Demo mode: add the database keys to share this workspace.");
};

const toastElement = $("toast");
const showToast = (message) => {
  toastElement.textContent = message;
  toastElement.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toastElement.classList.remove("show"), 3200);
};

/* ------------------------------------------------------ week + helpers */

const settings = () => session.state.settings;

function currentWeek() {
  const base = startOfWeek(addDays(new Date(), ui.weekOffset * 7), settings().weekStartsOn);
  return buildWeek(base, { today: new Date() });
}

const currentSlots = () => buildSlots({ dayStart: settings().dayStart, dayEnd: settings().dayEnd });

const me = () => session.state.members.find((member) => member.id === memberId) || null;

const displayName = () => profile.name || ui.user?.user_metadata?.full_name || ui.user?.user_metadata?.name || "You";

/* Phones show one day at a time instead of a sideways-scrolling week. */
const phoneQuery = window.matchMedia("(max-width: 620px)");

function dayIndexFor(week) {
  if (ui.dayIndex !== null) return Math.min(Math.max(ui.dayIndex, 0), week.length - 1);
  const today = week.findIndex((day) => day.isToday);
  return today >= 0 ? today : 0;
}

function visibleDays(week) {
  return phoneQuery.matches ? [week[dayIndexFor(week)]] : week;
}

function upcomingWindows(week = currentWeek()) {
  const now = Date.now();
  return windowsForWeek(week).filter((window) => window.end.getTime() > now);
}

function chosenWindow(week) {
  const windows = windowsForWeek(week);
  return ui.selectedWindow ? windows.find((window) => window.start.getTime() === ui.selectedWindow) || windows[0] : windows[0];
}

function windowsForWeek(week = currentWeek()) {
  return findOpenWindows(session.state.members, week, currentSlots(), { minHours: settings().minWindowHours });
}

/* ------------------------------------------------------------ persistence */

async function accessToken() {
  if (!supabaseClient) return null;
  const { data } = await supabaseClient.auth.getSession();
  return data.session?.access_token || null;
}

/** Groups need an account; the demo doesn't. Shown instead of the planner. */
function renderSignInGate() {
  const gated = session.needsSignIn === true;
  $("signInGate").hidden = !gated;
  document.body.classList.toggle("gated", gated);
  // "book-club-7fq2x" reads as "Book club"; the random ending is only there to keep links unique.
  if (gated) $("gateTitle").textContent = `Sign in to join ${placeholderName(session.slug.replace(/-(?=[a-z0-9]*\d)[a-z0-9]{5}$/, ""))}`;
}

async function loadWorkspace() {
  const cached = readJson(STORAGE.cache(session.slug), null);
  try {
    const token = await accessToken();
    const response = await fetch(`/api/workspace?slug=${encodeURIComponent(session.slug)}`, {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const gated = response.status === 401;
    session.needsSignIn = gated;
    renderSignInGate();
    if (gated) {
      // Nothing about the group comes back, and nothing is saved until sign-in.
      ui.workspaceLoaded = true;
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const payload = await response.json();
    session.rev = payload.rev || null;
    session.persisted = payload.persisted === true;
    session.offline = false;
    if (session.persisted) {
      session.state = normalizeWorkspaceState(payload.state);
      writeJson(STORAGE.cache(session.slug), session.state);
    } else if (!cached) {
      // Nothing saved here yet, so start from the sample workspace.
      session.state = normalizeWorkspaceState(payload.state);
    }
  } catch {
    session.offline = true;
    session.persisted = false;
  }
  ui.workspaceLoaded = true;
  await ensureMembership();
  render();
  if (!session.persisted) noteDemoMode();
}

/**
 * Applies a change, shows it immediately, then saves. `apply` runs again
 * against fresh server state if somebody else saved first, so a lost race
 * re-applies the same edit instead of clobbering their work.
 *
 * Calls are queued: without that, a second edit made while the first is still
 * in flight could be undone on screen when the first reply lands.
 */
let saveQueue = Promise.resolve();

function mutate(apply, options) {
  const next = saveQueue.then(() => applyAndSave(apply, options), () => applyAndSave(apply, options));
  saveQueue = next.catch(() => {});
  return next;
}

const TOO_LARGE_MESSAGE = "This group is out of room — remove a photo from another idea, then try again.";

/** The state after `apply`, or null when it would be too big to save. */
function nextStateFrom(base, apply, note) {
  const draft = structuredClone(base);
  apply(draft, base);
  if (note) draft.activity = [{ message: note, at: new Date().toISOString() }, ...(draft.activity || [])];
  const next = normalizeWorkspaceState(draft);
  return stateTooLarge(next) ? null : next;
}

async function applyAndSave(apply, { note } = {}) {
  // Behind the sign-in gate nothing is saved (background syncs included).
  if (session.needsSignIn) return false;
  let before = session.state;
  const next = nextStateFrom(before, apply, note);
  if (!next) {
    showToast(TOO_LARGE_MESSAGE);
    return false;
  }
  session.state = next;
  ui.saving = true;
  render();
  writeJson(STORAGE.cache(session.slug), session.state);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = await accessToken();
    let response;
    try {
      response = await fetch(`/api/workspace?slug=${encodeURIComponent(session.slug)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ state: session.state, rev: session.rev }),
      });
    } catch {
      ui.saving = false;
      session.offline = true;
      render();
      showToast("Saved on this device — no connection to your group right now.");
      return false;
    }

    const payload = await response.json().catch(() => ({}));

    if (response.ok || response.status === 201) {
      session.rev = payload.rev || null;
      session.persisted = payload.persisted === true;
      session.offline = false;
      ui.saving = false;
      if (session.persisted) {
        session.state = normalizeWorkspaceState(payload.state);
        writeJson(STORAGE.cache(session.slug), session.state);
      }
      render();
      if (!session.persisted) noteDemoMode();
      return session.persisted;
    }

    if (response.status === 409 && payload.state) {
      // Somebody else saved first: rebase this edit onto their version.
      const rebased = normalizeWorkspaceState(payload.state);
      session.rev = payload.rev || null;
      before = rebased;
      const retried = nextStateFrom(rebased, apply, note);
      if (retried) {
        session.state = retried;
        render();
        continue;
      }
      ui.saving = false;
      session.state = rebased;
      writeJson(STORAGE.cache(session.slug), session.state);
      render();
      showToast(TOO_LARGE_MESSAGE);
      return false;
    }

    ui.saving = false;
    if (response.status === 413) {
      // Too big for the server: undo the edit rather than keep a copy on this
      // device that can never be saved.
      session.state = before;
      writeJson(STORAGE.cache(session.slug), session.state);
      render();
      showToast(TOO_LARGE_MESSAGE);
      return false;
    }
    if (response.status === 401 && payload.signIn) {
      // Signed out elsewhere mid-edit: put the gate back up.
      session.needsSignIn = true;
      renderSignInGate();
      return false;
    }
    if (response.status === 403) {
      session.state = payload.state ? normalizeWorkspaceState(payload.state) : session.state;
      session.rev = payload.rev || session.rev;
      render();
      showToast(payload.error || "This workspace only accepts edits from signed-in members.");
      return false;
    }
    session.offline = true;
    render();
    showToast(payload.error || "Could not save to your group — kept on this device.");
    return false;
  }

  ui.saving = false;
  showToast("Your group is busy saving right now. Try that again in a moment.");
  return false;
}

/**
 * Makes sure exactly one member row represents the person at this browser.
 * The decision is recomputed inside the save so that a retry after somebody
 * else's edit still lands on the right row. See lib/membership.js.
 */
async function ensureMembership() {
  const wantedName = profile.name || displayName();
  const plan = resolveMembership({ members: session.state.members, localMemberId: memberId, user: ui.user });
  const current = session.state.members.find((member) => member.id === plan.id);

  const settled =
    plan.action !== "create" &&
    !plan.absorb &&
    current &&
    current.name === wantedName &&
    current.sharesSchedule === profile.shareSchedule &&
    !current.pending &&
    (!ui.user || current.userId === ui.user.id);
  if (settled) {
    if (memberId !== current.id) rememberMemberId(current.id);
    return;
  }

  const joining = plan.action === "create";
  let resolvedId = memberId;
  await mutate(
    (draft) => {
      const fresh = resolveMembership({ members: draft.members, localMemberId: memberId, user: ui.user });
      resolvedId = applyMembership(draft, fresh, {
        user: ui.user,
        name: wantedName,
        sharesSchedule: profile.shareSchedule,
        palettes: AVATAR_PALETTES,
        createId: () => createId("member"),
      }) || memberId;
    },
    joining ? { note: `${wantedName} joined` } : undefined
  );
  rememberMemberId(resolvedId);
}

function rememberMemberId(id) {
  if (!id || id === memberId) return;
  memberId = id;
  window.localStorage.setItem(STORAGE.member, memberId);
  // Which row is "you" changes what the whole page shows, so redraw.
  render();
}

/** Lets somebody without an account say "that invite is me". */
async function claimInvite(targetId) {
  const plan = planManualClaim({ members: session.state.members, localMemberId: memberId, targetId });
  if (!plan) return;
  const name = profile.name || session.state.members.find((member) => member.id === targetId)?.name || displayName();
  let resolvedId = memberId;
  await mutate(
    (draft) => {
      const fresh = planManualClaim({ members: draft.members, localMemberId: memberId, targetId });
      if (!fresh) return;
      resolvedId = applyMembership(draft, fresh, {
        user: ui.user,
        name,
        sharesSchedule: profile.shareSchedule,
        palettes: AVATAR_PALETTES,
        createId: () => createId("member"),
      }) || memberId;
    },
    { note: `${name} joined` }
  );
  rememberMemberId(resolvedId);
  profile = { ...profile, name };
  writeJson(STORAGE.profile, profile);
  renderSavedPeople();
  showToast(`You're in as ${name}.`);
}

/* ------------------------------------------------------------ rendering */

function render() {
  renderChrome();
  renderStatus();
  renderPlan();
  renderGrid();
  renderPeople();
  renderIdeas();
  renderMyCalendar();
  renderActivityBadge();
  renderChecklist();
}

function renderChrome() {
  $("workspaceName").textContent = session.state.name;
  document.title = `${session.state.name} — Waddle`;
  $("todayStamp").textContent = formatDayStamp(new Date()).toUpperCase();
  $("syncState").textContent = ui.saving ? "SAVING" : session.persisted ? "LIVE" : session.offline ? "OFFLINE" : "DEMO";
  $("privacyStatus").textContent = session.state.privacy === "details" ? "Event details shared" : "Busy / free only";
  $("profileName").textContent = displayName();
  $("profileSubtitle").textContent = profile.shareSchedule ? "Availability shared" : "Private schedule";

  const initials = initialsFor(displayName());
  for (const avatar of document.querySelectorAll(".profile-card .avatar, .account-avatar")) {
    avatar.textContent = profile.photo ? "" : initials;
    const photo = safeImageUrl(profile.photo);
    avatar.style.backgroundImage = photo ? `url("${photo}")` : "";
    avatar.style.backgroundSize = "cover";
    avatar.style.backgroundPosition = "center";
  }

  const radio = document.querySelector(`input[name="privacy"][value="${session.state.privacy}"]`);
  if (radio) {
    radio.checked = true;
    for (const option of document.querySelectorAll("#privacyDialog .privacy-option")) {
      option.classList.toggle("active", option.contains(radio));
    }
  }
  $("shareScheduleToggle").checked = profile.shareSchedule;
  $("profileShareSchedule").checked = profile.shareSchedule;
}

function renderStatus() {
  const week = currentWeek();
  const mine = me();
  const sharedDays = mine ? week.filter((day) => isSharingOn(mine, day.date)).length : 0;
  const hasAny = Boolean(mine && (mine.weekly.length || mine.busy.length));

  $("ownStatus").textContent = !mine
    ? "Joining…"
    : !profile.shareSchedule
      ? "Not shared"
      : hasAny
        ? sharedDays === week.length
          ? "Ready to share"
          : `${sharedDays} of ${week.length} days shared`
        : "Add your times";
  const icon = $("ownStatusIcon");
  const ready = Boolean(mine && profile.shareSchedule && hasAny);
  icon.innerHTML = svgIcon(ready ? "check" : "plus");
  icon.classList.toggle("green", ready);
  icon.classList.toggle("yellow", !ready);

  const windows = windowsForWeek(week);
  $("weekScopeLabel").textContent = ui.weekOffset === 0 ? "THIS WEEK" : formatWeekLabel(week[0].date, week.length).toUpperCase();
  $("overlapSummary").textContent = windows.length
    ? `${windows.length} overlap${windows.length === 1 ? "" : "s"} found`
    : "No shared window yet";

  $("weekLabel").textContent = formatWeekLabel(week[0].date, week.length);
  $("thisWeek").hidden = ui.weekOffset === 0;
  $("peopleCount").textContent = `${session.state.members.length} ${session.state.members.length === 1 ? "PERSON" : "PEOPLE"}`;
}

function renderGrid() {
  const grid = $("calendarGrid");

function showDay(index) {
  const week = currentWeek();
  ui.dayIndex = Math.min(Math.max(index, 0), week.length - 1);
  renderGrid();
}

$("dayStrip").addEventListener("click", (event) => {
  const pill = event.target.closest("[data-day-index]");
  if (pill) showDay(Number(pill.dataset.dayIndex));
});

$("bestTimes").addEventListener("click", (event) => {
  const card = event.target.closest("[data-window]");
  if (!card) return;
  const week = currentWeek();
  const window = windowsForWeek(week).find((entry) => entry.start.getTime() === Number(card.dataset.window));
  if (!window) return;
  ui.selectedWindow = window.start.getTime();
  ui.dayIndex = week.findIndex((day) => day.iso === window.day.iso);
  renderGrid();
  $("selectedWindow").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// Swipe between days on phones (group view only; "My availability" uses drag to paint).
let swipe = null;
grid.addEventListener("pointerdown", (event) => {
  swipe = phoneQuery.matches && ui.view !== "mine" ? { x: event.clientX, y: event.clientY } : null;
});
grid.addEventListener("pointerup", (event) => {
  if (!swipe) return;
  const dx = event.clientX - swipe.x;
  const dy = event.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) showDay(dayIndexFor(currentWeek()) + (dx < 0 ? 1 : -1));
});

phoneQuery.addEventListener("change", () => renderGrid());
  const week = currentWeek();
  const slots = currentSlots();
  const mine = me();
  const isMineView = ui.view === "mine";
  const days = visibleDays(week);
  const highlight = isMineView ? null : chosenWindow(week);

  grid.setAttribute("aria-label", isMineView ? "Your availability" : "Group availability");
  grid.style.gridTemplateColumns = `${phoneQuery.matches ? 52 : 62}px repeat(${days.length}, 1fr)`;
  grid.classList.toggle("single-day", days.length === 1);
  const cells = [`<div class="grid-corner">${timeZoneOffsetLabel()}</div>`];

  for (const day of days) {
    cells.push(
      `<div class="day${day.isToday ? " today" : ""}${day.isWeekend ? " weekend" : ""}"><small>${day.label}</small><strong>${day.dayOfMonth}</strong>${day.isToday ? "<span>Today</span>" : ""}</div>`
    );
  }

  for (const slot of slots) {
    cells.push(`<div class="time-label">${slot.showLabel ? formatHour(slot.hour) : ""}</div>`);
    for (const day of days) {
      const cell = isMineView ? classifySlot(mine ? [mine] : [], day.date, slot.hour) : classifySlot(session.state.members, day.date, slot.hour);
      const className = isMineView ? mineSlotClass(cell, mine) : cell.state;
      const selected = ui.selectedSlot && ui.selectedSlot.iso === day.iso && ui.selectedSlot.hour === slot.hour;
      const inWindow = highlight && cell.start >= highlight.start && cell.start < highlight.end;
      const windowEdge = inWindow
        ? `${cell.start.getTime() === highlight.start.getTime() ? " window-start" : ""}${cell.end.getTime() === highlight.end.getTime() ? " window-end" : ""}`
        : "";
      cells.push(
        `<div class="slot ${className}${selected ? " selected" : ""}${inWindow ? ` in-window${windowEdge}` : ""}" role="gridcell" tabindex="0"` +
          ` data-iso="${day.iso}" data-hour="${slot.hour}"` +
          ` aria-label="${escapeAttribute(slotLabel(day, slot, cell, isMineView))}"></div>`
      );
    }
  }

  grid.innerHTML = cells.join("");
  grid.classList.toggle("editing", isMineView);
  $("groupLegend").hidden = isMineView;
  $("mineLegend").hidden = !isMineView;
  $("editHint").hidden = !isMineView;
  $("mineActions").hidden = !isMineView;
  $("groupViewTab").classList.toggle("active", !isMineView);
  $("mineViewTab").classList.toggle("active", isMineView);
  $("groupViewTab").setAttribute("aria-selected", String(!isMineView));
  $("mineViewTab").setAttribute("aria-selected", String(isMineView));

  renderEventLayer(days, slots, isMineView);
  renderDayStrip(week);
  renderBestTimes(week);
  renderSelectedWindow(week);
}

/**
 * Named events on the group view: everything people let this group see (name
 * and place), plus your own events, which only you see by name. "My
 * availability" stays plain busy/free blocks.
 */
function groupEventsOn(day) {
  const entries = [];
  const mine = me();
  for (const event of eventsOnDay(allMyEvents(), day.date)) {
    if (event.allDay) continue;
    entries.push({ start: +new Date(event.start), end: +new Date(event.end), title: event.title || "Busy", location: event.location || "", who: "You", mine: true, hidden: isHidden(hiddenKeys, event.title) });
  }
  for (const member of session.state.members) {
    if (member.id === mine?.id) continue;
    for (const block of busyBlocksFor(member, day.date) || []) {
      if (!block.title) continue; // busy-only: the colours already say it
      entries.push({ start: block.start, end: block.end, title: block.title, location: block.location || "", who: member.name.split(" ")[0] });
    }
  }
  return entries;
}

/** "My availability": your calendar's events as plain busy blocks, no names. */
function mineBlocksOn(day) {
  return eventsOnDay(allMyEvents(), day.date)
    .filter((event) => !event.allDay)
    .map((event) => ({ start: +new Date(event.start), end: +new Date(event.end), block: true }));
}

function renderEventLayer(days, slots, isMineView) {
  const grid = $("calendarGrid");
  if (!slots.length) return;
  const first = slots[0].hour;
  const last = slots[slots.length - 1].hour + 1;
  const chips = [];
  for (const day of days) {
    const top = grid.querySelector(`.slot[data-iso="${day.iso}"][data-hour="${first}"]`);
    const bottom = grid.querySelector(`.slot[data-iso="${day.iso}"][data-hour="${last - 1}"]`);
    if (!top || !bottom) continue;
    const hourPx = (bottom.offsetTop + bottom.offsetHeight - top.offsetTop) / (last - first);
    const from = new Date(day.date);
    from.setHours(first, 0, 0, 0);
    const to = new Date(day.date);
    to.setHours(last, 0, 0, 0);
    const today = (isMineView ? mineBlocksOn(day) : groupEventsOn(day))
      .map((entry) => ({ ...entry, from: entry.start, start: Math.max(entry.start, +from), end: Math.min(entry.end, +to) }))
      .filter((entry) => entry.end > entry.start)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    // Side-by-side lanes for events that overlap.
    const lanes = [];
    for (const entry of today) {
      entry.lane = lanes.findIndex((end) => end <= entry.start);
      if (entry.lane === -1) entry.lane = lanes.push(0) - 1;
      lanes[entry.lane] = entry.end;
    }
    for (const entry of today) {
      const overlapping = today.filter((other) => other.start < entry.end && other.end > entry.start);
      const laneCount = Math.max(...overlapping.map((other) => other.lane)) + 1;
      const width = (top.offsetWidth - 6) / laneCount;
      const time = `${formatClock(new Date(entry.from))} – ${formatClock(new Date(entry.end))}`;
      const place = `top:${top.offsetTop + ((entry.start - from) / 3600000) * hourPx + 1}px;height:${Math.max(isMineView ? 8 : 20, ((entry.end - entry.start) / 3600000) * hourPx - 2)}px;` +
        `left:${top.offsetLeft + 3 + entry.lane * width}px;width:${width - 2}px`;
      if (entry.block) {
        chips.push(`<div class="busy-block" aria-hidden="true" title="Busy · ${escapeAttribute(time)}" style="${place}"></div>`);
        continue;
      }
      const detail = [entry.who, entry.location].filter(Boolean).join(" · ");
      chips.push(
        `<div class="event-chip${entry.mine ? " mine" : ""}${entry.hidden ? " private" : ""}" aria-hidden="true" title="${escapeAttribute([entry.title, detail, time].filter(Boolean).join(" · "))}"` +
          ` style="${place}">` +
          `${entry.hidden ? svgIcon("lock") : ""}<strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(detail)}</small>` +
          `${entry.location ? "" : `<small>${escapeHtml(time)}</small>`}</div>`
      );
    }
  }
  grid.insertAdjacentHTML("beforeend", chips.join(""));
}

// Chip positions come from the laid-out cells, so redraw when the grid resizes.
let gridWidth = 0;
new ResizeObserver(([entry]) => {
  if (Math.round(entry.contentRect.width) === gridWidth) return;
  gridWidth = Math.round(entry.contentRect.width);
  renderGrid();
}).observe($("calendarGrid"));

function renderDayStrip(week) {
  const strip = $("dayStrip");
  const active = dayIndexFor(week);
  const openDays = new Set(upcomingWindows(week).map((window) => window.day.iso));
  strip.innerHTML = week
    .map(
      (day, index) =>
        `<button type="button" class="day-pill${index === active ? " active" : ""}${day.isToday ? " today" : ""}" data-day-index="${index}" aria-pressed="${index === active}" aria-label="${escapeAttribute(day.longLabel)}">` +
        `<small>${day.label}</small><strong>${day.dayOfMonth}</strong><i class="${openDays.has(day.iso) ? "open" : ""}"></i></button>`
    )
    .join("");
}

function renderBestTimes(week) {
  const container = $("bestTimes");
  const top = upcomingWindows(week).slice(0, 3);
  if (ui.view === "mine" || !top.length) {
    container.hidden = true;
    return;
  }
  const sharing = session.state.members.filter((member) => member.sharesSchedule !== false).length;
  const selected = chosenWindow(week);
  container.hidden = false;
  container.innerHTML =
    `<p class="best-label">Best times</p><div class="best-list">` +
    top
      .map((window) => {
        const key = window.start.getTime();
        const everyone = sharing && window.memberIds.length >= sharing;
        const who = everyone ? "Everyone free" : `${window.memberIds.length} free`;
        return `<button type="button" class="best-card${selected && selected.start.getTime() === key ? " active" : ""}" data-window="${key}">` +
          `<small>${escapeHtml(formatDayStamp(window.start))}</small>` +
          `<strong>${escapeHtml(formatClock(window.start))} – ${escapeHtml(formatClock(window.end))}</strong>` +
          `<span>${who} · ${window.hours} hr${window.hours === 1 ? "" : "s"}</span></button>`;
      })
      .join("") +
    `</div>`;
}

/**
 * Editing means "mark when you're busy", so a week you have not shared yet
 * reads as free rather than as an unreadable block of hatching. The group view
 * still treats it as unknown until you actually share something.
 */
function mineSlotClass(cell, mine) {
  if (!mine) return "unknown";
  if (cell.unknown.length) return "mine-free";
  return cell.free.length ? "mine-free" : "mine-busy";
}

function slotLabel(day, slot, cell, isMineView) {
  const when = `${day.longLabel} ${formatHour(slot.hour)}`;
  if (isMineView) {
    if (cell.unknown.length) return `${when}, free, not shared yet`;
    return `${when}, you are ${cell.free.length ? "free" : "busy"}`;
  }
  if (cell.state === "overlap") return `${when}, everyone free`;
  if (cell.state === "partial") return `${when}, ${cell.free.length} free, ${cell.busy.length} busy`;
  return `${when}, no shared free time`;
}

function describeSlot(day, slot, cell) {
  const when = `${day.longLabel}, ${formatHour(slot.hour)}`;
  if (ui.view === "mine") {
    if (cell.unknown.length) return `${when} — free, but this week is not shared with your group yet.`;
    return `${when} — you are ${cell.free.length ? "free" : "busy"}.`;
  }
  const parts = [];
  if (cell.free.length) parts.push(`Free: ${cell.free.map((member) => member.name).join(", ")}`);
  if (cell.busy.length) {
    const showDetails = session.state.privacy === "details";
    parts.push(
      `Busy: ${cell.busy
        .map((entry) => (showDetails && entry.title ? `${entry.member.name} (${entry.title})` : entry.member.name))
        .join(", ")}`
    );
  }
  if (cell.unknown.length) parts.push(`No times yet: ${cell.unknown.map((member) => member.name).join(", ")}`);
  return `${when} — ${parts.join(" · ") || "nobody has shared times yet."}`;
}

function renderSelectedWindow(week) {
  const chosen = chosenWindow(week);
  const container = $("selectedWindow");

  if (!chosen || ui.view === "mine") {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  $("selectedWindowTitle").textContent = `${formatDayStamp(chosen.start)} · ${formatClock(chosen.start)} – ${formatClock(chosen.end)}`;
  $("selectedWindowDetail").textContent = describeWindow(chosen, session.state.members.filter((member) => member.sharesSchedule !== false).length);
}

function renderPeople() {
  const grid = $("peopleGrid");
  const week = currentWeek();
  const cards = session.state.members.map((member) => {
    const isYou = member.id === memberId;
    const sharedThisWeek = week.some((day) => isSharingOn(member, day.date));
    const status = member.pending
      ? "Waiting for times"
      : member.sharesSchedule === false
        ? "Schedule private"
        : sharedThisWeek
          ? "✓ All set"
          : "Needs update";
    const statusClass = status === "✓ All set" ? "person-status" : "person-status muted";
    return `<article class="person-card${isYou ? " is-you" : ""}${member.pending ? " pending" : ""}">
      ${isYou ? '<span class="person-badge">YOU</span>' : `<button class="card-remove" data-remove-member="${escapeAttribute(member.id)}" aria-label="Remove ${escapeAttribute(member.name)}">${svgIcon("x")}</button>`}
      <div class="person-top"><div class="avatar ${member.palette}">${escapeHtml(member.initials)}</div><span class="presence${sharedThisWeek ? "" : " away"}"></span></div>
      <strong>${escapeHtml(member.name)}</strong>
      <small>Updated ${escapeHtml(formatRelative(member.updatedAt))}</small>
      <span class="${statusClass}">${escapeHtml(status)}</span>
    </article>`;
  });

  cards.push(`<article class="person-card add-person" id="addPerson" role="button" tabindex="0"><div class="add-icon">${svgIcon("plus")}</div><strong>Add someone</strong><small>Invite a friend to join</small></article>`);
  grid.innerHTML = cards.join("");
}

function renderIdeas() {
  const grid = $("ideaGrid");
  const ideas = rankIdeas(session.state.ideas);
  if (!ideas.length) {
    grid.innerHTML = '<p class="empty-note">No ideas yet. Add the first one — anything from a walk to a weekend away.</p>';
    return;
  }
  const top = voteCount(ideas[0]);
  grid.innerHTML = ideas
    .map((idea) => {
      const style = IDEA_STYLES.find((entry) => entry.key === idea.style) || IDEA_STYLES[0];
      const voted = hasVoted(idea, memberId);
      const count = voteCount(idea);
      const tag = idea.tag || (count && count === top ? "POPULAR" : "IDEA");
      const photo = safeImageUrl(idea.photo);
      const tile = photo
        ? `<div class="idea-image ${style.key} has-photo" style="background-image:url('${escapeAttribute(photo)}')">`
        : `<div class="idea-image ${style.key}"><span>${style.emoji}</span>`;
      return `<article class="idea-card${count && count === top ? " selected-idea" : ""}">
        ${tile}
          <button class="idea-edit" data-edit-idea="${escapeAttribute(idea.id)}" aria-label="Edit ${escapeAttribute(idea.title)}">${svgIcon("pencil")}</button>
          <button class="heart${voted ? " voted" : ""}" data-vote-idea="${escapeAttribute(idea.id)}" aria-pressed="${voted}" aria-label="${voted ? "Remove your vote for" : "Vote for"} ${escapeAttribute(idea.title)}">${svgIcon(voted ? "heart-fill" : "heart")}</button>
        </div>
        <div class="idea-content">
          <span class="tag ${style.tagClass}">${escapeHtml(tag)}</span>
          <h3>${escapeHtml(idea.title)}</h3>
          <p>${escapeHtml(idea.description)}</p>
          <div class="idea-meta"><span>⌖ ${escapeHtml(idea.location || "Anywhere")}</span><span>${svgIcon("heart")} ${count} vote${count === 1 ? "" : "s"}</span></div>
          <button class="text-button plan-idea" type="button" data-plan-idea="${escapeAttribute(idea.id)}">Plan this ${svgIcon("arrow")}</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderPlan() {
  const plan = session.state.plan;
  const section = $("tentativePlanSection");
  if (!plan) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $("tentativeTitle").textContent = plan.location ? `${plan.activity} · ${plan.location}` : plan.activity;

  const scope = planScopeLabel(plan);
  const occurrence = nextOccurrence(plan);
  const repeats = plan.repeat && plan.repeat !== "none" ? ` · ${repeatLabel(plan.repeat).toLowerCase()}` : "";
  $("tentativeTiming").textContent = occurrence
    ? `${repeats ? "Next up" : "Pencilled in for"} ${formatDayStamp(occurrence.start)} at ${formatClock(occurrence.start)} with ${plan.audience}${repeats}`
    : `${scope} with ${plan.audience}${repeats}`;
  $("tentativeBadge").textContent = plan.chosen ? (repeats ? "Repeating" : "Pencilled in") : "Not confirmed";

  const options = timeOptionsForPlan(plan);
  $("tentativeSuggestions").innerHTML = options.length
    ? `<span>${plan.chosen ? "Other times" : "Vote on a time, then pick one"}</span>${options
        .map((option) => {
          const mine = option.voters.includes(memberId);
          const names = option.voters.map((id) => session.state.members.find((member) => member.id === id)?.name).filter(Boolean);
          return `<span class="time-option${mine ? " voted" : ""}">` +
            `<button type="button" class="time-vote" data-vote-time="${option.start.toISOString()}" aria-pressed="${mine}" title="${escapeAttribute(names.length ? `Votes: ${names.join(", ")}` : "No votes yet")}" aria-label="${mine ? "Remove your vote for" : "Vote for"} ${escapeAttribute(formatWindow(option))}">${svgIcon(mine ? "heart-fill" : "heart")} ${option.voters.length}</button>` +
            `<button type="button" data-window="${option.start.getTime()}" data-window-end="${option.end.getTime()}" title="Pick this time">${escapeHtml(formatWindow(option))}</button></span>`;
        })
        .join("")}`
    : '<span>No shared window in that range yet — add more times or widen the search.</span>';

  renderRsvp(plan, occurrence);
  renderCalendarAdd(plan);
}

/** Suggested windows plus any time someone has voted for, most votes first. */
function timeOptionsForPlan(plan) {
  const now = new Date();
  const length = settings().minWindowHours * 3600 * 1000;
  const votes = plan.timeVotes || {};
  const byStart = new Map(suggestionsForPlan(plan).map((window) => [window.start.toISOString(), { start: window.start, end: window.end }]));
  for (const key of Object.keys(votes)) {
    if (!byStart.has(key)) byStart.set(key, { start: new Date(key), end: new Date(new Date(key).getTime() + length) });
  }
  const chosen = plan.chosen ? new Date(plan.chosen).toISOString() : null;
  return [...byStart.entries()]
    .filter(([key, option]) => key !== chosen && option.end > now)
    .map(([key, option]) => ({ ...option, voters: votes[key] || [] }))
    .sort((a, b) => b.voters.length - a.voters.length || a.start - b.start)
    .slice(0, 5);
}

function renderRsvp(plan, occurrence) {
  const row = $("rsvpRow");
  row.hidden = !occurrence;
  if (!occurrence) return;
  const mine = rsvpAnswers(plan, occurrence)[memberId];
  for (const button of row.querySelectorAll("[data-rsvp]")) {
    const active = button.dataset.rsvp === mine;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const groups = rsvpSummary(plan, occurrence, session.state.members);
  const names = (list) => list.map((member) => member.name).join(", ");
  $("rsvpSummary").textContent = [
    groups.yes.length ? `Going: ${names(groups.yes)}` : "",
    groups.maybe.length ? `Maybe: ${names(groups.maybe)}` : "",
    groups.no.length ? `Can’t: ${names(groups.no)}` : "",
    groups.waiting.length ? `${groups.waiting.length} haven’t answered` : "",
  ].filter(Boolean).join(" · ");
}

/* Add to calendar */

function addedRecords() {
  return readJson(STORAGE.added, {});
}

/** The key names this plan at this exact time, so moving it re-enables adding. */
function addedKey(plan) {
  return `${planUid(plan, session.slug)}|${plan.chosen}|${plan.chosenEnd || ""}|${plan.repeat || "none"}`;
}

function renderCalendarAdd(plan) {
  const row = $("calendarAdd");
  if (!plan?.chosen) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  $("addToGoogle").href = googleCalendarUrl(plan, { url: inviteUrl() }) || "#";

  const record = addedRecords()[addedKey(plan)] || {};
  $("addToGoogle").textContent = record.google ? "Added to Google ✓" : "Google Calendar";
  $("addToGoogle").classList.toggle("done", Boolean(record.google));
  $("downloadIcs").textContent = record.ics ? "Downloaded ✓" : "Apple / Outlook";
  $("downloadIcs").classList.toggle("done", Boolean(record.ics));
  // Google's add link can't tell it's the same event, so say so plainly
  // rather than letting a second tap quietly make a duplicate.
  $("calendarAddNote").textContent = record.google
    ? "Already added to Google from this device — only add again if you deleted it."
    : record.ics
      ? "Opening the file again updates the same event rather than adding another."
      : "";
}

function markAdded(plan, kind) {
  const records = addedRecords();
  const key = addedKey(plan);
  records[key] = { ...records[key], [kind]: new Date().toISOString() };
  // Keep the record small: drop the oldest beyond 50 plans.
  const entries = Object.entries(records).sort((a, b) => String(b[1].google || b[1].ics).localeCompare(String(a[1].google || a[1].ics)));
  writeJson(STORAGE.added, Object.fromEntries(entries.slice(0, 50)));
  renderCalendarAdd(plan);
}

function planScopeLabel(plan) {
  if (plan.timing === "range" && plan.start && plan.end) return `Looking between ${plan.start} and ${plan.end}`;
  if (plan.timing === "month") return "Looking for a time this month";
  if (plan.timing === "later") return "Looking for a time later";
  return "Looking for a time this week";
}

/** Searches real availability over the plan's range instead of canned times. */
function suggestionsForPlan(plan) {
  const today = new Date();
  let from = startOfWeek(today, settings().weekStartsOn);
  let weeks = 1;
  if (plan.timing === "month") weeks = 5;
  else if (plan.timing === "later") {
    from = addDays(from, 28);
    weeks = 8;
  } else if (plan.timing === "range" && plan.start && plan.end) {
    from = startOfWeek(new Date(`${plan.start}T00:00:00`), settings().weekStartsOn);
    const span = Math.ceil((new Date(`${plan.end}T23:59:59`) - from) / (7 * 24 * 3600 * 1000));
    weeks = Math.min(12, Math.max(1, span));
  }

  const limits = plan.timing === "range" && plan.start && plan.end
    ? { min: new Date(`${plan.start}T00:00:00`), max: new Date(`${plan.end}T23:59:59`) }
    : null;

  const found = [];
  for (let index = 0; index < weeks && found.length < 3; index += 1) {
    const week = buildWeek(addDays(from, index * 7), { today });
    for (const window of windowsForWeek(week)) {
      if (window.end < today) continue;
      if (limits && (window.start < limits.min || window.start > limits.max)) continue;
      found.push(window);
      if (found.length >= 3) break;
    }
  }
  return found;
}

/** Returns the block without its event title. */
function withoutTitle(block) {
  const copy = { ...block };
  delete copy.title;
  return copy;
}

function renderActivityBadge() {
  const latest = session.state.activity[0];
  const seen = window.localStorage.getItem(STORAGE.seen(session.slug));
  $("activityDot").hidden = !latest || latest.at === seen;
}

/** Only http(s) image URLs are allowed into a CSS url() value. */
function safeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) return isSafeImageDataUrl(raw) ? raw : "";
  try {
    const parsed = new URL(raw, window.location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href.replace(/["\\]/g, "");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------ getting started */

/** Copy and the existing UI each step opens; which steps are done is lib/checklist.js. */
const CHECKLIST_STEPS = {
  name: {
    icon: "pencil",
    action: "Name it",
    doneAction: "Rename",
    hint: () => "Give it something friendlier than its link.",
    doneHint: () => `Called \u201c${session.state.name}\u201d.`,
    open: () => {
      $("settingsButton").click();
      $("settingWorkspaceName")?.select();
    },
  },
  times: {
    icon: "calendar",
    action: "Add times",
    doneAction: "Edit",
    hint: () => "Paint the hours you are free this week.",
    doneHint: () => "Your times are in.",
    open: () => $("editOwnAvailability").click(),
  },
  invite: {
    icon: "user-plus",
    action: "Invite",
    doneAction: "Invite more",
    hint: () => {
      const count = session.state.members.length;
      const wanted = count === 2 ? "one more friend" : count === 1 ? "two friends" : "a few friends";
      return `${count} ${count === 1 ? "person" : "people"} so far. Share the link with ${wanted}.`;
    },
    doneHint: () => `${session.state.members.length} people are in.`,
    open: () => $("inviteButton").click(),
  },
};

let checklistDismissed = readChecklistDismissed();
let checklistMarkup = "";
let checklistDone = {};

function readChecklistDismissed() {
  try {
    return window.localStorage.getItem(STORAGE.checklistDismissed(session.slug)) === "1";
  } catch {
    return false;
  }
}

function writeChecklistDismissed() {
  try {
    window.localStorage.setItem(STORAGE.checklistDismissed(session.slug), "1");
  } catch {
    /* Without storage the card stays hidden until the page reloads. */
  }
}

function checklistStepMarkup(step, index) {
  const copy = CHECKLIST_STEPS[step.id];
  const hint = step.done ? copy.doneHint() : copy.hint();
  const buttonClass = step.done ? "text-button" : "outline-button";
  return `<li class="checklist-step${step.done ? " is-done" : ""}" data-step="${escapeAttribute(step.id)}">
    <span class="checklist-mark" aria-hidden="true">${step.done ? svgIcon("check") : index + 1}</span>
    <div class="checklist-text">
      <strong>${escapeHtml(step.label)}<span class="checklist-sr">${step.done ? " (done)" : " (to do)"}</span></strong>
      <small>${escapeHtml(hint)}</small>
    </div>
    <button type="button" class="${buttonClass}" data-checklist-step="${escapeAttribute(step.id)}">${step.done ? "" : `${svgIcon(copy.icon)} `}${escapeHtml(step.done ? copy.doneAction : copy.action)}</button>
  </li>`;
}

function renderChecklist() {
  const card = $("checklistCard");
  const steps = checklistSteps({ state: session.state, member: me(), sourcesCount: calendarSources.length, slug: session.slug });
  const visible = ui.workspaceLoaded && !checklistDismissed && showChecklist(session.slug, steps);
  card.hidden = !visible;
  if (!visible) return;

  const doneCount = steps.filter((step) => step.done).length;
  $("checklistCount").textContent = `${doneCount} of ${steps.length} done`;
  $("checklistMeter").style.transform = `scaleX(${doneCount / steps.length})`;

  const markup = steps.map(checklistStepMarkup).join("");
  if (markup !== checklistMarkup) {
    checklistMarkup = markup;
    $("checklistSteps").innerHTML = markup;
    // A step that just flipped to done gets a small pop, once.
    for (const step of steps) {
      if (step.done && checklistDone[step.id] === false) {
        $("checklistSteps").querySelector(`[data-step="${step.id}"]`)?.classList.add("just-done");
      }
    }
  }
  checklistDone = Object.fromEntries(steps.map((step) => [step.id, step.done]));
}

function dismissChecklist() {
  checklistDismissed = true;
  writeChecklistDismissed();
  const card = $("checklistCard");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.classList.add("is-leaving");
  window.setTimeout(() => {
    card.classList.remove("is-leaving");
    renderChecklist();
  }, still ? 0 : 240);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

const escapeAttribute = escapeHtml;

/* ------------------------------------------------------- availability edits */

/**
 * Makes the displayed week editable: the recurring "usual week" is copied into
 * dated blocks once, so editing this week never rewrites every other week.
 */
function materializeMyWeek(draft, week) {
  const member = draft.members.find((entry) => entry.id === memberId);
  if (!member) return null;
  const from = week[0].date;
  const to = addDays(week[week.length - 1].date, 1);
  const lastDay = week[week.length - 1].date;
  const covered = member.coverage
    && new Date(`${member.coverage.from}T00:00:00`) <= from
    && new Date(`${member.coverage.to}T00:00:00`) >= lastDay;

  if (!covered) {
    const materialized = materializeWeek(member, week);
    member.busy = replaceBusyRange(member.busy, materialized, { source: "manual", from, to });
  }
  member.coverage = widenCoverage(member.coverage, from, lastDay);
  return member;
}

function applyPaint(cellsToPaint, busy) {
  const week = currentWeek();
  return mutate(
    (draft) => {
      const member = materializeMyWeek(draft, week);
      if (!member) return;
      for (const { iso, hour } of cellsToPaint) {
        const day = new Date(`${iso}T00:00:00`);
        const { start, end } = slotRange(day, hour);
        // Drop anything overlapping the slot, then re-add it when marking busy.
        member.busy = member.busy.filter((block) => !(new Date(block.start) < end && start < new Date(block.end)));
        if (busy) member.busy.push({ start: start.toISOString(), end: end.toISOString(), source: "manual" });
      }
      member.updatedAt = new Date().toISOString();
    },
    { note: `${displayName()} updated their times` }
  );
}

function slotFromEvent(event) {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const slot = element?.closest?.(".slot");
  return slot && $("calendarGrid").contains(slot) ? slot : null;
}

function beginPaint(slot) {
  const busy = !slot.classList.contains("mine-busy");
  ui.paint = { busy, cells: new Map() };
  extendPaint(slot);
}

function extendPaint(slot) {
  if (!ui.paint) return;
  const key = `${slot.dataset.iso}:${slot.dataset.hour}`;
  if (ui.paint.cells.has(key)) return;
  ui.paint.cells.set(key, { iso: slot.dataset.iso, hour: Number(slot.dataset.hour) });
  slot.classList.toggle("mine-busy", ui.paint.busy);
  slot.classList.toggle("mine-free", !ui.paint.busy);
  slot.classList.remove("unknown");
}

function commitPaint() {
  if (!ui.paint) return;
  const { busy, cells } = ui.paint;
  ui.paint = null;
  if (!cells.size) return;
  applyPaint([...cells.values()], busy);
}

/* --------------------------------------------------------- calendar sync */

function saveSources() {
  writeJson(STORAGE.sources, calendarSources);
  renderSources();
  renderChecklist();
}

function renderSources() {
  const container = $("calendarSources");
  if (!calendarSources.length) {
    container.innerHTML = '<p class="form-hint">No calendar links yet. Busy times you paint by hand stay as they are.</p>';
    return;
  }
  container.innerHTML = calendarSources
    .map(
      (source, index) => `<div class="source-row">
        <div><strong>${escapeHtml(source.label || source.url)}</strong><small>${source.syncedAt ? `Synced ${escapeHtml(formatRelative(source.syncedAt))} · ${source.blocks || 0} busy block${source.blocks === 1 ? "" : "s"}` : "Not synced yet"}</small></div>
        <button type="button" data-remove-source="${index}" aria-label="Remove this calendar link">${svgIcon("x")}</button>
      </div>`
    )
    .join("");
}

function syncRange() {
  const from = startOfWeek(new Date(), settings().weekStartsOn);
  return { from, to: addDays(from, SYNC_WEEKS * 7) };
}

function sourceKind(sourceKey) {
  return sourceKey === "google" ? "google" : "ics";
}

/** Every imported event from every connected calendar, names included. */
function allMyEvents() {
  return dedupeEvents(Object.values(myEvents).flatMap((entry) => entry?.events || []));
}

function saveMyEvents() {
  writeJson(STORAGE.myEvents, myEvents);
}

/** Whether an event's name may be written into this group's shared planner. */
function groupSeesTitle(title) {
  return session.state.privacy === "details" && showsTitle(sharing, sharing.groups, title);
}

/**
 * Remembers one calendar's events on this device, then saves the busy times
 * to the group. Returns { count, changed }; when nothing changed nothing is
 * saved, so an automatic refresh never touches the shared workspace or its
 * activity feed.
 */
async function storeImportedBlocks(events, sourceKey, range, { quiet = false } = {}) {
  const cleaned = events
    .map((event) => ({
      start: new Date(event.start),
      end: new Date(event.end),
      ...(event.allDay ? { allDay: true } : {}),
      ...(event.title ? { title: String(event.title).slice(0, 120) } : {}),
      ...(event.location ? { location: String(event.location).slice(0, 120) } : {}),
    }))
    .filter((event) => !Number.isNaN(event.start.getTime()) && !Number.isNaN(event.end.getTime()) && event.end > event.start);

  myEvents[sourceKey] = {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    events: cleaned.map((event) => ({ ...event, start: event.start.toISOString(), end: event.end.toISOString() })),
  };
  saveMyEvents();
  schedulePublish();
  renderMyCalendar();
  const changed = await publishKindToGroup(sourceKind(sourceKey), range, { quiet });
  return { count: cleaned.length, changed };
}

/**
 * Writes the busy times from every calendar of one kind into my row. All of
 * them go together, so refreshing one calendar link never wipes another's.
 */
async function publishKindToGroup(kind, range, { quiet = false } = {}) {
  await refreshHiddenKeys();
  const blocks = Object.entries(myEvents)
    .filter(([key]) => sourceKind(key) === kind)
    .flatMap(([, entry]) => entry?.events || [])
    // Private events never reach the group, not even as busy time.
    .filter((event) => !isHidden(hiddenKeys, event.title))
    .map((event) => ({
      start: new Date(event.start),
      end: new Date(event.end),
      ...(groupSeesTitle(event.title) ? { title: event.title, ...(event.location ? { location: event.location } : {}) } : {}),
    }));

  const mine = me();
  if (mine) {
    const nextBusy = normalizeWorkspaceState({
      members: [{ ...mine, busy: replaceBusyRange(mine.busy, blocks, { source: kind, from: range.from, to: range.to }) }],
    }).members[0].busy;
    const nextCoverage = widenCoverage(mine.coverage, range.from, addDays(range.to, -1));
    const coverageSame = mine.coverage && mine.coverage.from === nextCoverage.from && mine.coverage.to === nextCoverage.to;
    if (coverageSame && sameBusy(mine.busy, nextBusy)) return false;
  }

  await mutate(
    (draft) => {
      const member = draft.members.find((entry) => entry.id === memberId);
      if (!member) return;
      member.busy = replaceBusyRange(member.busy, blocks, { source: kind, from: range.from, to: range.to });
      member.coverage = widenCoverage(member.coverage, range.from, addDays(range.to, -1));
      member.updatedAt = new Date().toISOString();
    },
    quiet ? undefined : { note: `${displayName()} synced a calendar` }
  );
  return true;
}

/** Re-applies the group rules to what's already imported, after a setting changes. */
async function republishToGroup() {
  const range = syncRange();
  const kinds = new Set(Object.keys(myEvents).map(sourceKind));
  for (const kind of kinds) await publishKindToGroup(kind, range, { quiet: true });
}

async function importIcs(url, { silent = false, quiet = false } = {}) {
  const range = syncRange();
  const response = await fetch("/api/calendar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      // Names come back to this browser only; what the group and friends
      // see is filtered before anything is saved.
      details: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (!silent) showToast(payload.error || "Could not read that calendar link.");
    return null;
  }
  const { count, changed } = await storeImportedBlocks(payload.blocks || [], `ics:${url}`, range, { quiet });
  if (!silent) showToast(count ? `Imported ${count} busy block${count === 1 ? "" : "s"}.` : "That calendar has no events in the next four weeks.");
  importIcs.lastChanged = changed;
  return count;
}

async function syncGoogle({ silent = false, quiet = false } = {}) {
  const token = googleToken();
  if (!token && !googleServer.connected) {
    if (!silent) showToast("Connect Google Calendar first.");
    return null;
  }
  const range = syncRange();
  const params = new URLSearchParams({
    timeMin: range.from.toISOString(),
    timeMax: range.to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500",
  });
  let payload;
  try {
    // The browser's hour-long token when there is one; otherwise the server,
    // which renews access by itself (see api/google.js).
    const response = token
      ? await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      : await googleApi("GET", { from: range.from.toISOString(), to: range.to.toISOString() });
    if (response.status === 401 || response.status === 403) {
      if (token) clearGoogleToken();
      else googleServer.connected = false;
      renderGoogleState();
      if (!silent) {
        showToast(token && googleServer.connected
          ? "Refreshing Google access…"
          : googleServer.configured
            ? "Google stopped sharing your calendar. Tap Connect again."
            : "Google calendar access ran out (Google allows about an hour). Tap Connect again, or add your secret iCal address for nonstop syncing.");
      }
      // The browser token ran out but the server can still renew: try once more that way.
      if (token && googleServer.connected) return syncGoogle({ silent, quiet });
      return null;
    }
    if (!response.ok) throw new Error(String(response.status));
    payload = await response.json();
  } catch {
    if (!silent) showToast("Could not reach Google Calendar.");
    return null;
  }

  const blocks = (payload.items || [])
    .filter((item) => item.status !== "cancelled" && item.transparency !== "transparent")
    .map((item) => ({
      start: item.start?.dateTime || (item.start?.date ? `${item.start.date}T00:00:00` : null),
      end: item.end?.dateTime || (item.end?.date ? `${item.end.date}T00:00:00` : null),
      title: item.summary,
      location: item.location,
      allDay: Boolean(item.start?.date && !item.start?.dateTime),
    }))
    .filter((block) => block.start && block.end);

  const { count, changed } = await storeImportedBlocks(blocks, "google", range, { quiet });
  syncGoogle.lastChanged = changed;
  const source = calendarSources.find((entry) => entry.type === "google");
  if (source) {
    source.syncedAt = new Date().toISOString();
    source.blocks = count;
    saveSources();
  }
  if (!silent) showToast(count ? `Google Calendar synced: ${count} busy block${count === 1 ? "" : "s"}.` : "No Google events in the next four weeks.");
  return count;
}

function googleConnected() {
  return Boolean(googleToken()) || googleServer.connected;
}

function renderGoogleState() {
  const connected = googleConnected();
  const button = $("googleCalendarButton");
  button.textContent = connected ? "Synced" : "Connect";
  button.classList.toggle("connected", connected);
  $("googleCalendarState").textContent = connected
    ? googleServer.connected
      ? "Connected. Keeps syncing on its own while you use Waddle, on any device you sign in on."
      : "Connected. Google only allows about an hour at a time, then you'll be asked to connect again. For syncing that never stops, add your calendar's secret iCal address below."
    : "Sync busy times and show schedule overlaps.";
}

/* Automatic calendar refresh */

let autoSyncRunning = false;

/**
 * Re-imports every saved calendar that hasn't synced in the last half hour.
 * Runs when the app opens and whenever the tab comes back into view. Quiet:
 * no toasts for failures, no activity entries, and nothing is saved at all
 * when the calendar hasn't changed.
 */
async function autoSyncCalendars() {
  if (autoSyncRunning || !me()) return;
  autoSyncRunning = true;
  let changed = false;
  try {
    for (const source of calendarSources.filter((entry) => entry.type === "ics")) {
      if (!dueForSync(source.syncedAt)) continue;
      const count = await importIcs(source.url, { silent: true, quiet: true });
      if (count === null) continue;
      source.syncedAt = new Date().toISOString();
      source.blocks = count;
      changed = changed || importIcs.lastChanged;
    }
    const google = calendarSources.find((entry) => entry.type === "google");
    if (googleConnected() && dueForSync(google?.syncedAt)) {
      const count = await syncGoogle({ silent: true, quiet: true });
      if (count !== null) changed = changed || syncGoogle.lastChanged;
    }
    saveSources();
    if (changed) showToast("Your calendar was refreshed.");
  } finally {
    autoSyncRunning = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") autoSyncCalendars();
});

/* Groups */

const groupsState = { remote: [] };

function localGroups() {
  return readJson(STORAGE.groups, []);
}

function groupUrl(slug) {
  const url = new URL(window.location.href);
  url.search = slug === "weekend-crew" ? "" : `?w=${encodeURIComponent(slug)}`;
  url.hash = "";
  return url.toString();
}

/** Adds the open group to this browser's list, under its current name. */
function recordVisit() {
  writeJson(STORAGE.groups, rememberGroup(localGroups(), { slug: session.slug, name: session.state.name }));
}

async function loadRemoteGroups() {
  const token = await accessToken();
  if (!token) {
    groupsState.remote = [];
    return;
  }
  try {
    const response = await fetch("/api/groups", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return;
    const payload = await response.json();
    groupsState.remote = Array.isArray(payload.groups) ? payload.groups : [];
  } catch {
    /* Offline: the local list still works. */
  }
}

function renderGroups() {
  const groups = mergeGroups(localGroups(), groupsState.remote);
  $("groupList").innerHTML = groups.length
    ? groups
        .map((group) => {
          const current = group.slug === session.slug;
          const name = group.slug === session.slug ? session.state.name : group.name;
          return `<a class="group-row${current ? " current" : ""}" href="${escapeAttribute(groupUrl(group.slug))}">
            <span class="group-mark">${escapeHtml(initialsFor(name || group.slug))}</span>
            <div><strong>${escapeHtml(name || group.slug)}</strong><small>${escapeHtml(group.onAccount ? "On your account" : "On this device")} · ${escapeHtml(formatRelative(group.at))}</small></div>
            <span class="group-actions">${current ? '<span class="group-current">OPEN</span>' : ""}${
              !current && !group.onAccount ? `<button type="button" data-forget-group="${escapeAttribute(group.slug)}" aria-label="Remove ${escapeAttribute(name || group.slug)} from this list">${svgIcon("x")}</button>` : ""
            }</span>
          </a>`;
        })
        .join("")
    : '<p class="form-hint">No groups yet.</p>';
  $("groupsHint").textContent = ui.user
    ? "Groups you've joined while signed in follow you to every device."
    : "Groups you open on this device are listed here. Sign in to see them on your other devices too.";
}

async function openGroups() {
  renderGroups();
  openDialog(dialogs.groups);
  await loadRemoteGroups();
  renderGroups();
}

$("groupsButton").addEventListener("click", openGroups);
$("switchGroup").addEventListener("click", openGroups);

$("groupList").addEventListener("click", (event) => {
  const forget = event.target.closest("[data-forget-group]");
  if (!forget) return;
  event.preventDefault();
  writeJson(STORAGE.groups, forgetGroup(localGroups(), forget.dataset.forgetGroup));
  renderGroups();
});

$("newGroupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("newGroupName").value.trim();
  if (!name) return;
  const slug = newGroupSlug(name);
  // The server names a new group after its link; carry the real name over so
  // the first load can set it.
  try {
    window.sessionStorage.setItem(STORAGE.pendingName(slug), name);
  } catch {
    /* Without session storage the group keeps its link-derived name. */
  }
  window.location.href = groupUrl(slug);
});

/** Applies the name typed when the group was created, once. */
async function applyPendingName() {
  let pending = null;
  try {
    pending = window.sessionStorage.getItem(STORAGE.pendingName(session.slug));
    window.sessionStorage.removeItem(STORAGE.pendingName(session.slug));
  } catch {
    return;
  }
  if (!pending || pending === session.state.name) return;
  await mutate((draft) => {
    draft.name = pending;
  }, { note: `Group created: ${pending}` });
}

/* ------------------------------------------------------------- dialogs */

const dialogs = {
  privacy: $("privacyDialog"),
  calendar: $("calendarDialog"),
  account: $("accountDialog"),
  profile: $("profileDialog"),
  plan: $("tentativePlanDialog"),
  people: $("peopleDialog"),
  idea: $("ideaDialog"),
  settings: $("settingsDialog"),
  activity: $("activityDialog"),
  groups: $("groupsDialog"),
  sharing: $("sharingDialog"),
  friendCalendar: $("friendCalendarDialog"),
};

const openDialog = (dialog) => {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
};

for (const button of document.querySelectorAll(".close-dialog")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

const bookingOwner = initBookingOwner({
  supabase: supabaseClient,
  user: () => ui.user,
  displayName: () => displayName(),
  calendarLinks: () => calendarSources.map((source) => source.url).filter((url) => /^(https|webcal):\/\//i.test(String(url || ""))),
  calendarEvents: () => allMyEvents(),
  hasCalendars: () => calendarSources.length > 0 || allMyEvents().length > 0,
  showToast: (message) => showToast(message),
  openDialog: (dialog) => openDialog(dialog),
  openAccount: () => openDialog(dialogs.account),
  svgIcon,
  escapeHtml: (value) => escapeHtml(value),
});

for (const button of document.querySelectorAll("[data-scroll]")) {
  button.addEventListener("click", () => $(button.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

/* ------------------------------------------------------------ wiring */

$("prevWeek").addEventListener("click", () => {
  ui.weekOffset -= 1;
  ui.dayIndex = null;
  ui.selectedWindow = null;
  ui.selectedSlot = null;
  render();
});
$("nextWeek").addEventListener("click", () => {
  ui.weekOffset += 1;
  ui.dayIndex = null;
  ui.selectedWindow = null;
  ui.selectedSlot = null;
  render();
});
$("thisWeek").addEventListener("click", () => {
  ui.weekOffset = 0;
  ui.dayIndex = null;
  ui.selectedWindow = null;
  render();
});

for (const tab of document.querySelectorAll(".view-tab")) {
  tab.addEventListener("click", () => {
    ui.view = tab.dataset.view;
    $("slotDetail").textContent = "";
    render();
  });
}

$("editOwnAvailability").addEventListener("click", () => {
  ui.view = "mine";
  render();
  $("availability").scrollIntoView({ behavior: "smooth", block: "start" });
});

$("checklistSteps").addEventListener("click", (event) => {
  const button = event.target.closest("[data-checklist-step]");
  if (button) CHECKLIST_STEPS[button.dataset.checklistStep]?.open();
});
$("dismissChecklist").addEventListener("click", dismissChecklist);

const grid = $("calendarGrid");

grid.addEventListener("pointerdown", (event) => {
  const slot = event.target.closest(".slot");
  if (!slot) return;
  if (ui.view === "mine") {
    event.preventDefault();
    beginPaint(slot);
  } else {
    selectSlot(slot);
  }
});

grid.addEventListener("pointermove", (event) => {
  if (!ui.paint) return;
  const slot = slotFromEvent(event);
  if (slot) extendPaint(slot);
});

window.addEventListener("pointerup", commitPaint);
window.addEventListener("pointercancel", commitPaint);

grid.addEventListener("mouseover", (event) => {
  const slot = event.target.closest(".slot");
  if (slot) describeSlotElement(slot);
});

grid.addEventListener("focusin", (event) => {
  const slot = event.target.closest(".slot");
  if (slot) describeSlotElement(slot);
});

grid.addEventListener("keydown", (event) => {
  const slot = event.target.closest(".slot");
  if (!slot) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (ui.view === "mine") {
      applyPaint([{ iso: slot.dataset.iso, hour: Number(slot.dataset.hour) }], !slot.classList.contains("mine-busy"));
    } else {
      selectSlot(slot);
    }
    return;
  }
  const moves = { ArrowLeft: -1, ArrowRight: 1 };
  const columns = visibleDays(currentWeek()).length;
  const jumps = { ArrowUp: -columns, ArrowDown: columns };
  const delta = moves[event.key] ?? jumps[event.key];
  if (delta === undefined) return;
  event.preventDefault();
  const slots = [...grid.querySelectorAll(".slot")];
  const next = slots[slots.indexOf(slot) + delta];
  next?.focus();
});

function selectSlot(slot) {
  ui.selectedSlot = { iso: slot.dataset.iso, hour: Number(slot.dataset.hour) };
  for (const element of grid.querySelectorAll(".slot.selected")) element.classList.remove("selected");
  slot.classList.add("selected");
  describeSlotElement(slot);

  const week = currentWeek();
  const day = week.find((entry) => entry.iso === slot.dataset.iso);
  if (day) {
    const { start } = slotRange(day.date, Number(slot.dataset.hour));
    const containing = windowsForWeek(week).find((window) => window.start <= start && start < window.end);
    ui.selectedWindow = containing ? containing.start.getTime() : ui.selectedWindow;
    renderGrid();
  }
}

function describeSlotElement(slot) {
  const week = currentWeek();
  const day = week.find((entry) => entry.iso === slot.dataset.iso);
  if (!day) return;
  const hour = Number(slot.dataset.hour);
  const mine = me();
  const cell = ui.view === "mine" ? classifySlot(mine ? [mine] : [], day.date, hour) : classifySlot(session.state.members, day.date, hour);
  $("slotDetail").textContent = describeSlot(day, { hour }, cell);
}

$("saveUsualWeek").addEventListener("click", async () => {
  const week = currentWeek();
  const mine = me();
  if (!mine) return;
  const blocks = materializeWeek(mine, week);
  if (!blocks.length) {
    showToast("Mark some busy time first, then save it as your usual week.");
    return;
  }
  await mutate(
    (draft) => {
      const member = draft.members.find((entry) => entry.id === memberId);
      if (!member) return;
      member.weekly = blocks.map((block) => {
        const start = new Date(block.start);
        const end = new Date(block.end);
        return {
          weekday: start.getDay(),
          start: `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
          end: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`,
        };
      });
      member.updatedAt = new Date().toISOString();
    },
    { note: `${displayName()} saved a usual week` }
  );
  showToast("Saved. Weeks you have not edited now use this pattern.");
});

$("clearMyWeek").addEventListener("click", async () => {
  const week = currentWeek();
  await mutate(
    (draft) => {
      const member = draft.members.find((entry) => entry.id === memberId);
      if (!member) return;
      const from = week[0].date;
      const to = addDays(week[week.length - 1].date, 1);
      member.busy = replaceBusyRange(member.busy, [], { source: null, from, to });
      member.coverage = widenCoverage(member.coverage, from, week[week.length - 1].date);
      member.updatedAt = new Date().toISOString();
    },
    { note: `${displayName()} cleared a week` }
  );
  showToast("Shared — your group sees you as free all week.");
});

/* Sharing */

function inviteUrl() {
  const url = new URL(window.location.href);
  url.search = session.slug === "weekend-crew" ? "" : `?w=${encodeURIComponent(session.slug)}`;
  url.hash = "";
  return url.toString();
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Clipboard access needs a secure context and permission; fall back to a
    // selection the person can copy by hand.
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    field.remove();
    return copied;
  }
}

async function shareInvite(message) {
  const link = inviteUrl();
  if (await copyText(link)) showToast(`${message} Link copied.`);
  else showToast(`${message} Copy this link: ${link}`);
}

$("inviteButton").addEventListener("click", () => {
  $("inviteLink").value = inviteUrl();
  renderSavedPeople();
  openDialog(dialogs.people);
  shareInvite("Anyone who signs in with this link can join and add their times.");
});

$("shareButton").addEventListener("click", () => shareInvite("Availability view shared."));
$("copyInviteLink").addEventListener("click", () => shareInvite("Invite link ready."));

// "Plan something" under the selected window: the plan form opens with that time already picked.
$("planButton").addEventListener("click", () => {
  const window = chosenWindow(currentWeek());
  if (!window) return;
  const length = settings().minWindowHours * 3600 * 1000;
  ui.pendingWindow = { start: window.start, end: new Date(Math.min(window.start.getTime() + length, window.end.getTime())) };
  openPlanDialog();
});

$("addToGoogle").addEventListener("click", () => {
  const plan = session.state.plan;
  if (plan?.chosen) markAdded(plan, "google");
});

$("downloadIcs").addEventListener("click", () => {
  const plan = session.state.plan;
  const ics = plan && buildPlanIcs(plan, { slug: session.slug, url: inviteUrl() });
  if (!ics) return;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${session.slug}-plan.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  markAdded(plan, "ics");
  showToast("Calendar file ready — open it to add the plan.");
});

/* Privacy */

$("privacyButton").addEventListener("click", () => openDialog(dialogs.privacy));

for (const option of document.querySelectorAll("#privacyDialog .privacy-option")) {
  option.addEventListener("click", () => {
    for (const item of document.querySelectorAll("#privacyDialog .privacy-option")) item.classList.remove("active");
    option.classList.add("active");
    option.querySelector("input").checked = true;
  });
}

$("savePrivacy").addEventListener("click", async () => {
  const detailed = document.querySelector('input[name="privacy"]:checked').value === "details";
  await mutate(
    (draft) => {
      draft.privacy = detailed ? "details" : "busy";
      if (!detailed) {
        // Busy/free only is not just a display setting: drop the titles.
        for (const member of draft.members) {
          member.busy = member.busy.map(withoutTitle);
          member.weekly = member.weekly.map(withoutTitle);
        }
      }
    },
    { note: detailed ? "Event details are now shared" : "Sharing set to busy/free only" }
  );
  dialogs.privacy.close();
  if (detailed) await republishToGroup();
  showToast(detailed ? "This group can now see event names each person chooses to share." : "Only busy/free blocks are shared.");
});

/* Calendar links */

$("calendarButton").addEventListener("click", () => {
  renderSources();
  renderGoogleState();
  openDialog(dialogs.calendar);
});

$("googleCalendarButton").addEventListener("click", async () => {
  if (googleConnected()) {
    await syncGoogle();
    renderGoogleState();
    return;
  }
  if (!supabaseClient) {
    showToast("Add the Supabase keys in app.js to connect Google Calendar.");
    return;
  }
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: {
      // ?calendar tells the page it's back from the consent screen, so it keeps the token and syncs.
      redirectTo: `${AUTH_CONFIG.redirectUrl}?calendar=1${session.slug === "weekend-crew" ? "" : `&w=${encodeURIComponent(session.slug)}`}`,
      scopes: GOOGLE_SCOPE,
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });
  if (error) showToast(`Google Calendar could not start: ${error.message}`);
});

$("icsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const field = $("icsUrl");
  const url = field.value.trim();
  if (!url) {
    showToast("Paste a calendar link first.");
    return;
  }
  const button = $("icsSubmit");
  button.disabled = true;
  button.textContent = "Importing…";
  const count = await importIcs(url);
  button.disabled = false;
  button.textContent = "Import busy times";
  if (count === null) return;

  let host = url;
  try {
    host = new URL(url.replace(/^webcal:/i, "https:")).hostname;
  } catch {
    /* Keep the raw value as the label. */
  }
  const existing = calendarSources.find((source) => source.url === url);
  const record = existing || { type: "ics", url, label: host };
  record.syncedAt = new Date().toISOString();
  record.blocks = count;
  if (!existing) calendarSources.push(record);
  saveSources();
  field.value = "";
});

$("calendarSources").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-source]");
  if (!button) return;
  const [removed] = calendarSources.splice(Number(button.dataset.removeSource), 1);
  saveSources();
  if (removed) {
    delete myEvents[removed.type === "google" ? "google" : `ics:${removed.url}`];
    if (removed.type === "google") {
      clearGoogleToken();
      if (googleServer.connected) googleApi("DELETE").catch(() => {});
      googleServer.connected = false;
      renderGoogleState();
    }
    saveMyEvents();
    renderMyCalendar();
    schedulePublish();
    publishKindToGroup(removed.type === "google" ? "google" : "ics", syncRange(), { quiet: true });
  }
  showToast(removed?.type === "google" ? "Google Calendar disconnected." : "Calendar link removed from this device.");
});

$("syncCalendarButton").addEventListener("click", async () => {
  const icsSources = calendarSources.filter((source) => source.type === "ics");
  const hasGoogle = googleConnected();
  if (!icsSources.length && !hasGoogle) {
    renderSources();
    renderGoogleState();
    openDialog(dialogs.calendar);
    return;
  }
  const button = $("syncCalendarButton");
  button.disabled = true;
  button.innerHTML = `${svgIcon("sync")} Syncing…`;
  let total = 0;
  if (hasGoogle) total += (await syncGoogle({ silent: true })) || 0;
  for (const source of icsSources) {
    const count = await importIcs(source.url, { silent: true });
    if (count !== null) {
      source.syncedAt = new Date().toISOString();
      source.blocks = count;
      total += count;
    }
  }
  saveSources();
  button.disabled = false;
  button.innerHTML = `${svgIcon("sync")} Sync calendar`;
  showToast(`Synced ${total} busy block${total === 1 ? "" : "s"} for the next four weeks.`);
});

$("shareScheduleToggle").addEventListener("change", (event) => updateShareSchedule(event.target.checked));
$("profileShareSchedule").addEventListener("change", (event) => updateShareSchedule(event.target.checked));

async function updateShareSchedule(shared) {
  profile = { ...profile, shareSchedule: shared };
  writeJson(STORAGE.profile, profile);
  await mutate((draft) => {
    const member = draft.members.find((entry) => entry.id === memberId);
    if (member) {
      member.sharesSchedule = shared;
      member.updatedAt = new Date().toISOString();
    }
  });
  showToast(shared ? "Your groups can see when you're busy." : "Your times are hidden from your groups.");
}

/* Profile and account */

for (const button of [$("accountButton"), $("topAccountButton")]) {
  button.addEventListener("click", () => {
    $("profileDisplayName").value = profile.name || displayName();
    previewProfilePhoto(profile.photo);
    openDialog(dialogs.profile);
  });
}

$("openAccountFromProfile").addEventListener("click", () => {
  dialogs.profile.close();
  openDialog(dialogs.account);
});

function previewProfilePhoto(value) {
  const photo = safeImageUrl(value);
  $("profilePhotoUrl").value = photo;
  $("profilePhotoPreview").style.backgroundImage = photo ? `url("${photo}")` : "";
  $("profilePhotoPreview").textContent = photo ? "" : initialsFor($("profileDisplayName").value || displayName());
  $("removeProfilePhoto").hidden = !photo;
}

async function photoFileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const crop = squareCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = crop.size;
    canvas.height = crop.size;
    canvas.getContext("2d").drawImage(bitmap, crop.sx, crop.sy, crop.side, crop.side, 0, 0, crop.size, crop.size);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    bitmap.close?.();
  }
}

$("chooseProfilePhoto").addEventListener("click", () => $("profilePhotoFile").click());

$("profilePhotoFile").addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (!file) return;
  try {
    const dataUrl = await photoFileToDataUrl(file);
    if (!isSafeImageDataUrl(dataUrl)) throw new Error("too large");
    previewProfilePhoto(dataUrl);
  } catch {
    showToast("That photo couldn’t be read. Try a JPEG or PNG.");
  }
});

$("removeProfilePhoto").addEventListener("click", () => previewProfilePhoto(""));

$("profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("profileDisplayName").value.trim();
  profile = {
    ...profile,
    name,
    photo: $("profilePhotoUrl").value.trim(),
    shareSchedule: $("profileShareSchedule").checked,
  };
  writeJson(STORAGE.profile, profile);

  await mutate(
    (draft) => {
      const member = draft.members.find((entry) => entry.id === memberId);
      if (!member) return;
      member.name = name || member.name;
      member.initials = initialsFor(name || member.name);
      member.sharesSchedule = profile.shareSchedule;
      member.updatedAt = new Date().toISOString();
    },
    { note: `${name || "Someone"} updated their profile` }
  );

  if (supabaseClient && ui.user) {
    const { error } = await supabaseClient.from("profiles").upsert({
      id: ui.user.id,
      display_name: name || displayName(),
      photo_url: profile.photo || null,
      share_schedule: profile.shareSchedule,
      updated_at: new Date().toISOString(),
    });
    if (error) showToast("Profile saved. Run supabase/schema.sql to sync it to your account.");
  }
  dialogs.profile.close();
  showToast("Profile saved.");
});

$("googleSignInButton").addEventListener("click", async () => {
  if (!supabaseClient) {
    $("authNote").textContent = "Add your Supabase URL and publishable key to AUTH_CONFIG in app.js, then follow DEPLOY.md.";
    showToast("Google sign-in needs provider credentials first.");
    return;
  }
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${AUTH_CONFIG.redirectUrl}${session.slug === "weekend-crew" ? "" : `?w=${encodeURIComponent(session.slug)}`}` },
  });
  if (error) {
    $("authNote").textContent = `Google sign-in could not start: ${error.message}`;
    showToast("Google sign-in could not start.");
  }
});

$("gateSignIn").addEventListener("click", () => $("googleSignInButton").click());

$("signOutButton").addEventListener("click", async () => {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  clearGoogleToken();
  renderGoogleState();
  showToast("Signed out on this device.");
});

function renderAccount(user) {
  ui.user = user || null;
  bookingOwner?.reload();
  const signedIn = Boolean(user);
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || "Google account";
  $("accountStatus").textContent = signedIn ? "Signed in" : "Not signed in";
  $("accountStatusDetail").textContent = signedIn ? `${name} connected` : "Your local planner session is active.";
  $("accountStatusDot").style.background = signedIn ? "#64cf8b" : "#aaa7b5";
  $("googleSignInButton").hidden = signedIn;
  $("signOutButton").hidden = !signedIn;
  $("accountCopy").textContent = signedIn
    ? "Your availability follows this account between devices."
    : "Sign in to keep your groups and availability wherever you plan.";
  $("authNote").textContent = signedIn
    ? "Signed in with Google. Calendar access is only requested when you connect a calendar."
    : "Signing in links this planner to your Google account so your name and availability follow you between devices.";
  renderChrome();
}

/* Tentative plan */

function openPlanDialog() {
  const plan = session.state.plan;
  const audience = $("planAudience");
  audience.innerHTML = [session.state.name, ...session.state.members.map((member) => member.name)]
    .map((name) => `<option${plan?.audience === name ? " selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
  $("planActivity").value = plan?.activity || "";
  $("planLocation").value = plan?.location || "";
  const timing = document.querySelector(`input[name="timing"][value="${plan?.timing || "week"}"]`);
  if (timing) timing.checked = true;
  $("planStart").value = plan?.start || "";
  $("planEnd").value = plan?.end || "";
  $("dateRangeFields").hidden = plan?.timing !== "range";
  $("planWhen").hidden = !ui.pendingWindow;
  $("planWhen").textContent = ui.pendingWindow
    ? `${formatDayStamp(ui.pendingWindow.start)}, ${formatClock(ui.pendingWindow.start)} – ${formatClock(ui.pendingWindow.end)}`
    : "";
  $("planRepeat").innerHTML = REPEATS.map((entry) => `<option value="${entry.key}"${(plan?.repeat || "none") === entry.key ? " selected" : ""}>${entry.label}</option>`).join("");
  openDialog(dialogs.plan);
}

for (const button of [$("tentativePlanButton"), $("editTentativePlan")]) {
  button.addEventListener("click", () => {
    ui.pendingWindow = null;
    openPlanDialog();
  });
}
$("tentativePlanDialog").addEventListener("close", () => {
  ui.pendingWindow = null;
});

for (const input of document.querySelectorAll('input[name="timing"]')) {
  input.addEventListener("change", () => {
    const isRange = input.value === "range";
    $("dateRangeFields").hidden = !isRange;
    $("planStart").required = isRange;
    $("planEnd").required = isRange;
  });
}

$("tentativePlanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const plan = {
    // A stable id lets calendars recognise this plan again when it moves.
    id: session.state.plan?.id || createId("plan"),
    activity: String(form.get("activity") || "").trim(),
    location: String(form.get("location") || "").trim(),
    audience: String(form.get("audience") || session.state.name),
    timing: String(form.get("timing") || "week"),
    start: String(form.get("start") || ""),
    end: String(form.get("end") || ""),
    repeat: String(form.get("repeat") || "none"),
    updatedAt: new Date().toISOString(),
  };
  // Editing the plan keeps the picked time, votes and RSVPs.
  const previous = session.state.plan;
  if (previous) {
    for (const key of ["chosen", "chosenEnd", "timeZone", "timeVotes", "rsvp"]) {
      if (previous[key] !== undefined) plan[key] = previous[key];
    }
  }
  // Opened from "Plan something": that window becomes the plan's time.
  if (ui.pendingWindow) {
    plan.chosen = ui.pendingWindow.start.toISOString();
    plan.chosenEnd = ui.pendingWindow.end.toISOString();
    plan.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    ui.pendingWindow = null;
  }
  if (plan.timing === "range" && plan.start && plan.end && plan.end < plan.start) {
    showToast("The end of the range comes before the start.");
    return;
  }
  await mutate((draft) => {
    draft.plan = plan;
  }, { note: `Tentative plan: ${plan.activity}` });
  dialogs.plan.close();
  showToast("Tentative plan saved — suggested windows are below.");
});

$("rsvpRow").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-rsvp]");
  if (!button) return;
  const answer = button.dataset.rsvp;
  let result = null;
  await mutate((draft) => {
    const occurrence = draft.plan && nextOccurrence(draft.plan);
    if (!occurrence) return;
    draft.plan.rsvp = applyRsvp(draft.plan, occurrence, memberId, answer);
    result = draft.plan.rsvp.answers[memberId] || null;
  });
  showToast(result === "yes" ? "You’re going." : result === "maybe" ? "Marked as maybe." : result === "no" ? "Got it — you can’t make it." : "Answer cleared.");
});

$("removeTentativePlan").addEventListener("click", async () => {
  await mutate((draft) => {
    draft.plan = null;
  }, { note: "Tentative plan removed" });
  showToast("Tentative plan removed.");
});

$("tentativeSuggestions").addEventListener("click", async (event) => {
  const vote = event.target.closest("[data-vote-time]");
  if (vote) {
    const key = vote.dataset.voteTime;
    const adding = !(session.state.plan?.timeVotes?.[key] || []).includes(memberId);
    await mutate((draft) => {
      if (!draft.plan) return;
      draft.plan.timeVotes = toggleTimeVote(draft.plan.timeVotes, key, memberId);
    });
    showToast(adding ? "Vote added." : "Vote removed.");
    return;
  }
  const button = event.target.closest("[data-window]");
  if (!button) return;
  const chosen = new Date(Number(button.dataset.window));
  // A suggestion is the whole free stretch, which can be most of a day. The
  // event itself runs for the group's own "shortest window" setting, and never
  // past the end of the free stretch.
  const windowEnd = button.dataset.windowEnd ? Number(button.dataset.windowEnd) : null;
  const planLength = settings().minWindowHours * 3600 * 1000;
  const chosenEnd = new Date(Math.min(chosen.getTime() + planLength, windowEnd || Infinity));
  await mutate((draft) => {
    if (!draft.plan) return;
    draft.plan.id = draft.plan.id || createId("plan");
    draft.plan.chosen = chosen.toISOString();
    draft.plan.chosenEnd = chosenEnd.toISOString();
    draft.plan.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    draft.plan.updatedAt = new Date().toISOString();
  }, { note: `Pencilled in for ${formatDayStamp(chosen)} at ${formatClock(chosen)}` });
  showToast(`Pencilled in for ${formatDayStamp(chosen)} at ${formatClock(chosen)}.`);
});

/* People */

function renderSavedPeople() {
  $("inviteLink").value = inviteUrl();
  $("groupName").value = session.state.name;
  $("savedPeople").innerHTML = session.state.members
    .map(
      (member) => `<div class="saved-person"><span class="saved-person-icon">•</span><span>${escapeHtml(member.name)}</span><small>${member.id === memberId ? "You" : member.pending ? "Invited" : "Sharing"}</small>${
        member.id === memberId ? "" : `<button type="button" data-remove-member="${escapeAttribute(member.id)}" aria-label="Remove ${escapeAttribute(member.name)}">${svgIcon("x")}</button>`
      }</div>`
    )
    .join("");
  renderClaimPrompt();
  renderFriends();
}

/**
 * Somebody who opened an invite link without an account can say which pending
 * person they are, instead of adding themselves a second time.
 */
function renderClaimPrompt() {
  const container = $("savedPeople");
  const claimable = session.state.members.filter((member) => member.pending && member.id !== memberId);
  const existing = container.parentElement.querySelector(".claim-row");
  if (existing) existing.remove();
  if (!claimable.length) return;

  const row = document.createElement("div");
  row.className = "claim-row";
  row.innerHTML = `<span>Are you one of these people?</span>
    <select class="text-input" id="claimTarget">${claimable
      .map((member) => `<option value="${escapeAttribute(member.id)}">${escapeHtml(member.name)}</option>`)
      .join("")}</select>
    <button class="outline-button" type="button" id="claimInviteButton">That's me</button>`;
  container.after(row);
  $("claimInviteButton").addEventListener("click", () => claimInvite($("claimTarget").value));
}

/* ------------------------------------------------------------- friends */

async function loadFriends({ force = false } = {}) {
  if (!friendStore || !ui.user) {
    friends.rows = [];
    friends.profiles = {};
    friends.loaded = false;
    renderFriends();
    return;
  }
  if (friends.loaded && !force) return;
  const { data, error } = await friendStore.list();
  if (error) {
    friends.loaded = false;
    renderFriends(error.message);
    return;
  }
  friends.rows = data;
  const { data: profiles } = await friendStore.profiles(profileIdsFor(data));
  friends.profiles = profiles || {};
  friends.loaded = true;
  renderFriends();
  renderMyCalendar();
  schedulePublish();
}

function friendGroups() {
  return partitionRequests(friends.rows, { userId: ui.user?.id, email: ui.user?.email });
}

function friendRowMarkup(row, actions, { withStatus = false } = {}) {
  const party = describeParty(row, { userId: ui.user?.id, profiles: friends.profiles });
  const photo = safeImageUrl(party.photo);
  const status = withStatus ? statusLine(party.id) : null;
  return `<div class="friend-row">
    <div class="avatar avatar-lilac${status?.kind === "free-now" ? " is-free" : ""}"${photo ? ` style="background-image:url(&quot;${escapeAttribute(photo)}&quot;);background-size:cover;background-position:center"` : ""}>${photo ? "" : escapeHtml(initialsFor(party.name))}</div>
    <div><strong>${escapeHtml(party.name)}</strong><small>${escapeHtml(party.pendingSignup ? "Waiting for them to sign in" : party.email || "")}</small>${
      status ? `<small class="friend-status ${status.kind}">${escapeHtml(status.text)}</small>` : ""
    }</div>
    <div class="friend-actions">${actions}</div>
  </div>`;
}

function renderFriends(errorMessage) {
  const signedIn = Boolean(friendStore && ui.user);
  $("friendsSignedOut").hidden = signedIn;
  $("friendsSignedIn").hidden = !signedIn;
  if (!signedIn) {
    $("friendBadge").hidden = true;
    return;
  }

  const { incoming, outgoing, friends: accepted } = friendGroups();

  $("incomingSection").hidden = !incoming.length;
  $("incomingList").innerHTML = incoming
    .map((row) =>
      friendRowMarkup(
        row,
        `<button type="button" class="accept" data-accept="${escapeAttribute(row.id)}">Accept</button><button type="button" class="quiet" data-decline="${escapeAttribute(row.id)}">Decline</button>`
      )
    )
    .join("");

  $("outgoingSection").hidden = !outgoing.length;
  $("outgoingList").innerHTML = outgoing
    .map((row) => friendRowMarkup(row, `<button type="button" class="quiet" data-withdraw="${escapeAttribute(row.id)}">Withdraw</button>`))
    .join("");

  $("friendList").innerHTML = accepted.length
    ? accepted
        .map((row) => {
          const party = describeParty(row, { userId: ui.user?.id, profiles: friends.profiles });
          const match = findMemberForParty(session.state.members, party);
          // A row matched only by name is probably them, but nothing proves it
          // yet — offer to link it rather than silently adding a second copy.
          const linked = match && party.id && match.userId === party.id;
          const action = linked
            ? `<button type="button" disabled>In this group</button>`
            : match
              ? `<button type="button" data-add-friend="${escapeAttribute(row.id)}">Link to them</button>`
              : `<button type="button" data-add-friend="${escapeAttribute(row.id)}">Add to group</button>`;
          const calendar = party.id
            ? `<button type="button" class="quiet" data-view-calendar="${escapeAttribute(party.id)}" data-friend-name="${escapeAttribute(party.name)}">Calendar</button>`
            : "";
          return friendRowMarkup(row, calendar + action, { withStatus: true });
        })
        .join("")
    : `<p class="form-hint">${escapeHtml(errorMessage || "No friends yet. Send a request above, or just share the invite link.")}</p>`;

  renderStatusCard();
  $("friendBadge").textContent = String(incoming.length);
  $("friendBadge").hidden = incoming.length === 0;
  $("friendsTab").textContent = incoming.length ? `Friends (${incoming.length})` : "Friends";
}

$("friendsSignInButton").addEventListener("click", () => {
  dialogs.people.close();
  openDialog(dialogs.account);
});

$("friendRequestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!friendStore || !ui.user || friends.busy) return;
  const field = $("friendRequestEmail");
  const reason = rejectionFor(field.value, { email: ui.user.email, rows: friends.rows.filter((row) => row.requester_id === ui.user.id) });
  if (reason) {
    showToast(reason);
    return;
  }
  friends.busy = true;
  const button = $("sendFriendRequest");
  button.disabled = true;
  const { error } = await friendStore.send({
    requesterId: ui.user.id,
    email: field.value,
    note: `${displayName()} wants to plan with you on Waddle.`,
  });
  friends.busy = false;
  button.disabled = false;
  if (error) {
    showToast(friendError(error));
    return;
  }
  field.value = "";
  await loadFriends({ force: true });
  showToast("Friend request sent.");
});

function friendError(error) {
  const message = String(error?.message || "");
  if (/duplicate key|friend_requests_live_pair/i.test(message)) return "You already have a request waiting for them.";
  if (/row-level security|permission/i.test(message)) return "Run supabase/schema.sql to enable friend requests.";
  if (/relation .* does not exist|friend_requests/i.test(message)) return "Friend requests need the latest supabase/schema.sql.";
  return "That did not go through. Try again in a moment.";
}

$("friendsPanel").addEventListener("click", (event) => {
  const view = event.target.closest("[data-view-calendar]");
  if (!view || !shareStore || !ui.user) return;
  dialogs.people.close();
  openFriendCalendar(view.dataset.viewCalendar, view.dataset.friendName || "Your friend");
});

$("friendsPanel").addEventListener("click", async (event) => {
  const target = event.target.closest("[data-accept], [data-decline], [data-withdraw], [data-add-friend]");
  if (!target || !friendStore || !ui.user || friends.busy) return;
  friends.busy = true;
  target.disabled = true;

  const { accept, decline, withdraw, addFriend } = target.dataset;
  let error = null;
  if (accept || decline) {
    ({ error } = await friendStore.respond({ id: accept || decline, accept: Boolean(accept), userId: ui.user.id }));
  } else if (withdraw) {
    ({ error } = await friendStore.withdraw(withdraw));
  } else if (addFriend) {
    await addFriendToGroup(addFriend);
  }

  friends.busy = false;
  if (error) {
    target.disabled = false;
    showToast(friendError(error));
    return;
  }
  if (!addFriend) await loadFriends({ force: true });
  if (accept) showToast("You're now friends.");
  else if (decline) showToast("Request declined.");
  else if (withdraw) showToast("Request withdrawn.");
});

/** Puts a friend in this workspace as a pending member they can claim. */
async function addFriendToGroup(rowId) {
  const row = friends.rows.find((entry) => entry.id === rowId);
  if (!row) return;
  const party = describeParty(row, { userId: ui.user?.id, profiles: friends.profiles });
  const existing = findMemberForParty(session.state.members, party);
  await mutate(
    (draft) => {
      const already = findMemberForParty(draft.members, party);
      if (already) {
        // Somebody already added them by hand: link that row to the account
        // rather than leaving two copies of the same person in the group.
        linkMemberToParty(already, party);
        return;
      }
      draft.members.push({
        id: createId("member"),
        name: party.name,
        initials: initialsFor(party.name),
        palette: AVATAR_PALETTES[draft.members.length % AVATAR_PALETTES.length],
        ...(party.id ? { userId: party.id } : {}),
        ...(party.email ? { email: normalizeEmail(party.email) } : {}),
        pending: true,
        weekly: [],
        busy: [],
        updatedAt: new Date().toISOString(),
      });
    },
    { note: `${party.name} was added` }
  );
  renderSavedPeople();
  showToast(
    existing
      ? `${existing.name} was already here — now linked to their account.`
      : `${party.name} added — they'll see this group when they sign in.`
  );
}

$("managePeople").addEventListener("click", () => {
  renderSavedPeople();
  openDialog(dialogs.people);
});

for (const tab of document.querySelectorAll(".people-tab")) {
  tab.addEventListener("click", () => {
    for (const item of document.querySelectorAll(".people-tab")) item.classList.remove("active");
    tab.classList.add("active");
    $("friendForm").hidden = tab.dataset.peopleTab !== "friend";
    $("friendsPanel").hidden = tab.dataset.peopleTab !== "friends";
    $("groupForm").hidden = tab.dataset.peopleTab !== "group";
    if (tab.dataset.peopleTab === "friends") loadFriends();
  });
}

$("friendForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("friendName").value.trim();
  const email = $("friendEmail").value.trim();
  if (!name) return;
  const clash = session.state.members.find(
    (member) =>
      member.name.toLowerCase() === name.toLowerCase() ||
      (email && normalizeEmail(member.email) === normalizeEmail(email))
  );
  if (clash) {
    showToast(`${clash.name} is already in this group.`);
    return;
  }
  await mutate(
    (draft) => {
      draft.members.push({
        id: createId("member"),
        name,
        initials: initialsFor(name),
        palette: AVATAR_PALETTES[draft.members.length % AVATAR_PALETTES.length],
        ...(email ? { email } : {}),
        pending: true,
        weekly: [],
        busy: [],
        updatedAt: new Date().toISOString(),
      });
    },
    { note: `${name} was added` }
  );
  event.target.reset();
  renderSavedPeople();
  await shareInvite(`${name} added.`);
});

$("groupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("groupName").value.trim();
  if (!name) return;
  await mutate((draft) => {
    draft.name = name;
  }, { note: `Group renamed to ${name}` });
  renderSavedPeople();
  showToast("Group name saved.");
});

async function removeMember(id) {
  const member = session.state.members.find((entry) => entry.id === id);
  if (!member || id === memberId) return;
  await mutate(
    (draft) => {
      draft.members = draft.members.filter((entry) => entry.id !== id);
      for (const idea of draft.ideas) idea.votes = idea.votes.filter((vote) => vote !== id);
    },
    { note: `${member.name} was removed` }
  );
  renderSavedPeople();
  showToast(`${member.name} removed from this group.`);
}

$("savedPeople").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-member]");
  if (button) removeMember(button.dataset.removeMember);
});

$("peopleGrid").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove-member]");
  if (remove) {
    removeMember(remove.dataset.removeMember);
    return;
  }
  if (event.target.closest("#addPerson")) {
    renderSavedPeople();
    openDialog(dialogs.people);
  }
});

$("peopleGrid").addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.closest("#addPerson")) {
    event.preventDefault();
    renderSavedPeople();
    openDialog(dialogs.people);
  }
});

/* Ideas */

function openIdeaDialog(idea) {
  ui.editingIdeaId = idea?.id || null;
  $("ideaDialogEyebrow").textContent = idea ? "EDIT IDEA" : "NEW IDEA";
  $("ideaDialogTitle").textContent = idea ? "Tweak this idea." : "What sounds good?";
  $("ideaTitle").value = idea?.title || "";
  $("ideaDescription").value = idea?.description || "";
  $("ideaLocation").value = idea?.location || "";
  $("ideaTag").value = idea?.tag || "";
  $("ideaStyle").innerHTML = IDEA_STYLES.map(
    (style) => `<option value="${style.key}"${idea?.style === style.key ? " selected" : ""}>${style.emoji} ${style.key}</option>`
  ).join("");
  previewIdeaPhoto(idea?.photo);
  $("ideaSubmit").textContent = idea ? "Save idea" : "Add idea";
  $("deleteIdea").hidden = !idea;
  openDialog(dialogs.idea);
}

$("addIdea").addEventListener("click", () => openIdeaDialog(null));

function previewIdeaPhoto(value) {
  const photo = isSafeImageDataUrl(value, IDEA_PHOTO_MAX_LENGTH) ? value : "";
  $("ideaPhotoData").value = photo;
  $("ideaPhotoPreview").style.backgroundImage = photo ? `url("${photo}")` : "";
  $("ideaPhotoPreview").classList.toggle("has-photo", Boolean(photo));
  $("chooseIdeaPhotoLabel").textContent = photo ? "Change photo" : "Choose photo";
  $("removeIdeaPhoto").hidden = !photo;
}

/**
 * Crops to a 16:10 cover, scales to at most 720x450 and encodes as JPEG,
 * stepping the quality down until it fits the idea-photo cap. Returns "" when
 * even the lowest quality is too big.
 */
async function ideaPhotoFileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const crop = coverCrop(bitmap.width, bitmap.height, IDEA_PHOTO_WIDTH, IDEA_PHOTO_HEIGHT);
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext("2d");
    // JPEG has no transparency: see-through PNGs get a paper background, not black.
    context.fillStyle = "#fffcf8";
    context.fillRect(0, 0, crop.width, crop.height);
    context.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height);
    for (const quality of [0.75, 0.6, 0.5]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (isSafeImageDataUrl(dataUrl, IDEA_PHOTO_MAX_LENGTH)) return dataUrl;
    }
    return "";
  } finally {
    bitmap.close?.();
  }
}

$("chooseIdeaPhoto").addEventListener("click", () => $("ideaPhotoFile").click());

$("ideaPhotoFile").addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  event.target.value = "";
  if (!file) return;
  let dataUrl;
  try {
    dataUrl = await ideaPhotoFileToDataUrl(file);
  } catch {
    showToast("That photo couldn’t be read. Try a JPEG or PNG.");
    return;
  }
  if (!dataUrl) {
    showToast("That photo is too detailed to fit. Try a different one.");
    return;
  }
  previewIdeaPhoto(dataUrl);
});

$("removeIdeaPhoto").addEventListener("click", () => previewIdeaPhoto(""));

$("ideaForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = {
    title: $("ideaTitle").value.trim(),
    description: $("ideaDescription").value.trim(),
    location: $("ideaLocation").value.trim(),
    tag: $("ideaTag").value.trim().toUpperCase(),
    style: $("ideaStyle").value,
  };
  if (!fields.title) return;
  const photo = $("ideaPhotoData").value;
  const editingId = ui.editingIdeaId;
  const apply = (draft) => {
    if (editingId) {
      const idea = draft.ideas.find((entry) => entry.id === editingId);
      if (!idea) return;
      Object.assign(idea, fields);
      if (photo) idea.photo = photo;
      else delete idea.photo;
      return;
    }
    draft.ideas.push({ ...fields, ...(photo ? { photo } : {}), id: createId("idea"), votes: [memberId], createdAt: new Date().toISOString() });
  };
  // Checked here too so the dialog, and the chosen photo, stay open.
  if (!nextStateFrom(session.state, apply)) {
    showToast(TOO_LARGE_MESSAGE);
    return;
  }
  await mutate(apply, { note: editingId ? `Idea updated: ${fields.title}` : `New idea: ${fields.title}` });
  dialogs.idea.close();
  showToast(editingId ? "Idea updated." : "Idea added — your vote is on it.");
});

$("deleteIdea").addEventListener("click", async () => {
  const id = ui.editingIdeaId;
  if (!id) return;
  const idea = session.state.ideas.find((entry) => entry.id === id);
  await mutate((draft) => {
    draft.ideas = draft.ideas.filter((entry) => entry.id !== id);
  }, { note: `Idea removed: ${idea?.title || ""}` });
  dialogs.idea.close();
  showToast("Idea removed.");
});

$("ideaGrid").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-idea]");
  if (edit) {
    openIdeaDialog(session.state.ideas.find((idea) => idea.id === edit.dataset.editIdea));
    return;
  }
  const planIdea = event.target.closest("[data-plan-idea]");
  if (planIdea) {
    const idea = session.state.ideas.find((entry) => entry.id === planIdea.dataset.planIdea);
    if (!idea) return;
    openPlanDialog();
    $("planActivity").value = idea.title;
    $("planLocation").value = idea.location || "";
    return;
  }
  const vote = event.target.closest("[data-vote-idea]");
  if (!vote) return;
  const id = vote.dataset.voteIdea;
  const idea = session.state.ideas.find((entry) => entry.id === id);
  const adding = !hasVoted(idea, memberId);
  await mutate((draft) => {
    const target = draft.ideas.find((entry) => entry.id === id);
    if (!target) return;
    target.votes = adding
      ? [...new Set([...target.votes, memberId])]
      : target.votes.filter((entry) => entry !== memberId);
  });
  showToast(adding ? "Vote added." : "Vote removed.");
});

/* Settings */

const hourOptions = (selected) =>
  Array.from({ length: 25 }, (_, hour) => `<option value="${hour}"${hour === selected ? " selected" : ""}>${hour === 24 ? "Midnight" : formatHour(hour)}</option>`).join("");

/* Colour palette (per device) */

function currentPalette() {
  try {
    return normalizePalette(window.localStorage.getItem(STORAGE.palette));
  } catch {
    return normalizePalette(null);
  }
}

function applyPalette(id) {
  const palette = normalizePalette(id);
  document.documentElement.dataset.palette = palette;
  try {
    window.localStorage.setItem(STORAGE.palette, palette);
  } catch {
    /* Private mode: the choice lasts for this visit only. */
  }
  for (const swatch of $("palettePicker").children) swatch.setAttribute("aria-checked", String(swatch.dataset.palette === palette));
}

$("palettePicker").innerHTML = PALETTES.map(
  (palette) => `<button type="button" class="palette-swatch" role="radio" aria-checked="false" data-palette="${palette.id}"><i style="background:${palette.color}"></i>${escapeHtml(palette.name)}</button>`
).join("");
$("palettePicker").addEventListener("click", (event) => {
  const swatch = event.target.closest("[data-palette]");
  if (swatch) applyPalette(swatch.dataset.palette);
});
applyPalette(currentPalette());

/* Appearance (per device): Auto follows the system setting, Light and Dark force it. */

const systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let appearance = currentAppearance();

function currentAppearance() {
  try {
    return normalizeAppearance(window.localStorage.getItem(STORAGE.appearance));
  } catch {
    return normalizeAppearance(null);
  }
}

function paintTheme() {
  const theme = resolveTheme(appearance, Boolean(systemDark?.matches));
  document.documentElement.dataset.theme = theme;
  document.querySelector("meta[name=theme-color]")?.setAttribute("content", THEME_COLORS[theme]);
}

function applyAppearance(id, { animate = false } = {}) {
  appearance = normalizeAppearance(id);
  try {
    window.localStorage.setItem(STORAGE.appearance, appearance);
  } catch {
    /* Private mode: the choice lasts for this visit only. */
  }
  for (const option of $("appearancePicker").children) option.setAttribute("aria-checked", String(option.dataset.appearance === appearance));
  const changes = resolveTheme(appearance, Boolean(systemDark?.matches)) !== document.documentElement.dataset.theme;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (animate && changes && !calm && document.startViewTransition) document.startViewTransition(paintTheme);
  else paintTheme();
}

$("appearancePicker").innerHTML = APPEARANCES.map(
  (option) => `<button type="button" class="palette-swatch" role="radio" aria-checked="false" data-appearance="${option.id}"><i><svg class="icon" aria-hidden="true"><use href="#${option.icon}"/></svg></i>${escapeHtml(option.name)}</button>`
).join("");
$("appearancePicker").addEventListener("click", (event) => {
  const option = event.target.closest("[data-appearance]");
  if (option) applyAppearance(option.dataset.appearance, { animate: true });
});
systemDark?.addEventListener?.("change", paintTheme);
applyAppearance(appearance);

$("settingsButton").addEventListener("click", () => {
  const config = settings();
  $("settingWorkspaceName").value = session.state.name;
  $("settingWeekStart").value = String(config.weekStartsOn);
  $("settingMinWindow").innerHTML = [1, 2, 3, 4, 6]
    .map((hours) => `<option value="${hours}"${hours === config.minWindowHours ? " selected" : ""}>${hours} hour${hours === 1 ? "" : "s"}</option>`)
    .join("");
  $("settingDayStart").innerHTML = hourOptions(config.dayStart);
  $("settingDayEnd").innerHTML = hourOptions(config.dayEnd);
  $("settingLocked").checked = config.locked;
  $("settingLocked").disabled = !ui.user;
  $("lockHint").textContent = ui.user
    ? "Locked workspaces accept edits from you and any signed-in member."
    : "Sign in with Google first — locking needs an account so you do not lock yourself out.";
  $("timezoneNote").textContent = `Times are shown in ${timeZoneLabel()} (${timeZoneOffsetLabel()}). Workspace link: ${inviteUrl()}`;
  openDialog(dialogs.settings);
});

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dayStart = Number($("settingDayStart").value);
  const dayEnd = Number($("settingDayEnd").value);
  if (dayEnd <= dayStart) {
    showToast("The day has to end after it starts.");
    return;
  }
  const name = $("settingWorkspaceName").value.trim() || session.state.name;
  const locked = $("settingLocked").checked && Boolean(ui.user);
  await mutate(
    (draft) => {
      draft.name = name;
      draft.settings = {
        weekStartsOn: Number($("settingWeekStart").value),
        dayStart,
        dayEnd,
        minWindowHours: Number($("settingMinWindow").value),
        locked,
      };
      if (locked && ui.user) {
        draft.ownerId = draft.ownerId || ui.user.id;
        const member = draft.members.find((entry) => entry.id === memberId);
        if (member) member.userId = ui.user.id;
      }
    },
    { note: "Settings updated" }
  );
  dialogs.settings.close();
  showToast("Settings saved.");
});

$("exportWorkspace").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ slug: session.slug, ...session.state }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${session.slug}-waddle.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Workspace exported.");
});

$("resetLocal").addEventListener("click", () => {
  for (const key of [STORAGE.cache(session.slug), STORAGE.member, STORAGE.profile, STORAGE.sources, STORAGE.seen(session.slug)]) {
    window.localStorage.removeItem(key);
  }
  clearGoogleToken();
  showToast("This device is reset. Reloading…");
  window.setTimeout(() => window.location.reload(), 900);
});

/* Activity */

$("activityButton").addEventListener("click", () => {
  const entries = session.state.activity;
  $("activityList").innerHTML = entries.length
    ? entries
        .map((entry) => `<div class="activity-row"><strong>${escapeHtml(entry.message)}</strong><small>${escapeHtml(formatRelative(entry.at))}</small></div>`)
        .join("")
    : '<p class="form-hint">Nothing has changed yet.</p>';
  if (entries[0]) window.localStorage.setItem(STORAGE.seen(session.slug), entries[0].at);
  renderActivityBadge();
  openDialog(dialogs.activity);
});

/* My calendar and who sees what */

/** Small stable fingerprint, so an unchanged share is not re-uploaded. */
function fingerprint(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return `${text.length}:${hash >>> 0}`;
}

/** Saves your choices here, and (signed in) to your account so other devices get them. */
function saveSharing(next, { stamp = true } = {}) {
  sharing = normalizeSharing(stamp ? { ...next, updatedAt: new Date().toISOString() } : next);
  writeJson(STORAGE.sharing, sharing);
  if (stamp) scheduleSharingUpload();
}

let sharingUploadTimer = null;
function scheduleSharingUpload() {
  clearTimeout(sharingUploadTimer);
  sharingUploadTimer = setTimeout(uploadSharing, 800);
}

async function uploadSharing() {
  if (!sharingSettingsStore || !ui.user || !sharing.updatedAt) return;
  const { error } = await sharingSettingsStore.save(ui.user.id, sharing);
  if (error) console.warn("Sharing choices not synced:", error.message);
}

/**
 * Brings this device and your account into line: whichever copy was saved
 * last wins, and everything published from it is refreshed.
 */
async function loadRemoteSharing() {
  if (!sharingSettingsStore || !ui.user) return;
  const { data, error } = await sharingSettingsStore.load(ui.user.id);
  if (error) return;
  const remote = data ? { ...data.settings, updatedAt: data.settings?.updatedAt || data.updated_at } : null;
  const { sharing: merged, from } = mergeSharing(sharing, remote);
  if (from === "local") {
    if (sharing.updatedAt && remote?.updatedAt !== sharing.updatedAt) uploadSharing();
    return;
  }
  const hiddenChanged = JSON.stringify(merged.hidden) !== JSON.stringify(sharing.hidden) || merged.salt !== sharing.salt;
  const changed = JSON.stringify(merged) !== JSON.stringify(sharing);
  saveSharing(merged, { stamp: false });
  if (!changed) return;
  await refreshHiddenKeys();
  renderMyCalendar();
  schedulePublish();
  if (hiddenChanged || session.state.privacy === "details") await republishToGroup();
}

async function refreshHiddenKeys() {
  hiddenKeys = await resolveHidden(sharing, allMyEvents().map((event) => event.title));
  return hiddenKeys;
}

function acceptedFriends() {
  if (!ui.user || !friends.loaded) return [];
  return friendGroups()
    .friends.map((row) => ({ row, party: describeParty(row, { userId: ui.user.id, profiles: friends.profiles }) }))
    .filter((entry) => entry.party.id);
}

let publishTimer = null;
function schedulePublish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishToFriends();
    // Your booking link keeps the same busy times closed (times only).
    bookingOwner?.publishBusy();
  }, 600);
}

/**
 * Gives each friend exactly what their level allows: one row per friend,
 * rewritten only when it changes, and deleted for anyone set to "Nothing".
 */
let grantTimer = null;

async function publishToFriends() {
  if (!shareStore || !ui.user || !friends.loaded) return;
  const ownerId = ui.user.id;
  const published = readJson(STORAGE.published, {});
  const mine = published[ownerId] || {};
  await refreshHiddenKeys();
  const events = withoutHidden(allMyEvents(), hiddenKeys);
  const now = new Date();
  let failed = false;
  for (const { party } of acceptedFriends()) {
    // A temporary share sends the fuller view plus what they fall back to;
    // the database switches between them on time.
    const grant = activeGrant(sharing, party.id, now);
    const base = eventsForLevel(events, baseLevelForFriend(sharing, party.id), sharing);
    const payload = grant ? eventsForLevel(events, grant.level, sharing) : base;
    const options = grant ? { fallback: base, expires: grant.until } : {};
    const print = payload === null ? "none" : fingerprint(JSON.stringify([payload, options]));
    if (mine[party.id] === print) continue;
    const { error } = payload === null ? await shareStore.revoke(ownerId, party.id) : await shareStore.publish(party.id, payload, options);
    if (error) {
      failed = true;
      continue;
    }
    mine[party.id] = print;
  }
  published[ownerId] = mine;
  writeJson(STORAGE.published, published);
  if (failed) showToast("Some friends' calendar views could not be updated. They'll retry next time.");

  // Tidy up when the next temporary share ends (the database already stopped showing it).
  clearTimeout(grantTimer);
  const next = Math.min(...sharing.grants.map((grant) => new Date(grant.until).getTime()).filter((time) => time > Date.now()));
  if (Number.isFinite(next)) {
    grantTimer = setTimeout(() => {
      saveSharing(sharing, { stamp: false });
      renderMyCalendar();
      schedulePublish();
    }, Math.min(next - Date.now() + 1000, 2 ** 31 - 1));
  }
}

function myWeek() {
  const base = startOfWeek(addDays(new Date(), ui.myWeekOffset * 7), settings().weekStartsOn);
  return buildWeek(base, { today: new Date() });
}

function eventTimeLabel(event, day) {
  if (event.allDay) return "All day";
  const start = new Date(event.start);
  const end = new Date(event.end);
  const dayStart = new Date(day.date);
  dayStart.setHours(0, 0, 0, 0);
  const startsToday = start >= dayStart;
  const endsToday = end <= addDays(dayStart, 1);
  if (!startsToday && !endsToday) return "All day";
  if (!startsToday) return `Until ${formatClock(end)}`;
  if (!endsToday) return `From ${formatClock(start)}`;
  return `${formatClock(start)} – ${formatClock(end)}`;
}

/** The level the "Preview as" picker stands for, or null for your own view. */
function previewLevel() {
  const choice = ui.previewAs;
  if (choice === "me") return null;
  if (choice === "friends") return sharing.friends;
  if (choice === "groups") return session.state.privacy === "details" ? sharing.groups : "busy";
  return levelForFriend(sharing, choice);
}

function agendaMarkup(week, events, { owner = true, emptyText }) {
  return week
    .map((day) => {
      const dayEvents = eventsOnDay(events, day.date);
      const items = dayEvents.length
        ? dayEvents
            .map((event) => {
              const title = event.title || "Busy";
              const time = eventTimeLabel(event, day);
              if (!owner || !event.title) {
                return `<li class="agenda-event${event.title ? "" : " is-busy"}"><span class="agenda-time">${escapeHtml(time)}</span><strong>${escapeHtml(title)}</strong></li>`;
              }
              const picked = isPicked(sharing, event.title);
              const hidden = isHidden(hiddenKeys, event.title);
              const state = hidden ? "Private: hidden from everyone" : picked ? "Picked to share" : "Tap to pick";
              return `<li class="agenda-row${hidden ? " is-private" : ""}"><button type="button" class="agenda-event${picked && !hidden ? " is-picked" : ""}" data-pick-title="${escapeAttribute(event.title)}" aria-pressed="${picked}"${hidden ? " disabled" : ""}>
                <span class="agenda-time">${escapeHtml(time)}</span><strong>${escapeHtml(title)}</strong>
                <span class="pick-state">${state}</span></button>
                <button type="button" class="agenda-private" data-private-title="${escapeAttribute(event.title)}" aria-pressed="${hidden}" title="${hidden ? "Make visible again" : "Make private: hide from everyone"}" aria-label="${hidden ? "Make visible again" : "Make private"}: ${escapeAttribute(event.title)}">${svgIcon("lock")}</button></li>`;
            })
            .join("")
        : `<li class="agenda-empty">${escapeHtml(emptyText)}</li>`;
      return `<div class="agenda-day${day.isToday ? " today" : ""}"><div class="agenda-date"><small>${day.label}</small><strong>${day.dayOfMonth}</strong></div><ul>${items}</ul></div>`;
    })
    .join("");
}

function renderPreviewOptions() {
  const select = $("mycalPreview");
  const options = [
    ["me", "Just me (everything)"],
    ["friends", `Any friend (${LEVEL_LABELS[sharing.friends]})`],
    ["groups", "People in this group"],
    ...acceptedFriends().map(({ party }) => [party.id, party.name]),
  ];
  if (!options.some(([value]) => value === ui.previewAs)) ui.previewAs = "me";
  select.innerHTML = options
    .map(([value, label]) => `<option value="${escapeAttribute(value)}"${value === ui.previewAs ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function renderMyCalendar() {
  if (!$("myAgenda")) return;
  renderPreviewOptions();
  const week = myWeek();
  $("myWeekLabel").textContent = formatWeekLabel(week[0].date, week.length);
  $("myThisWeek").hidden = ui.myWeekOffset === 0;

  const events = allMyEvents();
  const level = previewLevel();
  const agenda = $("myAgenda");
  const summary = $("mycalSummary");

  if (!Object.keys(myEvents).length) {
    summary.textContent = "";
    agenda.innerHTML = `<div class="agenda-blank"><strong>Connect a calendar to see it here.</strong><p>Your events show up with their names — only you see those. You decide below what friends and groups get.</p><button class="primary-button small" type="button" data-open-calendars>Connect a calendar</button></div>`;
    return;
  }

  if (level === null) {
    const pickedCount = sharing.picked.length;
    summary.innerHTML = `Friends see: <strong>${escapeHtml(LEVEL_LABELS[sharing.friends])}</strong>${
      Object.keys(sharing.perFriend).length ? ` · ${Object.keys(sharing.perFriend).length} set individually` : ""
    } · ${pickedCount} event name${pickedCount === 1 ? "" : "s"} picked to share. Tap an event to pick or unpick it.`;
    agenda.innerHTML = agendaMarkup(week, events, { owner: true, emptyText: "Nothing on" });
    return;
  }

  if (level === "nothing") {
    summary.textContent = "";
    agenda.innerHTML = `<div class="agenda-blank"><strong>They can't see your calendar at all.</strong><p>In a group you share, they still see when you're busy, because that's how the group finds a time.</p></div>`;
    return;
  }
  const visible = eventsForLevel(withoutHidden(events, hiddenKeys), level, sharing);
  summary.innerHTML = `Previewing as they see it: <strong>${escapeHtml(LEVEL_LABELS[level])}</strong>.`;
  agenda.innerHTML = agendaMarkup(week, visible, { owner: false, emptyText: "Free" });
}

$("myPrevWeek").addEventListener("click", () => {
  ui.myWeekOffset -= 1;
  renderMyCalendar();
});
$("myNextWeek").addEventListener("click", () => {
  ui.myWeekOffset += 1;
  renderMyCalendar();
});
$("myThisWeek").addEventListener("click", () => {
  ui.myWeekOffset = 0;
  renderMyCalendar();
});
$("mycalPreview").addEventListener("change", (event) => {
  ui.previewAs = event.target.value;
  renderMyCalendar();
});

$("myAgenda").addEventListener("click", async (event) => {
  if (event.target.closest("[data-open-calendars]")) {
    openDialog(dialogs.calendar);
    return;
  }
  const privateButton = event.target.closest("[data-private-title]");
  if (privateButton) {
    const title = privateButton.dataset.privateTitle;
    const wasHidden = isHidden(hiddenKeys, title);
    saveSharing(await toggleHidden(sharing, title));
    await refreshHiddenKeys();
    renderMyCalendar();
    schedulePublish();
    await republishToGroup();
    showToast(wasHidden ? `"${title}" is visible again, as your sharing settings allow.` : `"${title}" is private: nobody sees it, not even as busy.`);
    return;
  }
  const button = event.target.closest("[data-pick-title]");
  if (!button) return;
  const title = button.dataset.pickTitle;
  const wasPicked = isPicked(sharing, title);
  saveSharing(togglePicked(sharing, title));
  renderMyCalendar();
  schedulePublish();
  if (session.state.privacy === "details" && sharing.groups === "some") await republishToGroup();
  showToast(wasPicked ? `"${title}" will show as Busy.` : `"${title}" can be seen by anyone set to "Only events I pick".`);
});

function levelOptions(levels, selected, { defaultLabel } = {}) {
  const options = defaultLabel ? [`<option value=""${selected ? "" : " selected"}>${escapeHtml(defaultLabel)}</option>`] : [];
  for (const level of levels) {
    options.push(`<option value="${level}"${level === selected ? " selected" : ""}>${escapeHtml(LEVEL_LABELS[level])}</option>`);
  }
  return options.join("");
}

function renderSharingDialog() {
  $("shareFriendsDefault").innerHTML = levelOptions(LEVELS, sharing.friends);
  $("shareGroups").innerHTML = levelOptions(GROUP_LEVELS, sharing.groups);
  $("shareGroupsHint").textContent =
    session.state.privacy === "details"
      ? "This group allows event names, so this choice applies here."
      : "This group is set to busy/free only, so it sees no names whatever you pick. Anyone in the group can change that under Privacy.";

  const list = acceptedFriends();
  $("shareSignedOut").hidden = Boolean(ui.user);
  $("shareFriendList").innerHTML = !ui.user
    ? ""
    : list.length
      ? list
          .map(
            ({ party }) => `<div class="share-friend"><label class="share-friend-row"><span>${escapeHtml(party.name)}</span>
              <select class="text-input" data-share-friend="${escapeAttribute(party.id)}">${levelOptions(LEVELS, sharing.perFriend[party.id] || "", {
                defaultLabel: `Default (${LEVEL_LABELS[sharing.friends]})`,
              })}</select></label>
              <div class="share-grant" data-grant-slot="${escapeAttribute(party.id)}">${grantSlotMarkup(party)}</div></div>`
          )
          .join("")
      : '<p class="form-hint">No friends yet. Add them under Manage people → Friends.</p>';

  $("sharePickedList").innerHTML = sharing.picked.length
    ? sharing.picked
        .map((key) => `<button type="button" class="share-picked-chip" data-unpick="${escapeAttribute(key)}">${escapeHtml(key)} <span aria-hidden="true">×</span></button>`)
        .join("")
    : '<p class="form-hint">None yet. Tap an event in Your calendar to pick it.</p>';

  const privateNames = [...new Set(allMyEvents().filter((event) => isHidden(hiddenKeys, event.title)).map((event) => event.title))];
  const elsewhere = Math.max(0, sharing.hidden.length - hiddenKeys.size);
  $("sharePrivateList").innerHTML =
    privateNames
      .map((title) => `<button type="button" class="share-picked-chip is-private" data-unhide="${escapeAttribute(title)}">${svgIcon("lock")} ${escapeHtml(title)} <span aria-hidden="true">×</span></button>`)
      .join("") +
    (elsewhere ? `<p class="form-hint">${elsewhere} more not in the calendars on this device.</p>` : "") ||
    '<p class="form-hint">None. Tap the lock on an event in Your calendar to make it private.</p>';
  $("shareSyncNote").textContent = ui.user
    ? "These choices follow you to any device you sign in on."
    : "Sign in and these choices follow you to your other devices.";
}

const whenLabel = (date) => `${formatDayStamp(date)}, ${formatClock(date)}`;

/** A friend's "for a while" control: the running share, or the form to start one. */
function grantSlotMarkup(party) {
  const grant = activeGrant(sharing, party.id);
  if (grant) {
    return `<p class="grant-on">${svgIcon("clock")} <span><strong>${escapeHtml(LEVEL_LABELS[grant.level])}</strong> until ${escapeHtml(whenLabel(new Date(grant.until)))}</span>
      <button type="button" class="text-button" data-stop-grant="${escapeAttribute(party.id)}">Stop</button></p>`;
  }
  const levels = ["all", "some", "busy"].map((level) => `<option value="${level}">${escapeHtml(LEVEL_LABELS[level])}</option>`).join("");
  const lengths = GRANT_LENGTHS.map((entry) => `<option value="${entry.key}">${escapeHtml(entry.label)}</option>`).join("");
  return `<details><summary>Share more for a while</summary><div class="grant-form">
    <select class="text-input" data-grant-level aria-label="What ${escapeAttribute(party.name)} sees">${levels}</select>
    <select class="text-input" data-grant-length aria-label="For how long">${lengths}</select>
    <button type="button" class="outline-button" data-start-grant="${escapeAttribute(party.id)}">Start</button></div></details>`;
}

$("shareFriendList").addEventListener("click", (event) => {
  const start = event.target.closest("[data-start-grant]");
  const stop = event.target.closest("[data-stop-grant]");
  if (!start && !stop) return;
  const id = (start || stop).dataset.startGrant || (start || stop).dataset.stopGrant;
  const party = acceptedFriends().find((entry) => entry.party.id === id)?.party;
  if (!party) return;
  if (start) {
    const form = start.closest(".grant-form");
    const level = form.querySelector("[data-grant-level]").value;
    const until = grantEnd(form.querySelector("[data-grant-length]").value);
    saveSharing(setGrant(sharing, id, level, until));
    showToast(`${party.name} sees ${LEVEL_LABELS[level].toLowerCase()} until ${whenLabel(until)}, then it goes back.`);
  } else {
    saveSharing(clearGrant(sharing, id));
    showToast(`Back to your usual setting for ${party.name}.`);
  }
  // Only this friend's slot, so unsaved changes elsewhere in the dialog stay put.
  document.querySelector(`[data-grant-slot="${CSS.escape(id)}"]`).innerHTML = grantSlotMarkup(party);
  renderMyCalendar();
  schedulePublish();
});

$("sharePrivateList").addEventListener("click", async (event) => {
  const chip = event.target.closest("[data-unhide]");
  if (!chip) return;
  saveSharing(await toggleHidden(sharing, chip.dataset.unhide));
  await refreshHiddenKeys();
  renderSharingDialog();
  renderMyCalendar();
  schedulePublish();
  await republishToGroup();
});

$("sharingButton").addEventListener("click", () => {
  renderSharingDialog();
  openDialog(dialogs.sharing);
});

$("sharePickedList").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-unpick]");
  if (!chip) return;
  saveSharing({ ...sharing, picked: sharing.picked.filter((key) => key !== chip.dataset.unpick) });
  renderSharingDialog();
});

$("saveSharing").addEventListener("click", async () => {
  const perFriend = {};
  for (const select of document.querySelectorAll("[data-share-friend]")) {
    if (select.value) perFriend[select.dataset.shareFriend] = select.value;
  }
  // Keep choices for friends who are not in the list right now (not loaded yet).
  const shown = new Set([...document.querySelectorAll("[data-share-friend]")].map((select) => select.dataset.shareFriend));
  for (const [id, level] of Object.entries(sharing.perFriend)) if (!shown.has(id)) perFriend[id] = level;

  saveSharing({ ...sharing, friends: $("shareFriendsDefault").value, groups: $("shareGroups").value, perFriend });
  dialogs.sharing.close();
  renderMyCalendar();
  schedulePublish();
  if (session.state.privacy === "details") await republishToGroup();
  showToast("Sharing saved.");
});

/* A friend's calendar, as much as they chose to show you */

function renderFriendCalendar() {
  const view = ui.friendCalendar;
  if (!view) return;
  const base = startOfWeek(addDays(new Date(), view.offset * 7), settings().weekStartsOn);
  const week = buildWeek(base, { today: new Date() });
  $("friendCalendarTitle").textContent = `${view.name}'s calendar`;
  $("friendWeekLabel").textContent = formatWeekLabel(week[0].date, week.length);
  const body = $("friendAgenda");
  if (view.loading) {
    body.innerHTML = '<p class="form-hint">Loading…</p>';
    return;
  }
  if (!view.events) {
    body.innerHTML = `<div class="agenda-blank"><strong>${escapeHtml(view.name)} isn't sharing their calendar with you.</strong><p>You'll still see when they're busy in groups you share.</p></div>`;
    return;
  }
  $("friendCalendarUpdated").textContent = [
    view.sharedUntil ? `Shared with you until ${whenLabel(new Date(view.sharedUntil))}` : "",
    view.updatedAt ? `Updated ${formatRelative(view.updatedAt)}` : "",
  ].filter(Boolean).join(" · ");
  body.innerHTML = `<div class="agenda compact-agenda">${agendaMarkup(week, view.events, { owner: false, emptyText: "Free" })}</div>`;
}

async function openFriendCalendar(friendId, name) {
  ui.friendCalendar = { id: friendId, name, offset: 0, loading: true, events: null, updatedAt: null };
  $("friendCalendarUpdated").textContent = "";
  renderFriendCalendar();
  openDialog(dialogs.friendCalendar);
  const { data, error } = await shareStore.sharedWithMe(friendId);
  if (ui.friendCalendar?.id !== friendId) return;
  ui.friendCalendar.loading = false;
  ui.friendCalendar.events = error || !data ? null : cleanSharedEvents(data.events);
  ui.friendCalendar.updatedAt = data?.updated_at || null;
  ui.friendCalendar.sharedUntil = data?.shared_until || null;
  if (error) showToast("Couldn't load their calendar. Try again in a moment.");
  renderFriendCalendar();
}

$("friendPrevWeek").addEventListener("click", () => {
  if (!ui.friendCalendar) return;
  ui.friendCalendar.offset -= 1;
  renderFriendCalendar();
});
$("friendNextWeek").addEventListener("click", () => {
  if (!ui.friendCalendar) return;
  ui.friendCalendar.offset += 1;
  renderFriendCalendar();
});

/* Navigation chrome */

$("mobileMenu").addEventListener("click", () => {
  const open = $("sidebar").classList.toggle("open");
  $("mobileMenu").setAttribute("aria-expanded", String(open));
});

for (const item of document.querySelectorAll(".nav-item")) {
  item.addEventListener("click", () => {
    $("sidebar").classList.remove("open");
    if (!item.getAttribute("href")) return;
    for (const link of document.querySelectorAll(".main-nav .nav-item")) link.classList.remove("active");
    item.classList.add("active");
  });
}

/* Free now: your status, and friends at a glance */

/** One friend's line under their name, or null when there's nothing to say. */
function statusLine(friendId) {
  const status = friendStatus({ presence: glance.presence.get(friendId), events: glance.shares.get(friendId) });
  if (!status) return null;
  if (status.kind === "free-now") {
    return { kind: status.kind, text: `Free now until ${formatClock(status.until)}${status.note ? ` · ${status.note}` : ""}` };
  }
  if (status.kind === "busy") return { kind: status.kind, text: `Busy until ${formatClock(status.until)}` };
  return { kind: status.kind, text: status.until ? `No plans until ${formatClock(status.until)}` : "No more plans today" };
}

async function loadGlance() {
  if (!ui.user || !presenceStore || !shareStore) {
    glance.presence.clear();
    glance.shares.clear();
    renderFreeNow();
    return;
  }
  const [presence, shares] = await Promise.all([presenceStore.listActive(), shareStore.sharedWithMeAll()]);
  if (!presence.error) glance.presence = new Map(presence.data.map((row) => [row.user_id, row]));
  if (!shares.error) glance.shares = new Map(shares.data.map((row) => [row.owner_id, cleanSharedEvents(row.events)]));
  renderFriends();
  renderFreeNow();
}

/** The strip on the main page: friends who said they're free right now. */
function renderFreeNow() {
  const strip = $("freeNowStrip");
  const now = new Date();
  const free = acceptedFriends()
    .map(({ party }) => ({ party, presence: glance.presence.get(party.id) }))
    .filter(({ presence }) => presence && new Date(presence.until) > now);
  strip.hidden = !free.length;
  if (!free.length) {
    strip.innerHTML = "";
    return;
  }
  strip.innerHTML = `<span class="free-now-label"><span class="status-dot" aria-hidden="true"></span>Free now</span>${free
    .map(({ party, presence }) => {
      const photo = safeImageUrl(party.photo);
      return `<button type="button" class="free-chip" data-view-calendar="${escapeAttribute(party.id)}" data-friend-name="${escapeAttribute(party.name)}">
        <span class="avatar avatar-lilac"${photo ? ` style="background-image:url(&quot;${escapeAttribute(photo)}&quot;);background-size:cover;background-position:center"` : ""}>${photo ? "" : escapeHtml(initialsFor(party.name))}</span>
        <span><strong>${escapeHtml(party.name)}</strong><small>until ${escapeHtml(formatClock(new Date(presence.until)))}${presence.note ? ` · ${escapeHtml(presence.note)}` : ""}</small></span></button>`;
    })
    .join("")}`;
}

$("freeNowStrip").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-view-calendar]");
  if (!chip || !shareStore || !ui.user) return;
  openFriendCalendar(chip.dataset.viewCalendar, chip.dataset.friendName || "Your friend");
});

/** Your own status, at the top of the Friends tab. */
function renderStatusCard() {
  const mine = ui.user ? glance.presence.get(ui.user.id) : null;
  const on = Boolean(mine && new Date(mine.until) > new Date());
  $("statusCard").classList.toggle("on", on);
  $("statusTitle").textContent = on ? `You're free until ${formatClock(new Date(mine.until))}` : "Free right now?";
  $("statusDetail").textContent = on ? (mine.note ? `“${mine.note}” · friends can see this` : "Your friends can see this.") : "Let your friends know at a glance.";
  $("statusActions").innerHTML = on
    ? '<button type="button" class="outline-button" id="freeStop">Stop</button>'
    : `<select class="text-input" id="freeLength" aria-label="For how long">${FREE_LENGTHS.map((entry) => `<option value="${entry.key}">${escapeHtml(entry.label)}</option>`).join("")}</select>
       <input class="text-input" id="freeNote" maxlength="80" placeholder="Up for coffee? (optional)" aria-label="Note for friends" />
       <button type="button" class="primary-button" id="freeStart">I'm free</button>`;
}

$("statusActions").addEventListener("click", async (event) => {
  if (!presenceStore || !ui.user) return;
  const start = event.target.closest("#freeStart");
  const stop = event.target.closest("#freeStop");
  if (!start && !stop) return;
  (start || stop).disabled = true;
  const { error } = start
    ? await presenceStore.set(ui.user.id, freeUntil($("freeLength").value), $("freeNote").value)
    : await presenceStore.clear(ui.user.id);
  if (error) {
    (start || stop).disabled = false;
    showToast("Couldn't update your status. Try again in a moment.");
    return;
  }
  await loadGlance();
  showToast(start ? "Friends can see you're free." : "Status cleared.");
});

setInterval(() => {
  if (document.visibilityState === "visible") loadGlance();
}, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadGlance();
});

/* ------------------------------------------------------------- startup */

let previousUserId = null;

async function start() {
  renderSources();
  renderGoogleState();
  render();

  if (supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    previousUserId = data.session?.user?.id || null;
    captureProviderToken(data.session);
    renderAccount(data.session?.user);
    supabaseClient.auth.onAuthStateChange(async (_event, authSession) => {
      const changed = (authSession?.user?.id || null) !== previousUserId;
      previousUserId = authSession?.user?.id || null;
      captureProviderToken(authSession);
      renderAccount(authSession?.user);
      renderGoogleState();
      if (!changed) return;
      // A new sign-in may mean an invite addressed to this person is waiting.
      friends.loaded = false;
      if (authSession?.user) {
        await loadRemoteProfile(authSession.user);
        // Coming through the sign-in gate: load the group now (that joins it too).
        if (session.needsSignIn) await loadWorkspace();
        else await ensureMembership();
        await loadFriends({ force: true });
        await loadRemoteSharing();
        loadGlance();
        loadGoogleServer();
        loadRemoteGroups();
      } else {
        renderFriends();
        loadGlance();
        if (session.slug !== DEMO_SLUG) await loadWorkspace();
      }
    });
    if (data.session?.user) await loadRemoteProfile(data.session.user);
  } else {
    renderAccount(null);
  }

  await loadWorkspace();
  await applyPendingName();
  recordVisit();
  await loadFriends();
  await refreshHiddenKeys();
  renderMyCalendar();
  await loadRemoteSharing();
  loadGlance();
  await loadGoogleServer();
  autoSyncCalendars();

  // Coming back from the Google consent screen: pull busy times straight away.
  if (new URLSearchParams(window.location.search).has("calendar")) {
    const { data } = supabaseClient ? await supabaseClient.auth.getSession() : { data: null };
    captureProviderToken(data?.session);
    if (googleToken()) await syncGoogle();
    else showToast("Google didn't grant calendar access. Try Connect again, or add your calendar's secret iCal address instead.");
    renderGoogleState();
    // Drop the marker so a reload doesn't re-run this.
    const url = new URL(window.location.href);
    url.searchParams.delete("calendar");
    window.history.replaceState(null, "", url);
  }
}

/**
 * Google's calendar access token (handed over once, on the OAuth callback;
 * never written to the shared workspace). It lasts about an hour and can't be renewed
 * without a server-side client secret, so it's kept (with its expiry) across
 * tabs and reloads until then, and the app asks to reconnect after.
 */
function googleToken() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE.googleToken) || "null");
    if (saved?.token && saved.expires > Date.now()) return saved.token;
  } catch {
    /* Old plain-string value or blocked storage: treat as not connected. */
  }
  return null;
}

function setGoogleToken(token) {
  try {
    window.localStorage.setItem(STORAGE.googleToken, JSON.stringify({ token, expires: Date.now() + 55 * 60 * 1000 }));
  } catch {
    /* Storage blocked: syncing still works on this page. */
  }
}

function clearGoogleToken() {
  try {
    window.localStorage.removeItem(STORAGE.googleToken);
    window.sessionStorage.removeItem(STORAGE.googleToken); // where older versions kept it
  } catch {
    /* Nothing stored. */
  }
}

/** Calls api/google.js as the signed-in person. Returns the fetch Response. */
async function googleApi(method, query = null, body = null) {
  const token = await accessToken();
  return fetch(`/api/google${query ? `?${new URLSearchParams(query)}` : ""}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Whether this server can keep Google syncing on its own, and whether it has your consent stored. */
async function loadGoogleServer() {
  if (!ui.user) {
    googleServer.configured = false;
    googleServer.connected = false;
    renderGoogleState();
    return;
  }
  try {
    const payload = await (await googleApi("GET")).json();
    googleServer.configured = payload.configured === true;
    googleServer.connected = payload.connected === true;
    // Connected on another device: list it here too, so it can be removed and its sync time kept.
    if (googleServer.connected) ensureGoogleSource();
  } catch {
    /* Offline or no server: keep the browser-only flow. */
  }
  renderGoogleState();
}

function ensureGoogleSource() {
  if (calendarSources.some((source) => source.type === "google")) return;
  calendarSources.push({ type: "google", label: "Google Calendar", url: "google" });
  saveSources();
}

/** Only the "Connect Google Calendar" round trip carries calendar access; a plain sign-in's token can't read calendars. */
function captureProviderToken(authSession) {
  if (authSession?.provider_token && new URLSearchParams(window.location.search).has("calendar")) {
    setGoogleToken(authSession.provider_token);
    // The refresh token comes only this once: hand it to the server so syncing outlives the hour.
    if (authSession.provider_refresh_token && authSession.provider_refresh_token !== googleServer.handedOver) {
      googleServer.handedOver = authSession.provider_refresh_token;
      googleApi("POST", null, { refreshToken: authSession.provider_refresh_token })
        .then((response) => response.json())
        .then((payload) => {
          googleServer.configured = payload.configured === true;
          googleServer.connected = payload.connected === true;
          renderGoogleState();
        })
        .catch(() => {});
    }
    ensureGoogleSource();
  }
}

async function loadRemoteProfile(user) {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("display_name, photo_url, share_schedule")
    .eq("id", user.id)
    .maybeSingle();
  if (error) return;
  if (!data) {
    // First sign-in on a project without the profile trigger: create the row
    // so friend requests can show a name instead of an email address.
    await supabaseClient.from("profiles").upsert({
      id: user.id,
      display_name: displayName(),
      photo_url: profile.photo || null,
      share_schedule: profile.shareSchedule,
      updated_at: new Date().toISOString(),
    });
    return;
  }
  profile = {
    ...profile,
    name: data.display_name || profile.name,
    photo: data.photo_url || profile.photo,
    shareSchedule: data.share_schedule !== false,
  };
  writeJson(STORAGE.profile, profile);
  renderChrome();
}

start();

/* Home screen app */

let installPrompt = null;

function renderInstallCard() {
  const mode = installMode({ standalone: isStandalone(), canPrompt: Boolean(installPrompt), userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints });
  $("installCard").hidden = mode === "none";
  $("installButton").hidden = mode !== "prompt";
  $("installSteps").innerHTML = mode === "ios"
    ? `In Safari, tap Share ${svgIcon("share")} then <strong>Add to Home Screen</strong>.`
    : "Opens like an app, full screen, no App Store.";
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  renderInstallCard();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  renderInstallCard();
  showToast("Waddle is on your home screen.");
});
$("installButton").addEventListener("click", async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
  renderInstallCard();
});
renderInstallCard();
registerServiceWorker();
