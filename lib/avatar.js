export const AVATAR_SIZE = 160;
export const AVATAR_MAX_LENGTH = 200_000;

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isSafeImageDataUrl(value) {
  const raw = String(value || "");
  return raw.length <= AVATAR_MAX_LENGTH && DATA_URL.test(raw);
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
