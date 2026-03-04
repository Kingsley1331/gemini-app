"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  savePreviewToIDB,
  getPreviewFromIDB,
  requestPersistentStorage,
} from "@/lib/preview-idb";

const SW_CACHE_NAME = "preview-pwa-v6";

// CDN scripts used by the preview — must be cached for offline support
const CDN_URLS = [
  "https://unpkg.com/@babel/standalone/babel.min.js",
  "https://unpkg.com/react@18/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  "https://unpkg.com/lucide@latest",
  "https://cdn.tailwindcss.com",
];

interface PreviewData {
  code: string;
  language: string;
  name: string;
  hasGeneratedIconHint?: boolean;
}

interface StoredPreviewAsset {
  assetKey: string;
  mimeType: string;
  data?: string;
  url?: string;
}

interface SharedPreviewResponse {
  id: string;
  code: string;
  language: string;
  name: string;
  hasGeneratedIcon: boolean;
  assets?: Array<{
    assetKey: string;
    mimeType: string;
  }>;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function getInstallHelpMessage(): string {
  const ua = navigator.userAgent || "";
  const isAndroid = /Android/i.test(ua);
  const isSamsungInternet = /SamsungBrowser/i.test(ua);
  const isEdge = /EdgA|EdgiOS|Edg\//i.test(ua);
  const isFirefox = /Firefox|FxiOS/i.test(ua);
  const isChrome = /Chrome|CriOS/i.test(ua) && !isEdge && !isSamsungInternet;

  if (isSamsungInternet) {
    return "Open the menu (three lines) and tap Add page to > Home screen.";
  }
  if (isEdge) {
    return "Open the menu (three dots) and tap Apps, then Install this site.";
  }
  if (isFirefox) {
    return "Open the browser menu and tap Install, or use Add to Home screen.";
  }
  if (isChrome && isAndroid) {
    return "Open the menu (three dots) and tap Install app or Add to Home screen.";
  }
  if (isAndroid) {
    return "Open your browser menu and tap Add to Home screen or Install app.";
  }
  return "Open your browser menu and choose Install app or Add to Home screen.";
}

function buildPreviewAssetUrl(id: string, assetKey: string): string {
  return `/preview/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetKey)}`;
}

const EXTERNAL_IMPORT_BLOCKLIST = new Set([
  "fs",
  "path",
  "os",
  "net",
  "tls",
  "http",
  "https",
  "zlib",
  "stream",
  "child_process",
  "worker_threads",
  "node:fs",
  "node:path",
  "node:os",
  "node:net",
  "node:tls",
  "node:http",
  "node:https",
  "node:zlib",
  "node:stream",
  "node:child_process",
  "node:worker_threads",
]);

function buildExternalImportPreamble(sourceCode: string): string {
  const importFromRegex = /(^|\n)\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/g;
  const sideEffectRegex = /(^|\n)\s*import\s+['"]([^'"]+)['"]\s*;?/g;
  const lines: string[] = [];
  let moduleCount = 0;

  const shouldResolveDynamically = (specifier: string): boolean => {
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("next/")
    ) {
      return false;
    }
    if (
      specifier === "react" ||
      specifier === "react-dom" ||
      specifier === "lucide-react"
    ) {
      return false;
    }
    const bareName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    return !EXTERNAL_IMPORT_BLOCKLIST.has(bareName);
  };

  const mapNamedImports = (namedBlock: string): string =>
    namedBlock
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !part.startsWith("type "))
      .map((part) => {
        const segments = part.split(/\s+as\s+/);
        const left = segments[0]?.trim();
        const right = segments[1]?.trim();
        return right ? `${left}: ${right}` : left;
      })
      .filter(Boolean)
      .join(", ");

  let match: RegExpExecArray | null;
  while ((match = importFromRegex.exec(sourceCode)) !== null) {
    const rawClause = match[2]?.trim() || "";
    const specifier = match[3]?.trim() || "";
    if (!rawClause || rawClause.startsWith("type ") || !specifier) continue;
    if (!shouldResolveDynamically(specifier)) continue;

    const modVar = `__extMod${moduleCount++}`;
    lines.push(`const ${modVar} = await __importFrom("${specifier}");`);

    const defaultAndNamed = rawClause.match(
      /^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*)\}$/,
    );
    const namespaceImport = rawClause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    const namedOnlyImport = rawClause.match(/^\{([\s\S]*)\}$/);
    const defaultOnlyImport = rawClause.match(/^([A-Za-z_$][\w$]*)$/);

    if (defaultAndNamed) {
      const defaultLocal = defaultAndNamed[1];
      const mappedNamed = mapNamedImports(defaultAndNamed[2]);
      lines.push(`const ${defaultLocal} = ${modVar}.default ?? ${modVar};`);
      if (mappedNamed) lines.push(`const { ${mappedNamed} } = ${modVar};`);
      continue;
    }

    if (namespaceImport) {
      lines.push(`const ${namespaceImport[1]} = ${modVar};`);
      continue;
    }

    if (namedOnlyImport) {
      const mappedNamed = mapNamedImports(namedOnlyImport[1]);
      if (mappedNamed) lines.push(`const { ${mappedNamed} } = ${modVar};`);
      continue;
    }

    if (defaultOnlyImport) {
      lines.push(`const ${defaultOnlyImport[1]} = ${modVar}.default ?? ${modVar};`);
    }
  }

  while ((match = sideEffectRegex.exec(sourceCode)) !== null) {
    const specifier = match[2]?.trim() || "";
    if (!specifier || !shouldResolveDynamically(specifier)) continue;
    lines.push(`await __importFrom("${specifier}");`);
  }

  return lines.join("\n");
}

function readPreviewData(id: string): PreviewData | null {
  const code = localStorage.getItem(`pwa-preview-${id}-code`);
  if (!code) return null;
  return {
    code,
    language: localStorage.getItem(`pwa-preview-${id}-language`) || "jsx",
    name: localStorage.getItem(`pwa-preview-${id}-name`) || "My App",
    hasGeneratedIconHint:
      localStorage.getItem(`pwa-preview-${id}-has-generated-icon`) === "1",
  };
}

function inferAssetCategory(assetKey: string): string {
  const key = assetKey.toLowerCase();
  if (key.includes("background") || key.includes("scene")) return "background";
  if (key.includes("character") || key.includes("avatar") || key.includes("actor")) {
    return "character";
  }
  if (key.includes("target") || key.includes("secondary") || key.includes("opponent")) {
    return "secondary";
  }
  if (
    key.includes("structure") ||
    key.includes("obstacle") ||
    key.includes("block") ||
    key.includes("terrain")
  ) {
    return "structure";
  }
  if (key.includes("effect") || key.includes("impact") || key.includes("explosion")) {
    return "effect";
  }
  return "generic";
}

function readPreviewAssets(id: string): StoredPreviewAsset[] {
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

function resolveCodeAssetPlaceholders(id: string, code: string): string {
  const transparentFallbackDataUrl =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const assets = readPreviewAssets(id);
  // Always provide a direct stable URL mapping even when localStorage payloads
  // are unavailable/truncated; the SW cache serves these asset URLs.
  const directReplacedCode = code.replace(
    /__ASSET_([a-zA-Z0-9_-]+)__/g,
    (_fullMatch, rawKey: string) => buildPreviewAssetUrl(id, rawKey),
  );
  if (!assets.length) return directReplacedCode;

  const assetUrlMap: Record<string, string> = {};
  const indexedAssets = assets.map((asset) => {
    const key = asset.assetKey.toLowerCase();
    const placeholder = `__ASSET_${asset.assetKey}__`;
    const cachedAssetUrl = buildPreviewAssetUrl(id, asset.assetKey);
    const resolvedUrl = asset.data
      ? `data:${asset.mimeType || "image/png"};base64,${asset.data}`
      : cachedAssetUrl;
    assetUrlMap[placeholder] = resolvedUrl;
    return {
      key,
      category: inferAssetCategory(key),
      resolvedUrl,
    };
  });

  return code.replace(/__ASSET_([a-zA-Z0-9_-]+)__/g, (fullMatch, rawKey: string) => {
    if (assetUrlMap[fullMatch]) return assetUrlMap[fullMatch];

    const requestKey = rawKey.toLowerCase();
    const requestCategory = inferAssetCategory(requestKey);

    const categoryMatch = indexedAssets.find((entry) => entry.category === requestCategory);
    if (categoryMatch) return categoryMatch.resolvedUrl;

    const fuzzyMatch = indexedAssets.find(
      (entry) => entry.key.includes(requestKey) || requestKey.includes(entry.key),
    );
    if (fuzzyMatch) return fuzzyMatch.resolvedUrl;

    // Fallback to direct cached asset URL first, then transparent pixel.
    return buildPreviewAssetUrl(id, rawKey) || transparentFallbackDataUrl;
  });
}

export default function PreviewClient() {
  const { id } = useParams<{ id: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iconVersion] = useState<number>(0);
  const [deferredInstallPrompt, setDeferredInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const installHelpMessage = useMemo(() => getInstallHelpMessage(), []);

  // Try localStorage first (synchronous). If empty, we'll check IndexedDB.
  const localData = id ? readPreviewData(id) : null;
  const [previewData, setPreviewData] = useState<PreviewData | null>(localData);
  const [idbChecked, setIdbChecked] = useState(!!localData);
  const [remoteUnavailable, setRemoteUnavailable] = useState(false);

  // When localStorage misses, try IndexedDB as a durable fallback.
  // If found, restore localStorage so future loads are instant.
  useEffect(() => {
    if (previewData || !id || idbChecked) return;
    let cancelled = false;

    const hydrateFromRecord = (
      record: {
        code: string;
        language: string;
        name: string;
        hasGeneratedIcon: boolean;
      },
      options?: { assets?: StoredPreviewAsset[]; persistIDB?: boolean }
    ) => {
      try {
        localStorage.setItem(`pwa-preview-${id}-code`, record.code);
        localStorage.setItem(`pwa-preview-${id}-language`, record.language);
        localStorage.setItem(`pwa-preview-${id}-name`, record.name);
        if (record.hasGeneratedIcon) {
          localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
        }
        if (options?.assets) {
          localStorage.setItem(`pwa-preview-${id}-assets`, JSON.stringify(options.assets));
        }
      } catch {
        // localStorage quota exceeded — proceed with in-memory/IDB data only
      }

      if (options?.persistIDB) {
        savePreviewToIDB({
          id,
          standaloneHTML: "",
          code: record.code,
          language: record.language,
          name: record.name,
          hasGeneratedIcon: record.hasGeneratedIcon,
          timestamp: Date.now(),
        }).catch(() => {});
      }

      setPreviewData({
        code: record.code,
        language: record.language,
        name: record.name,
        hasGeneratedIconHint: record.hasGeneratedIcon,
      });
      setRemoteUnavailable(false);
      setIdbChecked(true);
    };

    (async () => {
      const record = await getPreviewFromIDB(id);
      if (cancelled) return;
      if (record) {
        hydrateFromRecord({
          code: record.code,
          language: record.language,
          name: record.name,
          hasGeneratedIcon: record.hasGeneratedIcon,
        });
        return;
      }

      try {
        const remoteResp = await fetch(`/api/apps/${id}`, { cache: "no-store" });
        if (!remoteResp.ok) {
          setRemoteUnavailable(remoteResp.status === 404);
          setIdbChecked(true);
          return;
        }
        const shared = (await remoteResp.json()) as SharedPreviewResponse;
        hydrateFromRecord(
          {
            code: shared.code,
            language: shared.language,
            name: shared.name,
            hasGeneratedIcon: Boolean(shared.hasGeneratedIcon),
          },
          {
            assets: (shared.assets ?? []).map((asset) => ({
              assetKey: asset.assetKey,
              mimeType: asset.mimeType || "application/octet-stream",
            })),
            persistIDB: true,
          }
        );
      } catch {
        setRemoteUnavailable(false);
        setIdbChecked(true);
      }
    })();

    return () => { cancelled = true; };
  }, [id, previewData, idbChecked]);

  const [hasGeneratedIcon, setHasGeneratedIcon] = useState(
    () => previewData?.hasGeneratedIconHint ?? false,
  );

  const icon192Href = useMemo(() => {
    const base = hasGeneratedIcon
      ? `/api/preview/${id}/generate-icon?size=192`
      : "/icons/icon.svg";
    // Use & (not ?) when the base already contains a query string
    if (!iconVersion) return base;
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}v=${iconVersion}`;
  }, [hasGeneratedIcon, iconVersion, id]);

  useEffect(() => {
    if (!id) return;

    // If localStorage already told us icons exist, trust it and only use the
    // HEAD request as an upgrade path (never downgrade back to false).
    const hintSaysYes = previewData?.hasGeneratedIconHint ?? false;

    let cancelled = false;
    fetch(`/api/preview/${id}/generate-icon?size=192`, {
      method: "HEAD",
      cache: "no-store",
    })
      .then((resp) => {
        if (!cancelled) {
          // Only flip to true from the server; never override a localStorage
          // hint of "true" with a transient server 404 (e.g. cold start).
          if (resp.ok) {
            setHasGeneratedIcon(true);
          } else if (!hintSaysYes) {
            setHasGeneratedIcon(false);
          }
        }
      })
      .catch(() => {
        // Network error — keep the hint if we have one
        if (!cancelled && !hintSaysYes) {
          setHasGeneratedIcon(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id, previewData?.hasGeneratedIconHint]);

  // Pre-cache generated icon PNGs in the SW Cache API from localStorage.
  // This ensures the icons are available when the browser fetches them for
  // the PWA install dialog, even if the API route can't serve them (e.g.
  // serverless cold start, different lambda instance, server restart).
  useEffect(() => {
    if (!id || !hasGeneratedIcon) return;
    const icon192b64 = localStorage.getItem(`pwa-preview-${id}-icon192-b64`);
    const icon512b64 = localStorage.getItem(`pwa-preview-${id}-icon512-b64`);
    if (!icon192b64 && !icon512b64) return;

    (async () => {
      try {
        const cache = await caches.open(SW_CACHE_NAME);
        const b64ToResponse = (b64: string) => {
          const raw = atob(b64);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          return new Response(bytes, {
            headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
          });
        };
        if (icon192b64) {
          await cache.put(
            new Request(`/api/preview/${id}/generate-icon?size=192`),
            b64ToResponse(icon192b64),
          );
        }
        if (icon512b64) {
          await cache.put(
            new Request(`/api/preview/${id}/generate-icon?size=512`),
            b64ToResponse(icon512b64),
          );
        }
        // Clean up — data is now in the SW cache
        localStorage.removeItem(`pwa-preview-${id}-icon192-b64`);
        localStorage.removeItem(`pwa-preview-${id}-icon512-b64`);
      } catch {
        // caching is best-effort
      }
    })();
  }, [id, hasGeneratedIcon]);

  useEffect(() => {
    if (!id || !previewData) return;

    const { code, language, name } = previewData;
    const previewAssets = readPreviewAssets(id);
    const codeWithAssets = resolveCodeAssetPlaceholders(id, code);

    // Set page title and PWA meta tags in <head>
    document.title = name;

    const setMeta = (nameAttr: string, content: string) => {
      let el = document.querySelector(
        `meta[name="${nameAttr}"]`,
      ) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement("meta");
        el.name = nameAttr;
        document.head.appendChild(el);
      }
      el.content = content;
    };

    setMeta("theme-color", "#ffffff");
    setMeta("apple-mobile-web-app-capable", "yes");
    setMeta("apple-mobile-web-app-status-bar-style", "default");
    setMeta("apple-mobile-web-app-title", name);

    // Manifest link
    let manifestLink = document.querySelector(
      'link[rel="manifest"]',
    ) as HTMLLinkElement | null;
    if (!manifestLink) {
      manifestLink = document.createElement("link");
      manifestLink.rel = "manifest";
      document.head.appendChild(manifestLink);
    }
    const manifestUrl = `/preview/${id}/manifest.json?name=${encodeURIComponent(name)}${
      hasGeneratedIcon ? "&generated=1" : ""
    }${
      iconVersion ? `&v=${iconVersion}` : ""
    }`;
    manifestLink.href = manifestUrl;

    // Apple touch icon
    let touchIcon = document.querySelector(
      'link[rel="apple-touch-icon"]',
    ) as HTMLLinkElement | null;
    if (!touchIcon) {
      touchIcon = document.createElement("link");
      touchIcon.rel = "apple-touch-icon";
      document.head.appendChild(touchIcon);
    }
    touchIcon.href = icon192Href;

    // 1) Register the service worker first
    const swReady =
      "serviceWorker" in navigator
        ? navigator.serviceWorker
            .register("/preview-sw.js", { scope: "/preview" })
            .then((reg) => {
              // Wait for the SW to be active before caching
              if (reg.active) return reg;
              const installing = reg.installing || reg.waiting;
              if (!installing) return reg;
              return new Promise<ServiceWorkerRegistration>((resolve) => {
                installing.addEventListener("statechange", () => {
                  if (installing.state === "activated") resolve(reg);
                });
              });
            })
        : Promise.resolve(null);

    // 2) Build the preview HTML for the iframe
    const previewHTML = buildPreviewHTML(codeWithAssets, language, name);
    if (iframeRef.current) {
      iframeRef.current.srcdoc = previewHTML;
    }

    // 3) Build a fully self-contained standalone page and cache it
    //    This is what the SW will serve when the dev server is off
    const standaloneHTML = buildStandaloneHTML(
      codeWithAssets,
      language,
      name,
      id,
      icon192Href,
      hasGeneratedIcon,
    );

    swReady.then(async () => {
      await cacheForOffline(id, name, standaloneHTML, [
        manifestUrl,
        icon192Href,
        hasGeneratedIcon
          ? `/api/preview/${id}/generate-icon?size=512${iconVersion ? `&v=${iconVersion}` : ""}`
          : "/icons/icon.svg",
      ], previewAssets, code, language, hasGeneratedIcon);
    });
  }, [hasGeneratedIcon, icon192Href, iconVersion, id, previewData]);

  useEffect(() => {
    const displayModeStandalone = window.matchMedia("(display-mode: standalone)").matches;
    const iosStandalone = "standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone;
    if (displayModeStandalone || iosStandalone) {
      setIsInstalled(true);
    }

    const onBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setDeferredInstallPrompt(promptEvent);
    };

    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredInstallPrompt) {
      setShowInstallHelp(true);
      return;
    }
    if (isInstalling) return;
    setIsInstalling(true);
    try {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setIsInstalled(true);
      }
      setDeferredInstallPrompt(null);
    } finally {
      setIsInstalling(false);
    }
  };

  if (!previewData) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          color: "#71717a",
          backgroundColor: "#fafafa",
        }}
      >
        <div style={{ textAlign: "center" }}>
          {!idbChecked ? (
            <p>Loading preview&hellip;</p>
          ) : (
            <>
              <h1
                style={{
                  fontSize: "1.5rem",
                  color: "#18181b",
                  marginBottom: "0.5rem",
                }}
              >
                No Preview Available
              </h1>
              <p>
                {remoteUnavailable
                  ? "This shared app link is unavailable or unpublished."
                  : "Open a saved or shared app from chat preview or My Apps."}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {!isInstalled && (
        <button
          type="button"
          onClick={handleInstallClick}
          disabled={isInstalling}
          style={{
            position: "fixed",
            top: "1rem",
            right: "1rem",
            zIndex: 1000,
            backgroundColor: "#18181b",
            color: "white",
            border: "none",
            borderRadius: "9999px",
            padding: "0.65rem 1rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            cursor: isInstalling ? "wait" : "pointer",
            boxShadow: "0 6px 20px rgba(0,0,0,0.2)",
          }}
          aria-label="Install this app"
        >
          {isInstalling
            ? "Opening install..."
            : deferredInstallPrompt
              ? "Install App"
              : "How to install"}
        </button>
      )}
      {showInstallHelp && !isInstalled && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Install app instructions"
          onClick={() => setShowInstallHelp(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            backgroundColor: "rgba(0, 0, 0, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "22rem",
              backgroundColor: "white",
              borderRadius: "0.75rem",
              boxShadow: "0 18px 40px rgba(0, 0, 0, 0.22)",
              padding: "1rem",
              fontFamily:
                '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
              color: "#18181b",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: "1rem",
                fontWeight: 700,
              }}
            >
              Install this app
            </h2>
            <p
              style={{
                margin: "0.65rem 0 0",
                fontSize: "0.9rem",
                lineHeight: 1.45,
                color: "#3f3f46",
              }}
            >
              Install prompt is not available right now. {installHelpMessage}
            </p>
            <button
              type="button"
              onClick={() => setShowInstallHelp(false)}
              style={{
                marginTop: "0.9rem",
                width: "100%",
                border: "none",
                borderRadius: "0.6rem",
                backgroundColor: "#18181b",
                color: "white",
                fontWeight: 600,
                fontSize: "0.9rem",
                padding: "0.6rem 0.8rem",
                cursor: "pointer",
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          border: "none",
          backgroundColor: "white",
        }}
        sandbox="allow-scripts allow-modals allow-forms allow-popups allow-same-origin"
        title="Preview App"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Cache the standalone page + manifest so the PWA works without the server
// ---------------------------------------------------------------------------
async function cacheForOffline(
  id: string,
  name: string,
  standaloneHTML: string,
  extraUrls: string[],
  previewAssets: StoredPreviewAsset[] = [],
  previewCode?: string,
  previewLanguage?: string,
  hasGeneratedIcon?: boolean,
) {
  // Request persistent storage so the browser won't evict our caches.
  // Chrome auto-grants this for installed PWAs; other browsers may prompt.
  requestPersistentStorage();

  // Save to IndexedDB as the durable backup. Even if Cache API is evicted,
  // the service worker can rebuild from IDB.
  try {
    const code = previewCode ?? localStorage.getItem(`pwa-preview-${id}-code`) ?? "";
    const language = previewLanguage ?? localStorage.getItem(`pwa-preview-${id}-language`) ?? "jsx";
    await savePreviewToIDB({
      id,
      standaloneHTML,
      code,
      language,
      name,
      hasGeneratedIcon: hasGeneratedIcon ?? localStorage.getItem(`pwa-preview-${id}-has-generated-icon`) === "1",
      timestamp: Date.now(),
    });
  } catch {
    // best-effort — Cache API below is the primary serving mechanism
  }

  try {
    const cache = await caches.open(SW_CACHE_NAME);

    // 1) Cache the standalone HTML at the preview URL
    await cache.put(
      new Request(`/preview/${id}`),
      new Response(standaloneHTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    await cache.put(
      new Request(`/preview/${id}/`),
      new Response(standaloneHTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    // 2) Cache the manifest (with generated flag) + icon URLs.
    //    The correct manifest URL (including &generated=1 when applicable) is
    //    passed in via extraUrls so we don't build a second, potentially wrong,
    //    manifest URL here.
    await Promise.allSettled(
      extraUrls.map(async (url) => {
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            await cache.put(new Request(url), resp);
          }
        } catch {
          // best-effort
        }
      })
    );

    // 3) Cache generated/referenced preview assets under stable local URLs.
    await Promise.allSettled(
      previewAssets.map(async (asset) => {
        const assetUrl = buildPreviewAssetUrl(id, asset.assetKey);
        if (asset.data) {
          const raw = atob(asset.data);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          await cache.put(
            new Request(assetUrl),
            new Response(bytes, {
              headers: {
                "Content-Type": asset.mimeType || "image/png",
                "Cache-Control": "public, max-age=31536000",
              },
            }),
          );
          return;
        }

        if (asset.url) {
          try {
            const resp = await fetch(asset.url, { mode: "cors" });
            if (resp.ok) {
              await cache.put(new Request(assetUrl), resp);
              return;
            }
          } catch {
            // fall through to no-cors mode
          }
          try {
            const resp = await fetch(asset.url, { mode: "no-cors" });
            await cache.put(new Request(assetUrl), resp);
          } catch {
            // best-effort
          }
          return;
        }

        // Remote shared links may only have asset metadata; fetch from
        // stable same-origin preview asset URLs and cache for offline use.
        try {
          const resp = await fetch(assetUrl, { cache: "no-store" });
          if (resp.ok) {
            await cache.put(new Request(assetUrl), resp);
          }
        } catch {
          // best-effort
        }
      }),
    );

    // 4) Cache all CDN scripts for offline use.
    //    Some CDNs (e.g. cdn.tailwindcss.com) don't set CORS headers,
    //    so we use no-cors mode which returns an opaque response — the
    //    browser can still execute these when served by the service worker.
    await Promise.allSettled(
      CDN_URLS.map(async (url) => {
        const existing = await cache.match(url);
        if (existing) return; // already cached

        try {
          // Try CORS first (gives a readable response)
          const resp = await fetch(url, { mode: "cors" });
          if (resp.ok) {
            await cache.put(new Request(url), resp);
            return;
          }
        } catch {
          // CORS failed — fall through to no-cors
        }

        try {
          // Fallback: opaque response (works for script execution)
          const resp = await fetch(url, { mode: "no-cors" });
          await cache.put(new Request(url), resp);
        } catch {
          // best-effort
        }
      }),
    );
  } catch {
    // caching is best-effort; the app still works online without it
  }
}

// ---------------------------------------------------------------------------
// Build a FULLY SELF-CONTAINED HTML page that works without any server.
// This is what gets stored in the SW cache and served when offline.
// It includes: manifest link, SW re-registration, CDN scripts, and the
// user's code — all in a single HTML document.
// ---------------------------------------------------------------------------
function buildStandaloneHTML(
  code: string,
  language: string,
  appName: string,
  id: string,
  iconHref: string,
  useGeneratedIcons: boolean = false,
): string {
  // Auto-detect React code mislabeled as "html"
  language = detectEffectiveLanguage(code, language);

  const processedCode = processCode(code, language);

  // For raw HTML, wrap it with the manifest + SW registration
  if (language === "html") {
    const swScript = `<script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/preview-sw.js', { scope: '/preview' });
      }
    <\/script>`;
    const manifestLink = `<link rel="manifest" href="/preview/${id}/manifest.json?name=${encodeURIComponent(appName)}${useGeneratedIcons ? "&generated=1" : ""}">`;
    const metaTheme = `<meta name="theme-color" content="#ffffff">`;

    if (code.includes("</head>")) {
      return code.replace(
        "</head>",
        `${manifestLink}\n${metaTheme}\n${swScript}\n</head>`,
      );
    }
    return `${manifestLink}\n${metaTheme}\n${swScript}\n${code}`;
  }

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#ffffff" />
    <title>${appName}</title>
    <link rel="manifest" href="/preview/${id}/manifest.json?name=${encodeURIComponent(appName)}${useGeneratedIcons ? "&generated=1" : ""}">
    <link rel="apple-touch-icon" href="${iconHref}">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="${appName}">
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
    <script src="https://unpkg.com/lucide@latest"><\/script>
    <script src="https://cdn.tailwindcss.com"><\/script>
    <script>
      Babel.registerPreset('tsx', {
        presets: [
          [Babel.availablePresets['typescript'], { isTSX: true, allExtensions: true }],
          [Babel.availablePresets['react']]
        ]
      });
    <\/script>
    <script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/preview-sw.js', { scope: '/preview' });
      }
    <\/script>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background-color: white;
        color: #18181b;
      }
      #root { padding: 0; min-height: 100vh; }
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: #f1f1f1; }
      ::-webkit-scrollbar-thumb { background: #888; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: #555; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel" data-presets="tsx">
      const {
        useState, useEffect, useMemo, useCallback, useRef,
        useReducer, useContext, createContext, useLayoutEffect,
        useImperativeHandle, useDebugValue, useDeferredValue,
        useTransition, useId, memo, forwardRef, lazy,
        Suspense, Fragment, createElement, cloneElement,
        Children, createRef, isValidElement
      } = React;

      const __assetPlaceholderRegex = /__ASSET_([a-zA-Z0-9_-]+)__/;
      function __extractPreviewIdFromPath(pathname) {
        var path = String(pathname || '');
        if (!path.startsWith('/preview/')) return '';
        var remainder = path.slice('/preview/'.length);
        var id = remainder.split('/')[0] || '';
        return id ? decodeURIComponent(id) : '';
      }
      function __resolvePreviewAssetUrl(rawUrl) {
        if (typeof rawUrl !== 'string' || !rawUrl.includes('__ASSET_')) return rawUrl;
        var keyMatch = rawUrl.match(__assetPlaceholderRegex);
        if (!keyMatch || !keyMatch[1]) return rawUrl;
        var key = keyMatch[1];
        var previewId = __extractPreviewIdFromPath(location.pathname);
        if (!previewId) return rawUrl;
        return '/preview/' + encodeURIComponent(previewId) + '/assets/' + encodeURIComponent(key);
      }
      const __nativeFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        try {
          if (typeof input === 'string') return __nativeFetch(__resolvePreviewAssetUrl(input), init);
          if (input instanceof Request) {
            var rewritten = __resolvePreviewAssetUrl(input.url);
            if (rewritten !== input.url) return __nativeFetch(new Request(rewritten, input), init);
          }
        } catch {}
        return __nativeFetch(input, init);
      };
      try {
        const __imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (__imgSrcDesc && __imgSrcDesc.set && __imgSrcDesc.get) {
          Object.defineProperty(HTMLImageElement.prototype, 'src', {
            configurable: true,
            enumerable: true,
            get: function() { return __imgSrcDesc.get.call(this); },
            set: function(value) { return __imgSrcDesc.set.call(this, __resolvePreviewAssetUrl(value)); },
          });
        }
      } catch {}

      // Guard canvas draws against not-yet-ready/broken images so preview code
      // does not crash when assets are still loading.
      const __nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
        if (image instanceof HTMLImageElement) {
          const imageBroken = !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0;
          if (imageBroken) return;
        }
        return __nativeDrawImage.call(this, image, ...args);
      };

      const __iconHtmlCache = {};
      function __createLucideIcon(kebabName, displayName) {
        const LucideIcon = function(props) {
          const { size = 24, color = 'currentColor', strokeWidth = 2, className, style, ...rest } = props || {};
          if (!__iconHtmlCache[kebabName]) {
            try {
              const iconDef = window.lucide?.icons?.[kebabName];
              if (iconDef && window.lucide?.createElement) {
                const svgEl = window.lucide.createElement(iconDef);
                __iconHtmlCache[kebabName] = svgEl.innerHTML;
              }
            } catch(e) {}
          }
          const innerHtml = __iconHtmlCache[kebabName];
          if (!innerHtml) return null;
          return React.createElement('svg', Object.assign({
            xmlns: 'http://www.w3.org/2000/svg',
            width: size, height: size, viewBox: '0 0 24 24',
            fill: 'none', stroke: color, strokeWidth: strokeWidth,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            className: className, style: style,
            dangerouslySetInnerHTML: { __html: innerHtml }
          }, rest));
        };
        LucideIcon.displayName = displayName || kebabName;
        return LucideIcon;
      }

      const __builtins = new Set([
        'Map', 'Set', 'Date', 'Text', 'Image', 'Link', 'Option', 'Table',
        'Object', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'Proxy',
        'Promise', 'Error', 'Function', 'Reflect', 'Navigator', 'History',
        'Location', 'Screen', 'Event', 'Node', 'Element', 'Document',
        'Window', 'Range', 'Selection', 'File', 'Blob', 'URL',
        'Headers', 'Request', 'Response', 'Worker', 'Storage',
        'FormData', 'Clipboard'
      ]);
      if (window.lucide && window.lucide.icons) {
        Object.keys(window.lucide.icons).forEach(function(kebabName) {
          var pascalName = kebabName.replace(/(^|-)([a-z])/g, function(m, sep, c) {
            return c.toUpperCase();
          });
          if (!__builtins.has(pascalName)) {
            window[pascalName] = __createLucideIcon(kebabName, pascalName);
          }
        });
      }

      const __externalImportCache = {};
      async function __importFrom(specifier) {
        if (__externalImportCache[specifier]) return __externalImportCache[specifier];
        const isRemote = /^https?:\\/\\//.test(specifier);
        const isRelative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('next/');
        if (!isRemote && isRelative) throw new Error('Unsupported import in preview: ' + specifier);
        const url = isRemote ? specifier : ('https://esm.sh/' + specifier + '?bundle');
        const mod = await import(url);
        __externalImportCache[specifier] = mod;
        return mod;
      }

      (async () => {
      try {
        ${processedCode}

        const container = document.getElementById('root');
        const root = ReactDOM.createRoot(container);

        if (typeof App !== 'undefined') {
          root.render(React.createElement(React.StrictMode, null, React.createElement(App)));
        } else if (typeof main !== 'undefined') {
          main();
        } else {
          container.innerHTML = '<div style="padding: 20px; color: #ef4444;">Error: No <b>App</b> component found.</div>';
        }

        setTimeout(() => {
          if (window.lucide) window.lucide.createIcons();
        }, 100);
      } catch (err) {
        console.error("Preview Error:", err);
        document.getElementById('root').innerHTML =
          '<div style="color: #ef4444; background: #fee2e2; padding: 1.5rem; border: 1px solid #fecaca; border-radius: 0.5rem; font-family: monospace; margin: 1rem;">' +
          '<h3 style="margin-top: 0; color: #991b1b;">Runtime Error</h3>' +
          '<pre style="white-space: pre-wrap; margin: 0; font-size: 0.875rem;">' + (err.stack || err.toString()) + '</pre></div>';
      }
      })();
    <\/script>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Build preview HTML for the iframe (used on first load while server is up)
// ---------------------------------------------------------------------------
function buildPreviewHTML(
  code: string,
  language: string,
  appName: string,
): string {
  // Auto-detect React code mislabeled as "html"
  language = detectEffectiveLanguage(code, language);

  if (language === "html") {
    return code;
  }

  const processedCode = processCode(code, language);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appName}</title>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
    <script src="https://unpkg.com/lucide@latest"><\/script>
    <script src="https://cdn.tailwindcss.com"><\/script>
    <script>
      Babel.registerPreset('tsx', {
        presets: [
          [Babel.availablePresets['typescript'], { isTSX: true, allExtensions: true }],
          [Babel.availablePresets['react']]
        ]
      });
    <\/script>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background-color: white;
        color: #18181b;
      }
      #root { padding: 0; min-height: 100vh; }
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: #f1f1f1; }
      ::-webkit-scrollbar-thumb { background: #888; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: #555; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel" data-presets="tsx">
      const {
        useState, useEffect, useMemo, useCallback, useRef,
        useReducer, useContext, createContext, useLayoutEffect,
        useImperativeHandle, useDebugValue, useDeferredValue,
        useTransition, useId, memo, forwardRef, lazy,
        Suspense, Fragment, createElement, cloneElement,
        Children, createRef, isValidElement
      } = React;

      const __assetPlaceholderRegex = /__ASSET_([a-zA-Z0-9_-]+)__/;
      function __extractPreviewIdFromPath(pathname) {
        var path = String(pathname || '');
        if (!path.startsWith('/preview/')) return '';
        var remainder = path.slice('/preview/'.length);
        var id = remainder.split('/')[0] || '';
        return id ? decodeURIComponent(id) : '';
      }
      function __resolvePreviewAssetUrl(rawUrl) {
        if (typeof rawUrl !== 'string' || !rawUrl.includes('__ASSET_')) return rawUrl;
        var keyMatch = rawUrl.match(__assetPlaceholderRegex);
        if (!keyMatch || !keyMatch[1]) return rawUrl;
        var key = keyMatch[1];
        var previewId = __extractPreviewIdFromPath(location.pathname);
        if (!previewId) return rawUrl;
        return '/preview/' + encodeURIComponent(previewId) + '/assets/' + encodeURIComponent(key);
      }
      const __nativeFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        try {
          if (typeof input === 'string') return __nativeFetch(__resolvePreviewAssetUrl(input), init);
          if (input instanceof Request) {
            var rewritten = __resolvePreviewAssetUrl(input.url);
            if (rewritten !== input.url) return __nativeFetch(new Request(rewritten, input), init);
          }
        } catch {}
        return __nativeFetch(input, init);
      };
      try {
        const __imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (__imgSrcDesc && __imgSrcDesc.set && __imgSrcDesc.get) {
          Object.defineProperty(HTMLImageElement.prototype, 'src', {
            configurable: true,
            enumerable: true,
            get: function() { return __imgSrcDesc.get.call(this); },
            set: function(value) { return __imgSrcDesc.set.call(this, __resolvePreviewAssetUrl(value)); },
          });
        }
      } catch {}

      // Guard canvas draws against not-yet-ready/broken images so preview code
      // does not crash when assets are still loading.
      const __nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
        if (image instanceof HTMLImageElement) {
          const imageBroken = !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0;
          if (imageBroken) return;
        }
        return __nativeDrawImage.call(this, image, ...args);
      };

      const __iconHtmlCache = {};
      function __createLucideIcon(kebabName, displayName) {
        const LucideIcon = function(props) {
          const { size = 24, color = 'currentColor', strokeWidth = 2, className, style, ...rest } = props || {};
          if (!__iconHtmlCache[kebabName]) {
            try {
              const iconDef = window.lucide?.icons?.[kebabName];
              if (iconDef && window.lucide?.createElement) {
                const svgEl = window.lucide.createElement(iconDef);
                __iconHtmlCache[kebabName] = svgEl.innerHTML;
              }
            } catch(e) {}
          }
          const innerHtml = __iconHtmlCache[kebabName];
          if (!innerHtml) return null;
          return React.createElement('svg', Object.assign({
            xmlns: 'http://www.w3.org/2000/svg',
            width: size, height: size, viewBox: '0 0 24 24',
            fill: 'none', stroke: color, strokeWidth: strokeWidth,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            className: className, style: style,
            dangerouslySetInnerHTML: { __html: innerHtml }
          }, rest));
        };
        LucideIcon.displayName = displayName || kebabName;
        return LucideIcon;
      }

      const __builtins = new Set([
        'Map', 'Set', 'Date', 'Text', 'Image', 'Link', 'Option', 'Table',
        'Object', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'Proxy',
        'Promise', 'Error', 'Function', 'Reflect', 'Navigator', 'History',
        'Location', 'Screen', 'Event', 'Node', 'Element', 'Document',
        'Window', 'Range', 'Selection', 'File', 'Blob', 'URL',
        'Headers', 'Request', 'Response', 'Worker', 'Storage',
        'FormData', 'Clipboard'
      ]);
      if (window.lucide && window.lucide.icons) {
        Object.keys(window.lucide.icons).forEach(function(kebabName) {
          var pascalName = kebabName.replace(/(^|-)([a-z])/g, function(m, sep, c) {
            return c.toUpperCase();
          });
          if (!__builtins.has(pascalName)) {
            window[pascalName] = __createLucideIcon(kebabName, pascalName);
          }
        });
      }

      const __externalImportCache = {};
      async function __importFrom(specifier) {
        if (__externalImportCache[specifier]) return __externalImportCache[specifier];
        const isRemote = /^https?:\\/\\//.test(specifier);
        const isRelative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('next/');
        if (!isRemote && isRelative) throw new Error('Unsupported import in preview: ' + specifier);
        const url = isRemote ? specifier : ('https://esm.sh/' + specifier + '?bundle');
        const mod = await import(url);
        __externalImportCache[specifier] = mod;
        return mod;
      }

      (async () => {
      try {
        ${processedCode}

        const container = document.getElementById('root');
        const root = ReactDOM.createRoot(container);

        if (typeof App !== 'undefined') {
          root.render(React.createElement(React.StrictMode, null, React.createElement(App)));
        } else if (typeof main !== 'undefined') {
          main();
        } else {
          container.innerHTML = '<div style="padding: 20px; color: #ef4444;">Error: No <b>App</b> component found.</div>';
        }

        setTimeout(() => {
          if (window.lucide) window.lucide.createIcons();
        }, 100);
      } catch (err) {
        console.error("Preview Error:", err);
        document.getElementById('root').innerHTML =
          '<div style="color: #ef4444; background: #fee2e2; padding: 1.5rem; border: 1px solid #fecaca; border-radius: 0.5rem; font-family: monospace; margin: 1rem;">' +
          '<h3 style="margin-top: 0; color: #991b1b;">Runtime Error</h3>' +
          '<pre style="white-space: pre-wrap; margin: 0; font-size: 0.875rem;">' + (err.stack || err.toString()) + '</pre></div>';
      }
      })();
    <\/script>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Detect whether "html"-tagged code is actually React/JSX so we process it
// correctly instead of returning raw source as-is.
// ---------------------------------------------------------------------------
function detectEffectiveLanguage(code: string, language: string): string {
  if (language === "html") {
    const isReactCode =
      /import\s.*from\s/.test(code) ||
      /export\s+default\s+function/.test(code) ||
      /useState|useEffect|useRef|useCallback/.test(code);
    if (isReactCode) return "tsx";
  }
  return language;
}

// ---------------------------------------------------------------------------
// Shared code processing — strips imports/exports, handles lucide icons, etc.
// ---------------------------------------------------------------------------
function processCode(code: string, language: string): string {
  // Auto-detect React code mislabeled as "html"
  language = detectEffectiveLanguage(code, language);

  if (language === "html") return code;

  const externalImportPreamble = buildExternalImportPreamble(code);
  const defaultExportMatch = code.match(/export\s+default\s+function\s+(\w+)/);
  const defaultExportName = defaultExportMatch ? defaultExportMatch[1] : null;

  const cleanedCode =
    code
      .replace(/import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
      .replace(/import\s+type\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
      .replace(
        /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"];?\n?/g,
        (_match: string, names: string) => {
          return (
            names
              .split(",")
              .map((n: string) => n.trim())
              .filter(Boolean)
              .map((n: string) => {
                const parts = n.split(/\s+as\s+/);
                const original = parts[0].trim();
                const alias = parts.length > 1 ? parts[1].trim() : original;
                const kebab = original
                  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
                  .toLowerCase();
                return (
                  "const " +
                  alias +
                  " = __createLucideIcon('" +
                  kebab +
                  "', '" +
                  original +
                  "');"
                );
              })
              .join("\n") + "\n"
          );
        },
      )
      .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
      .replace(
        /import\s+\w+\s*,?\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
        "",
      )
      .replace(/import\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
      .replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
      .replace(/import\s*['"][^'"]*['"];?\n?/g, "")
      .replace(/export\s+default\s+function\s+(\w+)/, "function $1")
      .replace(/export\s+default\s+/, "const App = ")
      .replace(/export\s+/g, "") +
    (defaultExportName && defaultExportName !== "App"
      ? `\nconst App = ${defaultExportName};\n`
      : "");

  // Escape LaTeX math in JSX
  let result = cleanedCode;
  result = result.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (_m: string, inner: string) => {
      const escaped = inner
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
      return '{"$$' + escaped + '$$"}';
    },
  );
  result = result.replace(/\$([^$\n]+?)\$/g, (_m: string, inner: string) => {
    if (/[\\^_]/.test(inner) || /^[A-Za-z]$/.test(inner)) {
      const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return '{"$' + escaped + '$"}';
    }
    return _m;
  });

  return [externalImportPreamble, result].filter(Boolean).join("\n");
}
