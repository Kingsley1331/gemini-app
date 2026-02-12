// Service Worker for Preview PWA — enables fully offline operation
const CACHE_NAME = "preview-pwa-v1";

// Only pre-cache local assets (CDN scripts are cached on-demand when
// loaded via <script> tags, which don't have CORS restrictions)
const PRECACHE_URLS = ["/icons/icon-192.png", "/icons/icon-512.png"];

// Install — pre-cache local assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean up old caches and take control immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch handler
// - Navigation to /preview/*: cache-first (serves the standalone HTML that
//   the page wrote into the cache on first load — works without the server)
// - Everything else: network-first with cache fallback (caches CDN scripts
//   on first successful load so they're available offline later)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Navigation requests to /preview/* — serve cached standalone HTML
  if (
    event.request.mode === "navigate" &&
    url.pathname.startsWith("/preview/")
  ) {
    event.respondWith(
      caches
        .match(event.request)
        .then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(event.request, clone));
            }
            return response;
          });
        })
        .catch(() => {
          return new Response(
            "<html><body style='display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;color:#71717a'>" +
              "<div style='text-align:center'><h1 style='color:#18181b'>Offline</h1><p>This preview is not available offline yet.</p></div>" +
              "</body></html>",
            { headers: { "Content-Type": "text/html" } }
          );
        })
    );
    return;
  }

  // All other requests — network-first, cache on success, serve cache on failure
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response &&
          response.status === 200 &&
          event.request.method === "GET"
        ) {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          return new Response("Offline", {
            status: 503,
            statusText: "Service Unavailable",
          });
        });
      })
  );
});
