"use client";

import { useState, useEffect, useRef } from "react";
import {
  Play,
  Code,
  Maximize2,
  Minimize2,
  RotateCcw,
  Copy,
  Check,
} from "lucide-react";

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

  const updateIframe = () => {
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
      // Basic React/JS runner template
      content = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8" />
            <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
            <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
              body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
              #root { padding: 20px; }
            </style>
          </head>
          <body>
            <div id="root"></div>
            <script type="text/babel">
              const { useState, useEffect, useMemo, useCallback, useRef } = React;
              
              try {
                ${
                  code.includes("export default")
                    ? code
                        .replace(
                          /export\s+default\s+function\s+(\w+)/,
                          "function $1"
                        )
                        .replace(/export\s+default\s+/, "const App = ") +
                      "\n ReactDOM.createRoot(document.getElementById('root')).render(<App />);"
                    : code +
                      "\n if (typeof App !== 'undefined') { ReactDOM.createRoot(document.getElementById('root')).render(<App />); } else if (typeof main !== 'undefined') { main(); }"
                }
              } catch (err) {
                document.getElementById('root').innerHTML = '<pre style="color: red">' + err.toString() + '</pre>';
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
  };

  useEffect(() => {
    if (activeTab === "preview") {
      updateIframe();
    }
  }, [code, activeTab]);

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

      <div className="relative flex-1 min-h-[300px] bg-zinc-50 dark:bg-zinc-900/20">
        {activeTab === "preview" ? (
          <iframe
            ref={iframeRef}
            className="w-full h-full border-none bg-white"
            sandbox="allow-scripts allow-modals allow-forms allow-popups allow-same-origin"
            title="Code Preview"
          />
        ) : (
          <pre className="p-4 text-sm font-mono text-zinc-800 dark:text-zinc-200 overflow-auto h-full max-h-[500px]">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
