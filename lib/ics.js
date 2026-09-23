// Minimal iCalendar (RFC 5545) reader: enough of the format to turn a
// published Google/Apple calendar feed into busy blocks. Dependency-free so
// both the browser and the serverless proxy can use it.
//
// Times carrying a TZID are expanded in that zone's wall-clock time (so a
// weekly 9 AM class stays at 9 AM across a daylight-saving change) and then
// converted to UTC on output ("2026-09-21T13:00:00Z"). UTC times keep their
// trailing "Z". Floating times, all-day dates and TZIDs the runtime does not
// recognise are emitted without a zone designator ("2026-09-21T10:00:00") and
// read in the viewer's own zone.

const MAX_EVENTS = 1200;
const MAX_INSTANCES_PER_RULE = 400;
const WEEKDAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Outlook and Exchange feeds name zones the Windows way.
const WINDOWS_ZONES = {
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "Canada Central Standard Time": "America/Regina",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC": "UTC",
};

const zoneFormatters = new Map();

function zoneFormatter(zone) {
  if (!zoneFormatters.has(zone)) {
    let formatter = null;
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      formatter = null;
    }
    zoneFormatters.set(zone, formatter);
  }
  return zoneFormatters.get(zone);
}

/**
 * Maps a TZID parameter to an IANA zone the runtime knows, or null. Accepts
 * Windows names and prefixed forms such as "/mozilla.org/20070129_1/Europe/Paris".
 */
export function resolveZone(tzid) {
  const raw = String(tzid || "").trim();
  if (!raw) return null;
  const candidates = [WINDOWS_ZONES[raw], raw];
  const segments = raw.split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) candidates.push(segments.slice(index).join("/"));
  for (const candidate of candidates) {
    if (candidate && zoneFormatter(candidate)) return candidate;
  }
  return null;
}

/** How far `zone` is ahead of UTC at the instant `millis`, in milliseconds. */
function zoneOffset(millis, zone) {
  const parts = {};
  for (const { type, value } of zoneFormatter(zone).formatToParts(new Date(millis))) parts[type] = Number(value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(millis / 1000) * 1000;
}

/**
 * Converts a wall-clock reading in `zone` to a UTC instant. A time skipped by
 * a spring-forward change lands just after it; a repeated one takes the first.
 */
export function wallClockToUtc(wallMillis, zone) {
  const first = wallMillis - zoneOffset(wallMillis, zone);
  const second = wallMillis - zoneOffset(first, zone);
  if (first === second) return first;
  const valid = [first, second].filter((instant) => instant + zoneOffset(instant, zone) === wallMillis);
  // Both readings exist during a fall-back hour; neither exists in a spring-forward gap.
  return valid.length ? Math.min(...valid) : Math.max(first, second);
}

/** Joins RFC 5545 folded lines (a CRLF followed by a space or tab). */
export function unfold(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

export function parseContentLine(line) {
  const colon = findUnquoted(line, ":");
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(";");
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    params[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

function findUnquoted(line, character) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === character && !quoted) return index;
  }
  return -1;
}

function unescapeText(value) {
  return String(value)
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** Parses DATE (20260921) and DATE-TIME (20260921T100000[Z]) values. */
export function parseIcsDate(value, params = {}) {
  const raw = String(value || "").trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly) {
    return {
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
      hour: 0,
      minute: 0,
      second: 0,
      utc: false,
      allDay: true,
    };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!dateTime) return null;
  const zone = !dateTime[7] && params.VALUE !== "DATE" ? resolveZone(params.TZID) : null;
  return {
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
    second: Number(dateTime[6]),
    utc: Boolean(dateTime[7]),
    allDay: params.VALUE === "DATE",
    ...(zone ? { zone } : {}),
  };
}

function toUtcMillis(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function fromUtcMillis(millis, template) {
  const date = new Date(millis);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    utc: template.utc,
    allDay: template.allDay,
    ...(template.zone ? { zone: template.zone } : {}),
  };
}

/** The real UTC instant for zoned times; the wall-clock reading otherwise. */
function instantMillis(parts) {
  const wall = toUtcMillis(parts);
  return parts.zone ? wallClockToUtc(wall, parts.zone) : wall;
}

/** Serializes to a string the browser's Date constructor reads correctly. */
export function formatStamp(parts) {
  if (parts.zone && !parts.utc) {
    return formatStamp(fromUtcMillis(instantMillis(parts), { utc: true, allDay: parts.allDay }));
  }
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  const base = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return parts.utc ? `${base}Z` : base;
}

/** ISO 8601 duration subset used by DURATION (P1DT2H30M). */
export function parseDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || "").trim());
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const weeks = Number(match[2] || 0);
  const days = Number(match[3] || 0);
  const hours = Number(match[4] || 0);
  const minutes = Number(match[5] || 0);
  const seconds = Number(match[6] || 0);
  const total = ((weeks * 7 + days) * 24 * 3600 + hours * 3600 + minutes * 60 + seconds) * 1000;
  return total === 0 ? null : sign * total;
}

function parseRule(value) {
  const rule = {};
  for (const part of String(value || "").split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    rule[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1);
  }
  const freq = String(rule.FREQ || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const until = rule.UNTIL ? parseIcsDate(rule.UNTIL) : null;
  return {
    freq,
    interval: Math.max(1, Number(rule.INTERVAL || 1) || 1),
    count: rule.COUNT ? Math.max(1, Number(rule.COUNT)) : null,
    until: until ? toUtcMillis(until) : null,
    untilUtc: Boolean(until && until.utc),
    byDay: rule.BYDAY
      ? String(rule.BYDAY)
          .split(",")
          .map((code) => WEEKDAY_CODES[code.replace(/^[+-]?\d+/, "").toUpperCase()])
          .filter((day) => day !== undefined)
      : [],
  };
}

/** Collects VEVENT blocks; other components (VTODO, VTIMEZONE) are ignored. */
export function parseComponents(text) {
  const events = [];
  let current = null;
  let depth = 0;
  for (const line of unfold(text).split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseContentLine(line);
    if (!parsed) continue;
    if (parsed.name === "BEGIN") {
      depth += 1;
      if (parsed.value.toUpperCase() === "VEVENT" && depth <= 3) current = { lines: [] };
      continue;
    }
    if (parsed.name === "END") {
      depth = Math.max(0, depth - 1);
      if (parsed.value.toUpperCase() === "VEVENT" && current) {
        if (events.length < MAX_EVENTS) events.push(current);
        current = null;
      }
      continue;
    }
    if (current) current.lines.push(parsed);
  }
  return events;
}

function readEvent(lines) {
  const event = { exdates: [], rule: null };
  for (const { name, params, value } of lines) {
    switch (name) {
      case "UID":
        event.uid = value.trim();
        break;
      case "SUMMARY":
        event.title = unescapeText(value);
        break;
      case "DTSTART":
        event.start = parseIcsDate(value, params);
        break;
      case "DTEND":
        event.end = parseIcsDate(value, params);
        break;
      case "DURATION":
        event.duration = parseDuration(value);
        break;
      case "RRULE":
        event.rule = parseRule(value);
        break;
      case "STATUS":
        event.status = value.trim().toUpperCase();
        break;
      case "TRANSP":
        event.transparent = value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "RECURRENCE-ID":
        event.recurrenceId = parseIcsDate(value, params);
        break;
      case "EXDATE":
        for (const part of value.split(",")) {
          const exdate = parseIcsDate(part, params);
          if (exdate) event.exdates.push(instantMillis(exdate));
        }
        break;
      default:
        break;
    }
  }
  return event;
}

function instanceEnd(start, event) {
  if (event.end) return event.end;
  if (event.duration) return fromUtcMillis(toUtcMillis(start) + event.duration, start);
  if (start.allDay) return fromUtcMillis(toUtcMillis(start) + 24 * 3600 * 1000, start);
  return fromUtcMillis(toUtcMillis(start) + 3600 * 1000, start);
}

function stepStart(start, rule, step) {
  const base = new Date(toUtcMillis(start));
  if (rule.freq === "DAILY") base.setUTCDate(base.getUTCDate() + step * rule.interval);
  else if (rule.freq === "WEEKLY") base.setUTCDate(base.getUTCDate() + step * rule.interval * 7);
  else if (rule.freq === "MONTHLY") base.setUTCMonth(base.getUTCMonth() + step * rule.interval);
  else base.setUTCFullYear(base.getUTCFullYear() + step * rule.interval);
  return fromUtcMillis(base.getTime(), start);
}

function expand(event, windowStart, windowEnd) {
  const instances = [];
  if (!event.start) return instances;
  const duration = toUtcMillis(instanceEnd(event.start, event)) - toUtcMillis(event.start);
  const length = duration > 0 ? duration : 3600 * 1000;

  if (!event.rule) {
    const startMillis = toUtcMillis(event.start);
    if (startMillis + length >= windowStart && startMillis <= windowEnd) instances.push(event.start);
    return instances;
  }

  const rule = event.rule;
  const weekdays = rule.freq === "WEEKLY" && rule.byDay.length ? rule.byDay : null;
  let emitted = 0;
  for (let step = 0; step < MAX_INSTANCES_PER_RULE; step += 1) {
    const periodStart = stepStart(event.start, rule, step);
    const periodMillis = toUtcMillis(periodStart);
    if (rule.until && (rule.untilUtc ? instantMillis(periodStart) : periodMillis) > rule.until) break;
    if (periodMillis > windowEnd + length) break;

    const candidates = weekdays
      ? weekdays.map((weekday) => {
          const shift = (weekday - new Date(periodMillis).getUTCDay() + 7) % 7;
          return fromUtcMillis(periodMillis + shift * 24 * 3600 * 1000, event.start);
        })
      : [periodStart];

    for (const candidate of candidates) {
      const candidateMillis = toUtcMillis(candidate);
      if (candidateMillis < toUtcMillis(event.start)) continue;
      if (rule.until && (rule.untilUtc ? instantMillis(candidate) : candidateMillis) > rule.until) continue;
      if (rule.count !== null && emitted >= rule.count) return instances;
      emitted += 1;
      if (event.exdates.includes(instantMillis(candidate))) continue;
      if (candidateMillis + length >= windowStart && candidateMillis <= windowEnd) instances.push(candidate);
    }
    if (rule.count !== null && emitted >= rule.count) break;
  }
  return instances;
}

/**
 * Turns calendar text into busy blocks between `from` and `to`.
 * Cancelled and free-time (TRANSP:TRANSPARENT) events are skipped. Titles are
 * only included when `includeTitles` is set, so busy/free-only privacy holds
 * at the point the data is read.
 */
export function parseIcs(text, { from, to, includeTitles = false, padHours = 36 } = {}) {
  const pad = padHours * 3600 * 1000;
  const windowStart = new Date(from).getTime() - pad;
  const windowEnd = new Date(to).getTime() + pad;
  if (Number.isNaN(windowStart) || Number.isNaN(windowEnd)) throw new Error("Invalid window");

  const parsedEvents = parseComponents(text).map((component) => readEvent(component.lines));
  const overridden = new Set(
    parsedEvents
      .filter((event) => event.recurrenceId && event.uid)
      .map((event) => `${event.uid}@${instantMillis(event.recurrenceId)}`)
  );

  const blocks = [];
  for (const event of parsedEvents) {
    if (!event.start) continue;
    if (event.status === "CANCELLED" || event.transparent) continue;
    // Every instance of a recurring event keeps the first instance's length.
    const length = toUtcMillis(instanceEnd(event.start, event)) - toUtcMillis(event.start);
    for (const start of expand(event, windowStart, windowEnd)) {
      if (!event.recurrenceId && overridden.has(`${event.uid}@${instantMillis(start)}`)) continue;
      const end = fromUtcMillis(toUtcMillis(start) + (length > 0 ? length : 3600 * 1000), start);
      blocks.push({
        start: formatStamp(start),
        end: formatStamp(end),
        allDay: Boolean(start.allDay),
        ...(includeTitles && event.title ? { title: event.title.slice(0, 120) } : {}),
      });
    }
  }
  return blocks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).slice(0, MAX_EVENTS);
}
