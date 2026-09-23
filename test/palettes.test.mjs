import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PALETTES, DEFAULT_PALETTE, normalizePalette } from "../lib/palettes.js";

test("unknown or missing palettes fall back to the default", () => {
  assert.equal(normalizePalette("plum"), "plum");
  assert.equal(normalizePalette("neon"), DEFAULT_PALETTE);
  assert.equal(normalizePalette(null), DEFAULT_PALETTE);
});

test("every non-default palette has a stylesheet block", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const { id } of PALETTES.filter((p) => p.id !== DEFAULT_PALETTE)) {
    assert.match(css, new RegExp(`:root\\[data-palette="${id}"\\]\\{[^}]*--purple:`));
  }
});
