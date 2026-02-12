// Service Worker for Preview PWA — enables fully offline operation
const CACHE_NAME = "preview-pwa-v1";

// Install — pre-cache local icon assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(["/icons/icon-192.png", "/icons/icon-512.png"])
      )
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
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // ── Navigation to /preview/* ──
  // Cache-first: serve the standalone HTML that was cached by the page.
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
              "<div style='text-align:center'><h1 style='color:#18181b'>Offline</h1><p>This preview is not available offline yet. Open it once while online to enable offline access.</p></div>" +
              "</body></html>",
            { headers: { "Content-Type": "text/html" } }
          );
        })
    );
    return;
  }

  // ── CDN and other cross-origin requests ──
  // Cache-first: these were pre-cached by cacheForOffline() and don't change.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // Not cached yet — fetch and cache for next time
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
    );
    return;
  }

  // ── Same-origin requests (manifest, icons, etc.) ──
  // Cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
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
          return new Response("Offline", {
            status: 503,
            statusText: "Service Unavailable",
          });
        });
    })
  );
});
