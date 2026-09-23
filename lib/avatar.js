export const AVATAR_SIZE = 160;
export const AVATAR_MAX_LENGTH = 200_000;

// Photos on activity-idea cards: a 16:10 cover, small enough that a group can
// keep several of them inside the shared workspace blob.
export const IDEA_PHOTO_WIDTH = 720;
export const IDEA_PHOTO_HEIGHT = 450;
export const IDEA_PHOTO_MAX_LENGTH = 120_000;

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isSafeImageDataUrl(value, maxLength = AVATAR_MAX_LENGTH) {
  const raw = String(value || "");
  return raw.length <= maxLength && DATA_URL.test(raw);
}

// Centre-crop a width x height image to a square and scale it down to size.
export function squareCrop(width, height, size = AVATAR_SIZE) {
  const side = Math.min(width, height);
  return {
    sx: Math.round((width - side) / 2),
    sy: Math.round((height - side) / 2),
    side,
    size: Math.max(1, Math.min(size, side)),
  };
}

/**
 * Centre-crops a width x height image to the targetW:targetH aspect ratio
 * (like CSS `object-fit: cover`) and scales it down to fit targetW x targetH.
 * Returns the source rectangle (sx, sy, sw, sh) and the output size. Never
 * upscales, so a small photo keeps its own resolution.
 */
export function coverCrop(width, height, targetW, targetH) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const tw = Math.max(1, Math.round(Number(targetW) || 0));
  const th = Math.max(1, Math.round(Number(targetH) || 0));
  const ratio = tw / th;
  const sw = w / h > ratio ? Math.max(1, Math.round(h * ratio)) : w;
  const sh = w / h > ratio ? h : Math.max(1, Math.round(w / ratio));
  const scale = Math.min(1, tw / sw);
  return {
    sx: Math.round((w - sw) / 2),
    sy: Math.round((h - sh) / 2),
    sw,
    sh,
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
  };
}
