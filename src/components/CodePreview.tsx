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
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface CodePreviewProps {
  code: string;
  language: string;
  title?: string;
}

export default function CodePreview({
  code,
  language,
  title = "Preview",
}: CodePreviewProps) {
  const [activeTab, setActiveTab] = useState<"preview" | "code">(
    language === "html" || language === "jsx" || language === "tsx"
      ? "preview"
      : "code"
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
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
      // Clean up the code: remove imports that will fail in the browser
      const cleanedCode = code
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, "")
        .replace(/export\s+default\s+function\s+(\w+)/, "function $1")
        .replace(/export\s+default\s+/, "const App = ")
        .replace(/export\s+/g, "");

      // Basic React/JS runner template
      content = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8" />
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
            <script src="https://unpkg.com/lucide@latest"></script>
            <script src="https://cdn.tailwindcss.com"></script>
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
              // Setup globals for the AI code
              const { 
                useState, useEffect, useMemo, useCallback, useRef, 
                useReducer, useContext, createContext, useLayoutEffect,
                useImperativeHandle, useDebugValue, useDeferredValue,
                useTransition, useId
              } = React;
              
              // Lucide icon helper
              window.LucideReact = window.lucide;

              try {
                ${cleanedCode}
                
                // Final render logic
                const container = document.getElementById('root');
                const root = ReactDOM.createRoot(container);
                
                if (typeof App !== 'undefined') {
                  root.render(
                    <React.StrictMode>
                      <App />
                    </React.StrictMode>
                  );
                } else if (typeof main !== 'undefined') {
                  main();
                } else {
                  console.error("No 'App' component found.");
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

  useEffect(() => {
    if (activeTab === "preview") {
      updateIframe();
    }
  }, [activeTab, updateIframe]);

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
            onClick={() => updateIframe()}
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
