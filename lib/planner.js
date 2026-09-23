// Shared planning logic for Waddle.
// Imported by the browser app (app.js) and the serverless API (api/*.js),
// so it must stay dependency-free and avoid touching `window` or `process`.

export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 22;
export const MIN_WINDOW_HOURS = 2;
export const WEEK_DAYS = 7;

export const LIMITS = {
  members: 40,
  ideas: 60,
  busyPerMember: 600,
  weeklyPerMember: 60,
  activity: 40,
  text: 120,
  description: 280,
  stateBytes: 256 * 1024,
};

export const AVATAR_PALETTES = ["avatar-lilac", "avatar-coral", "avatar-mint", "avatar-yellow", "avatar-sky", "avatar-rose"];

export const IDEA_STYLES = [
  { key: "brunch", emoji: "☕", tagClass: "" },
  { key: "park", emoji: "☀", tagClass: "green-tag" },
  { key: "games", emoji: "✦", tagClass: "purple-tag" },
  { key: "sunset", emoji: "◐", tagClass: "coral-tag" },
  { key: "ocean", emoji: "○", tagClass: "sky-tag" },
  { key: "night", emoji: "☾", tagClass: "purple-tag" },
];

const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ------------------------------------------------------------------ ids */

export function createId(prefix = "id") {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return `${prefix}_${random}`;
}

export function initialsFor(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function slugify(value, fallback = "weekend-crew") {
  const slug = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

/* ---------------------------------------------------------------- dates */

export function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function addDays(date, amount) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

/** Monday-based by default; weekStartsOn 0 gives Sunday-based weeks. */
export function startOfWeek(date, weekStartsOn = 1) {
  const day = startOfDay(date);
  const shift = (day.getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -shift);
}

export function isoDate(date) {
  const day = startOfDay(date);
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${month}-${dayOfMonth}`;
}

/** Parses YYYY-MM-DD as a local date (not UTC, which would shift the day). */
export function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function sameDay(a, b) {
  return isoDate(a) === isoDate(b);
}

export function buildWeek(weekStart, { days = WEEK_DAYS, today = new Date() } = {}) {
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(weekStart, index);
    return {
      date,
      iso: isoDate(date),
      weekday: date.getDay(),
      label: WEEKDAY_LABELS[date.getDay()],
      longLabel: WEEKDAY_LONG[date.getDay()],
      dayOfMonth: date.getDate(),
      isToday: sameDay(date, today),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    };
  });
}

export function buildSlots({ dayStart = DAY_START_HOUR, dayEnd = DAY_END_HOUR } = {}) {
  const slots = [];
  for (let hour = dayStart; hour < dayEnd; hour += 1) {
    slots.push({ hour, label: formatHour(hour), showLabel: hour % 2 === dayStart % 2 });
  }
  return slots;
}

export function formatHour(hour) {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized < 12 ? "AM" : "PM";
  const display = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${display} ${suffix}`;
}

export function formatClock(date) {
  const value = new Date(date);
  const hours = value.getHours();
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const suffix = hours < 12 ? "AM" : "PM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

export function formatWeekLabel(weekStart, days = WEEK_DAYS) {
  const start = startOfDay(weekStart);
  const end = addDays(start, days - 1);
  const startPart = `${MONTH_LABELS[start.getMonth()]} ${start.getDate()}`;
  const endPart = start.getMonth() === end.getMonth()
    ? `${end.getDate()}`
    : `${MONTH_LABELS[end.getMonth()]} ${end.getDate()}`;
  return `${startPart} – ${endPart}, ${end.getFullYear()}`;
}

export function formatDayStamp(date) {
  const value = new Date(date);
  return `${WEEKDAY_LONG[value.getDay()].slice(0, 3)}, ${MONTH_LABELS[value.getMonth()]} ${value.getDate()}`;
}

export function formatRelative(value, now = new Date()) {
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return "never";
  const minutes = Math.round((now.getTime() - then.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatDayStamp(then);
}

export function timeZoneLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
  } catch {
    return "Local time";
  }
}

export function timeZoneOffsetLabel(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "−" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/* ----------------------------------------------------------- intervals */

export function slotRange(date, hour) {
  const start = startOfDay(date);
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(hour + 1, 0, 0, 0);
  return { start, end };
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function toTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function parseHourMinute(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function dateAtHourMinute(date, { hour, minute }) {
  const value = startOfDay(date);
  value.setHours(hour, minute, 0, 0);
  return value;
}

function coversDate(coverage, date) {
  if (!coverage) return false;
  const from = parseIsoDate(coverage.from);
  const to = parseIsoDate(coverage.to);
  if (!from || !to) return false;
  const day = startOfDay(date);
  return day >= from && day <= to;
}

/**
 * Busy blocks for one member on one day.
 * Dated availability (calendar sync or a hand-edited week) wins for days it
 * covers; otherwise the member's recurring "usual week" applies. Returns null
 * when the member has shared nothing for that day, which keeps unknown
 * schedules out of "everyone is free" claims.
 */
export function busyBlocksFor(member, date) {
  if (!member || member.sharesSchedule === false) return null;
  if (coversDate(member.coverage, date)) {
    const dayStart = startOfDay(date).getTime();
    const dayEnd = addDays(startOfDay(date), 1).getTime();
    return (member.busy || [])
      .map((block) => ({ start: toTime(block.start), end: toTime(block.end), title: block.title, source: block.source }))
      .filter((block) => block.start !== null && block.end !== null && block.end > block.start)
      .filter((block) => block.start < dayEnd && block.end > dayStart);
  }
  const weekly = (member.weekly || []).filter((block) => Number(block.weekday) === date.getDay());
  if (!weekly.length) return member.weekly?.length ? [] : null;
  return weekly
    .map((block) => {
      const start = parseHourMinute(block.start);
      const end = parseHourMinute(block.end);
      if (!start || !end) return null;
      return {
        start: dateAtHourMinute(date, start).getTime(),
        end: dateAtHourMinute(date, end).getTime(),
        title: block.title,
        source: "weekly",
      };
    })
    .filter((block) => block && block.end > block.start);
}

export function isSharingOn(member, date) {
  return busyBlocksFor(member, date) !== null;
}

/**
 * Who is free during one slot. `state` is "overlap" when every member who
 * shared that day is free, "partial" when only some are, "busy" otherwise.
 */
export function classifySlot(members, date, hour) {
  const { start, end } = slotRange(date, hour);
  const startTime = start.getTime();
  const endTime = end.getTime();
  const free = [];
  const busy = [];
  const unknown = [];

  for (const member of members) {
    const blocks = busyBlocksFor(member, date);
    if (blocks === null) {
      unknown.push(member);
      continue;
    }
    const conflict = blocks.find((block) => overlaps(startTime, endTime, block.start, block.end));
    if (conflict) busy.push({ member, title: conflict.title });
    else free.push(member);
  }

  const shared = free.length + busy.length;
  let slotState = "busy";
  if (shared > 0 && free.length === shared) slotState = "overlap";
  else if (free.length > 0) slotState = "partial";

  return { state: slotState, free, busy, unknown, shared, start, end };
}

export function buildAvailabilityMatrix(members, week, slots) {
  return week.map((day) => slots.map((slot) => classifySlot(members, day.date, slot.hour)));
}

/**
 * Contiguous runs where everyone who shared is free, longest first.
 * Windows never span midnight because each day is scanned separately.
 */
export function findOpenWindows(members, week, slots, { minHours = MIN_WINDOW_HOURS } = {}) {
  const windows = [];
  for (const day of week) {
    let run = null;
    for (const slot of slots) {
      const cell = classifySlot(members, day.date, slot.hour);
      const continues = cell.state === "overlap" && (!run || run.nextHour === slot.hour);
      if (continues) {
        if (!run) run = { day, start: cell.start, end: cell.end, hours: 1, nextHour: slot.hour + 1, memberIds: cell.free.map((m) => m.id) };
        else {
          run.end = cell.end;
          run.hours += 1;
          run.nextHour = slot.hour + 1;
          run.memberIds = run.memberIds.filter((id) => cell.free.some((m) => m.id === id));
        }
        continue;
      }
      if (run) {
        if (run.hours >= minHours) windows.push(run);
        run = null;
      }
      if (cell.state === "overlap") {
        run = { day, start: cell.start, end: cell.end, hours: 1, nextHour: slot.hour + 1, memberIds: cell.free.map((m) => m.id) };
      }
    }
    if (run && run.hours >= minHours) windows.push(run);
  }
  return windows
    .map((window) => ({ day: window.day, start: window.start, end: window.end, hours: window.hours, memberIds: window.memberIds }))
    .sort((a, b) => b.hours - a.hours || a.start - b.start);
}

export function formatWindow(window) {
  if (!window) return "";
  return `${formatDayStamp(window.start)} · ${formatClock(window.start)}`;
}

export function describeWindow(window, memberCount) {
  if (!window) return "No shared window yet";
  const people = window.memberIds.length;
  const everyone = memberCount && people >= memberCount;
  const who = everyone ? "Everyone is free" : `${people} ${people === 1 ? "person" : "people"} free`;
  return `${who} for a ${window.hours}-hour window`;
}

/* -------------------------------------------------------- busy editing */

/**
 * Replaces every block from one source inside [from, to) with `blocks`, so
 * re-syncing a calendar or re-editing a week updates in place instead of
 * stacking duplicate copies of the same busy time.
 */
export function replaceBusyRange(existing, blocks, { source, from, to }) {
  const rangeStart = new Date(from).getTime();
  const rangeEnd = new Date(to).getTime();
  const kept = (existing || []).filter((block) => {
    if (source && block.source !== source) return true;
    const start = toTime(block.start);
    const end = toTime(block.end);
    if (start === null || end === null) return false;
    return !overlaps(start, end, rangeStart, rangeEnd);
  });
  const added = (blocks || [])
    .map((block) => ({
      start: new Date(block.start).toISOString(),
      end: new Date(block.end).toISOString(),
      ...(block.title ? { title: String(block.title).slice(0, LIMITS.text) } : {}),
      source: source || block.source || "manual",
    }))
    .filter((block) => block.start && block.end && block.end > block.start);
  return [...kept, ...added]
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, LIMITS.busyPerMember);
}

export function widenCoverage(coverage, from, to) {
  const current = coverage || {};
  const currentFrom = parseIsoDate(current.from);
  const currentTo = parseIsoDate(current.to);
  const nextFrom = startOfDay(from);
  const nextTo = startOfDay(to);
  return {
    from: isoDate(currentFrom && currentFrom < nextFrom ? currentFrom : nextFrom),
    to: isoDate(currentTo && currentTo > nextTo ? currentTo : nextTo),
  };
}

/**
 * Materializes the recurring "usual week" into dated blocks so a member can
 * hand-edit one week without losing their baseline or changing other weeks.
 */
export function materializeWeek(member, week) {
  const blocks = [];
  for (const day of week) {
    const existing = busyBlocksFor(member, day.date) || [];
    for (const block of existing) {
      blocks.push({ start: new Date(block.start).toISOString(), end: new Date(block.end).toISOString(), title: block.title });
    }
  }
  return blocks;
}

/* ------------------------------------------------------------ ideas */

export function voteCount(idea) {
  return Array.isArray(idea?.votes) ? idea.votes.length : 0;
}

export function hasVoted(idea, memberId) {
  return Array.isArray(idea?.votes) && idea.votes.includes(memberId);
}

export function rankIdeas(ideas) {
  return [...(ideas || [])].sort((a, b) => voteCount(b) - voteCount(a) || String(a.title).localeCompare(String(b.title)));
}

/* --------------------------------------------------- state validation */

const PRIVACY_VALUES = new Set(["busy", "details"]);
const TIMING_VALUES = new Set(["week", "month", "later", "range"]);
const SOURCE_VALUES = new Set(["manual", "google", "ics", "weekly"]);

function text(value, max = LIMITS.text) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function boundedNumber(value, { min, max, fallback }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeBusy(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((block) => {
      const start = new Date(block?.start);
      const end = new Date(block?.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
      const source = SOURCE_VALUES.has(block?.source) ? block.source : "manual";
      const title = text(block?.title);
      return { start: start.toISOString(), end: end.toISOString(), ...(title ? { title } : {}), source };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, LIMITS.busyPerMember);
}

function normalizeWeekly(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((block) => {
      const weekday = Number(block?.weekday);
      const start = parseHourMinute(block?.start);
      const end = parseHourMinute(block?.end);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !start || !end) return null;
      const startMinutes = start.hour * 60 + start.minute;
      const endMinutes = end.hour * 60 + end.minute;
      if (endMinutes <= startMinutes) return null;
      const title = text(block?.title);
      return {
        weekday,
        start: `${String(start.hour).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}`,
        end: `${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}`,
        ...(title ? { title } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, LIMITS.weeklyPerMember);
}

function normalizeCoverage(coverage) {
  const from = parseIsoDate(coverage?.from);
  const to = parseIsoDate(coverage?.to);
  if (!from || !to || to < from) return null;
  return { from: isoDate(from), to: isoDate(to) };
}

function normalizeMember(member, index) {
  const name = text(member?.name, 60) || `Guest ${index + 1}`;
  const coverage = normalizeCoverage(member?.coverage);
  return {
    id: text(member?.id, 40) || createId("member"),
    name,
    initials: (text(member?.initials, 3) || initialsFor(name)).toUpperCase(),
    palette: AVATAR_PALETTES.includes(member?.palette) ? member.palette : AVATAR_PALETTES[index % AVATAR_PALETTES.length],
    ...(text(member?.userId, 64) ? { userId: text(member.userId, 64) } : {}),
    ...(text(member?.email, 120) ? { email: text(member.email, 120) } : {}),
    sharesSchedule: member?.sharesSchedule !== false,
    pending: member?.pending === true,
    weekly: normalizeWeekly(member?.weekly),
    busy: normalizeBusy(member?.busy),
    ...(coverage ? { coverage } : {}),
    updatedAt: Number.isNaN(new Date(member?.updatedAt).getTime()) ? new Date().toISOString() : new Date(member.updatedAt).toISOString(),
  };
}

function normalizeIdea(idea, index) {
  const title = text(idea?.title, 80) || "Untitled idea";
  const style = IDEA_STYLES.find((entry) => entry.key === idea?.style) || IDEA_STYLES[index % IDEA_STYLES.length];
  const votes = Array.isArray(idea?.votes)
    ? [...new Set(idea.votes.map((vote) => text(vote, 40)).filter(Boolean))].slice(0, LIMITS.members)
    : [];
  return {
    id: text(idea?.id, 40) || createId("idea"),
    title,
    description: text(idea?.description, LIMITS.description),
    location: text(idea?.location, 80),
    tag: text(idea?.tag, 24).toUpperCase(),
    style: style.key,
    votes,
    createdAt: Number.isNaN(new Date(idea?.createdAt).getTime()) ? new Date().toISOString() : new Date(idea.createdAt).toISOString(),
  };
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  const activity = text(plan.activity, 80);
  if (!activity) return null;
  const timing = TIMING_VALUES.has(plan.timing) ? plan.timing : "week";
  const start = parseIsoDate(plan.start);
  const end = parseIsoDate(plan.end);
  return {
    activity,
    location: text(plan.location, 80),
    audience: text(plan.audience, 60) || "Everyone",
    timing,
    ...(timing === "range" && start && end ? { start: isoDate(start), end: isoDate(end) } : {}),
    ...(text(plan.id, 40) ? { id: text(plan.id, 40) } : {}),
    ...(plan.chosen && !Number.isNaN(new Date(plan.chosen).getTime()) ? { chosen: new Date(plan.chosen).toISOString() } : {}),
    ...(plan.chosen && plan.chosenEnd && new Date(plan.chosenEnd) > new Date(plan.chosen)
      ? { chosenEnd: new Date(plan.chosenEnd).toISOString() }
      : {}),
    updatedAt: Number.isNaN(new Date(plan.updatedAt).getTime()) ? new Date().toISOString() : new Date(plan.updatedAt).toISOString(),
  };
}

function normalizeActivity(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      const message = text(entry?.message, 140);
      if (!message) return null;
      const at = new Date(entry?.at);
      return { message, at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString() };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, LIMITS.activity);
}

function normalizeSettings(settings) {
  return {
    weekStartsOn: [0, 1].includes(Number(settings?.weekStartsOn)) ? Number(settings.weekStartsOn) : 1,
    dayStart: boundedNumber(settings?.dayStart, { min: 0, max: 22, fallback: DAY_START_HOUR }),
    dayEnd: boundedNumber(settings?.dayEnd, { min: 1, max: 24, fallback: DAY_END_HOUR }),
    minWindowHours: boundedNumber(settings?.minWindowHours, { min: 1, max: 8, fallback: MIN_WINDOW_HOURS }),
    locked: settings?.locked === true,
  };
}

/** Single gate for anything written to the shared workspace blob. */
export function normalizeWorkspaceState(input) {
  const raw = input && typeof input === "object" ? input : {};
  const settings = normalizeSettings(raw.settings);
  if (settings.dayEnd <= settings.dayStart) {
    settings.dayStart = DAY_START_HOUR;
    settings.dayEnd = DAY_END_HOUR;
  }
  const members = Array.isArray(raw.members) ? raw.members.slice(0, LIMITS.members).map(normalizeMember) : [];
  const seen = new Set();
  const uniqueMembers = members.filter((member) => {
    if (seen.has(member.id)) return false;
    seen.add(member.id);
    return true;
  });
  const memberIds = new Set(uniqueMembers.map((member) => member.id));
  const ideas = (Array.isArray(raw.ideas) ? raw.ideas.slice(0, LIMITS.ideas) : []).map(normalizeIdea);
  return {
    version: 2,
    name: text(raw.name, 60) || "Weekend crew",
    privacy: PRIVACY_VALUES.has(raw.privacy) ? raw.privacy : "busy",
    ...(text(raw.ownerId, 64) ? { ownerId: text(raw.ownerId, 64) } : {}),
    settings,
    members: uniqueMembers,
    ideas: ideas.map((idea) => ({ ...idea, votes: idea.votes.filter((vote) => memberIds.has(vote)) })),
    plan: normalizePlan(raw.plan),
    activity: normalizeActivity(raw.activity),
    updatedAt: new Date().toISOString(),
  };
}

export function stateTooLarge(state) {
  try {
    return JSON.stringify(state).length > LIMITS.stateBytes;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------- demo content */

/** Evergreen sample workspace: recurring patterns, so it never goes stale. */
export function createDemoState() {
  const now = new Date().toISOString();
  return normalizeWorkspaceState({
    name: "Weekend crew",
    privacy: "busy",
    members: [
      {
        id: "demo_jamie",
        name: "Jamie Miller",
        palette: "avatar-coral",
        updatedAt: now,
        weekly: [
          { weekday: 1, start: "09:00", end: "12:00" },
          { weekday: 2, start: "13:00", end: "15:00" },
          { weekday: 3, start: "09:00", end: "11:00" },
          { weekday: 4, start: "18:00", end: "21:00" },
          { weekday: 5, start: "09:00", end: "12:00" },
        ],
      },
      {
        id: "demo_taylor",
        name: "Taylor Kim",
        palette: "avatar-mint",
        updatedAt: now,
        weekly: [
          { weekday: 1, start: "08:00", end: "10:00" },
          { weekday: 2, start: "16:00", end: "19:00" },
          { weekday: 4, start: "09:00", end: "13:00" },
          { weekday: 6, start: "10:00", end: "12:00" },
        ],
      },
      {
        id: "demo_riley",
        name: "Riley Lee",
        palette: "avatar-yellow",
        updatedAt: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
        weekly: [
          { weekday: 2, start: "08:00", end: "09:00" },
          { weekday: 3, start: "14:00", end: "17:00" },
          { weekday: 5, start: "17:00", end: "22:00" },
        ],
      },
    ],
    ideas: [
      { id: "demo_brunch", title: "Slow morning brunch", description: "Good coffee, no rush, extra syrup.", location: "Anywhere", tag: "POPULAR", style: "brunch", votes: ["demo_jamie", "demo_taylor", "demo_riley"] },
      { id: "demo_picnic", title: "Picnic in the park", description: "Fresh air and a blanket in the sun.", location: "Riverside Park", tag: "OUTSIDE", style: "park", votes: ["demo_taylor"] },
      { id: "demo_games", title: "Games night", description: "Bring your best strategy and snacks.", location: "At someone's place", tag: "COZY", style: "games", votes: ["demo_jamie", "demo_riley"] },
    ],
    activity: [{ message: "Workspace created", at: now }],
  });
}
