// Minimal PWA service worker: cache-first for the static JS/CSS/vendor
// bundle (so the app shell still loads offline / on a flaky connection),
// straight to the network for everything else -- paper data, audio, PDFs,
// and every /api/* call must always be live, never served stale from cache.
const CACHE_NAME = "researchpal-shell-v2";
const CACHEABLE_PREFIXES = ["/app/", "/assets/"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!CACHEABLE_PREFIXES.some((p) => url.pathname.startsWith(p))) return; // network-only

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
