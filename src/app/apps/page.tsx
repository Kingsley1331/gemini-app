"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteSavedApp, getAllSavedApps, saveApp, type SavedApp } from "@/lib/saved-apps-idb";
import { requestPersistentStorage, savePreviewToIDB } from "@/lib/preview-idb";
import { loadAppBootstrapData, type AppBootstrapData } from "@/lib/app-bootstrap";
import {
  cacheGeneratedPreviewIcons,
  createPwaPreviewId,
  persistPwaPreviewAssets,
} from "@/lib/pwa-preview";
import AppNav from "@/components/AppNav";

type RemoteApp = {
  id: string;
  name: string;
  hasIcon: boolean;
  iconUrl?: string;
  updatedAt: number;
};

type MergedApp = {
  id: string;
  name: string;
  timestamp: number;
  local?: SavedApp;
  remote?: RemoteApp;
};

type CloneIconMode = "none" | "copied" | "generated";

type GenerateIconResponse = {
  details?: string;
  error?: string;
  icons?: { icon192?: string; icon512?: string };
  iconDataUrls?: { icon192?: string; icon512?: string };
  shareUrl?: string;
};

function stripDataUrlPrefix(value?: string | null): string | null {
  if (!value) return null;
  return value.replace(/^data:[^,]+,/, "");
}

function getInitialCloneIconState(app: MergedApp) {
  if (app.local?.hasIcon && app.local.iconBase64) {
    return {
      hasIcon: true,
      mode: "copied" as const,
      previewUrl: `data:image/png;base64,${app.local.iconBase64}`,
      base64: app.local.iconBase64,
    };
  }

  if (app.local?.hasIcon || app.remote?.hasIcon) {
    return {
      hasIcon: true,
      mode: "copied" as const,
      previewUrl: `/api/preview/${encodeURIComponent(app.id)}/generate-icon?size=192&v=${Date.now()}`,
      base64: null,
    };
  }

  return {
    hasIcon: false,
    mode: "none" as const,
    previewUrl: null,
    base64: null,
  };
}

export default function AppsPage() {
  const router = useRouter();
  const cloneRequestRef = useRef(0);
  const [localApps, setLocalApps] = useState<SavedApp[]>([]);
  const [remoteApps, setRemoteApps] = useState<RemoteApp[]>([]);
  const [loadedLocal, setLoadedLocal] = useState(false);
  const [loadedRemote, setLoadedRemote] = useState(false);
  const [brokenRemoteIcons, setBrokenRemoteIcons] = useState<Record<string, boolean>>({});
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloneSource, setCloneSource] = useState<MergedApp | null>(null);
  const [cloneSourceData, setCloneSourceData] = useState<AppBootstrapData | null>(null);
  const [clonePreviewId, setClonePreviewId] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState("My App");
  const [cloneIconPrompt, setCloneIconPrompt] = useState("");
  const [cloneStatus, setCloneStatus] = useState<string | null>(null);
  const [cloneIconPreviewUrl, setCloneIconPreviewUrl] = useState<string | null>(null);
  const [cloneIconBase64, setCloneIconBase64] = useState<string | null>(null);
  const [cloneHasIcon, setCloneHasIcon] = useState(false);
  const [cloneIconMode, setCloneIconMode] = useState<CloneIconMode>("none");
  const [cloneSavedLocally, setCloneSavedLocally] = useState(false);
  const [isLoadingCloneSource, setIsLoadingCloneSource] = useState(false);
  const [isGeneratingCloneIcon, setIsGeneratingCloneIcon] = useState(false);
  const [isSavingClone, setIsSavingClone] = useState(false);

  const refreshRemoteApps = useCallback(async () => {
    try {
      const resp = await fetch("/api/apps", { cache: "no-store" });
      if (!resp.ok) {
        setRemoteApps([]);
        return;
      }
      const data = (await resp.json()) as { apps?: RemoteApp[] };
      setRemoteApps(Array.isArray(data.apps) ? data.apps : []);
    } catch {
      setRemoteApps([]);
    } finally {
      setLoadedRemote(true);
    }
  }, []);

  useEffect(() => {
    getAllSavedApps()
      .then((result) => {
        setLocalApps(result);
      })
      .finally(() => setLoadedLocal(true));

    refreshRemoteApps();
  }, [refreshRemoteApps]);

  const apps = useMemo<MergedApp[]>(() => {
    const merged = new Map<string, MergedApp>();

    for (const remote of remoteApps) {
      merged.set(remote.id, {
        id: remote.id,
        name: remote.name,
        timestamp: remote.updatedAt || 0,
        remote,
      });
    }

    for (const local of localApps) {
      const existing = merged.get(local.id);
      if (existing) {
        merged.set(local.id, {
          ...existing,
          name: local.name || existing.name,
          timestamp: Math.max(existing.timestamp, local.timestamp || 0),
          local,
        });
      } else {
        merged.set(local.id, {
          id: local.id,
          name: local.name,
          timestamp: local.timestamp || 0,
          local,
        });
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [localApps, remoteApps]);

  const handleDelete = async (e: React.MouseEvent, appId: string) => {
    e.stopPropagation();
    await deleteSavedApp(appId);
    setLocalApps((prev) => prev.filter((a) => a.id !== appId));
  };

  const handleEdit = (e: React.MouseEvent, appId: string) => {
    e.stopPropagation();
    router.push(`/?editAppId=${encodeURIComponent(appId)}&origin=apps`);
  };

  const resetCloneState = useCallback(() => {
    setShowCloneModal(false);
    setCloneSource(null);
    setCloneSourceData(null);
    setClonePreviewId(null);
    setCloneName("My App");
    setCloneIconPrompt("");
    setCloneStatus(null);
    setCloneIconPreviewUrl(null);
    setCloneIconBase64(null);
    setCloneHasIcon(false);
    setCloneIconMode("none");
    setCloneSavedLocally(false);
    setIsLoadingCloneSource(false);
    setIsGeneratingCloneIcon(false);
    setIsSavingClone(false);
  }, []);

  const closeCloneModal = useCallback(() => {
    if (isGeneratingCloneIcon || isSavingClone) return;
    const previewIdToClean = clonePreviewId;
    cloneRequestRef.current += 1;
    resetCloneState();
    if (previewIdToClean && !cloneSavedLocally) {
      fetch(`/api/preview/${encodeURIComponent(previewIdToClean)}/generate-icon`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }, [clonePreviewId, cloneSavedLocally, isGeneratingCloneIcon, isSavingClone, resetCloneState]);

  const openCloneModal = useCallback(async (e: React.MouseEvent, app: MergedApp) => {
    e.stopPropagation();
    const requestId = cloneRequestRef.current + 1;
    cloneRequestRef.current = requestId;
    const nextCloneId = createPwaPreviewId();
    const initialIcon = getInitialCloneIconState(app);

    setShowCloneModal(true);
    setCloneSource(app);
    setCloneSourceData(null);
    setClonePreviewId(nextCloneId);
    setCloneName(`${app.name} Copy`);
    setCloneIconPrompt("");
    setCloneStatus("Loading app...");
    setCloneIconPreviewUrl(initialIcon.previewUrl);
    setCloneIconBase64(initialIcon.base64);
    setCloneHasIcon(initialIcon.hasIcon);
    setCloneIconMode(initialIcon.mode);
    setCloneSavedLocally(false);
    setIsLoadingCloneSource(true);

    const loaded = await loadAppBootstrapData(app.id);
    if (cloneRequestRef.current !== requestId) return;

    if (!loaded) {
      setCloneStatus("I couldn't load this app for cloning. Please try again.");
      setCloneSourceData(null);
      setIsLoadingCloneSource(false);
      return;
    }

    setCloneSourceData(loaded);
    setCloneName(`${loaded.name} Copy`);
    setCloneStatus(null);
    setIsLoadingCloneSource(false);
  }, []);

  const applyIconResponse = useCallback(
    async (
      id: string,
      data: GenerateIconResponse,
      nextMode: Exclude<CloneIconMode, "none">,
    ) => {
      const icon192b64 = stripDataUrlPrefix(data.iconDataUrls?.icon192);
      const icon512b64 = stripDataUrlPrefix(data.iconDataUrls?.icon512);
      const iconVersion = Date.now();
      if (icon192b64) {
        localStorage.setItem(`pwa-preview-${id}-icon192-b64`, icon192b64);
        setCloneIconBase64(icon192b64);
      }
      localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
      localStorage.setItem(`pwa-preview-${id}-icon-version`, String(iconVersion));
      await cacheGeneratedPreviewIcons(id, { icon192b64, icon512b64, version: iconVersion });
      setCloneHasIcon(true);
      setCloneIconMode(nextMode);

      const cacheBust = Date.now();
      const baseIconUrl = data.icons?.icon192 || `/api/preview/${id}/generate-icon?size=192`;
      const separator = baseIconUrl.includes("?") ? "&" : "?";
      setCloneIconPreviewUrl(`${baseIconUrl}${separator}v=${cacheBust}`);
      return icon192b64;
    },
    [],
  );

  const handleGenerateCloneIcon = useCallback(async () => {
    if (isGeneratingCloneIcon || !clonePreviewId) return;
    const name = cloneName.trim() || "My App";
    setIsGeneratingCloneIcon(true);
    setCloneStatus("Generating icon...");

    try {
      const retryDelaysMs = [900, 1700];
      let data: GenerateIconResponse | null = null;
      let success = false;

      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        const res = await fetch(`/api/preview/${clonePreviewId}/generate-icon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            prompt:
              cloneIconPrompt.trim() ||
              `Create a clean, high-contrast, minimal app icon for "${name}". Centered symbol, no text, no watermark, readable at small sizes.`,
            pro: true,
          }),
        });

        data = (await res.json().catch(() => ({}))) as GenerateIconResponse;
        if (res.ok) {
          success = true;
          break;
        }

        const isRetryable = res.status === 503;
        const canRetry = attempt < retryDelaysMs.length;
        if (isRetryable && canRetry) {
          const retryNumber = attempt + 1;
          const retryTotal = retryDelaysMs.length;
          setCloneStatus(`Model is busy, retrying icon generation (${retryNumber}/${retryTotal})...`);
          await new Promise((resolve) => window.setTimeout(resolve, retryDelaysMs[attempt] ?? 0));
          continue;
        }

        throw new Error(data.details || data.error || "Icon generation failed");
      }

      if (!success || !data) {
        throw new Error("Icon generation failed");
      }

      await applyIconResponse(clonePreviewId, data, "generated");
      setCloneStatus("Icon ready! Click Clone to finish.");
    } catch (error: unknown) {
      setCloneStatus(error instanceof Error ? error.message : "Unable to generate icon right now.");
    } finally {
      setIsGeneratingCloneIcon(false);
    }
  }, [applyIconResponse, cloneIconPrompt, cloneName, clonePreviewId, isGeneratingCloneIcon]);

  const handleSaveClone = useCallback(async () => {
    if (isSavingClone || !cloneSource || !cloneSourceData || !clonePreviewId) return;

    const id = clonePreviewId;
    const name = cloneName.trim() || "My App";
    const timestamp = Date.now();
    const assets = cloneSourceData.assets.map((asset, index) => ({
      assetKey: asset.assetKey || `asset_${index + 1}`,
      mimeType: asset.mimeType || "application/octet-stream",
      data: asset.data,
      url: asset.url,
    }));

    setIsSavingClone(true);
    setCloneStatus("Saving clone...");

    try {
      let nextIconBase64 = cloneIconBase64;

      if (cloneHasIcon && cloneIconMode === "copied") {
        setCloneStatus("Copying icon...");
        const copyResp = await fetch(`/api/preview/${id}/generate-icon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            copyFromId: cloneSource.id,
          }),
        });
        const copyData = (await copyResp.json().catch(() => ({}))) as GenerateIconResponse;
        if (!copyResp.ok) {
          throw new Error(copyData.details || copyData.error || "Unable to copy the icon.");
        }
        nextIconBase64 = (await applyIconResponse(id, copyData, "copied")) ?? nextIconBase64;
      }

      localStorage.setItem(`pwa-preview-${id}-code`, cloneSourceData.code);
      localStorage.setItem(`pwa-preview-${id}-language`, cloneSourceData.language);
      localStorage.setItem(`pwa-preview-${id}-name`, name);
      if (cloneHasIcon) {
        localStorage.setItem(`pwa-preview-${id}-has-generated-icon`, "1");
        if (!localStorage.getItem(`pwa-preview-${id}-icon-version`)) {
          localStorage.setItem(`pwa-preview-${id}-icon-version`, String(Date.now()));
        }
      } else {
        localStorage.removeItem(`pwa-preview-${id}-has-generated-icon`);
        localStorage.removeItem(`pwa-preview-${id}-icon-version`);
      }

      await persistPwaPreviewAssets(id, assets);
      savePreviewToIDB({
        id,
        standaloneHTML: "",
        code: cloneSourceData.code,
        language: cloneSourceData.language,
        name,
        hasGeneratedIcon: cloneHasIcon,
        timestamp,
      }).catch(() => {});
      requestPersistentStorage();

      const nextLocalApp: SavedApp = {
        id,
        name,
        iconBase64: nextIconBase64 ?? undefined,
        hasIcon: cloneHasIcon,
        timestamp,
      };
      await saveApp(nextLocalApp);
      setCloneSavedLocally(true);
      setLocalApps((prev) => [nextLocalApp, ...prev.filter((app) => app.id !== id)]);

      const publishResp = await fetch("/api/apps/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name,
          code: cloneSourceData.code,
          language: cloneSourceData.language,
          hasGeneratedIcon: cloneHasIcon,
          assets,
        }),
      });
      const publishData = (await publishResp.json().catch(() => ({}))) as GenerateIconResponse;
      if (!publishResp.ok || !publishData.shareUrl) {
        const details = publishData.details || publishData.error || "Cloud save failed.";
        setCloneStatus(`Cloned locally. Firebase sync failed: ${details}`);
        await refreshRemoteApps();
        return;
      }

      await refreshRemoteApps();
      resetCloneState();
    } catch (error: unknown) {
      setCloneStatus(error instanceof Error ? error.message : "Unable to clone this app right now.");
    } finally {
      setIsSavingClone(false);
    }
  }, [
    applyIconResponse,
    cloneHasIcon,
    cloneIconBase64,
    cloneIconMode,
    cloneName,
    clonePreviewId,
    cloneSource,
    cloneSourceData,
    isSavingClone,
    refreshRemoteApps,
    resetCloneState,
  ]);

  const loaded = loadedLocal && loadedRemote;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            My Apps
          </h1>
          <AppNav current="apps" />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {!loaded ? (
          <p className="text-center text-zinc-400 py-20">Loading...</p>
        ) : apps.length === 0 ? (
          <div className="text-center py-20">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </div>
            <h2 className="text-lg font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              No apps yet
            </h2>
            <p className="text-sm text-zinc-400">
              Save or publish an app to see it here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {apps.map((app) => (
              <div
                key={app.id}
                onClick={() => router.push(`/preview/${app.id}`)}
                className="group relative flex flex-col items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-600 hover:shadow-md transition-all"
              >
                <div className="absolute top-2 left-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                  <button
                    onClick={(e) => handleEdit(e, app.id)}
                    className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                    title="Edit in chat"
                  >
                    Edit
                  </button>
                  <button
                    onClick={(e) => openCloneModal(e, app)}
                    className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                    title="Clone app"
                  >
                    Clone
                  </button>
                </div>
                {app.local ? (
                  <button
                    onClick={(e) => handleDelete(e, app.id)}
                    className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-zinc-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-all"
                    title="Remove local copy"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                ) : null}

                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0">
                  {app.local?.hasIcon && app.local.iconBase64 ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`data:image/png;base64,${app.local.iconBase64}`}
                      alt={app.name}
                      className="w-full h-full object-cover"
                    />
                  ) : app.remote?.hasIcon && app.remote.iconUrl && !brokenRemoteIcons[app.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={app.remote.iconUrl}
                      alt={app.name}
                      className="w-full h-full object-cover"
                      onError={() =>
                        setBrokenRemoteIcons((prev) => ({ ...prev, [app.id]: true }))
                      }
                    />
                  ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <line x1="3" y1="9" x2="21" y2="9" />
                      <line x1="9" y1="21" x2="9" y2="9" />
                    </svg>
                  )}
                </div>

                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 text-center truncate w-full">
                  {app.name}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  {app.local && app.remote ? "Local + Remote" : app.local ? "Local" : "Remote"}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>

      {showCloneModal ? (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Clone App
                </h3>
                {cloneSource ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                    Creating a new copy of {cloneSource.name}.
                  </p>
                ) : null}
              </div>
              <button
                onClick={closeCloneModal}
                className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-50"
                disabled={isGeneratingCloneIcon || isSavingClone}
              >
                Close
              </button>
            </div>

            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              New App Name
            </label>
            <input
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              className="w-full mb-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
              placeholder="My App Copy"
            />

            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Icon Prompt (optional)
            </label>
            <textarea
              value={cloneIconPrompt}
              onChange={(e) => setCloneIconPrompt(e.target.value)}
              className="w-full mb-3 min-h-[90px] rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
              placeholder="Leave blank to auto-generate a prompt that matches the cloned app."
            />

            {cloneStatus ? (
              <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-300">{cloneStatus}</p>
            ) : null}

            {cloneIconPreviewUrl ? (
              <div className="mb-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950/40 p-3">
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                  Icon Preview
                </p>
                <div className="w-24 h-24 rounded-xl overflow-hidden border border-zinc-300 dark:border-zinc-600">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={cloneIconPreviewUrl}
                    alt="Cloned app icon preview"
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {isLoadingCloneSource
                  ? "Loading the original app..."
                  : cloneHasIcon
                    ? "The clone will keep this icon unless you generate a new one."
                    : "No icon yet. You can generate one before cloning."}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={closeCloneModal}
                  className="px-3 py-1.5 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
                  disabled={isGeneratingCloneIcon || isSavingClone}
                >
                  Cancel
                </button>
                <button
                  onClick={handleGenerateCloneIcon}
                  disabled={isLoadingCloneSource || isGeneratingCloneIcon || isSavingClone || !clonePreviewId}
                  className="px-3 py-1.5 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
                >
                  {isGeneratingCloneIcon
                    ? "Generating..."
                    : cloneIconMode === "generated"
                      ? "Regenerate Icon"
                      : "Generate Icon"}
                </button>
                <button
                  onClick={handleSaveClone}
                  disabled={isLoadingCloneSource || isSavingClone || !cloneSourceData}
                  className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white disabled:opacity-50"
                >
                  {isSavingClone ? "Cloning..." : "Clone"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
