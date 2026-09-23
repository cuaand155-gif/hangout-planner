import test from "node:test";
import assert from "node:assert/strict";
import { isSafeImageDataUrl, squareCrop, AVATAR_MAX_LENGTH } from "../lib/avatar.js";

test("accepts small base64 jpeg/png/webp data URLs", () => {
  assert.ok(isSafeImageDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg=="));
  assert.ok(isSafeImageDataUrl("data:image/png;base64,iVBORw0KGgo="));
  assert.ok(isSafeImageDataUrl("data:image/webp;base64,UklGRg"));
});

test("rejects svg, non-base64, injected quotes and oversized data URLs", () => {
  assert.equal(isSafeImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isSafeImageDataUrl("data:image/png,<svg>"), false);
  assert.equal(isSafeImageDataUrl('data:image/png;base64,abc");background:url(x'), false);
  assert.equal(isSafeImageDataUrl(`data:image/png;base64,${"A".repeat(AVATAR_MAX_LENGTH)}`), false);
  assert.equal(isSafeImageDataUrl(""), false);
});

test("squareCrop centres the crop and never upscales", () => {
  assert.deepEqual(squareCrop(400, 300, 160), { sx: 50, sy: 0, side: 300, size: 160 });
  assert.deepEqual(squareCrop(300, 500, 160), { sx: 0, sy: 100, side: 300, size: 160 });
  assert.deepEqual(squareCrop(90, 120, 160), { sx: 0, sy: 15, side: 90, size: 90 });
});
