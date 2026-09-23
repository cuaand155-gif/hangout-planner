// Turning a pencilled-in plan into a calendar event.
//
// Two routes, because no single one works everywhere:
//   * an .ics file, which Apple Calendar and Outlook open directly and which
//     carries a stable UID, so re-importing updates the event in place;
//   * a Google Calendar link, which opens a pre-filled "new event" form. Google
//     has no way to say "this is the same event as before" through a link, so
//     the app remembers that it was added (see app.js) rather than claiming it
//     cannot duplicate.

const DEFAULT_HOURS = 2;

/** 20260923T140000Z — the UTC form every calendar accepts. */
export function toIcsUtc(date) {
  const value = new Date(date);
  const pad = (number) => String(number).padStart(2, "0");
  return (
    `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}` +
    `T${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`
  );
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
export function escapeIcsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds a content line at 75 octets (not characters), continuing with a
 * leading space, without splitting a multi-byte character.
 */
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = "";
  let size = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += bytes;
  }
  parts.push(current);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join("\r\n");
}

/** Start and end of the chosen window; two hours when only a start is known. */
export function planEventWindow(plan) {
  if (!plan?.chosen) return null;
  const start = new Date(plan.chosen);
  if (Number.isNaN(start.getTime())) return null;
  let end = plan.chosenEnd ? new Date(plan.chosenEnd) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) {
    end = new Date(start.getTime() + DEFAULT_HOURS * 3600 * 1000);
  }
  return { start, end };
}

/**
 * The identity a calendar uses to recognise this event again. It depends on
 * the plan and the group, never on the time, so moving the plan updates the
 * existing event instead of adding a second one.
 */
export function planUid(plan, slug) {
  const planPart = plan?.id || `legacy-${String(plan?.activity || "plan").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
  const groupPart = String(slug || "group").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  // Kept from the app's old name so plans already added keep updating the same event.
  return `${planPart}.${groupPart}@gatherly`;
}

function planTitle(plan) {
  return plan.location ? `${plan.activity} · ${plan.location}` : plan.activity;
}

export function buildPlanIcs(plan, { slug, url, now = new Date() } = {}) {
  const window = planEventWindow(plan);
  if (!window) return null;
  // SEQUENCE must rise each time the event changes; the plan's last update
  // (in seconds) always does.
  const sequence = Math.max(0, Math.floor(new Date(plan.updatedAt || now).getTime() / 1000) - 1_700_000_000);
  const description = [`Planned with ${plan.audience || "your group"} on Waddle.`, url ? `Group: ${url}` : ""]
    .filter(Boolean)
    .join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Waddle//Hangout planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${planUid(plan, slug)}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${toIcsUtc(now)}`,
    `DTSTART:${toIcsUtc(window.start)}`,
    `DTEND:${toIcsUtc(window.end)}`,
    `SUMMARY:${escapeIcsText(planTitle(plan))}`,
    ...(plan.location ? [`LOCATION:${escapeIcsText(plan.location)}`] : []),
    `DESCRIPTION:${escapeIcsText(description)}`,
    ...(url ? [`URL:${url}`] : []),
    "STATUS:TENTATIVE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** Link that opens Google Calendar's new-event form, pre-filled. */
export function googleCalendarUrl(plan, { url } = {}) {
  const window = planEventWindow(plan);
  if (!window) return null;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: planTitle(plan),
    dates: `${toIcsUtc(window.start)}/${toIcsUtc(window.end)}`,
    details: [`Planned with ${plan.audience || "your group"} on Waddle.`, url ? `Group: ${url}` : ""].filter(Boolean).join("\n"),
  });
  if (plan.location) params.set("location", plan.location);
  return `https://calendar.google.com/calendar/render?${params}`;
}
