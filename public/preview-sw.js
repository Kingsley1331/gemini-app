// Service Worker for Preview PWA — enables fully offline operation
const CACHE_NAME = "preview-pwa-v5";

// ---------------------------------------------------------------------------
// IndexedDB helpers — the SW cannot access localStorage, so IndexedDB is the
// durable fallback when the Cache API is evicted by the browser.
// ---------------------------------------------------------------------------
const IDB_NAME = "preview-pwa-db";
const IDB_VERSION = 1;
const IDB_STORE = "previews";

function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(id) {
  return openIDB().then((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }),
  );
}

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

  async function matchAnyCachedAssetByKey(cache, assetKey) {
    try {
      const requests = await cache.keys();
      for (let i = requests.length - 1; i >= 0; i -= 1) {
        const req = requests[i];
        const reqUrl = new URL(req.url);
        const match = reqUrl.pathname.match(/^\/preview\/[^/]+\/assets\/([^/?#]+)/);
        if (!match) continue;
        const key = decodeURIComponent(match[1] || "");
        if (key !== assetKey) continue;
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
      }
    } catch {
      // ignore and return null below
    }
    return null;
  }

  // ── Legacy unresolved placeholder URLs ──
  // Some generated code may still reference "__ASSET_key__" directly. When this
  // happens inside /preview/{id}, the browser requests /preview/__ASSET_key__.
  // Resolve that to /preview/{id}/assets/{key} using the active client URL.
  const unresolvedMatch = url.pathname.match(/^\/preview\/__ASSET_([a-zA-Z0-9_-]+)__$/);
  if (unresolvedMatch) {
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(CACHE_NAME);
          const client =
            (event.clientId && (await self.clients.get(event.clientId))) ||
            (event.resultingClientId && (await self.clients.get(event.resultingClientId)));
          const referrerUrl = event.request.referrer ? new URL(event.request.referrer) : null;
          const clientUrl = client ? new URL(client.url) : referrerUrl;
          const idMatch = clientUrl?.pathname.match(/^\/preview\/([^/]+)/);
          const previewId = idMatch?.[1];
          const assetKey = unresolvedMatch[1];
          if (previewId && assetKey) {
            const rewritten = `/preview/${encodeURIComponent(previewId)}/assets/${encodeURIComponent(assetKey)}`;
            const cached =
              (await cache.match(new Request(rewritten), { ignoreSearch: true })) ||
              (await cache.match(rewritten, { ignoreSearch: true }));
            if (cached) return cached;
          }
          if (assetKey) {
            const crossIdHit = await matchAnyCachedAssetByKey(cache, assetKey);
            if (crossIdHit) return crossIdHit;
          }
        } catch {
          // fall through to default response below
        }
        return new Response("Asset not cached", { status: 404 });
      })()
    );
    return;
  }

  // ── Cached preview assets (sprites/backgrounds/etc.) ──
  if (/^\/preview\/[^/]+\/assets\//.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached =
          (await cache.match(event.request, { ignoreSearch: true })) ||
          (await cache.match(new Request(url.origin + url.pathname), { ignoreSearch: true }));
        if (cached) return cached;
        const keyMatch = url.pathname.match(/^\/preview\/[^/]+\/assets\/([^/?#]+)/);
        const assetKey = keyMatch ? decodeURIComponent(keyMatch[1] || "") : "";
        if (assetKey) {
          const crossIdHit = await matchAnyCachedAssetByKey(cache, assetKey);
          if (crossIdHit) return crossIdHit;
        }
        return new Response("Asset not cached", { status: 404 });
      })()
    );
    return;
  }

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

        // Cache miss — try IndexedDB as a durable fallback. The browser can
        // evict Cache API entries under storage pressure, but IndexedDB
        // (especially with persistent storage granted) is much more resilient.
        try {
          const idMatch = url.pathname.match(/^\/preview\/([^/]+)/);
          const previewId = idMatch ? decodeURIComponent(idMatch[1]) : null;
          if (previewId) {
            const record = await idbGet(previewId);
            if (record && record.standaloneHTML) {
              const headers = { "Content-Type": "text/html; charset=utf-8" };
              const resp = new Response(record.standaloneHTML, { headers });
              // Self-heal: restore the Cache API entries so future loads are fast
              cache.put(new Request(url.origin + trimmedPath), new Response(record.standaloneHTML, { headers }));
              cache.put(new Request(url.origin + withSlashPath), new Response(record.standaloneHTML, { headers }));
              return resp;
            }
          }
        } catch {
          // IDB unavailable — fall through to network
        }

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
