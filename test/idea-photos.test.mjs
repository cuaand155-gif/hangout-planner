import test from "node:test";
import assert from "node:assert/strict";
import { AVATAR_MAX_LENGTH, IDEA_PHOTO_HEIGHT, IDEA_PHOTO_MAX_LENGTH, IDEA_PHOTO_WIDTH, coverCrop, isSafeImageDataUrl } from "../lib/avatar.js";
import { LIMITS, normalizeWorkspaceState, stateTooLarge } from "../lib/planner.js";
import workspaceHandler from "../api/workspace.js";

const PREFIX = "data:image/jpeg;base64,";
const jpeg = (length) => `${PREFIX}${"A".repeat(length - PREFIX.length)}`;

test("coverCrop trims a wide photo to 16:10 and scales it down", () => {
  assert.deepEqual(coverCrop(4000, 2000, 720, 450), { sx: 400, sy: 0, sw: 3200, sh: 2000, width: 720, height: 450 });
});

test("coverCrop trims a tall photo top and bottom", () => {
  assert.deepEqual(coverCrop(3024, 4032, 720, 450), { sx: 0, sy: 1071, sw: 3024, sh: 1890, width: 720, height: 450 });
});

test("coverCrop keeps an exact 16:10 photo whole and never upscales", () => {
  assert.deepEqual(coverCrop(1440, 900, 720, 450), { sx: 0, sy: 0, sw: 1440, sh: 900, width: 720, height: 450 });
  assert.deepEqual(coverCrop(720, 450, 720, 450), { sx: 0, sy: 0, sw: 720, sh: 450, width: 720, height: 450 });
  assert.deepEqual(coverCrop(320, 320, 720, 450), { sx: 0, sy: 60, sw: 320, sh: 200, width: 320, height: 200 });
});

test("coverCrop always stays inside the source and within the target", () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [4032, 3024], [800, 801], [5000, 400], [37, 1000]]) {
    const crop = coverCrop(width, height, IDEA_PHOTO_WIDTH, IDEA_PHOTO_HEIGHT);
    assert.ok(crop.width <= IDEA_PHOTO_WIDTH && crop.height <= IDEA_PHOTO_HEIGHT, `${width}x${height} fits the target`);
    assert.ok(crop.sx >= 0 && crop.sy >= 0, `${width}x${height} starts inside the source`);
    assert.ok(crop.sx + crop.sw <= width && crop.sy + crop.sh <= height, `${width}x${height} ends inside the source`);
    assert.ok(Math.abs(crop.sw / crop.sh - 1.6) < 0.05, `${width}x${height} crop is 16:10`);
  }
});

test("coverCrop survives zero and junk sizes", () => {
  const crop = coverCrop(0, Number.NaN, 720, 450);
  assert.ok(crop.width >= 1 && crop.height >= 1 && crop.sw >= 1 && crop.sh >= 1);
});

test("isSafeImageDataUrl honours a custom max length and keeps the avatar default", () => {
  assert.ok(isSafeImageDataUrl(jpeg(IDEA_PHOTO_MAX_LENGTH), IDEA_PHOTO_MAX_LENGTH));
  assert.equal(isSafeImageDataUrl(jpeg(IDEA_PHOTO_MAX_LENGTH + 1), IDEA_PHOTO_MAX_LENGTH), false);
  assert.ok(isSafeImageDataUrl(jpeg(IDEA_PHOTO_MAX_LENGTH + 1)), "the avatar default is larger");
  assert.ok(isSafeImageDataUrl(jpeg(AVATAR_MAX_LENGTH)));
  assert.equal(isSafeImageDataUrl(jpeg(AVATAR_MAX_LENGTH + 1)), false);
  assert.equal(isSafeImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=", IDEA_PHOTO_MAX_LENGTH), false);
});

const withIdeaPhoto = (photo) =>
  normalizeWorkspaceState({ members: [{ id: "a", name: "Jamie" }], ideas: [{ id: "i1", title: "Picnic", votes: ["a"], photo }] }).ideas[0];

test("normalizeWorkspaceState keeps a valid idea photo", () => {
  const photo = jpeg(80_000);
  assert.equal(withIdeaPhoto(photo).photo, photo);
  assert.equal(withIdeaPhoto("data:image/png;base64,iVBORw0KGgo=").photo, "data:image/png;base64,iVBORw0KGgo=");
});

test("normalizeWorkspaceState drops unsafe or oversized idea photos", () => {
  for (const photo of [
    "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
    "javascript:alert(1)",
    "https://example.com/photo.jpg",
    'data:image/png;base64,abc");background:url(x',
    jpeg(IDEA_PHOTO_MAX_LENGTH + 1),
    42,
    { src: "x" },
  ]) {
    const idea = withIdeaPhoto(photo);
    assert.equal("photo" in idea, false, `${String(photo).slice(0, 40)} is dropped`);
    assert.equal(idea.title, "Picnic", "the rest of the idea survives");
  }
  assert.equal("photo" in withIdeaPhoto(undefined), false);
});

test("a group with eight full-size idea photos still fits, sixty do not", () => {
  const members = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, name: `Member ${index}` }));
  const ideas = (count) =>
    Array.from({ length: count }, (_, index) => ({ id: `i${index}`, title: `Idea ${index}`, votes: ["m0"], photo: jpeg(IDEA_PHOTO_MAX_LENGTH) }));
  const eight = normalizeWorkspaceState({ members, ideas: ideas(8) });
  assert.equal(eight.ideas.filter((idea) => idea.photo).length, 8);
  assert.equal(stateTooLarge(eight), false);
  assert.equal(stateTooLarge(normalizeWorkspaceState({ members, ideas: ideas(LIMITS.ideas) })), true);
});

function mockResponse() {
  const captured = { status: null, body: null };
  return {
    captured,
    setHeader() {},
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
}

const put = async (state) => {
  const response = mockResponse();
  await workspaceHandler({ method: "PUT", query: { slug: "photo-test" }, headers: {}, body: { state } }, response);
  return response.captured;
};

test("the workspace API refuses a state that is too large, even without a database", async () => {
  const ideas = Array.from({ length: 20 }, (_, index) => ({ id: `i${index}`, title: `Idea ${index}`, photo: jpeg(IDEA_PHOTO_MAX_LENGTH) }));
  const result = await put({ ideas });
  assert.equal(result.status, 413);
  assert.match(result.body.error, /too large/i);
});

test("the workspace API echoes idea photos back in demo mode", async () => {
  const photo = jpeg(60_000);
  const result = await put({ ideas: [{ id: "i1", title: "Picnic", photo }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.ideas[0].photo, photo);
});
