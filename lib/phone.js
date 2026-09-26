// Phone numbers, for signing in with a text message and for friend requests.
//
// Everything is kept in E.164 ("+15551234567"), the form Supabase Auth sends
// codes to. A number typed without a country code is taken as North American
// (+1), since that is where Waddle's first users are; anyone else types the
// "+" and their country code.

const DEFAULT_COUNTRY = "1";

/** "+15551234567" for anything that reads as a phone number, or "" when it doesn't. */
export function normalizePhone(value, { country = DEFAULT_COUNTRY } = {}) {
  const raw = String(value || "").trim();
  if (!raw || /[a-z@]/i.test(raw)) return "";
  const international = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) digits = digits.slice(2);
  if (!international) {
    if (country === "1" && digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    if (country === "1" && digits.length !== 10) return "";
    digits = `${country}${digits}`;
  }
  // E.164: a country code and number of 8 to 15 digits, never starting with 0.
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return "";
  return `+${digits}`;
}

export function isValidPhone(value) {
  return Boolean(normalizePhone(value));
}

/** Just the digits: how two spellings of one number are compared. */
export function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function samePhone(a, b) {
  const left = phoneDigits(a);
  return Boolean(left) && left === phoneDigits(b);
}

/** "+1 555 123 4567" for North American numbers, the E.164 form otherwise. */
export function formatPhone(value) {
  const phone = normalizePhone(value) || (phoneDigits(value) ? `+${phoneDigits(value)}` : "");
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `+1 ${match[1]} ${match[2]} ${match[3]}` : phone;
}

/** Tells an email address from a phone number in the one box that takes both. */
export function contactKind(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return "email";
  return /^[+\d\s().-]+$/.test(raw) ? "phone" : "email";
}
