"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
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
  Save,
  Camera,
  Loader2,
  Share2,
  ExternalLink,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import JSZip from "jszip";
import { savePreviewToIDB, requestPersistentStorage } from "@/lib/preview-idb";
import { saveApp } from "@/lib/saved-apps-idb";
import {
  buildPreviewAssetUrl,
  cacheGeneratedPreviewIcons,
  createPwaPreviewId,
  persistPwaPreviewAssets,
} from "@/lib/pwa-preview";

interface CodePreviewProps {
  code: string;
  language: string;
  title?: string;
  assets?: Array<{
    url: string;
    mimeType: string;
    data?: string;
    assetKey?: string;
  }>;
  onDebug?: (error: string, code: string, language: string) => void;
  onSnapshot?: (snapshot: {
    url: string;
    mimeType: string;
    data: string;
  }) => void;
  editSource?: "apps";
  existingAppId?: string;
  initialAppName?: string;
  initialHasGeneratedIcon?: boolean;
}

const EMPTY_PREVIEW_ASSETS: Array<{
  url: string;
  mimeType: string;
  data?: string;
  assetKey?: string;
}> = [];
const STUDIO_DRAFT_STORAGE_PREFIX = "studio-draft:";

function normalizePreviewError(message: string): string {
  const invalidHookPattern =
    /Cannot read properties of null \(reading 'useContext'\)|Invalid hook call/i;
  if (!invalidHookPattern.test(message)) return message;

  return `${message}\n\nHint: This preview failed due to an invalid React hook context. This usually happens when code imports React UI libraries that bundle/use a different React runtime, or when a hook is called outside a React function component/custom hook. Try using plain React + Tailwind in a single file and keep all hooks inside App/custom hooks.`;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

export default function CodePreview({
  code,
  language,
  title = "Preview",
  assets = EMPTY_PREVIEW_ASSETS,
  editSource,
  existingAppId,
  initialAppName,
  initialHasGeneratedIcon,
  onDebug,
  onSnapshot,
}: CodePreviewProps) {
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<"preview" | "code">(
    language === "html" || language === "jsx" || language === "tsx"
      ? "preview"
      : "code",
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isGeneratingPwaIcon, setIsGeneratingPwaIcon] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState("My App");
  const [saveIconPrompt, setSaveIconPrompt] = useState("");
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isSavingApp, setIsSavingApp] = useState(false);
  const [savePreviewId, setSavePreviewId] = useState<string | null>(null);
  const [hasSaveIcon, setHasSaveIcon] = useState(false);
  const [generatedIconBase64, setGeneratedIconBase64] = useState<string | null>(null);
  const [generatedIconPreviewUrl, setGeneratedIconPreviewUrl] = useState<string | null>(null);
  const [isCapturingSnapshot, setIsCapturingSnapshot] = useState(false);
  const [assetUrlMap, setAssetUrlMap] = useState<Record<string, string>>({});
  const [isPublishingShare, setIsPublishingShare] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const latestAssetsRef = useRef(assets);
  const shareInstallsEnabled =
    process.env.NEXT_PUBLIC_ENABLE_SHAREABLE_INSTALLS === "1" ||
    process.env.NEXT_PUBLIC_ENABLE_SHAREABLE_INSTALLS === "true";
  const assetSignature = useMemo(
    () =>
      assets
        .map(
          (asset, index) =>
            `${asset.assetKey || `asset_${index + 1}`}|${asset.mimeType}|${asset.data?.length || 0}|${asset.url}`,
        )
        .join("||"),
    [assets],
  );

  useEffect(() => {
    latestAssetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    const stableAssets = latestAssetsRef.current;
    if (!stableAssets.length) {
      setAssetUrlMap((prev) =>
        Object.keys(prev).length === 0 ? prev : {},
      );
      return;
    }

    const createdObjectUrls: string[] = [];
    const nextMap: Record<string, string> = {};
    const previewAssetId = existingAppId || savePreviewId;

    for (const [index, asset] of stableAssets.entries()) {
      const key = asset.assetKey || `asset_${index + 1}`;
      const placeholder = `__ASSET_${key}__`;
      let resolvedUrl =
        asset.url ||
        (previewAssetId ? buildPreviewAssetUrl(previewAssetId, key) : "");

      if (asset.data) {
        try {
          const binaryString = window.atob(asset.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], {
            type: asset.mimeType || "image/png",
          });
          resolvedUrl = URL.createObjectURL(blob);
          createdObjectUrls.push(resolvedUrl);
        } catch {
          resolvedUrl =
            asset.url ||
            (previewAssetId ? buildPreviewAssetUrl(previewAssetId, key) : "");
        }
      }

      nextMap[placeholder] = resolvedUrl;
    }

    setAssetUrlMap((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(nextMap);
      if (prevKeys.length === nextKeys.length) {
        const unchanged = nextKeys.every((key) => prev[key] === nextMap[key]);
        if (unchanged) {
          return prev;
        }
      }
      return nextMap;
    });
    return () => {
      for (const objectUrl of createdObjectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [assetSignature, existingAppId, savePreviewId]);

  // Remove legacy large icon data-url keys left by earlier builds.
  useEffect(() => {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (/^pwa-preview-.*-icon-(192|512)$/.test(key)) {
        localStorage.removeItem(key);
      }
    }
  }, []);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenInStudio = useCallback(() => {
    if (typeof window === "undefined") return;

    const draftId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    window.sessionStorage.setItem(
      `${STUDIO_DRAFT_STORAGE_PREFIX}${draftId}`,
      JSON.stringify({
        code,
        language,
        title,
        assets,
      }),
    );
    window.location.assign(`/studio?draft=${encodeURIComponent(draftId)}`);
  }, [assets, code, language, title]);

  const handleDownload = useCallback(async () => {
    const name =
      window.prompt("Enter a name for your project:", "my-app") || "my-app";
    const safeName = name.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();

    // Detect if "html"-tagged code is actually React/JSX
    const isReactCode =
      /import\s.*from\s/.test(code) ||
      /export\s+default\s+function/.test(code) ||
      /useState|useEffect|useRef|useCallback/.test(code);
    const dlLanguage = language === "html" && isReactCode ? "tsx" : language;

    const zip = new JSZip();
    const folder = zip.folder(safeName)!;

    if (dlLanguage === "html") {
      folder.file("index.html", code);
    } else {
      const ext =
        dlLanguage === "tsx" || dlLanguage === "typescript" ? "tsx" : "jsx";
      folder.file("App." + ext, code);

      // Process the code: extract lucide icons, strip imports/exports
      const lucideIconDecls: string[] = [];

      // Extract the default-exported function name before transforms
      const dlDefaultExportMatch = code.match(
        /export\s+default\s+function\s+(\w+)/,
      );
      const dlDefaultExportName = dlDefaultExportMatch
        ? dlDefaultExportMatch[1]
        : null;

      const processedCode =
        code
          .replace(
            /import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
            "",
          )
          .replace(/import\s+type\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
          .replace(
            /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"];?\n?/g,
            (_match, names) => {
              const icons = names
                .split(",")
                .map((n: string) => n.trim())
                .filter(Boolean)
                .filter((n: string) => !n.startsWith("type "));
              icons.forEach((rawName: string) => {
                const parts = rawName.split(/\s+as\s+/);
                const original = parts[0]?.trim();
                const alias = parts[1]?.trim() || original;
                if (!original || !alias) return;
                const kebab = original
                  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
                  .toLowerCase();
                lucideIconDecls.push(
                  "const " +
                    alias +
                    " = __createLucideIcon('" +
                    kebab +
                    "', '" +
                    original +
                    "');",
                );
              });
              return "";
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
        // Alias the default-exported function as App (if it wasn't already named App)
        (dlDefaultExportName && dlDefaultExportName !== "App"
          ? `\nconst App = ${dlDefaultExportName};\n`
          : "");
      const externalImportPreamble = buildExternalImportPreamble(code);

      const iconSection =
        lucideIconDecls.length > 0
          ? "\n      // Lucide icon components\n      " +
            lucideIconDecls.join("\n      ") +
            "\n"
          : "";

      // Build runner HTML using string concatenation to avoid template literal issues
      const runnerParts = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="UTF-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        "    <title>My App</title>",
        '    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
        '    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>',
        '    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>',
        '    <script src="https://unpkg.com/lucide@latest"></script>',
        '    <script src="https://cdn.tailwindcss.com"></script>',
        "    <script>",
        "      Babel.registerPreset('tsx', {",
        "        presets: [",
        "          [Babel.availablePresets['typescript'], { isTSX: true, allExtensions: true }],",
        "          [Babel.availablePresets['react']]",
        "        ]",
        "      });",
        "    </script>",
        "    <style>",
        "      body {",
        "        margin: 0;",
        '        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
        "        background-color: white;",
        "        color: #18181b;",
        "      }",
        "      #root { padding: 0; min-height: 100vh; }",
        "    </style>",
        "  </head>",
        "  <body>",
        '    <div id="root"></div>',
        '    <script type="text/babel" data-presets="tsx">',
        "      const {",
        "        useState, useEffect, useMemo, useCallback, useRef,",
        "        useReducer, useContext, createContext, useLayoutEffect,",
        "        useImperativeHandle, useDebugValue, useDeferredValue,",
        "        useTransition, useId, memo, forwardRef, lazy,",
        "        Suspense, Fragment, createElement, cloneElement,",
        "        Children, createRef, isValidElement",
        "      } = React;",
        "",
        "      // Guard canvas draws against not-yet-ready/broken images so preview code",
        "      // does not crash when assets are still loading.",
        "      const __nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;",
        "      CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {",
        "        if (image instanceof HTMLImageElement) {",
        "          const imageBroken = !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0;",
        "          if (imageBroken) return;",
        "        }",
        "        return __nativeDrawImage.call(this, image, ...args);",
        "      };",
        "",
        "      // Lucide icon factory — uses lucide.createElement() for reliable SVG generation",
        "      const __iconHtmlCache = {};",
        "      function __createLucideIcon(kebabName, displayName) {",
        "        const LucideIcon = function(props) {",
        "          const { size = 24, color = 'currentColor', strokeWidth = 2, className, style, ...rest } = props || {};",
        "          if (!__iconHtmlCache[kebabName]) {",
        "            try {",
        "              const iconDef = window.lucide?.icons?.[kebabName];",
        "              if (iconDef && window.lucide?.createElement) {",
        "                const svgEl = window.lucide.createElement(iconDef);",
        "                __iconHtmlCache[kebabName] = svgEl.innerHTML;",
        "              }",
        "            } catch(e) { /* icon not found */ }",
        "          }",
        "          const innerHtml = __iconHtmlCache[kebabName];",
        "          if (!innerHtml) return null;",
        "          return React.createElement('svg', Object.assign({",
        "            xmlns: 'http://www.w3.org/2000/svg',",
        "            width: size, height: size, viewBox: '0 0 24 24',",
        "            fill: 'none', stroke: color, strokeWidth: strokeWidth,",
        "            strokeLinecap: 'round', strokeLinejoin: 'round',",
        "            className: className, style: style,",
        "            dangerouslySetInnerHTML: { __html: innerHtml }",
        "          }, rest));",
        "        };",
        "        LucideIcon.displayName = displayName || kebabName;",
        "        return LucideIcon;",
        "      }",
        "",
        "      const __externalImportCache = {};",
        "      async function __importFrom(specifier) {",
        "        if (__externalImportCache[specifier]) return __externalImportCache[specifier];",
        "        const isRemote = /^https?:\\/\\//.test(specifier);",
        "        const isRelative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('next/');",
        "        if (!isRemote && isRelative) throw new Error('Unsupported import in preview: ' + specifier);",
        "        const url = isRemote ? specifier : ('https://esm.sh/' + specifier + '?bundle');",
        "        const mod = await import(url);",
        "        __externalImportCache[specifier] = mod;",
        "        return mod;",
        "      }",
        "",
        iconSection,
        "",
        "      (async () => {",
        "        try {",
        externalImportPreamble,
        "",
        "          // APP CODE",
        processedCode,
        "",
        "          // Render",
        "          const container = document.getElementById('root');",
        "          const root = ReactDOM.createRoot(container);",
        "          if (typeof App !== 'undefined') {",
        "            root.render(React.createElement(React.StrictMode, null, React.createElement(App)));",
        "          }",
        "        } catch (err) {",
        "          const container = document.getElementById('root');",
        "          if (container) {",
        "            container.innerHTML = '<div style=\"color:#ef4444;background:#fee2e2;padding:1rem;border:1px solid #fecaca;border-radius:.5rem;margin:1rem;font-family:monospace;\"><b>Runtime Error:</b><pre style=\"white-space:pre-wrap;\">' + (err && (err.stack || err.toString()) ? (err.stack || err.toString()) : String(err)) + '</pre></div>';",
        "          }",
        "        }",
        "      })();",
        "    </script>",
        "  </body>",
        "</html>",
      ];

      folder.file("index.html", runnerParts.join("\n"));

      // Add a README
      const readme = [
        `# ${name}`,
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
    a.download = `${safeName}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [code, language]);

  const resolveEffectiveLanguage = useCallback(() => {
    const isReactCode =
      /import\s.*from\s/.test(code) ||
      /export\s+default\s+function/.test(code) ||
      /useState|useEffect|useRef|useCallback/.test(code);
    return language === "html" && isReactCode ? "tsx" : language;
  }, [code, language]);

  const openSaveModal = useCallback(() => {
    const targetId =
      editSource === "apps" && existingAppId ? existingAppId : null;
    const existingStoredName = targetId
      ? localStorage.getItem(`pwa-preview-${targetId}-name`)
      : null;
    const existingIconFromStorage = targetId
      ? localStorage.getItem(`pwa-preview-${targetId}-has-generated-icon`) === "1"
      : false;
    const existingIcon192 = targetId
      ? localStorage.getItem(`pwa-preview-${targetId}-icon192-b64`)
      : null;
    const hasExistingIcon = targetId
      ? existingIconFromStorage || Boolean(initialHasGeneratedIcon)
      : false;

    setSaveName(
      existingStoredName ||
        initialAppName ||
        (title && title !== "Preview" ? title : "My App"),
    );
    setSaveIconPrompt("");
    setSaveStatus(null);
    setSavePreviewId(targetId);
    setHasSaveIcon(hasExistingIcon);
    setGeneratedIconBase64(existingIcon192 || null);
    if (existingIcon192) {
      setGeneratedIconPreviewUrl(`data:image/png;base64,${existingIcon192}`);
    } else if (hasExistingIcon && targetId) {
      setGeneratedIconPreviewUrl(
        `/api/preview/${targetId}/generate-icon?size=192&v=${Date.now()}`,
      );
    } else {
      setGeneratedIconPreviewUrl(null);
    }
    setShowSaveModal(true);
  }, [editSource, existingAppId, initialAppName, initialHasGeneratedIcon, title]);

  const closeSaveModal = useCallback(() => {
    setShowSaveModal(false);
  }, []);

  const handleGenerateSaveIcon = useCallback(async () => {
    if (isGeneratingPwaIcon) return;
    const name = saveName.trim() || "My App";
    const id = savePreviewId || createPwaPreviewId();
    if (!savePreviewId) {
      setSavePreviewId(id);
    }

    setIsGeneratingPwaIcon(true);
    setSaveStatus("Generating icon...");
    try {
      const retryDelaysMs = [900, 1700];
      type GenerateIconResponse = {
        details?: string;
        error?: string;
        icons?: { icon192?: string; icon512?: string };
        iconDataUrls?: { icon192?: string; icon512?: string };
      };
      let data: GenerateIconResponse | null = null;
      let success = false;

      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        const res = await fetch(`/api/preview/${id}/generate-icon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            prompt:
              saveIconPrompt.trim() ||
              `Create a clean, high-contrast, minimal app icon for "${name}" that matches this ${language} preview app. Centered symbol, no text, no watermark, readable at small sizes.`,
            pro: true,
          }),
        });

        data = await res.json();
        if (res.ok) {
          success = true;
          break;
        }

        const isRetryable = res.status === 503;
        const canRetry = attempt < retryDelaysMs.length;
        if (isRetryable && canRetry) {
          const retryNumber = attempt + 1;
          const retryTotal = retryDelaysMs.length;
          setSaveStatus(
            `Model is busy, retrying icon generation (${retryNumber}/${retryTotal})...`
          );
          await sleep(retryDelaysMs[attempt] ?? 0);
          continue;
        }

        throw new Error(data?.details || data?.error || "Icon generation failed");
      }
      if (!success) throw new Error("Icon generation failed");

      const icon192b64 = data?.iconDataUrls?.icon192?.replace(/^data:[^,]+,/, "") || null;
      const icon512b64 = data?.iconDataUrls?.icon512?.replace(/^data:[^,]+,/, "") || null;
      const iconVersion = Date.now();
      if (icon192b64) {
        localStorage.setItem(`pwa-preview-${id}-icon192-b64`, icon192b64);
        setGeneratedIconBase64(icon192b64);
      }
      localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
      localStorage.setItem(`pwa-preview-${id}-icon-version`, String(iconVersion));
      await cacheGeneratedPreviewIcons(id, { icon192b64, icon512b64, version: iconVersion });
      setHasSaveIcon(true);

      const cacheBust = Date.now();
      const baseIconUrl = data?.icons?.icon192 || `/api/preview/${id}/generate-icon?size=192`;
      const separator = baseIconUrl.includes("?") ? "&" : "?";
      setGeneratedIconPreviewUrl(`${baseIconUrl}${separator}v=${cacheBust}`);
      setSaveStatus("Icon ready! Click Save to finish.");
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Unable to generate icon right now.";
      setSaveStatus(message);
    } finally {
      setIsGeneratingPwaIcon(false);
    }
  }, [isGeneratingPwaIcon, language, saveName, saveIconPrompt, savePreviewId]);

  const handleSaveApp = useCallback(async () => {
    if (isSavingApp) return;
    const id =
      savePreviewId ||
      (editSource === "apps" && existingAppId
        ? existingAppId
        : createPwaPreviewId());
    const name = saveName.trim() || "My App";
    const hasGeneratedIcon = hasSaveIcon;
    const effectiveLanguage = resolveEffectiveLanguage();

    setIsSavingApp(true);
    setSaveStatus("Saving...");
    try {
      localStorage.setItem(`pwa-preview-${id}-code`, code);
      localStorage.setItem(`pwa-preview-${id}-language`, effectiveLanguage);
      localStorage.setItem(`pwa-preview-${id}-name`, name);
      if (hasGeneratedIcon) {
        localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
        if (!localStorage.getItem(`pwa-preview-${id}-icon-version`)) {
          localStorage.setItem(`pwa-preview-${id}-icon-version`, String(Date.now()));
        }
      } else {
        localStorage.removeItem(`pwa-preview-${id}-has-generated-icon`);
        localStorage.removeItem(`pwa-preview-${id}-icon-version`);
      }

      await persistPwaPreviewAssets(id, latestAssetsRef.current);
      savePreviewToIDB({
        id,
        standaloneHTML: "",
        code,
        language: effectiveLanguage,
        name,
        hasGeneratedIcon,
        timestamp: Date.now(),
      }).catch(() => {});
      requestPersistentStorage();

      await saveApp({
        id,
        name,
        iconBase64: generatedIconBase64 ?? undefined,
        hasIcon: hasGeneratedIcon,
        timestamp: Date.now(),
      });

      const publishResp = await fetch("/api/apps/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name,
          code,
          language: effectiveLanguage,
          hasGeneratedIcon,
          assets: (latestAssetsRef.current || []).map((asset, index) => ({
            assetKey: asset.assetKey || `asset_${index + 1}`,
            mimeType: asset.mimeType || "application/octet-stream",
            data: asset.data,
            url: asset.url,
          })),
        }),
      });
      const publishData = await publishResp.json().catch(() => ({}));
      if (!publishResp.ok || !publishData?.shareUrl) {
        const details =
          publishData?.details || publishData?.error || "Cloud save failed.";
        setSaveStatus(`Saved locally. Firebase sync failed: ${details}`);
      } else {
        const sharedLink = publishData.shareUrl as string;
        setShareUrl(sharedLink);
        setShareStatus("Saved locally and synced to Firebase.");
        setSaveStatus("Saved to My Apps and Firebase.");
      }
      setShowSaveModal(false);
    } catch {
      setSaveStatus("Failed to save. Please try again.");
    } finally {
      setIsSavingApp(false);
    }
  }, [
    code,
    editSource,
    existingAppId,
    generatedIconBase64,
    hasSaveIcon,
    isSavingApp,
    resolveEffectiveLanguage,
    saveName,
    savePreviewId,
  ]);

  const handlePublishShare = useCallback(async () => {
    if (isPublishingShare) return;
    setIsPublishingShare(true);
    setShareStatus("Publishing...");
    setShareUrl(null);

    try {
      const name = window.prompt("Enter a name for your shared app:", "My App") || "My App";
      const id = createPwaPreviewId();
      const hasGeneratedIcon = false;
      const effectiveLanguage = resolveEffectiveLanguage();

      localStorage.setItem(`pwa-preview-${id}-code`, code);
      localStorage.setItem(`pwa-preview-${id}-language`, effectiveLanguage);
      localStorage.setItem(`pwa-preview-${id}-name`, name);
      if (hasGeneratedIcon) {
        localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
      }

      await persistPwaPreviewAssets(id, latestAssetsRef.current);
      savePreviewToIDB({
        id,
        standaloneHTML: "",
        code,
        language: effectiveLanguage,
        name,
        hasGeneratedIcon,
        timestamp: Date.now(),
      }).catch(() => {});
      requestPersistentStorage();

      const publishResp = await fetch("/api/apps/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name,
          code,
          language: effectiveLanguage,
          hasGeneratedIcon,
          assets: (latestAssetsRef.current || []).map((asset, index) => ({
            assetKey: asset.assetKey || `asset_${index + 1}`,
            mimeType: asset.mimeType || "application/octet-stream",
            data: asset.data,
            url: asset.url,
          })),
        }),
      });
      const data = await publishResp.json();
      if (!publishResp.ok || !data?.shareUrl) {
        throw new Error(data?.details || data?.error || "Publish failed.");
      }

      const sharedLink = data.shareUrl as string;
      setShareUrl(sharedLink);
      setShareStatus("Shared link ready.");
      try {
        await navigator.clipboard.writeText(sharedLink);
        setShareStatus("Shared link copied to clipboard.");
      } catch {
        // clipboard write is best-effort
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unable to publish shared app.";
      setShareStatus(message);
    } finally {
      setIsPublishingShare(false);
    }
  }, [code, isPublishingShare, resolveEffectiveLanguage]);

  const requestPreviewSnapshot = useCallback(async (): Promise<string> => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !iframe.contentDocument) {
      throw new Error("Preview is not ready yet.");
    }

    // Always get live references at capture time
    const getIframeRefs = () => {
      const win = iframe.contentWindow as unknown as Record<string, unknown>;
      const doc = iframe.contentDocument;
      return { win, doc };
    };

    let { win: iframeWin, doc: iframeDoc } = getIframeRefs();

    // Wait for iframe document to be fully loaded
    if (iframeDoc && iframeDoc.readyState !== "complete") {
      await new Promise<void>((resolve) => {
        const check = () => {
          const { doc } = getIframeRefs();
          if (doc?.readyState === "complete") {
            resolve();
          } else {
            window.setTimeout(check, 50);
          }
        };
        check();
        window.setTimeout(resolve, 3000);
      });
      ({ win: iframeWin, doc: iframeDoc } = getIframeRefs());
    }

    if (!iframeDoc?.body) {
      throw new Error("Preview document is not ready.");
    }

    // dom-to-image-more uses the browser's native SVG foreignObject
    // renderer with properly inlined computed styles, so the output
    // is pixel-perfect (flexbox, text baselines, etc. all match).
    const dtiKey = "domtoimage";
    if (
      typeof iframeWin[dtiKey] !== "object" ||
      iframeWin[dtiKey] === null
    ) {
      await new Promise<void>((resolve, reject) => {
        const script = iframeDoc!.createElement("script");
        script.src =
          "https://cdn.jsdelivr.net/npm/dom-to-image-more@3/dist/dom-to-image-more.min.js";
        script.onload = () => resolve();
        script.onerror = () =>
          reject(new Error("Failed to load snapshot library."));
        iframeDoc!.head.appendChild(script);
      });

      ({ win: iframeWin, doc: iframeDoc } = getIframeRefs());

      if (!iframeDoc?.body) {
        throw new Error("Preview document became unavailable during capture.");
      }
    }

    const domToImage = iframeWin[dtiKey] as {
      toPng: (
        node: Node,
        options?: Record<string, unknown>,
      ) => Promise<string>;
    };

    if (typeof domToImage?.toPng !== "function") {
      throw new Error("Snapshot library failed to initialize.");
    }

    const iframeWindow = iframe.contentWindow;

    // Wait for web fonts so text metrics are correct.
    if (iframeDoc.fonts?.status !== "loaded") {
      await Promise.race([
        iframeDoc.fonts?.ready ?? Promise.resolve(),
        new Promise((resolve) => window.setTimeout(resolve, 2000)),
      ]);
    }

    // Let the browser finish one more paint frame.
    await new Promise<void>((resolve) => {
      iframeWindow.requestAnimationFrame(() => {
        iframeWindow.requestAnimationFrame(() => resolve());
      });
    });

    // Read the actual background color from the page so we don't
    // introduce a white border on dark-themed previews.
    const computedBg =
      iframeWindow.getComputedStyle(iframeDoc.body).backgroundColor ||
      iframeWindow.getComputedStyle(iframeDoc.documentElement).backgroundColor;
    const bg =
      computedBg && computedBg !== "rgba(0, 0, 0, 0)" && computedBg !== "transparent"
        ? computedBg
        : null;

    // Temporarily suppress outlines, focus rings, carets, and border
    // artifacts that foreignObject renders differently from the live
    // preview.  Removed immediately after capture.
    const fixup = iframeDoc.createElement("style");
    fixup.setAttribute("data-snapshot-fixup", "1");
    fixup.textContent = [
      "*, *::before, *::after {",
      "  outline: none !important;",
      "  outline-offset: 0 !important;",
      "  caret-color: transparent !important;",
      "  text-decoration-color: currentColor !important;",
      "}",
      "input, textarea, [contenteditable] {",
      "  border-color: transparent !important;",
      "}",
    ].join("\n");
    iframeDoc.head.appendChild(fixup);

    try {
      return await domToImage.toPng(iframeDoc.body, {
        width: iframe.clientWidth || undefined,
        height: iframe.clientHeight || undefined,
        bgcolor: bg,
        cacheBust: true,
      });
    } finally {
      fixup.remove();
    }
  }, []);

  const handleSnapshot = useCallback(async () => {
    if (!onSnapshot || isCapturingSnapshot) return;
    setIsCapturingSnapshot(true);
    try {
      const dataUrl = await requestPreviewSnapshot();
      const parsed = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!parsed?.[2]) {
        throw new Error("Captured snapshot had an invalid format.");
      }
      const mimeType = parsed[1] || "image/png";
      const base64 = parsed[2];

      // Convert to a fresh Blob URL so each snapshot is a unique URL
      // and the browser / React always treats it as a new image.
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);

      onSnapshot({ url: blobUrl, mimeType, data: base64 });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to capture preview snapshot.";
      window.alert(message);
    } finally {
      setIsCapturingSnapshot(false);
    }
  }, [isCapturingSnapshot, onSnapshot, requestPreviewSnapshot]);

  const updateIframe = useCallback(() => {
    if (!iframeRef.current) return;
    const transparentFallbackDataUrl =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    const inferAssetCategory = (assetKey: string): string => {
      const key = assetKey.toLowerCase();
      if (
        key.includes("background") ||
        key.includes("scene") ||
        key === "bg"
      ) {
        return "background";
      }
      if (
        key.includes("character") ||
        key.includes("bird") ||
        key.includes("player") ||
        key.includes("hero") ||
        key.includes("avatar") ||
        key.includes("actor")
      ) {
        return "character";
      }
      if (
        key.includes("target") ||
        key.includes("pig") ||
        key.includes("enemy") ||
        key.includes("secondary") ||
        key.includes("opponent")
      ) {
        return "secondary";
      }
      if (
        key.includes("structure") ||
        key.includes("wood") ||
        key.includes("slingshot") ||
        key.includes("obstacle") ||
        key.includes("block") ||
        key.includes("terrain")
      ) {
        return "structure";
      }
      if (
        key.includes("effect") ||
        key.includes("effect") ||
        key.includes("impact") ||
        key.includes("explosion")
      ) {
        return "effect";
      }
      return "generic";
    };

    const indexedAssets = Object.entries(assetUrlMap).map(
      ([placeholder, assetUrl]) => {
        const key = placeholder
          .replace(/^__ASSET_/, "")
          .replace(/__$/, "")
          .toLowerCase();
        return {
          placeholder,
          assetUrl,
          category: inferAssetCategory(key),
          key,
        };
      },
    );

    const codeWithAssetUrls = code.replace(
      /__ASSET_([a-zA-Z0-9_-]+)__/g,
      (fullMatch, rawKey: string) => {
        if (assetUrlMap[fullMatch]) {
          return assetUrlMap[fullMatch];
        }

        const requestKey = rawKey.toLowerCase();
        const requestCategory = inferAssetCategory(requestKey);

        const categoryMatch = indexedAssets.find(
          (entry) => entry.category === requestCategory,
        );
        if (categoryMatch) {
          return categoryMatch.assetUrl;
        }

        const fuzzyMatch = indexedAssets.find(
          (entry) =>
            entry.key.includes(requestKey) || requestKey.includes(entry.key),
        );
        if (fuzzyMatch) {
          return fuzzyMatch.assetUrl;
        }

        return transparentFallbackDataUrl;
      },
    );
    const codeWithResolvedFallbacks = codeWithAssetUrls.replace(
      /(["'`])((?:\/)?[a-zA-Z0-9_-]+\.(?:png|jpe?g|gif|webp|svg))\1/g,
      (fullMatch, quote: string, rawPath: string) => {
        const normalizedPath = rawPath.trim().toLowerCase();
        if (
          normalizedPath.startsWith("http://") ||
          normalizedPath.startsWith("https://") ||
          normalizedPath.startsWith("data:") ||
          normalizedPath.startsWith("blob:") ||
          normalizedPath.startsWith("/preview/") ||
          normalizedPath.startsWith("/api/")
        ) {
          return fullMatch;
        }

        const requestKey = normalizedPath
          .replace(/^\//, "")
          .replace(/\.[a-z0-9]+$/, "");
        const requestCategory = inferAssetCategory(requestKey);

        const categoryMatch = indexedAssets.find(
          (entry) => entry.category === requestCategory,
        );
        if (categoryMatch?.assetUrl) {
          return `${quote}${categoryMatch.assetUrl}${quote}`;
        }

        const fuzzyMatch = indexedAssets.find(
          (entry) =>
            entry.key.includes(requestKey) || requestKey.includes(entry.key),
        );
        if (fuzzyMatch?.assetUrl) {
          return `${quote}${fuzzyMatch.assetUrl}${quote}`;
        }

        return fullMatch;
      },
    );

    // Detect if "html"-tagged code is actually React/JSX
    const isReactCode =
      /import\s.*from\s/.test(codeWithResolvedFallbacks) ||
      /export\s+default\s+function/.test(codeWithResolvedFallbacks) ||
      /useState|useEffect|useRef|useCallback/.test(codeWithResolvedFallbacks);

    const effectiveLanguage =
      language === "html" && isReactCode ? "tsx" : language;

    let content = "";
    if (effectiveLanguage === "html") {
      content = codeWithResolvedFallbacks;
    } else if (
      effectiveLanguage === "jsx" ||
      effectiveLanguage === "tsx" ||
      effectiveLanguage === "javascript" ||
      effectiveLanguage === "typescript"
    ) {
      // Clean up the code: convert lucide imports to const declarations,
      // strip all other imports, and handle exports

      // Extract the default-exported function name before transforms
      const defaultExportMatch = codeWithResolvedFallbacks.match(
        /export\s+default\s+function\s+(\w+)/,
      );
      const defaultExportName = defaultExportMatch
        ? defaultExportMatch[1]
        : null;

      const cleanedCode =
        codeWithResolvedFallbacks
          // Remove type-only imports
          .replace(
            /import\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
            "",
          )
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
                  .filter((n: string) => !n.startsWith("type "))
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
          // Remove remaining imports (react, etc.)
          .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g, "")
          .replace(
            /import\s+\w+\s*,?\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\n?/g,
            "",
          )
          .replace(/import\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
          .replace(/import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*['"];?\n?/g, "")
          // Remove side-effect imports
          .replace(/import\s*['"][^'"]*['"];?\n?/g, "")
          // Handle exports — just strip the keywords, keep function declarations intact
          .replace(/export\s+default\s+function\s+(\w+)/, "function $1")
          .replace(/export\s+default\s+/, "const App = ")
          .replace(/export\s+/g, "") +
        // Alias the default-exported function as App (if it wasn't already named App)
        (defaultExportName && defaultExportName !== "App"
          ? `\nconst App = ${defaultExportName};\n`
          : "");

      // Escape LaTeX math in JSX so Babel doesn't interpret $...$ content as expressions
      const escapeLatex = (src: string): string => {
        // Replace block math $$...$$ with {"$$...$$"} (double dollar is never valid JS)
        src = src.replace(
          /\$\$([\s\S]*?)\$\$/g,
          (_m: string, inner: string) => {
            const escaped = inner
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"')
              .replace(/\n/g, "\\n");
            return '{"$$' + escaped + '$$"}';
          },
        );
        // Replace inline math $...$ that contains LaTeX-like chars (\, ^, _, or is a single letter)
        src = src.replace(/\$([^$\n]+?)\$/g, (_m: string, inner: string) => {
          // Only escape if it looks like LaTeX (contains \, ^, _, or is a single letter variable like A, B, x)
          if (/[\\^_]/.test(inner) || /^[A-Za-z]$/.test(inner)) {
            const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            return '{"$' + escaped + '$"}';
          }
          return _m; // leave non-LaTeX dollar expressions alone
        });
        return src;
      };

      const finalCode = escapeLatex(cleanedCode);
      const externalImportPreamble = buildExternalImportPreamble(
        codeWithResolvedFallbacks,
      );

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

              const __externalImportCache = {};
              async function __importFrom(specifier) {
                if (__externalImportCache[specifier]) return __externalImportCache[specifier];
                const isRemote = /^https?:\\/\\//.test(specifier);
                const isRelative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('next/');
                if (!isRemote && isRelative) {
                  throw new Error('Unsupported import in preview: ' + specifier);
                }
                const url = isRemote ? specifier : ('https://esm.sh/' + specifier + '?bundle');
                const mod = await import(url);
                __externalImportCache[specifier] = mod;
                return mod;
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

              (async () => {
                try {
                  ${externalImportPreamble}
                  ${finalCode}
                  
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
              })();
            </script>
          </body>
        </html>
      `;
    }

    // Use srcdoc to create a completely fresh document context each time,
    // avoiding stale Babel helper declarations on refresh
    iframeRef.current.srcdoc = content;
  }, [assetUrlMap, code, language]);

  const handleRefresh = useCallback(() => {
    setError(null);
    updateIframe();
  }, [updateIframe]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "preview-error") {
        const rawMessage =
          typeof event.data.message === "string"
            ? event.data.message
            : String(event.data.message);
        setError(normalizePreviewError(rawMessage));
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
        isFullscreen ? "fixed inset-1 z-50 sm:inset-4" : "w-full"
      }`}
    >
      <div className="flex flex-col gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
            {title}
          </span>
          <div className="flex bg-zinc-200 dark:bg-zinc-800 p-0.5 rounded-lg">
            <button
              onClick={() => setActiveTab("preview")}
              className={`rounded-md px-3 py-1 text-xs transition-all ${
                activeTab === "preview"
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              <Play className="w-3 h-3 inline-block mr-1" /> Preview1
            </button>
            <button
              onClick={() => setActiveTab("code")}
              className={`rounded-md px-3 py-1 text-xs transition-all ${
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
              onClick={() => onDebug(error, code, language)}
              className="flex items-center gap-1.5 rounded-md bg-red-500 px-3 py-1 text-[10px] font-bold text-white shadow-sm transition-all hover:bg-red-600 sm:text-[11px]"
            >
              <Bug className="w-3 h-3" />
              DEBUG WITH GEMINI
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1 sm:gap-2">
          {pathname !== "/studio" ? (
            <button
              onClick={handleOpenInStudio}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              title="Open in Studio"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
          ) : null}
          <button
            onClick={copyToClipboard}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
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
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title="Download as ZIP"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={openSaveModal}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title="Save App"
          >
            <Save className="w-4 h-4" />
          </button>
          {shareInstallsEnabled ? (
            <button
              onClick={handlePublishShare}
              disabled={isPublishingShare}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              title="Publish shareable app link"
            >
              {isPublishingShare ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Share2 className="w-4 h-4" />
              )}
            </button>
          ) : null}
          <button
            onClick={handleSnapshot}
            disabled={activeTab !== "preview" || !onSnapshot || isCapturingSnapshot}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title={
              activeTab === "preview"
                ? isCapturingSnapshot
                  ? "Capturing snapshot..."
                  : "Capture preview snapshot"
                : "Switch to Preview tab to capture"
            }
          >
            {isCapturingSnapshot ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Camera className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={handleRefresh}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title="Reload preview"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
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
      {shareStatus || shareUrl ? (
        <div className="px-4 py-2 text-[11px] text-zinc-600 dark:text-zinc-300 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/60">
          {shareStatus ? <p>{shareStatus}</p> : null}
          {shareUrl ? (
            <p className="mt-1 truncate">
              <span className="font-medium">Link:</span>{" "}
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="underline hover:no-underline"
              >
                {shareUrl}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="relative flex-1 min-h-[320px] bg-zinc-50 dark:bg-zinc-900/20 sm:min-h-[500px]">
        {activeTab === "preview" ? (
          <iframe
            ref={iframeRef}
            className="h-full min-h-[320px] w-full border-none bg-white sm:min-h-[500px]"
            sandbox="allow-scripts allow-modals allow-forms allow-popups allow-same-origin"
            title="Code Preview"
          />
        ) : (
          <div className="h-full max-h-[55vh] overflow-auto bg-[#1e1e1e] sm:max-h-[600px]">
            <SyntaxHighlighter
              language={language}
              style={vscDarkPlus}
              showLineNumbers={true}
              wrapLines={true}
              className="gemini-code-block"
              lineNumberStyle={{
                color: "#6e7681",
                minWidth: "2em",
                paddingRight: "1em",
                userSelect: "none",
              }}
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

      {showSaveModal ? (
        <div className="absolute inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Save App
              </h3>
              <button
                onClick={closeSaveModal}
                className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              App Name
            </label>
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              className="w-full mb-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
              placeholder="My App"
            />

            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Icon Prompt (optional)
            </label>
            <textarea
              value={saveIconPrompt}
              onChange={(e) => setSaveIconPrompt(e.target.value)}
              className="w-full mb-3 min-h-[90px] rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
              placeholder="Leave blank to auto-generate a prompt that matches this preview app."
            />

            {saveStatus ? (
              <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-300">{saveStatus}</p>
            ) : null}

            {generatedIconPreviewUrl ? (
              <div className="mb-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950/40 p-3">
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                  Icon Preview
                </p>
                <div className="w-24 h-24 rounded-xl overflow-hidden border border-zinc-300 dark:border-zinc-600">
                  <Image
                    src={generatedIconPreviewUrl}
                    alt="Generated app icon preview"
                    width={96}
                    height={96}
                    className="w-full h-full object-cover"
                    unoptimized
                  />
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={closeSaveModal}
                className="px-3 py-1.5 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateSaveIcon}
                disabled={isGeneratingPwaIcon}
                className="px-3 py-1.5 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
              >
                {isGeneratingPwaIcon
                  ? "Generating..."
                  : generatedIconPreviewUrl
                    ? "Regenerate"
                    : "Generate Icon"}
              </button>
              <button
                onClick={handleSaveApp}
                disabled={isSavingApp}
                className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white disabled:opacity-50"
              >
                {isSavingApp ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
