// Minimal iCalendar (RFC 5545) reader: enough of the format to turn a
// published Google/Apple calendar feed into busy blocks. Dependency-free so
// both the browser and the serverless proxy can use it.
//
// Times carrying a TZID, and floating times, are emitted as wall-clock
// strings without a zone designator ("2026-09-21T10:00:00"). The browser then
// reads them in the viewer's own zone, which is the right answer whenever the
// calendar and the viewer share a timezone, and is documented as a limitation
// when they do not. UTC times keep their trailing "Z".

const MAX_EVENTS = 1200;
const MAX_INSTANCES_PER_RULE = 400;
const WEEKDAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

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
  return {
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
    second: Number(dateTime[6]),
    utc: Boolean(dateTime[7]),
    allDay: params.VALUE === "DATE",
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
  };
}

/** Serializes to a string the browser's Date constructor reads correctly. */
export function formatStamp(parts) {
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
          if (exdate) event.exdates.push(toUtcMillis(exdate));
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
    if (rule.until && periodMillis > rule.until) break;
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
      if (rule.until && candidateMillis > rule.until) continue;
      if (rule.count !== null && emitted >= rule.count) return instances;
      emitted += 1;
      if (event.exdates.includes(candidateMillis)) continue;
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
      .map((event) => `${event.uid}@${toUtcMillis(event.recurrenceId)}`)
  );

  const blocks = [];
  for (const event of parsedEvents) {
    if (!event.start) continue;
    if (event.status === "CANCELLED" || event.transparent) continue;
    // Every instance of a recurring event keeps the first instance's length.
    const length = toUtcMillis(instanceEnd(event.start, event)) - toUtcMillis(event.start);
    for (const start of expand(event, windowStart, windowEnd)) {
      if (!event.recurrenceId && overridden.has(`${event.uid}@${toUtcMillis(start)}`)) continue;
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
