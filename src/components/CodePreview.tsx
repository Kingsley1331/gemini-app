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
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

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
      // Extract Lucide icon names from imports before stripping
      const lucideImports: string[] = [];
      const lucideImportRegex =
        /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"];?/g;
      let lucideMatch;
      while ((lucideMatch = lucideImportRegex.exec(code)) !== null) {
        const names = lucideMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          // Handle "X as Y" aliasing
          .map((s) => {
            const parts = s.split(/\s+as\s+/);
            return parts.length > 1
              ? { original: parts[0].trim(), alias: parts[1].trim() }
              : { original: s.trim(), alias: s.trim() };
          });
        names.forEach((n) => lucideImports.push(JSON.stringify(n)));
      }

      // Clean up the code: remove imports and exports
      const cleanedCode = code
        // Remove type-only imports
        .replace(/import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+type\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
        // Remove regular imports (single and multi-line)
        .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+\w+\s*,?\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
        .replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
        // Remove side-effect imports
        .replace(/import\s*['"][^'"]*['"];?\n?/g, "")
        // Handle exports
        .replace(/export\s+default\s+function\s+(\w+)/, "function $1")
        .replace(/export\s+default\s+/, "const App = ")
        .replace(/export\s+/g, "");

      // Generate Lucide icon declarations
      const iconDeclarations = lucideImports.length > 0
        ? `const __lucideNames = [${lucideImports.join(",")}];\n` +
          `__lucideNames.forEach(function(n) {\n` +
          `  const name = typeof n === 'string' ? n : n.original;\n` +
          `  const alias = typeof n === 'string' ? n : n.alias;\n` +
          `  const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();\n` +
          `  window[alias] = __createLucideIcon(kebab, name);\n` +
          `});\n`
        : "";

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
            <script type="text/babel" data-presets="react,typescript">
              // React globals
              const { 
                useState, useEffect, useMemo, useCallback, useRef, 
                useReducer, useContext, createContext, useLayoutEffect,
                useImperativeHandle, useDebugValue, useDeferredValue,
                useTransition, useId, memo, forwardRef, lazy, 
                Suspense, Fragment, createElement, cloneElement,
                Children, createRef, isValidElement
              } = React;

              // Lucide icon factory — creates React components from lucide vanilla icons
              function __createLucideIcon(kebabName, displayName) {
                const iconNode = window.lucide?.icons?.[kebabName];
                if (!iconNode) {
                  // Return a fallback that renders nothing but doesn't crash
                  const Fallback = () => null;
                  Fallback.displayName = displayName || kebabName;
                  return Fallback;
                }
                const LucideIcon = function(props) {
                  const { size = 24, color = 'currentColor', strokeWidth = 2, className, style, absoluteStrokeWidth, ...rest } = props || {};
                  const sw = absoluteStrokeWidth ? strokeWidth : strokeWidth * 24 / Number(size);
                  const children = (iconNode[2] || []).map(function(child, i) {
                    return React.createElement(child[0], Object.assign({ key: i }, child[1]));
                  });
                  return React.createElement('svg', Object.assign({
                    xmlns: 'http://www.w3.org/2000/svg',
                    width: size,
                    height: size,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: color,
                    strokeWidth: sw,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    className: className,
                    style: style
                  }, rest), ...children);
                };
                LucideIcon.displayName = displayName || kebabName;
                return LucideIcon;
              }

              // Proxy to auto-create any Lucide icon on access
              const __LucideProxy = new Proxy({}, {
                get(target, prop) {
                  if (typeof prop !== 'string') return undefined;
                  if (!target[prop]) {
                    const kebab = prop.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
                    target[prop] = __createLucideIcon(kebab, prop);
                  }
                  return target[prop];
                }
              });

              // Setup explicit icon declarations from imports
              ${iconDeclarations}

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

    const doc = iframeRef.current.contentWindow?.document;
    if (doc) {
      doc.open();
      doc.write(content);
      doc.close();
    }
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
