// Home screen app support: registering the service worker (sw.js) and deciding
// which "Add Waddle to your home screen" hint a device should see.

/** Registers /sw.js after load. Add ?nosw on localhost to develop without it. Failures stay silent. */
export function registerServiceWorker() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const { hostname, search } = window.location;
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (local && new URLSearchParams(search).has("nosw")) return;
    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  } catch {
    /* Blocked storage or a sandboxed frame: the app works the same without it. */
  }
}

/** True when Waddle is already running as an installed app. */
export function isStandalone() {
  return Boolean(window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone);
}

/** iPhone, iPod or iPad (iPadOS reports itself as a Mac with a touch screen). */
export function isIos(userAgent = "", maxTouchPoints = 0) {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/**
 * Which install hint to show: "prompt" when the browser offered its own install
 * dialog (beforeinstallprompt), "ios" for the Share → Add to Home Screen steps,
 * "none" when already installed or the browser has no way to install.
 */
export function installMode({ standalone = false, canPrompt = false, userAgent = "", maxTouchPoints = 0 } = {}) {
  if (standalone) return "none";
  if (canPrompt) return "prompt";
  return isIos(userAgent, maxTouchPoints) ? "ios" : "none";
}
