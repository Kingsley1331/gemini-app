"use client";

import dynamic from "next/dynamic";
import type { IDisposable, editor as MonacoEditorApi } from "monaco-editor";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ChangeEvent,
} from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  Play,
  Code,
  ImageIcon,
  Maximize2,
  Minimize2,
  RotateCcw,
  Copy,
  Trash2,
  Check,
  Bug,
  Download,
  Save,
  Camera,
  Loader2,
  Share2,
  ExternalLink,
  Plus,
  Sparkles,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import JSZip from "jszip";
import {
  isSvgMimeType,
  isVisualAsset,
  sanitizeAssetKey,
  type AppAsset,
} from "@/lib/app-assets";
import {
  blobToBase64,
  ensureDraftAppAssets,
  uploadDraftAppAsset,
} from "@/lib/app-asset-drafts";
import { savePreviewToIDB, requestPersistentStorage } from "@/lib/preview-idb";
import { saveApp } from "@/lib/saved-apps-idb";
import {
  buildPreviewAssetUrl,
  cacheGeneratedPreviewIcons,
  createPwaPreviewId,
  persistPwaPreviewAssets,
} from "@/lib/pwa-preview";
import { getPreviewDiffSemanticsText } from "@/lib/preview-edit-response";

interface CodePreviewProps {
  code: string;
  comparisonCode?: string | null;
  language: string;
  title?: string;
  assets?: AppAsset[];
  onCodeKeep?: (nextCode: string) => void;
  onCodeUndo?: (nextCode: string) => void;
  onCodeDiffResolved?: () => void;
  onDebug?: (error: string, code: string, language: string) => void;
  onSnapshot?: (snapshot: {
    url: string;
    mimeType: string;
    data: string;
  }) => void;
  onAssetsChange?: (assets: AppAsset[]) => void;
  editSource?: "apps";
  existingAppId?: string;
  initialAppName?: string;
  initialHasGeneratedIcon?: boolean;
}

const EMPTY_PREVIEW_ASSETS: AppAsset[] = [];
const STUDIO_DRAFT_STORAGE_PREFIX = "studio-draft:";
const ASSET_FILE_ACCEPT = "image/*,.svg";
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((module) => module.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[320px] items-center justify-center bg-[#1e1e1e] text-sm text-zinc-400 sm:min-h-[500px]">
        Loading editor...
      </div>
    ),
  },
);
const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((module) => module.DiffEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[320px] items-center justify-center bg-[#1e1e1e] text-sm text-zinc-400 sm:min-h-[500px]">
        Loading diff editor...
      </div>
    ),
  },
);
const RASTER_OUTPUT_OPTIONS = [
  { mimeType: "image/png", label: "PNG", extension: "png" },
  { mimeType: "image/jpeg", label: "JPEG", extension: "jpg" },
  { mimeType: "image/webp", label: "WebP", extension: "webp" },
] as const;

type RasterOutputMimeType = (typeof RASTER_OUTPUT_OPTIONS)[number]["mimeType"];

function normalizePreviewError(message: string): string {
  const invalidHookPattern =
    /Cannot read properties of null \(reading 'useContext'\)|Invalid hook call/i;
  if (!invalidHookPattern.test(message)) return message;

  return `${message}\n\nHint: This preview failed due to an invalid React hook context. This usually happens when code imports React UI libraries that bundle/use a different React runtime, or when a hook is called outside a React function component/custom hook. Try using plain React + Tailwind in a single file and keep all hooks inside App/custom hooks.`;
}

function getMonacoLanguage(language: string): string {
  if (language === "tsx" || language === "typescript") return "typescript";
  if (language === "jsx" || language === "javascript") return "javascript";
  if (language === "html") return "html";
  return "plaintext";
}

function getMonacoPath(language: string): string {
  if (language === "tsx") return "preview.tsx";
  if (language === "typescript") return "preview.ts";
  if (language === "jsx") return "preview.jsx";
  if (language === "javascript") return "preview.js";
  if (language === "html") return "preview.html";
  return "preview.txt";
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getFileExtensionForMimeType(mimeType: string): string {
  if (mimeType === "image/svg+xml") return "svg";
  const match = RASTER_OUTPUT_OPTIONS.find(
    (option) => option.mimeType === mimeType,
  );
  return match?.extension || "png";
}

function ensureGeneratedAssetDisplayName(
  rawName: string,
  mimeType: string,
): string {
  const trimmed = rawName.trim();
  const extension = getFileExtensionForMimeType(mimeType);
  if (!trimmed) return `app-asset.${extension}`;
  if (/\.(png|jpe?g|webp|svg)$/i.test(trimmed)) {
    return `${trimmed.replace(/\.(png|jpe?g|webp|svg)$/i, "")}.${extension}`;
  }
  if (/\.[a-z0-9]+$/i.test(trimmed)) return trimmed;
  return `${trimmed}.${extension}`;
}

function requestsTransparentBackground(input: string): boolean {
  return /\b(transparent background|transparent png|png with transparency|alpha transparency|alpha channel|no background|remove background|cut out|cutout|isolated sprite|isolated subject)\b/i.test(
    input,
  );
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
  const importFromRegex =
    /(^|\n)\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/g;
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
      lines.push(
        `const ${defaultOnlyImport[1]} = ${modVar}.default ?? ${modVar};`,
      );
    }
  }

  while ((match = sideEffectRegex.exec(sourceCode)) !== null) {
    const specifier = match[2]?.trim() || "";
    if (!specifier || !shouldResolveDynamically(specifier)) continue;
    lines.push(`await __importFrom("${specifier}");`);
  }

  return lines.join("\n");
}

function getAssetDisplayName(asset: AppAsset, index: number): string {
  return asset.displayName || asset.assetKey || `asset_${index + 1}`;
}

function getAssetBadgeLabel(asset: AppAsset): string {
  if (isSvgMimeType(asset.mimeType)) return "SVG";
  const mimeSubtype = (asset.mimeType || "").split("/")[1];
  return mimeSubtype ? mimeSubtype.toUpperCase() : "IMAGE";
}

function dataUrlToBase64(dataUrl: string): string {
  const [, base64 = ""] = dataUrl.split(",", 2);
  return base64;
}

export default function CodePreview({
  code,
  comparisonCode = null,
  language,
  title = "Preview",
  assets = EMPTY_PREVIEW_ASSETS,
  onCodeKeep,
  onCodeUndo,
  onCodeDiffResolved,
  onAssetsChange,
  editSource,
  existingAppId,
  initialAppName,
  initialHasGeneratedIcon,
  onDebug,
  onSnapshot,
}: CodePreviewProps) {
  const pathname = usePathname();
  const isStudioPage = pathname === "/studio";
  const [activeTab, setActiveTab] = useState<"preview" | "code" | "assets">(
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
  const [generatedIconBase64, setGeneratedIconBase64] = useState<string | null>(
    null,
  );
  const [, setGeneratedIcon512Base64] = useState<string | null>(null);
  const [generatedIconPreviewUrl, setGeneratedIconPreviewUrl] = useState<
    string | null
  >(null);
  const [isCapturingSnapshot, setIsCapturingSnapshot] = useState(false);
  const [assetUrlMap, setAssetUrlMap] = useState<Record<string, string>>({});
  const [isPublishingShare, setIsPublishingShare] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showAddAssetModal, setShowAddAssetModal] = useState(false);
  const [addAssetMode, setAddAssetMode] = useState<"upload" | "raster" | "svg">(
    "upload",
  );
  const [addAssetOutputMimeType, setAddAssetOutputMimeType] =
    useState<RasterOutputMimeType>("image/png");
  const [addAssetName, setAddAssetName] = useState("");
  const [addAssetRolePrompt, setAddAssetRolePrompt] = useState("");
  const [addAssetPrompt, setAddAssetPrompt] = useState("");
  const [addAssetStatus, setAddAssetStatus] = useState<string | null>(null);
  const [pendingUploadAsset, setPendingUploadAsset] = useState<AppAsset | null>(
    null,
  );
  const [isCreatingAsset, setIsCreatingAsset] = useState(false);
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | null>(null);
  const [showCloneAssetModal, setShowCloneAssetModal] = useState(false);
  const [cloneSourceAssetKey, setCloneSourceAssetKey] = useState<string | null>(
    null,
  );
  const [cloneAssetName, setCloneAssetName] = useState("");
  const [cloneAssetStatus, setCloneAssetStatus] = useState<string | null>(null);
  const [isCloningAsset, setIsCloningAsset] = useState(false);
  const [showDeleteAssetModal, setShowDeleteAssetModal] = useState(false);
  const [deleteTargetAssetKey, setDeleteTargetAssetKey] = useState<
    string | null
  >(null);
  const [deleteAssetStatus, setDeleteAssetStatus] = useState<string | null>(
    null,
  );
  const [isDeletingAsset, setIsDeletingAsset] = useState(false);
  const [assetEditPrompt, setAssetEditPrompt] = useState("");
  const [assetEditTransparentBackground, setAssetEditTransparentBackground] =
    useState(false);
  const [assetEditStatus, setAssetEditStatus] = useState<string | null>(null);
  const [assetCandidate, setAssetCandidate] = useState<AppAsset | null>(null);
  const [isGeneratingAssetCandidate, setIsGeneratingAssetCandidate] =
    useState(false);
  const [draftCode, setDraftCode] = useState(code);
  const [codeDraftStatus, setCodeDraftStatus] = useState<string | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<"split" | "combined">(
    "combined",
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const addAssetInputRef = useRef<HTMLInputElement>(null);
  const latestAssetsRef = useRef(assets);
  const codeEditorSubscriptionRef = useRef<IDisposable | null>(null);
  const isCodeEditable = isStudioPage && typeof onCodeKeep === "function";
  const isCodeDirty = isCodeEditable && draftCode !== code;
  const hasComparisonDiff =
    isCodeEditable &&
    typeof comparisonCode === "string" &&
    comparisonCode !== code;
  const hasManualPendingChanges = isCodeDirty && !hasComparisonDiff;
  const isShowingCodeDiff = hasComparisonDiff;
  const diffOriginalCode = comparisonCode ?? code;
  const diffModifiedCode = isCodeDirty ? draftCode : code;
  const monacoLanguage = getMonacoLanguage(language);
  const monacoPath = getMonacoPath(language);
  const diffSemanticsText = getPreviewDiffSemanticsText();
  const shareInstallsEnabled =
    process.env.NEXT_PUBLIC_ENABLE_SHAREABLE_INSTALLS === "1" ||
    process.env.NEXT_PUBLIC_ENABLE_SHAREABLE_INSTALLS === "true";
  const assetSignature = useMemo(
    () =>
      assets
        .map(
          (asset, index) =>
            `${asset.assetKey || `asset_${index + 1}`}|${asset.mimeType}|${asset.data?.length || 0}|${asset.url}|${asset.storagePath || ""}|${asset.displayName || ""}|${asset.rolePrompt || ""}|${asset.svgText?.length || 0}`,
        )
        .join("||"),
    [assets],
  );

  useEffect(() => {
    latestAssetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    return () => {
      codeEditorSubscriptionRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    setDraftCode(code);
    setCodeDraftStatus(null);
  }, [code]);

  useEffect(() => {
    if (!isStudioPage && activeTab === "assets") {
      setActiveTab(
        language === "html" || language === "jsx" || language === "tsx"
          ? "preview"
          : "code",
      );
    }
  }, [activeTab, isStudioPage, language]);

  const buildUniqueAssetKey = useCallback((rawName: string) => {
    const fallback = `asset_${latestAssetsRef.current.length + 1}`;
    const baseKey = sanitizeAssetKey(rawName, fallback);
    const usedKeys = new Set(
      latestAssetsRef.current.map(
        (asset, index) => asset.assetKey || `asset_${index + 1}`,
      ),
    );
    let nextKey = baseKey;
    let suffix = 2;
    while (usedKeys.has(nextKey)) {
      nextKey = `${baseKey}_${suffix}`;
      suffix += 1;
    }
    return nextKey;
  }, []);

  const ensureDraftId = useCallback(() => {
    if (editSource === "apps" && existingAppId) return existingAppId;
    if (savePreviewId) return savePreviewId;
    const nextId = createPwaPreviewId();
    setSavePreviewId(nextId);
    return nextId;
  }, [editSource, existingAppId, savePreviewId]);

  const ensureAssetsOnDraft = useCallback(
    async (targetId: string, opts?: { persist?: boolean }) => {
      const nextAssets = await ensureDraftAppAssets(
        targetId,
        latestAssetsRef.current || [],
      );
      if (opts?.persist !== false) {
        latestAssetsRef.current = nextAssets;
        if (onAssetsChange) {
          onAssetsChange(nextAssets);
        }
      }
      return nextAssets;
    },
    [onAssetsChange],
  );

  const resolveAssetPreviewUrl = useCallback(
    (asset: AppAsset, index: number) => {
      const key = asset.assetKey || `asset_${index + 1}`;
      const placeholder = `__ASSET_${key}__`;
      if (assetUrlMap[placeholder]) return assetUrlMap[placeholder];
      if (asset.data) return `data:${asset.mimeType};base64,${asset.data}`;
      return asset.url;
    },
    [assetUrlMap],
  );

  const visualAssets = useMemo(
    () =>
      assets
        .map((asset, index) => ({ asset, index }))
        .filter(({ asset }) => isVisualAsset(asset.mimeType)),
    [assets],
  );

  const selectedAssetEntry = useMemo(
    () =>
      visualAssets.find(
        ({ asset, index }) =>
          (asset.assetKey || `asset_${index + 1}`) === selectedAssetKey,
      ) || null,
    [selectedAssetKey, visualAssets],
  );

  const selectedAsset = selectedAssetEntry?.asset || null;
  const selectedAssetIndex = selectedAssetEntry?.index ?? -1;
  const selectedAssetPreviewUrl =
    selectedAsset && selectedAssetIndex >= 0
      ? resolveAssetPreviewUrl(selectedAsset, selectedAssetIndex)
      : "";
  const cloneSourceEntry = useMemo(
    () =>
      visualAssets.find(
        ({ asset, index }) =>
          (asset.assetKey || `asset_${index + 1}`) === cloneSourceAssetKey,
      ) || null,
    [cloneSourceAssetKey, visualAssets],
  );
  const cloneSourceAsset = cloneSourceEntry?.asset || null;
  const cloneSourceAssetIndex = cloneSourceEntry?.index ?? -1;
  const deleteTargetEntry = useMemo(
    () =>
      visualAssets.find(
        ({ asset, index }) =>
          (asset.assetKey || `asset_${index + 1}`) === deleteTargetAssetKey,
      ) || null,
    [deleteTargetAssetKey, visualAssets],
  );
  const deleteTargetAsset = deleteTargetEntry?.asset || null;
  const deleteTargetAssetIndex = deleteTargetEntry?.index ?? -1;

  useEffect(() => {
    const stableAssets = latestAssetsRef.current;
    if (!stableAssets.length) {
      setAssetUrlMap((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }

    let cancelled = false;
    const createdObjectUrls: string[] = [];
    const previewAssetId = existingAppId || savePreviewId;

    void (async () => {
      const nextMap: Record<string, string> = {};

      for (const [index, asset] of stableAssets.entries()) {
        const key = asset.assetKey || `asset_${index + 1}`;
        const placeholder = `__ASSET_${key}__`;
        const fallbackUrl =
          asset.url ||
          (previewAssetId ? buildPreviewAssetUrl(previewAssetId, key) : "");
        let resolvedUrl = fallbackUrl;

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
            resolvedUrl = fallbackUrl;
          }
        } else if (fallbackUrl && previewAssetId) {
          try {
            const cacheNames = ["preview-pwa-v5", "preview-pwa-v6"];
            let cachedResponse: Response | undefined;
            for (const cacheName of cacheNames) {
              const cache = await caches.open(cacheName);
              const match = await cache.match(new Request(fallbackUrl));
              if (match) {
                cachedResponse = match;
                break;
              }
            }

            if (cachedResponse) {
              const blob = await cachedResponse.blob();
              resolvedUrl = URL.createObjectURL(blob);
              createdObjectUrls.push(resolvedUrl);
            }
          } catch {
            resolvedUrl = fallbackUrl;
          }
        }

        nextMap[placeholder] = resolvedUrl;
      }

      if (cancelled) return;

      setAssetUrlMap((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(nextMap);
        if (prevKeys.length === nextKeys.length) {
          const unchanged = nextKeys.every(
            (mapKey) => prev[mapKey] === nextMap[mapKey],
          );
          if (unchanged) {
            return prev;
          }
        }
        return nextMap;
      });
    })();

    return () => {
      cancelled = true;
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

  const readFileAsDataUrl = useCallback((file: File) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Unable to read file."));
      };
      reader.onerror = () =>
        reject(reader.error || new Error("Unable to read file."));
      reader.readAsDataURL(file);
    });
  }, []);

  const updateAssets = useCallback(
    (updater: (current: AppAsset[]) => AppAsset[]) => {
      if (!onAssetsChange) return;
      onAssetsChange(updater(latestAssetsRef.current));
    },
    [onAssetsChange],
  );

  const syncAssetToDraft = useCallback(
    async (asset: AppAsset) => {
      try {
        const uploadedAsset = await uploadDraftAppAsset(ensureDraftId(), asset);
        updateAssets((current) =>
          current.map((currentAsset, index) =>
            (currentAsset.assetKey || `asset_${index + 1}`) === asset.assetKey
              ? {
                  ...currentAsset,
                  ...uploadedAsset,
                  assetKey: asset.assetKey,
                }
              : currentAsset,
          ),
        );
        return uploadedAsset;
      } catch {
        return null;
      }
    },
    [ensureDraftId, updateAssets],
  );

  const ensureInlineAsset = useCallback(
    async (asset: AppAsset, index: number): Promise<AppAsset> => {
      if (asset.data && (!isSvgMimeType(asset.mimeType) || asset.svgText)) {
        return asset;
      }

      const resolvedUrl = resolveAssetPreviewUrl(asset, index);
      if (!resolvedUrl) {
        throw new Error("This asset is missing file data.");
      }

      const response = await fetch(resolvedUrl);
      if (!response.ok) {
        throw new Error("Unable to load asset bytes.");
      }

      const blob = await response.blob();
      const data = await blobToBase64(blob);
      const svgText = isSvgMimeType(asset.mimeType)
        ? await blob.text()
        : asset.svgText;

      return {
        ...asset,
        mimeType: blob.type || asset.mimeType,
        url: resolvedUrl,
        data,
        svgText,
      };
    },
    [resolveAssetPreviewUrl],
  );

  const resetAddAssetModal = useCallback(() => {
    setShowAddAssetModal(false);
    setAddAssetMode("upload");
    setAddAssetOutputMimeType("image/png");
    setAddAssetName("");
    setAddAssetRolePrompt("");
    setAddAssetPrompt("");
    setAddAssetStatus(null);
    setPendingUploadAsset(null);
    if (addAssetInputRef.current) {
      addAssetInputRef.current.value = "";
    }
  }, []);

  const resetCloneAssetModal = useCallback(() => {
    if (isCloningAsset) return;
    setShowCloneAssetModal(false);
    setCloneSourceAssetKey(null);
    setCloneAssetName("");
    setCloneAssetStatus(null);
  }, [isCloningAsset]);

  const resetDeleteAssetModal = useCallback(() => {
    if (isDeletingAsset) return;
    setShowDeleteAssetModal(false);
    setDeleteTargetAssetKey(null);
    setDeleteAssetStatus(null);
  }, [isDeletingAsset]);

  const closeAssetModal = useCallback(() => {
    setSelectedAssetKey(null);
    setAssetEditPrompt("");
    setAssetEditTransparentBackground(false);
    setAssetEditStatus(null);
    setAssetCandidate(null);
  }, []);

  const openAssetModal = useCallback((assetKey: string) => {
    setSelectedAssetKey(assetKey);
    setAssetEditPrompt("");
    setAssetEditTransparentBackground(false);
    setAssetEditStatus(null);
    setAssetCandidate(null);
  }, []);

  const openCloneAssetModal = useCallback(
    (assetKey: string) => {
      const sourceEntry =
        visualAssets.find(
          ({ asset, index }) =>
            (asset.assetKey || `asset_${index + 1}`) === assetKey,
        ) || null;
      const defaultName = sourceEntry
        ? `${getAssetDisplayName(sourceEntry.asset, sourceEntry.index)} copy`
        : "Asset copy";
      setCloneSourceAssetKey(assetKey);
      setCloneAssetName(defaultName);
      setCloneAssetStatus(null);
      setShowCloneAssetModal(true);
    },
    [visualAssets],
  );

  const openDeleteAssetModal = useCallback((assetKey: string) => {
    setDeleteTargetAssetKey(assetKey);
    setDeleteAssetStatus(null);
    setShowDeleteAssetModal(true);
  }, []);

  const handleAddAssetFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (
        !file.type.startsWith("image/") &&
        !file.name.toLowerCase().endsWith(".svg")
      ) {
        setAddAssetStatus("Please choose an image or SVG file.");
        return;
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const svgText =
          file.type.includes("svg") || file.name.toLowerCase().endsWith(".svg")
            ? await file.text()
            : undefined;
        const displayName = file.name;
        const assetKey = buildUniqueAssetKey(displayName);
        setPendingUploadAsset({
          assetKey,
          displayName,
          mimeType: file.type || (svgText ? "image/svg+xml" : "image/png"),
          url: dataUrl,
          data: dataUrlToBase64(dataUrl),
          rolePrompt: addAssetRolePrompt.trim() || undefined,
          sourceType: "upload",
          svgText,
        });
        if (!addAssetName.trim()) {
          setAddAssetName(displayName);
        }
        setAddAssetStatus("Asset ready to add.");
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unable to read asset.";
        setAddAssetStatus(message);
      }
    },
    [addAssetName, addAssetRolePrompt, buildUniqueAssetKey, readFileAsDataUrl],
  );

  const handleCreateAsset = useCallback(async () => {
    if (!onAssetsChange || isCreatingAsset) return;

    const displayName =
      addAssetMode === "upload"
        ? addAssetName.trim() || pendingUploadAsset?.displayName || "app-asset"
        : ensureGeneratedAssetDisplayName(
            addAssetName,
            addAssetMode === "svg" ? "image/svg+xml" : addAssetOutputMimeType,
          );
    const rolePrompt = addAssetRolePrompt.trim() || undefined;
    const assetKey = buildUniqueAssetKey(displayName);

    if (addAssetMode === "upload") {
      if (!pendingUploadAsset) {
        setAddAssetStatus("Choose a file first.");
        return;
      }

      const nextAsset: AppAsset = {
        ...pendingUploadAsset,
        assetKey,
        displayName,
        rolePrompt,
        sourceType: "upload",
      };
      updateAssets((current) => [...current, nextAsset]);
      resetAddAssetModal();
      void syncAssetToDraft(nextAsset);
      return;
    }

    if (!addAssetPrompt.trim()) {
      setAddAssetStatus("Describe the asset you want to generate.");
      return;
    }

    setIsCreatingAsset(true);
    setAddAssetStatus("Generating asset...");
    try {
      const response = await fetch("/api/assets/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: addAssetPrompt.trim(),
          rolePrompt,
          outputType: addAssetMode === "svg" ? "svg" : "raster",
          outputMimeType:
            addAssetMode === "raster" ? addAssetOutputMimeType : undefined,
          pro: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.asset) {
        throw new Error(
          payload?.details || payload?.error || "Unable to generate asset.",
        );
      }

      const nextAsset: AppAsset = {
        assetKey,
        displayName,
        rolePrompt,
        sourceType: "generated",
        mimeType: payload.asset.mimeType || "image/png",
        data: payload.asset.data,
        url: payload.asset.url || "",
        svgText: payload.asset.svgText,
      };
      updateAssets((current) => [...current, nextAsset]);
      resetAddAssetModal();
      void syncAssetToDraft(nextAsset);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unable to generate asset.";
      setAddAssetStatus(message);
    } finally {
      setIsCreatingAsset(false);
    }
  }, [
    addAssetMode,
    addAssetOutputMimeType,
    addAssetName,
    addAssetPrompt,
    addAssetRolePrompt,
    buildUniqueAssetKey,
    isCreatingAsset,
    onAssetsChange,
    pendingUploadAsset,
    resetAddAssetModal,
    syncAssetToDraft,
    updateAssets,
  ]);

  const handleCloneAsset = useCallback(async () => {
    if (
      !onAssetsChange ||
      isCloningAsset ||
      !cloneSourceAsset ||
      cloneSourceAssetIndex < 0
    )
      return;

    const displayName = cloneAssetName.trim();
    if (!displayName) {
      setCloneAssetStatus("Enter a name for the cloned asset.");
      return;
    }

    setIsCloningAsset(true);
    setCloneAssetStatus("Cloning asset...");
    try {
      const preparedAsset = await ensureInlineAsset(
        cloneSourceAsset,
        cloneSourceAssetIndex,
      );
      const assetKey = buildUniqueAssetKey(displayName);
      const clonedAsset: AppAsset = {
        ...preparedAsset,
        assetKey,
        displayName,
        storagePath: undefined,
      };

      updateAssets((current) => [...current, clonedAsset]);
      const uploadedAsset = await syncAssetToDraft(clonedAsset);
      if (!uploadedAsset) {
        updateAssets((current) =>
          current.filter(
            (asset, index) =>
              (asset.assetKey || `asset_${index + 1}`) !== assetKey,
          ),
        );
        throw new Error("Unable to save cloned asset.");
      }

      setShowCloneAssetModal(false);
      setCloneSourceAssetKey(null);
      setCloneAssetName("");
      setCloneAssetStatus(null);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unable to clone asset.";
      setCloneAssetStatus(message);
    } finally {
      setIsCloningAsset(false);
    }
  }, [
    buildUniqueAssetKey,
    cloneAssetName,
    cloneSourceAsset,
    cloneSourceAssetIndex,
    ensureInlineAsset,
    isCloningAsset,
    onAssetsChange,
    syncAssetToDraft,
    updateAssets,
  ]);

  const handleDeleteAsset = useCallback(async () => {
    if (!deleteTargetAsset || deleteTargetAssetIndex < 0 || isDeletingAsset)
      return;

    const assetKey =
      deleteTargetAsset.assetKey || `asset_${deleteTargetAssetIndex + 1}`;
    const preferredDraftId =
      (editSource === "apps" && existingAppId
        ? existingAppId
        : savePreviewId) ||
      (deleteTargetAsset.storagePath?.startsWith("draft-apps/")
        ? deleteTargetAsset.storagePath.split("/")[1] || null
        : null);

    setIsDeletingAsset(true);
    setDeleteAssetStatus("Deleting asset...");
    updateAssets((current) =>
      current.filter(
        (asset, index) => (asset.assetKey || `asset_${index + 1}`) !== assetKey,
      ),
    );

    if (selectedAssetKey === assetKey) {
      closeAssetModal();
    }
    if (cloneSourceAssetKey === assetKey) {
      setShowCloneAssetModal(false);
      setCloneSourceAssetKey(null);
      setCloneAssetName("");
      setCloneAssetStatus(null);
    }

    try {
      if (preferredDraftId) {
        const response = await fetch(
          `/api/apps/${encodeURIComponent(preferredDraftId)}/assets/${encodeURIComponent(assetKey)}`,
          { method: "DELETE" },
        );
        const payload = (await response.json().catch(() => null)) as {
          details?: string;
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(
            payload?.details || payload?.error || "Unable to delete asset.",
          );
        }
      }

      setShowDeleteAssetModal(false);
      setDeleteTargetAssetKey(null);
      setDeleteAssetStatus(null);
    } catch (error: unknown) {
      updateAssets((current) => {
        const exists = current.some(
          (asset, index) =>
            (asset.assetKey || `asset_${index + 1}`) === assetKey,
        );
        if (exists) return current;
        const nextAssets = [...current];
        nextAssets.splice(deleteTargetAssetIndex, 0, deleteTargetAsset);
        return nextAssets;
      });
      const message =
        error instanceof Error ? error.message : "Unable to delete asset.";
      setDeleteAssetStatus(message);
    } finally {
      setIsDeletingAsset(false);
    }
  }, [
    cloneSourceAssetKey,
    closeAssetModal,
    deleteTargetAsset,
    deleteTargetAssetIndex,
    editSource,
    existingAppId,
    isDeletingAsset,
    savePreviewId,
    selectedAssetKey,
    updateAssets,
  ]);

  const handleGenerateAssetCandidate = useCallback(async () => {
    if (!selectedAsset || selectedAssetIndex < 0 || isGeneratingAssetCandidate)
      return;
    if (!assetEditPrompt.trim()) {
      setAssetEditStatus("Describe the changes you want to make first.");
      return;
    }

    setIsGeneratingAssetCandidate(true);
    setAssetEditStatus("Generating candidate...");
    try {
      const preparedAsset = await ensureInlineAsset(
        selectedAsset,
        selectedAssetIndex,
      );
      const wantsTransparentBackground =
        assetEditTransparentBackground ||
        requestsTransparentBackground(assetEditPrompt);
      const endpoint = isSvgMimeType(preparedAsset.mimeType)
        ? "/api/assets/edit-svg"
        : "/api/assets/edit-image";
      const body = isSvgMimeType(preparedAsset.mimeType)
        ? {
            prompt: assetEditPrompt.trim(),
            rolePrompt: preparedAsset.rolePrompt,
            displayName: preparedAsset.displayName,
            svgText: preparedAsset.svgText,
          }
        : {
            prompt: assetEditPrompt.trim(),
            rolePrompt: preparedAsset.rolePrompt,
            displayName: preparedAsset.displayName,
            mimeType: preparedAsset.mimeType,
            outputMimeType: wantsTransparentBackground
              ? "image/png"
              : preparedAsset.mimeType,
            backgroundMode: wantsTransparentBackground
              ? "transparent"
              : undefined,
            data: preparedAsset.data,
            pro: true,
          };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.asset) {
        throw new Error(
          payload?.details || payload?.error || "Unable to generate candidate.",
        );
      }

      setAssetCandidate({
        ...preparedAsset,
        mimeType: payload.asset.mimeType || preparedAsset.mimeType,
        data: payload.asset.data,
        url: payload.asset.url || preparedAsset.url,
        svgText: payload.asset.svgText ?? preparedAsset.svgText,
        sourceType: "edited",
      });
      setAssetEditStatus("Candidate ready. Review it, then click Keep.");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unable to edit asset.";
      setAssetEditStatus(message);
    } finally {
      setIsGeneratingAssetCandidate(false);
    }
  }, [
    assetEditPrompt,
    assetEditTransparentBackground,
    ensureInlineAsset,
    isGeneratingAssetCandidate,
    selectedAsset,
    selectedAssetIndex,
  ]);

  const handleKeepAssetCandidate = useCallback(async () => {
    if (!assetCandidate || !selectedAssetKey) return;
    const nextAsset: AppAsset = {
      ...assetCandidate,
      assetKey: selectedAssetKey,
    };
    updateAssets((current) =>
      current.map((asset, index) =>
        (asset.assetKey || `asset_${index + 1}`) === selectedAssetKey
          ? {
              ...asset,
              ...nextAsset,
              assetKey: selectedAssetKey,
              displayName: nextAsset.displayName || asset.displayName,
              rolePrompt: nextAsset.rolePrompt || asset.rolePrompt,
            }
          : asset,
      ),
    );
    closeAssetModal();
    void syncAssetToDraft(nextAsset);
  }, [
    assetCandidate,
    closeAssetModal,
    selectedAssetKey,
    syncAssetToDraft,
    updateAssets,
  ]);

  const copyToClipboard = () => {
    const clipboardCode =
      isCodeEditable && activeTab === "code" ? draftCode : code;
    navigator.clipboard.writeText(clipboardCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const bindEditorModel = useCallback(
    (getModel: () => MonacoEditorApi.ITextModel | null) => {
      codeEditorSubscriptionRef.current?.dispose();
      const model = getModel();
      if (!model) return;
      codeEditorSubscriptionRef.current = model.onDidChangeContent(() => {
        const nextValue = model.getValue();
        setDraftCode((current) =>
          current === nextValue ? current : nextValue,
        );
        setCodeDraftStatus(null);
      });
    },
    [],
  );

  const handleCodeDraftChange = useCallback((value: string | undefined) => {
    setDraftCode(value ?? "");
    setCodeDraftStatus(null);
  }, []);

  const handleEditorMount = useCallback(
    (editor: MonacoEditorApi.IStandaloneCodeEditor) => {
      bindEditorModel(() => editor.getModel());
      editor.focus();
    },
    [bindEditorModel],
  );

  const handleDiffEditorMount = useCallback(
    (editor: MonacoEditorApi.IStandaloneDiffEditor) => {
      bindEditorModel(() => editor.getModifiedEditor().getModel());
      editor.getModifiedEditor().focus();
    },
    [bindEditorModel],
  );

  const handleKeepCodeDraft = useCallback(() => {
    if (!isCodeEditable) return;
    if (hasManualPendingChanges) {
      onCodeKeep?.(draftCode);
      setCodeDraftStatus("Applied your manual code changes to the preview.");
      return;
    }
    if (hasComparisonDiff && isCodeDirty) {
      onCodeKeep?.(draftCode);
      return;
    }
    if (hasComparisonDiff) {
      onCodeDiffResolved?.();
      setCodeDraftStatus("Showing the current preview code.");
    }
  }, [
    draftCode,
    hasComparisonDiff,
    hasManualPendingChanges,
    isCodeDirty,
    isCodeEditable,
    onCodeDiffResolved,
    onCodeKeep,
  ]);

  const handleResetCodeDraft = useCallback(() => {
    if (hasComparisonDiff && comparisonCode) {
      setDraftCode(comparisonCode);
      onCodeUndo?.(comparisonCode);
      return;
    }
    setDraftCode(code);
    setCodeDraftStatus("Showing the current preview code.");
  }, [code, comparisonCode, hasComparisonDiff, onCodeUndo]);

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
      ? localStorage.getItem(`pwa-preview-${targetId}-has-generated-icon`) ===
        "1"
      : false;
    const existingIcon192 = targetId
      ? localStorage.getItem(`pwa-preview-${targetId}-icon192-b64`)
      : null;
    const existingIcon512 = targetId
      ? localStorage.getItem(`pwa-preview-${targetId}-icon512-b64`)
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
    setGeneratedIcon512Base64(existingIcon512 || null);
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
  }, [
    editSource,
    existingAppId,
    initialAppName,
    initialHasGeneratedIcon,
    title,
  ]);

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
            `Model is busy, retrying icon generation (${retryNumber}/${retryTotal})...`,
          );
          await sleep(retryDelaysMs[attempt] ?? 0);
          continue;
        }

        throw new Error(
          data?.details || data?.error || "Icon generation failed",
        );
      }
      if (!success) throw new Error("Icon generation failed");

      const icon192b64 =
        data?.iconDataUrls?.icon192?.replace(/^data:[^,]+,/, "") || null;
      const icon512b64 =
        data?.iconDataUrls?.icon512?.replace(/^data:[^,]+,/, "") || null;
      const iconVersion = Date.now();
      if (icon192b64) {
        localStorage.setItem(`pwa-preview-${id}-icon192-b64`, icon192b64);
        setGeneratedIconBase64(icon192b64);
      }
      setGeneratedIcon512Base64(icon512b64);
      localStorage.removeItem(`pwa-preview-${id}-icon512-b64`);
      localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
      localStorage.setItem(
        `pwa-preview-${id}-icon-version`,
        String(iconVersion),
      );
      await cacheGeneratedPreviewIcons(id, {
        icon192b64,
        icon512b64,
        version: iconVersion,
      });
      setHasSaveIcon(true);

      const cacheBust = Date.now();
      const baseIconUrl =
        data?.icons?.icon192 || `/api/preview/${id}/generate-icon?size=192`;
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
    const id = ensureDraftId();
    const name = saveName.trim() || "My App";
    const hasGeneratedIcon = hasSaveIcon;
    const effectiveLanguage = resolveEffectiveLanguage();
    const localIconBase64 =
      localStorage.getItem(`pwa-preview-${id}-icon192-b64`) ||
      generatedIconBase64 ||
      undefined;

    setIsSavingApp(true);
    setSaveStatus("Saving...");
    try {
      const preparedAssets = await ensureAssetsOnDraft(id);

      localStorage.setItem(`pwa-preview-${id}-code`, code);
      localStorage.setItem(`pwa-preview-${id}-language`, effectiveLanguage);
      localStorage.setItem(`pwa-preview-${id}-name`, name);
      if (hasGeneratedIcon) {
        localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
        if (!localStorage.getItem(`pwa-preview-${id}-icon-version`)) {
          localStorage.setItem(
            `pwa-preview-${id}-icon-version`,
            String(Date.now()),
          );
        }
      } else {
        localStorage.removeItem(`pwa-preview-${id}-has-generated-icon`);
        localStorage.removeItem(`pwa-preview-${id}-icon-version`);
      }

      await persistPwaPreviewAssets(id, preparedAssets);
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
        iconBase64: localIconBase64,
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
          assets: preparedAssets.map((asset, index) => ({
            assetKey: asset.assetKey || `asset_${index + 1}`,
            mimeType: asset.mimeType || "application/octet-stream",
            url: asset.url,
            storagePath: asset.storagePath,
            displayName: asset.displayName,
            rolePrompt: asset.rolePrompt,
            sourceType: asset.sourceType,
            svgText: asset.svgText,
          })),
        }),
      });
      const publishData = await publishResp.json().catch(() => ({}));
      if (!publishResp.ok || !publishData?.shareUrl) {
        const details =
          publishData?.details || publishData?.error || "Cloud save failed.";
        setSaveStatus(`Saved locally. Firebase sync failed: ${details}`);
      } else {
        if (
          typeof publishData?.updatedAt === "number" &&
          Number.isFinite(publishData.updatedAt) &&
          publishData.updatedAt > 0
        ) {
          localStorage.setItem(
            `pwa-preview-${id}-remote-updated-at`,
            String(publishData.updatedAt),
          );
        }
        const sharedLink = publishData.shareUrl as string;
        setShareUrl(sharedLink);
        setShareStatus("Saved locally and synced to Firebase.");
        setSaveStatus("Saved to My Apps and Firebase.");
        setShowSaveModal(false);
      }
    } catch {
      setSaveStatus("Failed to save. Please try again.");
    } finally {
      setIsSavingApp(false);
    }
  }, [
    code,
    ensureAssetsOnDraft,
    ensureDraftId,
    generatedIconBase64,
    hasSaveIcon,
    isSavingApp,
    resolveEffectiveLanguage,
    saveName,
  ]);

  const handlePublishShare = useCallback(async () => {
    if (isPublishingShare) return;
    setIsPublishingShare(true);
    setShareStatus("Publishing...");
    setShareUrl(null);

    try {
      const name =
        window.prompt("Enter a name for your shared app:", "My App") ||
        "My App";
      const id = createPwaPreviewId();
      const hasGeneratedIcon = false;
      const effectiveLanguage = resolveEffectiveLanguage();
      const preparedAssets = await ensureDraftAppAssets(
        id,
        latestAssetsRef.current || [],
      );

      localStorage.setItem(`pwa-preview-${id}-code`, code);
      localStorage.setItem(`pwa-preview-${id}-language`, effectiveLanguage);
      localStorage.setItem(`pwa-preview-${id}-name`, name);
      if (hasGeneratedIcon) {
        localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
      }

      await persistPwaPreviewAssets(id, preparedAssets);
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
          assets: preparedAssets.map((asset, index) => ({
            assetKey: asset.assetKey || `asset_${index + 1}`,
            mimeType: asset.mimeType || "application/octet-stream",
            url: asset.url,
            storagePath: asset.storagePath,
            displayName: asset.displayName,
            rolePrompt: asset.rolePrompt,
            sourceType: asset.sourceType,
            svgText: asset.svgText,
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
      const message =
        error instanceof Error
          ? error.message
          : "Unable to publish shared app.";
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
    if (typeof iframeWin[dtiKey] !== "object" || iframeWin[dtiKey] === null) {
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
      toPng: (node: Node, options?: Record<string, unknown>) => Promise<string>;
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
      computedBg &&
      computedBg !== "rgba(0, 0, 0, 0)" &&
      computedBg !== "transparent"
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
        err instanceof Error
          ? err.message
          : "Failed to capture preview snapshot.";
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
      if (key.includes("background") || key.includes("scene") || key === "bg") {
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
      <input
        ref={addAssetInputRef}
        type="file"
        accept={ASSET_FILE_ACCEPT}
        className="hidden"
        onChange={handleAddAssetFileChange}
      />
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
              <Play className="w-3 h-3 inline-block mr-1" /> Preview
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
            {isStudioPage ? (
              <button
                onClick={() => setActiveTab("assets")}
                className={`rounded-md px-3 py-1 text-xs transition-all ${
                  activeTab === "assets"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                <ImageIcon className="w-3 h-3 inline-block mr-1" /> Assets
              </button>
            ) : null}
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
            disabled={
              activeTab !== "preview" || !onSnapshot || isCapturingSnapshot
            }
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
        ) : activeTab === "code" || !isStudioPage ? (
          isCodeEditable && activeTab === "code" ? (
            <div className="flex h-full min-h-[320px] flex-col bg-[#1e1e1e] sm:min-h-[500px]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-100">
                    {isShowingCodeDiff
                      ? "Studio code diff"
                      : hasManualPendingChanges
                        ? "Manual Studio edits"
                        : "Studio preview source"}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {isShowingCodeDiff
                      ? `${diffSemanticsText} Use Undo to discard or Keep All to apply the staged changes.`
                      : hasManualPendingChanges
                        ? "Your manual edits are local until you click Keep Changes."
                      : codeDraftStatus ||
                        "Edit the code here, then click Keep Changes to apply your manual updates to the preview."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {isShowingCodeDiff ? (
                    <>
                      <div className="flex items-center rounded-lg border border-zinc-700 p-1">
                        <button
                          type="button"
                          onClick={() => setDiffViewMode("split")}
                          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                            diffViewMode === "split"
                              ? "bg-zinc-100 text-zinc-950"
                              : "text-zinc-300 hover:bg-zinc-800"
                          }`}
                        >
                          Split View
                        </button>
                        <button
                          type="button"
                          onClick={() => setDiffViewMode("combined")}
                          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                            diffViewMode === "combined"
                              ? "bg-zinc-100 text-zinc-950"
                              : "text-zinc-300 hover:bg-zinc-800"
                          }`}
                        >
                          Combined View
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={handleResetCodeDraft}
                        className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
                      >
                        Undo
                      </button>
                      <button
                        type="button"
                        onClick={handleKeepCodeDraft}
                        className="rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-400"
                      >
                        Keep All
                      </button>
                    </>
                  ) : hasManualPendingChanges ? (
                    <button
                      type="button"
                      onClick={handleKeepCodeDraft}
                      className="rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-400"
                    >
                      Keep Changes
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="h-[55vh] min-h-[320px] overflow-hidden sm:h-[600px]">
                {isShowingCodeDiff ? (
                  <MonacoDiffEditor
                    height="100%"
                    language={monacoLanguage}
                    original={diffOriginalCode}
                    modified={diffModifiedCode}
                    originalModelPath={`${monacoPath}.original`}
                    modifiedModelPath={`${monacoPath}.modified`}
                    onMount={handleDiffEditorMount}
                    theme="vs-dark"
                    options={{
                      automaticLayout: true,
                      fontSize: 14,
                      lineNumbersMinChars: 3,
                      minimap: { enabled: false },
                      originalEditable: false,
                      renderMarginRevertIcon: false,
                      renderSideBySide: diffViewMode === "split",
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                    }}
                  />
                ) : (
                  <MonacoEditor
                    height="100%"
                    language={monacoLanguage}
                    path={monacoPath}
                    defaultValue={code}
                    value={draftCode}
                    onMount={handleEditorMount}
                    onChange={handleCodeDraftChange}
                    theme="vs-dark"
                    options={{
                      automaticLayout: true,
                      minimap: { enabled: false },
                      fontSize: 14,
                      lineNumbersMinChars: 3,
                      padding: { top: 16, bottom: 16 },
                      scrollBeyondLastLine: false,
                      tabSize: 2,
                      wordWrap: "on",
                    }}
                  />
                )}
              </div>
            </div>
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
          )
        ) : (
          <div className="flex h-full min-h-[320px] flex-col sm:min-h-[500px]">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Visual Assets
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  View, add, and iterate on the images used by this app.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddAssetModal(true)}
                disabled={!onAssetsChange}
                className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Asset
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {visualAssets.length === 0 ? (
                <div className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-white/70 px-6 text-center dark:border-zinc-700 dark:bg-zinc-950/40">
                  <ImageIcon className="mb-3 h-10 w-10 text-zinc-400" />
                  <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    No visual assets yet
                  </h4>
                  <p className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
                    Add an image or SVG, or generate one from a prompt, and it
                    will show up here.
                  </p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {visualAssets.map(({ asset, index }) => {
                    const assetKey = asset.assetKey || `asset_${index + 1}`;
                    const previewUrl = resolveAssetPreviewUrl(asset, index);
                    return (
                      <div
                        key={assetKey}
                        className="group relative rounded-2xl border border-zinc-200 bg-white p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-600"
                      >
                        <button
                          type="button"
                          onClick={() => openAssetModal(assetKey)}
                          className="block w-full text-left"
                        >
                          <div className="relative mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-900">
                            {previewUrl ? (
                              <Image
                                src={previewUrl}
                                alt={getAssetDisplayName(asset, index)}
                                fill
                                unoptimized
                                className="object-contain"
                              />
                            ) : (
                              <ImageIcon className="h-10 w-10 text-zinc-400" />
                            )}
                          </div>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                {getAssetDisplayName(asset, index)}
                              </p>
                              <p className="mt-1 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                                {asset.rolePrompt || "No role prompt yet."}
                              </p>
                            </div>
                            <span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                              {getAssetBadgeLabel(asset)}
                            </span>
                          </div>
                        </button>
                        <div className="absolute right-5 top-5 z-10 flex gap-2">
                          <button
                            type="button"
                            onClick={() => openCloneAssetModal(assetKey)}
                            disabled={!onAssetsChange}
                            aria-label={`Clone ${getAssetDisplayName(asset, index)}`}
                            className="inline-flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-[11px] font-medium text-zinc-700 shadow-sm transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-950/90 dark:text-zinc-200 dark:hover:bg-zinc-900"
                          >
                            <Copy className="h-3 w-3" />
                            Clone
                          </button>
                          <button
                            type="button"
                            onClick={() => openDeleteAssetModal(assetKey)}
                            disabled={!onAssetsChange}
                            aria-label={`Delete ${getAssetDisplayName(asset, index)}`}
                            className="inline-flex items-center gap-1 rounded-md bg-red-50/95 px-2 py-1 text-[11px] font-medium text-red-700 shadow-sm transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-950/80 dark:text-red-200 dark:hover:bg-red-950"
                          >
                            <Trash2 className="h-3 w-3" />
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {showAddAssetModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Add Asset
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Upload a visual asset or generate one from a prompt.
                </p>
              </div>
              <button
                type="button"
                onClick={resetAddAssetModal}
                className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              {[
                { id: "upload", label: "Upload" },
                { id: "raster", label: "Generate Image" },
                { id: "svg", label: "Generate SVG" },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setAddAssetMode(option.id as "upload" | "raster" | "svg");
                    setAddAssetStatus(null);
                  }}
                  className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                    addAssetMode === option.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    File Name
                  </label>
                  <input
                    value={addAssetName}
                    onChange={(e) => setAddAssetName(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    placeholder={
                      addAssetMode === "svg"
                        ? "hero-image.svg"
                        : `hero-image.${getFileExtensionForMimeType(addAssetOutputMimeType)}`
                    }
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    Role Prompt
                  </label>
                  <textarea
                    value={addAssetRolePrompt}
                    onChange={(e) => setAddAssetRolePrompt(e.target.value)}
                    className="min-h-[100px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    placeholder="Describe how this asset should be used in the app."
                  />
                </div>

                {addAssetMode === "upload" ? (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Asset File
                    </label>
                    <button
                      type="button"
                      onClick={() => addAssetInputRef.current?.click()}
                      className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      <Plus className="h-4 w-4" />
                      Choose File
                    </button>
                  </div>
                ) : (
                  <div>
                    {addAssetMode === "raster" ? (
                      <div className="mb-4">
                        <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          Image File Type
                        </label>
                        <select
                          value={addAssetOutputMimeType}
                          onChange={(e) =>
                            setAddAssetOutputMimeType(
                              e.target.value as RasterOutputMimeType,
                            )
                          }
                          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                        >
                          {RASTER_OUTPUT_OPTIONS.map((option) => (
                            <option
                              key={option.mimeType}
                              value={option.mimeType}
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      Generation Prompt
                    </label>
                    <textarea
                      value={addAssetPrompt}
                      onChange={(e) => setAddAssetPrompt(e.target.value)}
                      className="min-h-[120px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      placeholder={
                        addAssetMode === "svg"
                          ? "Describe the SVG you want to generate."
                          : "Describe the image you want to generate."
                      }
                    />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Preview
                </p>
                {pendingUploadAsset && addAssetMode === "upload" ? (
                  <div className="space-y-3">
                    <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-white dark:bg-zinc-900">
                      <Image
                        src={pendingUploadAsset.url}
                        alt={pendingUploadAsset.displayName || "Pending asset"}
                        fill
                        unoptimized
                        className="object-contain"
                      />
                    </div>
                    <p className="text-sm text-zinc-600 dark:text-zinc-300">
                      {pendingUploadAsset.displayName}
                    </p>
                  </div>
                ) : (
                  <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                    <Sparkles className="mb-3 h-8 w-8 text-zinc-400" />
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {addAssetMode === "upload"
                        ? "Pick a file to preview it here before adding it."
                        : "The generated asset will be added to the gallery when it is ready."}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {addAssetStatus ? (
              <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-300">
                {addAssetStatus}
              </p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetAddAssetModal}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateAsset}
                disabled={isCreatingAsset || !onAssetsChange}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                {isCreatingAsset
                  ? "Generating..."
                  : addAssetMode === "upload"
                    ? "Add Asset"
                    : "Generate Asset"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCloneAssetModal && cloneSourceAsset && cloneSourceAssetIndex >= 0 ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Clone Asset
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Choose a name for the cloned version of{" "}
                  {getAssetDisplayName(cloneSourceAsset, cloneSourceAssetIndex)}
                  .
                </p>
              </div>
              <button
                type="button"
                onClick={resetCloneAssetModal}
                className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              New Asset Name
            </label>
            <input
              value={cloneAssetName}
              onChange={(e) => setCloneAssetName(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              placeholder="Asset copy"
              autoFocus
            />

            {cloneAssetStatus ? (
              <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-300">
                {cloneAssetStatus}
              </p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetCloneAssetModal}
                disabled={isCloningAsset}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCloneAsset}
                disabled={isCloningAsset || !onAssetsChange}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                {isCloningAsset ? "Cloning..." : "Clone Asset"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDeleteAssetModal &&
      deleteTargetAsset &&
      deleteTargetAssetIndex >= 0 ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Delete Asset?
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  This will remove{" "}
                  {getAssetDisplayName(
                    deleteTargetAsset,
                    deleteTargetAssetIndex,
                  )}{" "}
                  from the Studio asset library.
                </p>
              </div>
              <button
                type="button"
                onClick={resetDeleteAssetModal}
                disabled={isDeletingAsset}
                className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/40">
              <p className="text-xs text-red-700 dark:text-red-200">
                This action cannot be undone.
              </p>
            </div>

            {deleteAssetStatus ? (
              <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-300">
                {deleteAssetStatus}
              </p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetDeleteAssetModal}
                disabled={isDeletingAsset}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteAsset}
                disabled={isDeletingAsset || !onAssetsChange}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                {isDeletingAsset ? "Deleting..." : "Delete Asset"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedAsset ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-5xl rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {selectedAsset.displayName ||
                    selectedAsset.assetKey ||
                    "Asset"}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {selectedAsset.rolePrompt || "No role prompt saved yet."}
                </p>
              </div>
              <button
                type="button"
                onClick={closeAssetModal}
                className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Current
                  </p>
                  <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-white dark:bg-zinc-900">
                    {selectedAssetPreviewUrl ? (
                      <Image
                        src={selectedAssetPreviewUrl}
                        alt={selectedAsset.displayName || "Current asset"}
                        fill
                        unoptimized
                        className="object-contain"
                      />
                    ) : (
                      <ImageIcon className="h-10 w-10 text-zinc-400" />
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Candidate
                  </p>
                  <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-white dark:bg-zinc-900">
                    {assetCandidate?.url ? (
                      <Image
                        src={assetCandidate.url}
                        alt={assetCandidate.displayName || "Candidate asset"}
                        fill
                        unoptimized
                        className="object-contain"
                      />
                    ) : (
                      <div className="px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        Generate a candidate to preview the updated asset here.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Change Prompt
                  </p>
                  <textarea
                    value={assetEditPrompt}
                    onChange={(e) => setAssetEditPrompt(e.target.value)}
                    className="mt-2 min-h-[180px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    placeholder="Describe the visual changes you want to make."
                  />
                </div>

                {!isSvgMimeType(selectedAsset.mimeType) ? (
                  <label className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                    <input
                      type="checkbox"
                      checked={assetEditTransparentBackground}
                      onChange={(e) =>
                        setAssetEditTransparentBackground(e.target.checked)
                      }
                      className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
                    />
                    <span>
                      Return a transparent PNG and remove the background.
                    </span>
                  </label>
                ) : null}

                {assetEditStatus ? (
                  <p className="text-xs text-zinc-600 dark:text-zinc-300">
                    {assetEditStatus}
                  </p>
                ) : null}

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeAssetModal}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateAssetCandidate}
                    disabled={isGeneratingAssetCandidate || !onAssetsChange}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    {isGeneratingAssetCandidate ? "Generating..." : "Generate"}
                  </button>
                  <button
                    type="button"
                    onClick={handleKeepAssetCandidate}
                    disabled={!assetCandidate || !onAssetsChange}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                  >
                    Keep
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
              <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-300">
                {saveStatus}
              </p>
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
