"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";

const SW_CACHE_NAME = "preview-pwa-v2";

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
  };
}

export default function PreviewClient() {
  const { id } = useParams<{ id: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cleanupScheduledRef = useRef(false);
  const [iconVersion, setIconVersion] = useState<number>(0);
  const [hasGeneratedIcon, setHasGeneratedIcon] = useState(false);
  const [isGeneratingIcon, setIsGeneratingIcon] = useState(false);
  const [iconStatus, setIconStatus] = useState<string | null>(null);

  // Since SSR is disabled, we can read localStorage directly during render
  const previewData = id ? readPreviewData(id) : null;
  const icon192Href = useMemo(() => {
    const base = hasGeneratedIcon
      ? `/generated-icons/${id}/icon-192.png`
      : "/icons/icon.svg";
    return iconVersion ? `${base}?v=${iconVersion}` : base;
  }, [hasGeneratedIcon, iconVersion, id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/generated-icons/${id}/icon-192.png`, {
      method: "HEAD",
      cache: "no-store",
    })
      .then((resp) => {
        if (!cancelled) {
          setHasGeneratedIcon(resp.ok);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasGeneratedIcon(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id || !previewData) return;

    const { code, language, name } = previewData;

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

    setMeta("theme-color", "#18181b");
    setMeta("apple-mobile-web-app-capable", "yes");
    setMeta("apple-mobile-web-app-status-bar-style", "black-translucent");
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
    const previewHTML = buildPreviewHTML(code, language, name);
    if (iframeRef.current) {
      iframeRef.current.srcdoc = previewHTML;
    }

    // 3) Build a fully self-contained standalone page and cache it
    //    This is what the SW will serve when the dev server is off
    const standaloneHTML = buildStandaloneHTML(code, language, name, id, icon192Href);

    swReady.then(async () => {
      await cacheForOffline(id, name, standaloneHTML, [
        manifestUrl,
        icon192Href,
        hasGeneratedIcon
          ? `/generated-icons/${id}/icon-512.png${iconVersion ? `?v=${iconVersion}` : ""}`
          : "/icons/icon.svg",
      ]);

      // After assets are cached for this preview, remove generated icon files from /public.
      if (hasGeneratedIcon && !cleanupScheduledRef.current) {
        cleanupScheduledRef.current = true;
        window.setTimeout(() => {
          fetch(`/api/preview/${id}/generate-icon`, {
            method: "DELETE",
            keepalive: true,
          }).catch(() => {
            // cleanup is best-effort
          });
        }, 12000);
      }
    });
  }, [hasGeneratedIcon, icon192Href, iconVersion, id, previewData]);

  const handleGenerateIcon = async () => {
    if (!id || !previewData || isGeneratingIcon) return;
    setIsGeneratingIcon(true);
    setIconStatus("Generating PWA icon...");
    try {
      const res = await fetch(`/api/preview/${id}/generate-icon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: previewData.name,
          prompt: `Create a clean, high-contrast, minimal app icon for "${previewData.name}". Centered symbol, no text, no watermark, readable at small sizes.`,
          pro: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.details || data?.error || "Failed to generate icon");
      }
      const version = typeof data?.timestamp === "number" ? data.timestamp : Date.now();
      setHasGeneratedIcon(true);
      setIconVersion(version);
      setIconStatus("PWA icon generated.");
      window.setTimeout(() => setIconStatus(null), 2500);
    } catch (error) {
      setIconStatus(error instanceof Error ? error.message : "Icon generation failed");
    } finally {
      setIsGeneratingIcon(false);
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
            Use the &ldquo;Install as App&rdquo; button from a code preview to
            open this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
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
      <div
        style={{
          position: "fixed",
          top: "0.75rem",
          right: "0.75rem",
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: "0.5rem",
        }}
      >
        <button
          onClick={handleGenerateIcon}
          disabled={isGeneratingIcon}
          style={{
            border: "1px solid #27272a",
            background: isGeneratingIcon ? "#a1a1aa" : "#18181b",
            color: "#fff",
            borderRadius: "8px",
            padding: "0.45rem 0.7rem",
            fontSize: "0.85rem",
            cursor: isGeneratingIcon ? "not-allowed" : "pointer",
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
          }}
        >
          {isGeneratingIcon ? "Generating..." : "Generate PWA Icon"}
        </button>
        {iconStatus ? (
          <div
            style={{
              background: "rgba(24,24,27,0.92)",
              color: "#fff",
              fontSize: "0.75rem",
              padding: "0.35rem 0.5rem",
              borderRadius: "6px",
              maxWidth: "280px",
            }}
          >
            {iconStatus}
          </div>
        ) : null}
      </div>
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
  extraUrls: string[]
) {
  try {
    const cache = await caches.open(SW_CACHE_NAME);

    // 1) Cache the standalone HTML at the preview URL
    await cache.put(
      new Request(`/preview/${id}`),
      new Response(standaloneHTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    // 2) Fetch and cache the manifest so it's available offline too
    const manifestUrl = `/preview/${id}/manifest.json?name=${encodeURIComponent(name)}`;
    try {
      const manifestResp = await fetch(manifestUrl);
      if (manifestResp.ok) {
        await cache.put(new Request(manifestUrl), manifestResp);
      }
    } catch {
      // manifest caching is best-effort
    }

    // 3) Cache current icon + latest manifest URL (with version, if provided).
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
  iconHref: string
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
    const manifestLink = `<link rel="manifest" href="/preview/${id}/manifest.json?name=${encodeURIComponent(appName)}">`;
    const metaTheme = `<meta name="theme-color" content="#18181b">`;

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
    <meta name="theme-color" content="#18181b" />
    <title>${appName}</title>
    <link rel="manifest" href="/preview/${id}/manifest.json?name=${encodeURIComponent(appName)}">
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
