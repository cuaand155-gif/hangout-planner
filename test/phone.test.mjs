import { test } from "node:test";
import assert from "node:assert/strict";
import { contactKind, formatPhone, isValidPhone, normalizePhone, samePhone } from "../lib/phone.js";

test("normalizePhone gives E.164, assuming North America without a country code", () => {
  assert.equal(normalizePhone("(416) 555-0123"), "+14165550123");
  assert.equal(normalizePhone("1 416 555 0123"), "+14165550123");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("0044 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("555-0123"), "", "too short without an area code");
  assert.equal(normalizePhone("sam@example.com"), "");
  assert.equal(normalizePhone("+0 123 4567 890"), "");
  assert.equal(normalizePhone(""), "");
  assert.equal(isValidPhone("416-555-0123"), true);
});

test("the same number compares equal however it was typed", () => {
  assert.equal(samePhone("+14165550123", "14165550123"), true, "Supabase keeps phones without the +");
  assert.equal(samePhone("+14165550123", "+14165550124"), false);
  assert.equal(samePhone("", ""), false);
});

test("formatPhone and contactKind", () => {
  assert.equal(formatPhone("+14165550123"), "+1 416 555 0123");
  assert.equal(formatPhone("14165550123"), "+1 416 555 0123");
  assert.equal(formatPhone("+442079460958"), "+442079460958");
  assert.equal(contactKind("sam@example.com"), "email");
  assert.equal(contactKind("(416) 555-0123"), "phone");
  assert.equal(contactKind("sam"), "email");
  assert.equal(contactKind("  "), "");
});
