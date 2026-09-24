// Waddle's service worker: lets the home screen app open without a connection.
//
// Navigations and our own JS/CSS go network-first, so a deploy shows up on the
// next load and the cache is only a fallback for when you are offline. The API,
// Supabase and anything else cross-origin are never cached: they pass straight
// through to the network.

// Bump the version whenever SHELL changes; activate deletes the old cache.
const CACHE = "waddle-v2";

// The app shell: the page, every module app.js imports (directly or not), styles and icons.
const SHELL = [
  "/",
  "/app.js",
  "/booking-owner.js",
  "/styles.css",
  "/lib/appearance.js",
  "/lib/avatar.js",
  "/lib/booking.js",
  "/lib/calendar-export.js",
  "/lib/checklist.js",
  "/lib/friends.js",
  "/lib/hangout.js",
  "/lib/groups.js",
  "/lib/membership.js",
  "/lib/palettes.js",
  "/lib/planner.js",
  "/lib/presence.js",
  "/lib/pwa.js",
  "/lib/sharing.js",
  "/lib/sync.js",
  "/manifest.webmanifest",
  "/icons/favicon.svg",
  "/icons/icon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("waddle-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Not ours to cache: the API and every other origin (Supabase, fonts, the CDN).
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Every planner URL is the same page (the group lives in the query string), and
    // every /book/<handle> is book.html, so one cache entry covers each.
    const key = /^\/book(\/|$)/.test(url.pathname) ? "/book" : "/";
    event.respondWith(networkFirst(event, key));
  } else if (/\.(js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(event, url.pathname));
  } else {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
  }
});

async function networkFirst(event, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(event.request);
    if (response.ok && response.type === "basic") event.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}
