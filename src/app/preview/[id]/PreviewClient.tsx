"use client";

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";

const SW_CACHE_NAME = "preview-pwa-v1";

interface PreviewData {
  code: string;
  language: string;
  name: string;
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

  // Since SSR is disabled, we can read localStorage directly during render
  const previewData = id ? readPreviewData(id) : null;
  const appName = previewData?.name ?? "My App";

  useEffect(() => {
    if (!id || !previewData) return;

    const { code, language, name } = previewData;

    // Set page title and PWA meta tags in <head>
    document.title = name;

    const setMeta = (nameAttr: string, content: string) => {
      let el = document.querySelector(`meta[name="${nameAttr}"]`) as HTMLMetaElement | null;
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
    let manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (!manifestLink) {
      manifestLink = document.createElement("link");
      manifestLink.rel = "manifest";
      document.head.appendChild(manifestLink);
    }
    manifestLink.href = `/preview/${id}/manifest.json?name=${encodeURIComponent(name)}`;

    // Apple touch icon
    let touchIcon = document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement | null;
    if (!touchIcon) {
      touchIcon = document.createElement("link");
      touchIcon.rel = "apple-touch-icon";
      document.head.appendChild(touchIcon);
    }
    touchIcon.href = "/icons/icon-192.png";

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
    const standaloneHTML = buildStandaloneHTML(code, language, name, id);

    swReady.then(() => cacheForOffline(id, name, standaloneHTML));
  }, [id, previewData]);

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
  );
}

// ---------------------------------------------------------------------------
// Cache the standalone page + manifest so the PWA works without the server
// ---------------------------------------------------------------------------
async function cacheForOffline(
  id: string,
  name: string,
  standaloneHTML: string
) {
  try {
    const cache = await caches.open(SW_CACHE_NAME);

    // Cache the standalone HTML at the preview URL
    await cache.put(
      new Request(`/preview/${id}`),
      new Response(standaloneHTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );

    // Fetch and cache the manifest so it's available offline too
    const manifestUrl = `/preview/${id}/manifest.json?name=${encodeURIComponent(name)}`;
    try {
      const manifestResp = await fetch(manifestUrl);
      if (manifestResp.ok) {
        await cache.put(new Request(manifestUrl), manifestResp);
      }
    } catch {
      // manifest caching is best-effort
    }
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
  id: string
): string {
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
        `${manifestLink}\n${metaTheme}\n${swScript}\n</head>`
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
    <link rel="apple-touch-icon" href="/icons/icon-192.png">
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
  appName: string
): string {
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
    <\/script>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared code processing — strips imports/exports, handles lucide icons, etc.
// ---------------------------------------------------------------------------
function processCode(code: string, language: string): string {
  if (language === "html") return code;

  const defaultExportMatch = code.match(
    /export\s+default\s+function\s+(\w+)/
  );
  const defaultExportName = defaultExportMatch
    ? defaultExportMatch[1]
    : null;

  const cleanedCode =
    code
      .replace(
        /import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
        ""
      )
      .replace(
        /import\s+type\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g,
        ""
      )
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
                const alias =
                  parts.length > 1 ? parts[1].trim() : original;
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
        }
      )
      .replace(
        /import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
        ""
      )
      .replace(
        /import\s+\w+\s*,?\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
        ""
      )
      .replace(/import\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
      .replace(
        /import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g,
        ""
      )
      .replace(/import\s*['"][^'"]*['"];?\n?/g, "")
      .replace(
        /export\s+default\s+function\s+(\w+)/,
        "function $1"
      )
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
    }
  );
  result = result.replace(
    /\$([^$\n]+?)\$/g,
    (_m: string, inner: string) => {
      if (/[\\^_]/.test(inner) || /^[A-Za-z]$/.test(inner)) {
        const escaped = inner
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"');
        return '{"$' + escaped + '$"}';
      }
      return _m;
    }
  );

  return result;
}
