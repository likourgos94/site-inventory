// Service worker: keeps a copy of the app on the phone so it opens without signal.
// When you change the app, raise the version number so phones pick up the new files.
const CACHE = "site-inventory-v2";
const FILES = [
  "/",
  "/app.js",
  "/style.css",
  "/xlsx.js",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Try the internet first (to get updates), but fall back to the saved copy
// if there is no signal or it takes longer than 4 seconds.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        // "no-cache" = always ask the server whether a file changed (cheap when it did not)
        const response = await fetch(event.request, { cache: "no-cache", signal: controller.signal });
        clearTimeout(timer);
        if (response.ok && !response.redirected) cache.put(event.request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        if (event.request.mode === "navigate") return (await cache.match("/")) || Response.error();
        return Response.error();
      }
    })(),
  );
});
