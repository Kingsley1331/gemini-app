"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

export default function PreviewPage() {
  const { id } = useParams<{ id: string }>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [appName, setAppName] = useState("My App");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) return;

    const code = localStorage.getItem(`pwa-preview-${id}-code`);
    const language =
      localStorage.getItem(`pwa-preview-${id}-language`) || "jsx";
    const name =
      localStorage.getItem(`pwa-preview-${id}-name`) || "My App";
    setAppName(name);

    if (!code) {
      setMissing(true);
      return;
    }

    // Dynamically set the manifest link (unique per ID)
    let manifestLink = document.querySelector(
      'link[rel="manifest"]'
    ) as HTMLLinkElement | null;
    if (!manifestLink) {
      manifestLink = document.createElement("link");
      manifestLink.rel = "manifest";
      document.head.appendChild(manifestLink);
    }
    manifestLink.href = `/preview/${id}/manifest.json?name=${encodeURIComponent(name)}`;

    // Set theme-color meta
    let themeMeta = document.querySelector(
      'meta[name="theme-color"]'
    ) as HTMLMetaElement | null;
    if (!themeMeta) {
      themeMeta = document.createElement("meta");
      themeMeta.name = "theme-color";
      document.head.appendChild(themeMeta);
    }
    themeMeta.content = "#18181b";

    // Set title
    document.title = name;

    // Register service worker
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/preview-sw.js", { scope: "/preview" })
        .catch((err) => console.warn("SW registration failed:", err));
    }

    // Build the preview HTML
    const html = buildPreviewHTML(code, language, name);

    if (iframeRef.current) {
      iframeRef.current.srcdoc = html;
    }
  }, [id]);

  if (missing) {
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
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content={appName} />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
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

/**
 * Build the full preview HTML — mirrors the logic in CodePreview.tsx's updateIframe
 */
function buildPreviewHTML(
  code: string,
  language: string,
  appName: string
): string {
  if (language === "html") {
    return code;
  }

  // Extract the default-exported function name before transforms
  const defaultExportMatch = code.match(
    /export\s+default\s+function\s+(\w+)/
  );
  const defaultExportName = defaultExportMatch
    ? defaultExportMatch[1]
    : null;

  const cleanedCode =
    code
      // Remove type-only imports
      .replace(
        /import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
        ""
      )
      .replace(
        /import\s+type\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g,
        ""
      )
      // Convert lucide-react imports into const declarations
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
      // Remove remaining imports
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
      // Handle exports
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
  const escapeLatex = (src: string): string => {
    src = src.replace(
      /\$\$([\s\S]*?)\$\$/g,
      (_m: string, inner: string) => {
        const escaped = inner
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n");
        return '{"$$' + escaped + '$$"}';
      }
    );
    src = src.replace(
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
    return src;
  };

  const finalCode = escapeLatex(cleanedCode);

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
            } catch(e) { /* icon not found */ }
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
        ${finalCode}

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
          if (window.lucide) {
            window.lucide.createIcons();
          }
        }, 100);
      } catch (err) {
        console.error("Preview Error:", err);
        document.getElementById('root').innerHTML =
          '<div style="color: #ef4444; background: #fee2e2; padding: 1.5rem; border: 1px solid #fecaca; border-radius: 0.5rem; font-family: monospace; margin: 1rem;">' +
          '<h3 style="margin-top: 0; color: #991b1b;">Runtime Error</h3>' +
          '<pre style="white-space: pre-wrap; margin: 0; font-size: 0.875rem;">' + (err.stack || err.toString()) + '</pre>' +
          '</div>';
      }
    <\/script>
  </body>
</html>`;
}
