// Service Worker for Preview PWA — enables fully offline operation
const CACHE_NAME = "preview-pwa-v3";

// Install — keep minimal to avoid hard-failing on missing generated icons
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
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
  // Network-first while online; do NOT cache the server response — it is the
  // React app shell which depends on localStorage. The standalone HTML
  // (fully self-contained) is stored by cacheForOffline() in PreviewClient.
  // Caching the Next.js response would overwrite the standalone and cause
  // "No Preview Available" when opening the PWA offline or in standalone mode.
  if (
    event.request.mode === "navigate" &&
    url.pathname.startsWith("/preview/")
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);

        // Prefer the cached standalone preview page so installed PWAs don't
        // depend on the live dev server/localStorage app shell.
        const noQuery = new Request(url.origin + url.pathname);
        const trimmedPath = url.pathname.endsWith("/")
          ? url.pathname.slice(0, -1)
          : url.pathname;
        const withSlashPath = trimmedPath + "/";
        const trailingSlash = new Request(url.origin + withSlashPath);
        const withoutTrailingSlash = new Request(url.origin + trimmedPath);

        const cached =
          (await cache.match(event.request, { ignoreSearch: true })) ||
          (await cache.match(noQuery, { ignoreSearch: true })) ||
          (await cache.match(withoutTrailingSlash, { ignoreSearch: true })) ||
          (await cache.match(trailingSlash, { ignoreSearch: true }));

        if (cached) return cached;

        try {
          return await fetch(event.request);
        } catch {
          return new Response(
            "<html><body style='display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;color:#71717a'>" +
              "<div style='text-align:center'><h1 style='color:#18181b'>Offline</h1><p>This preview is not available offline yet. Open it once while online to enable offline access.</p></div>" +
              "</body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }
      })()
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
