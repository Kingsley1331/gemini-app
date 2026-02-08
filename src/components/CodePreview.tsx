"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Play,
  Code,
  Maximize2,
  Minimize2,
  RotateCcw,
  Copy,
  Check,
  Bug,
  Download,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import JSZip from "jszip";

interface CodePreviewProps {
  code: string;
  language: string;
  title?: string;
  onDebug?: (error: string) => void;
}

export default function CodePreview({
  code,
  language,
  title = "Preview",
  onDebug,
}: CodePreviewProps) {
  const [activeTab, setActiveTab] = useState<"preview" | "code">(
    language === "html" || language === "jsx" || language === "tsx"
      ? "preview"
      : "code"
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = useCallback(async () => {
    const zip = new JSZip();
    const folder = zip.folder("my-app")!;

    if (language === "html") {
      folder.file("index.html", code);
    } else {
      const ext =
        language === "tsx" || language === "typescript" ? "tsx" : "jsx";
      folder.file("App." + ext, code);

      // Process the code: extract lucide icons, strip imports/exports
      const lucideIconDecls: string[] = [];

      // Extract the default-exported function name before transforms
      const dlDefaultExportMatch = code.match(/export\s+default\s+function\s+(\w+)/);
      const dlDefaultExportName = dlDefaultExportMatch ? dlDefaultExportMatch[1] : null;

      const processedCode = code
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
          (_match, names) => {
            const icons = names
              .split(",")
              .map((n: string) => n.trim())
              .filter(Boolean);
            icons.forEach((n: string) => {
              const kebab = n
                .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
                .toLowerCase();
              lucideIconDecls.push(
                "const " +
                  n +
                  " = __createLucideIcon('" +
                  kebab +
                  "', '" +
                  n +
                  "');"
              );
            });
            return "";
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
        .replace(/export\s+default\s+function\s+(\w+)/, "function $1")
        .replace(/export\s+default\s+/, "const App = ")
        .replace(/export\s+/g, "")
        // Alias the default-exported function as App (if it wasn't already named App)
        + (dlDefaultExportName && dlDefaultExportName !== 'App'
          ? `\nconst App = ${dlDefaultExportName};\n`
          : '');

      const iconSection =
        lucideIconDecls.length > 0
          ? "\n      // Lucide icon components\n      " +
            lucideIconDecls.join("\n      ") +
            "\n"
          : "";

      // Build runner HTML using string concatenation to avoid template literal issues
      const runnerParts = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '  <head>',
        '    <meta charset="UTF-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        '    <title>My App</title>',
        '    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
        '    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>',
        '    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>',
        '    <script src="https://unpkg.com/lucide@latest"></script>',
        '    <script src="https://cdn.tailwindcss.com"></script>',
        '    <script>',
        "      Babel.registerPreset('tsx', {",
        '        presets: [',
        "          [Babel.availablePresets['typescript'], { isTSX: true, allExtensions: true }],",
        "          [Babel.availablePresets['react']]",
        '        ]',
        '      });',
        '    </script>',
        '    <style>',
        '      body {',
        '        margin: 0;',
        '        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
        '        background-color: white;',
        '        color: #18181b;',
        '      }',
        '      #root { padding: 0; min-height: 100vh; }',
        '    </style>',
        '  </head>',
        '  <body>',
        '    <div id="root"></div>',
        '    <script type="text/babel" data-presets="tsx">',
        '      const {',
        '        useState, useEffect, useMemo, useCallback, useRef,',
        '        useReducer, useContext, createContext, useLayoutEffect,',
        '        useImperativeHandle, useDebugValue, useDeferredValue,',
        '        useTransition, useId, memo, forwardRef, lazy,',
        '        Suspense, Fragment, createElement, cloneElement,',
        '        Children, createRef, isValidElement',
        '      } = React;',
        '',
        '      // Lucide icon factory — uses lucide.createElement() for reliable SVG generation',
        '      const __iconHtmlCache = {};',
        '      function __createLucideIcon(kebabName, displayName) {',
        '        const LucideIcon = function(props) {',
        "          const { size = 24, color = 'currentColor', strokeWidth = 2, className, style, ...rest } = props || {};",
        '          if (!__iconHtmlCache[kebabName]) {',
        '            try {',
        '              const iconDef = window.lucide?.icons?.[kebabName];',
        '              if (iconDef && window.lucide?.createElement) {',
        '                const svgEl = window.lucide.createElement(iconDef);',
        '                __iconHtmlCache[kebabName] = svgEl.innerHTML;',
        '              }',
        '            } catch(e) { /* icon not found */ }',
        '          }',
        '          const innerHtml = __iconHtmlCache[kebabName];',
        '          if (!innerHtml) return null;',
        "          return React.createElement('svg', Object.assign({",
        "            xmlns: 'http://www.w3.org/2000/svg',",
        "            width: size, height: size, viewBox: '0 0 24 24',",
        "            fill: 'none', stroke: color, strokeWidth: strokeWidth,",
        "            strokeLinecap: 'round', strokeLinejoin: 'round',",
        '            className: className, style: style,',
        '            dangerouslySetInnerHTML: { __html: innerHtml }',
        '          }, rest));',
        '        };',
        '        LucideIcon.displayName = displayName || kebabName;',
        '        return LucideIcon;',
        '      }',
        '',
        iconSection,
        '',
        '      // APP CODE',
        processedCode,
        '',
        '      // Render',
        "      const container = document.getElementById('root');",
        '      const root = ReactDOM.createRoot(container);',
        "      if (typeof App !== 'undefined') {",
        '        root.render(React.createElement(React.StrictMode, null, React.createElement(App)));',
        '      }',
        '    </script>',
        '  </body>',
        '</html>',
      ];

      folder.file("index.html", runnerParts.join("\n"));

      // Add a README
      const readme = [
        "# My App",
        "",
        "Generated with Gemini.",
        "",
        "## How to Run",
        "",
        "Simply open `index.html` in your browser — no build step or server required.",
        "",
        "The app loads React, Tailwind CSS, and Lucide icons from CDNs automatically.",
        "",
        "## Source Code",
        "",
        "The original component source is in `App." + ext + "`.",
        "",
      ].join("\n");
      folder.file("README.md", readme);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "my-app.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [code, language]);

  const updateIframe = useCallback(() => {
    if (!iframeRef.current) return;

    let content = "";
    if (language === "html") {
      content = code;
    } else if (
      language === "jsx" ||
      language === "tsx" ||
      language === "javascript" ||
      language === "typescript"
    ) {
      // Clean up the code: convert lucide imports to const declarations,
      // strip all other imports, and handle exports

      // Extract the default-exported function name before transforms
      const defaultExportMatch = code.match(/export\s+default\s+function\s+(\w+)/);
      const defaultExportName = defaultExportMatch ? defaultExportMatch[1] : null;

      const cleanedCode = code
        // Remove type-only imports
        .replace(/import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+type\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
        // Convert lucide-react imports into const declarations (BEFORE general import stripping)
        .replace(
          /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"];?\n?/g,
          (_match, names) => {
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
        // Remove remaining imports (react, etc.)
        .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+\w+\s*,?\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
        // Remove side-effect imports
        .replace(/import\s*['"][^'"]*['"];?\n?/g, "")
        // Handle exports — just strip the keywords, keep function declarations intact
        .replace(/export\s+default\s+function\s+(\w+)/, "function $1")
        .replace(/export\s+default\s+/, "const App = ")
        .replace(/export\s+/g, "")
        // Alias the default-exported function as App (if it wasn't already named App)
        + (defaultExportName && defaultExportName !== 'App'
          ? `\nconst App = ${defaultExportName};\n`
          : '');

      // Basic React/JS runner template
      content = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8" />
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
            <script src="https://unpkg.com/react@18/umd/react.development.js"><\/script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"><\/script>
            <script src="https://unpkg.com/lucide@latest"><\/script>
            <script src="https://cdn.tailwindcss.com"><\/script>
            <script>
              // Register a custom TSX preset so Babel can parse TypeScript generics + JSX together
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
              // React globals
              const { 
                useState, useEffect, useMemo, useCallback, useRef, 
                useReducer, useContext, createContext, useLayoutEffect,
                useImperativeHandle, useDebugValue, useDeferredValue,
                useTransition, useId, memo, forwardRef, lazy, 
                Suspense, Fragment, createElement, cloneElement,
                Children, createRef, isValidElement
              } = React;

              // Lucide icon factory — uses lucide.createElement() to get SVG HTML,
              // then wraps it in a React component with dangerouslySetInnerHTML
              const __iconHtmlCache = {};
              function __createLucideIcon(kebabName, displayName) {
                const LucideIcon = function(props) {
                  const { size = 24, color = 'currentColor', strokeWidth = 2, className, style, ...rest } = props || {};

                  // Cache the SVG inner HTML on first use
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
                    width: size,
                    height: size,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: color,
                    strokeWidth: strokeWidth,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    className: className,
                    style: style,
                    dangerouslySetInnerHTML: { __html: innerHtml }
                  }, rest));
                };
                LucideIcon.displayName = displayName || kebabName;
                return LucideIcon;
              }

              // Pre-create ALL lucide icons as global variables so they're
              // always available regardless of import patterns.
              // IMPORTANT: Skip names that collide with JS built-ins (Map, Set, Text, etc.)
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
                  // Only set if it won't overwrite a JS built-in
                  if (!__builtins.has(pascalName)) {
                    window[pascalName] = __createLucideIcon(kebabName, pascalName);
                  }
                });
              }

              // Error reporter
              const reportError = (err) => {
                const message = (err && err.stack) ? err.stack : String(err);
                window.parent.postMessage({ type: 'preview-error', message }, '*');
              };

              window.onerror = (msg, url, lineNo, columnNo, error) => {
                reportError(error || msg);
                return false;
              };

              window.onunhandledrejection = (event) => {
                reportError(event.reason);
              };

              try {
                ${cleanedCode}
                
                // Final render logic
                const container = document.getElementById('root');
                const root = ReactDOM.createRoot(container);
                
                if (typeof App !== 'undefined') {
                  root.render(
                    React.createElement(React.StrictMode, null, React.createElement(App))
                  );
                } else if (typeof main !== 'undefined') {
                  main();
                } else {
                  const noAppMsg = "No 'App' component found. Please define 'export default function App()'.";
                  console.error(noAppMsg);
                  window.parent.postMessage({ type: 'preview-error', message: noAppMsg }, '*');
                  container.innerHTML = '<div style="padding: 20px; color: #ef4444;">Error: No <b>App</b> component found. Please define <code>export default function App()</code>.</div>';
                }
                
                // Initialize lucide icons if any
                setTimeout(() => {
                  if (window.lucide) {
                    window.lucide.createIcons();
                  }
                }, 100);
              } catch (err) {
                console.error("Preview Error:", err);
                reportError(err);
                document.getElementById('root').innerHTML = \`
                  <div style="color: #ef4444; background: #fee2e2; padding: 1.5rem; border: 1px solid #fecaca; border-radius: 0.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; margin: 1rem;">
                    <h3 style="margin-top: 0; color: #991b1b; font-size: 1.125rem;">Runtime Error</h3>
                    <pre style="white-space: pre-wrap; margin: 0; font-size: 0.875rem; line-height: 1.5;">\${err.stack || err.toString()}</pre>
                  </div>
                \`;
              }
            </script>
          </body>
        </html>
      `;
    }

    // Use srcdoc to create a completely fresh document context each time,
    // avoiding stale Babel helper declarations on refresh
    iframeRef.current.srcdoc = content;
  }, [code, language]);

  const handleRefresh = useCallback(() => {
    setError(null);
    updateIframe();
  }, [updateIframe]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "preview-error") {
        setError(event.data.message);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Use a separate effect for the initial load and tab switches
  // but don't clear the error here
  // Debounced update to avoid flickering during streaming
  useEffect(() => {
    if (activeTab !== "preview") return;

    const timer = setTimeout(() => {
      updateIframe();
    }, 500); // Wait 500ms after last code change

    return () => clearTimeout(timer);
  }, [code, activeTab, updateIframe]);

  return (
    <div
      className={`flex flex-col border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden bg-white dark:bg-zinc-950 my-4 ${
        isFullscreen ? "fixed inset-4 z-50" : "w-full"
      }`}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50">
        <div className="flex items-center gap-4">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
            {title}
          </span>
          <div className="flex bg-zinc-200 dark:bg-zinc-800 p-0.5 rounded-lg">
            <button
              onClick={() => setActiveTab("preview")}
              className={`px-3 py-1 text-xs rounded-md transition-all ${
                activeTab === "preview"
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              <Play className="w-3 h-3 inline-block mr-1" /> Preview
            </button>
            <button
              onClick={() => setActiveTab("code")}
              className={`px-3 py-1 text-xs rounded-md transition-all ${
                activeTab === "code"
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              <Code className="w-3 h-3 inline-block mr-1" /> Code
            </button>
          </div>
          {error && onDebug && activeTab === "preview" && (
            <button
              onClick={() => onDebug(error)}
              className="flex items-center gap-1.5 px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-[10px] font-bold rounded-md transition-all shadow-sm animate-pulse"
            >
              <Bug className="w-3 h-3" />
              DEBUG WITH GEMINI
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={copyToClipboard}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            title="Copy code"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={handleDownload}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            title="Download as ZIP"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={handleRefresh}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            title="Reload preview"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      <div className="relative flex-1 min-h-[500px] bg-zinc-50 dark:bg-zinc-900/20">
        {activeTab === "preview" ? (
          <iframe
            ref={iframeRef}
            className="w-full h-full min-h-[500px] border-none bg-white"
            sandbox="allow-scripts allow-modals allow-forms allow-popups allow-same-origin"
            title="Code Preview"
          />
        ) : (
          <div className="h-full overflow-auto max-h-[600px] bg-[#1e1e1e]">
            <SyntaxHighlighter
              language={language}
              style={vscDarkPlus}
              showLineNumbers={true}
              wrapLines={true}
              className="gemini-code-block"
              lineNumberStyle={{ color: "#6e7681", minWidth: "2em", paddingRight: "1em", userSelect: "none" }}
              customStyle={{
                margin: 0,
                padding: "1.5rem",
                fontSize: "0.875rem",
                lineHeight: "1.5",
                backgroundColor: "transparent",
              }}
              codeTagProps={{
                style: {
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                },
              }}
            >
              {code}
            </SyntaxHighlighter>
          </div>
        )}
      </div>
    </div>
  );
}
