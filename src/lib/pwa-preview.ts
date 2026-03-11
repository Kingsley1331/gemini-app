"use client";

export type StoredPreviewAsset = {
  assetKey: string;
  mimeType: string;
  data?: string;
  url?: string;
  displayName?: string;
  rolePrompt?: string;
  sourceType?: "upload" | "generated" | "edited";
  svgText?: string;
};

type StoredPreviewAssetRecord = {
  assetKey: string;
  mimeType: string;
  displayName?: string;
  rolePrompt?: string;
  sourceType?: "upload" | "generated" | "edited";
  svgText?: string;
};

type PreviewAssetInput = {
  assetKey?: string;
  mimeType?: string;
  data?: string;
  url?: string;
  displayName?: string;
  rolePrompt?: string;
  sourceType?: "upload" | "generated" | "edited";
  svgText?: string;
};

const SW_CACHE_NAME = "preview-pwa-v5";
const ICON_CACHE_NAME = "preview-pwa-v6";
const LEGACY_PREVIEW_CACHE_NAME = "preview-pwa-v6";

export function createPwaPreviewId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function buildPreviewAssetUrl(id: string, assetKey: string): string {
  return `/preview/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetKey)}`;
}

function buildGeneratedIconUrl(id: string, size: 192 | 512, version?: number): string {
  const baseUrl = `/api/preview/${encodeURIComponent(id)}/generate-icon?size=${size}`;
  return typeof version === "number" && Number.isFinite(version) && version > 0
    ? `${baseUrl}&v=${version}`
    : baseUrl;
}

function base64ToResponse(b64: string): Response {
  const raw = window.atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return new Response(bytes, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}

function listPreviewLocalStorageKeys(id: string): string[] {
  const prefix = `pwa-preview-${id}-`;
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
  } catch {
    return [];
  }
  return keys;
}

function isAppScopedCacheRequest(request: Request, id: string): boolean {
  try {
    const url = new URL(request.url, window.location.origin);
    const encodedId = encodeURIComponent(id);
    return (
      url.pathname.startsWith(`/preview/${encodedId}/assets/`) ||
      url.pathname === `/api/preview/${encodedId}/generate-icon`
    );
  } catch {
    return false;
  }
}

export function readPreviewAssets(id: string): StoredPreviewAsset[] {
  try {
    const raw = localStorage.getItem(`pwa-preview-${id}-assets`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.assetKey === "string");
  } catch {
    return [];
  }
}

export async function persistPwaPreviewAssets(
  id: string,
  assets: PreviewAssetInput[] | undefined,
) {
  const normalized = (assets || []).map((asset, index) => ({
    assetKey: asset.assetKey || `asset_${index + 1}`,
    mimeType: asset.mimeType || "image/png",
    data: asset.data || "",
    url: asset.url || "",
    displayName: asset.displayName || "",
    rolePrompt: asset.rolePrompt || "",
    sourceType: asset.sourceType,
    svgText: asset.svgText || "",
  }));
  const lightweightRecords: StoredPreviewAssetRecord[] = normalized.map((asset) => ({
    assetKey: asset.assetKey,
    mimeType: asset.mimeType,
    displayName: asset.displayName || undefined,
    rolePrompt: asset.rolePrompt || undefined,
    sourceType: asset.sourceType,
    svgText: asset.svgText || undefined,
  }));

  try {
    localStorage.setItem(`pwa-preview-${id}-assets`, JSON.stringify(lightweightRecords));
  } catch {
    // best-effort; the cache below is the primary source for larger assets
  }

  try {
    const cache = await caches.open(SW_CACHE_NAME);
    await Promise.allSettled(
      normalized.map(async (asset) => {
        const targetUrl = buildPreviewAssetUrl(id, asset.assetKey);
        let response: Response | null = null;

        if (asset.data) {
          const binaryString = window.atob(asset.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i += 1) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          response = new Response(bytes, {
            headers: {
              "Content-Type": asset.mimeType || "image/png",
              "Cache-Control": "public, max-age=31536000",
            },
          });
        } else if (asset.url) {
          try {
            const fetched = await fetch(asset.url, { mode: "cors" });
            if (fetched.ok) {
              response = fetched;
            }
          } catch {
            try {
              const fetched = await fetch(asset.url, { mode: "no-cors" });
              response = fetched;
            } catch {
              response = null;
            }
          }
        }

        if (response) {
          await cache.put(new Request(targetUrl), response);
        }
      }),
    );
  } catch {
    // best-effort; localStorage metadata still allows legacy fallback paths
  }
}

export async function cacheGeneratedPreviewIcons(
  id: string,
  icons: {
    icon192b64?: string | null;
    icon512b64?: string | null;
    version?: number;
  },
) {
  const { icon192b64, icon512b64, version } = icons;
  if (!icon192b64 && !icon512b64) return;

  try {
    const cache = await caches.open(ICON_CACHE_NAME);
    if (icon192b64) {
      const response192 = base64ToResponse(icon192b64);
      await cache.put(new Request(buildGeneratedIconUrl(id, 192)), response192.clone());
      if (version) {
        await cache.put(new Request(buildGeneratedIconUrl(id, 192, version)), response192.clone());
      }
    }
    if (icon512b64) {
      const response512 = base64ToResponse(icon512b64);
      await cache.put(new Request(buildGeneratedIconUrl(id, 512)), response512.clone());
      if (version) {
        await cache.put(new Request(buildGeneratedIconUrl(id, 512, version)), response512.clone());
      }
    }
  } catch {
    // best-effort; the icon route still provides the canonical source
  }
}

export async function purgePwaPreviewLocalArtifacts(id: string): Promise<void> {
  for (const key of listPreviewLocalStorageKeys(id)) {
    try {
      localStorage.removeItem(key);
    } catch {
      // best-effort
    }
  }

  try {
    const cacheNames = Array.from(new Set([SW_CACHE_NAME, ICON_CACHE_NAME, LEGACY_PREVIEW_CACHE_NAME]));
    await Promise.allSettled(
      cacheNames.map(async (cacheName) => {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        await Promise.allSettled(
          requests
            .filter((request) => isAppScopedCacheRequest(request, id))
            .map((request) => cache.delete(request)),
        );
      }),
    );
  } catch {
    // best-effort; local storage and IDB remain the canonical local cleanup
  }
}
