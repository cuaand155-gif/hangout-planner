import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { installMode, isIos } from "../lib/pwa.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path.replace(/^\//, ""), root));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path) {
  const bytes = read(path);
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", `${path} is a PNG`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test("the manifest is valid and every icon exists at its stated size", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.name, "Waddle");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of manifest.icons) assert.equal(pngSize(icon.src), icon.sizes);
  assert.equal(pngSize("/icons/apple-touch-icon.png"), "180x180");
});

test("the service worker never caches the API or other sites", () => {
  const source = read("sw.js").toString();
  assert.match(source, /url\.origin !== self\.location\.origin \|\| url\.pathname\.startsWith\("\/api\/"\)\) return;/);
});

test("the offline shell lists files that exist, including every module the app loads", () => {
  const source = read("sw.js").toString();
  const shell = JSON.parse(source.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));
  for (const path of shell) if (path !== "/") assert.ok(existsSync(new URL(path.slice(1), root)), `${path} exists`);

  // Walk app.js's imports so a new module can't be forgotten.
  const seen = new Set();
  const walk = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    for (const [, spec] of read(path).toString().matchAll(/from "(\.[^"]+)"/g)) {
      walk(new URL(spec, `http://x${dir}`).pathname);
    }
  };
  walk("/app.js");
  for (const path of seen) assert.ok(shell.includes(path), `${path} is in the offline shell`);
});

test("install hints: the browser's own prompt, iPhone steps, or nothing once installed", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
  assert.equal(installMode({ standalone: true, canPrompt: true }), "none");
  assert.equal(installMode({ canPrompt: true }), "prompt");
  assert.equal(installMode({ userAgent: iphone }), "ios");
  assert.ok(isIos(ipad, 5), "iPadOS reports a Mac with touch");
  assert.ok(!isIos(ipad, 0), "a real Mac is not iOS");
  assert.equal(installMode({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0" }), "none");
});
