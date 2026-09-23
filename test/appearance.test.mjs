import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPEARANCES, DEFAULT_APPEARANCE, THEME_COLORS, normalizeAppearance, resolveTheme } from "../lib/appearance.js";
import { PALETTES, DEFAULT_PALETTE } from "../lib/palettes.js";

test("unknown or missing appearances fall back to auto", () => {
  assert.equal(DEFAULT_APPEARANCE, "auto");
  assert.equal(normalizeAppearance("dark"), "dark");
  assert.equal(normalizeAppearance("light"), "light");
  assert.equal(normalizeAppearance("auto"), "auto");
  assert.equal(normalizeAppearance("sepia"), "auto");
  assert.equal(normalizeAppearance(null), "auto");
  assert.equal(normalizeAppearance(undefined), "auto");
});

test("auto follows the system setting", () => {
  assert.equal(resolveTheme("auto", true), "dark");
  assert.equal(resolveTheme("auto", false), "light");
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme("sepia", false), "light");
});

test("light and dark ignore the system setting", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("every resolved theme has a browser chrome colour", () => {
  for (const { id } of APPEARANCES) {
    for (const system of [true, false]) assert.match(THEME_COLORS[resolveTheme(id, system)], /^#[0-9a-f]{6}$/);
  }
});

test("the stylesheet lifts every palette's accent in dark mode", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /:root\[data-theme="dark"\]\{[^}]*--purple:/);
  for (const { id } of PALETTES.filter((p) => p.id !== DEFAULT_PALETTE)) {
    assert.match(css, new RegExp(`:root\\[data-theme="dark"\\]\\[data-palette="${id}"\\]\\{[^}]*--purple:`));
  }
});

test("the head script applies the stored appearance before paint", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /localStorage\.getItem\("gatherly-appearance"\)/);
  assert.match(head, /prefers-color-scheme: ?dark/);
  assert.match(head, /dataset\.theme/);
});
