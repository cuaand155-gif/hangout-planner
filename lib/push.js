// Web Push helpers shared by the browser and the server. Pure: no network.

/** A VAPID public key (base64url) as the bytes pushManager.subscribe wants. */
export function urlBase64ToUint8Array(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = globalThis.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Whether this browser can take push notifications, and if not, why (so the
 * control can say so instead of failing). iPhones only allow it once Waddle is
 * on the home screen.
 */
export function pushSupport({ hasServiceWorker = false, hasPushManager = false, hasNotification = false, standalone = false, ios = false } = {}) {
  if (ios && !standalone) return { supported: false, reason: "ios-home-screen" };
  if (!hasServiceWorker || !hasPushManager || !hasNotification) return { supported: false, reason: "unsupported" };
  return { supported: true, reason: "" };
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** Checks a PushSubscription's JSON before it's stored. Returns the clean row fields, or null. */
export function cleanSubscription(input) {
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint.trim() : "";
  const p256dh = input?.keys?.p256dh;
  const auth = input?.keys?.auth;
  if (!endpoint || endpoint.length > 1000) return null;
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (typeof p256dh !== "string" || p256dh.length < 20 || p256dh.length > 200 || !BASE64URL.test(p256dh)) return null;
  if (typeof auth !== "string" || auth.length < 8 || auth.length > 100 || !BASE64URL.test(auth)) return null;
  return { endpoint, p256dh, auth };
}
