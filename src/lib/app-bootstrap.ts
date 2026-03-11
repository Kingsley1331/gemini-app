"use client";

import { getPreviewFromIDB } from "@/lib/preview-idb";
import {
  buildPreviewAssetUrl,
  readPreviewAssets,
  type StoredPreviewAsset,
} from "@/lib/pwa-preview";

type SharedPreviewResponse = {
  id: string;
  code: string;
  language: string;
  name: string;
  hasGeneratedIcon: boolean;
  updatedAt?: number;
  assets?: Array<{
    assetKey: string;
    mimeType: string;
    displayName?: string;
    rolePrompt?: string;
    sourceType?: "upload" | "generated" | "edited";
    svgText?: string;
  }>;
};

type AppBootstrapAsset = StoredPreviewAsset & {
  url: string;
};

export type AppBootstrapData = {
  id: string;
  code: string;
  language: string;
  name: string;
  hasGeneratedIcon: boolean;
  assets: AppBootstrapAsset[];
  remoteUpdatedAtHint?: number;
};

function hydrateBootstrapAssets(id: string, assets: StoredPreviewAsset[]): AppBootstrapAsset[] {
  return assets.map((asset) => ({
    ...asset,
    url: asset.url || buildPreviewAssetUrl(id, asset.assetKey),
  }));
}

async function getPreviewFromIDBWithTimeout(
  id: string,
  timeoutMs = 1500,
): Promise<Awaited<ReturnType<typeof getPreviewFromIDB>>> {
  return await Promise.race([
    getPreviewFromIDB(id),
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
}

export function readAppBootstrapFromLocal(id: string): AppBootstrapData | null {
  const code = localStorage.getItem(`pwa-preview-${id}-code`);
  if (!code) return null;
  const remoteUpdatedAtRaw = localStorage.getItem(`pwa-preview-${id}-remote-updated-at`);
  const remoteUpdatedAt = remoteUpdatedAtRaw ? Number(remoteUpdatedAtRaw) : 0;
  return {
    id,
    code,
    language: localStorage.getItem(`pwa-preview-${id}-language`) || "tsx",
    name: localStorage.getItem(`pwa-preview-${id}-name`) || "My App",
    hasGeneratedIcon: localStorage.getItem(`pwa-preview-${id}-has-generated-icon`) === "1",
    assets: hydrateBootstrapAssets(id, readPreviewAssets(id)),
    remoteUpdatedAtHint:
      Number.isFinite(remoteUpdatedAt) && remoteUpdatedAt > 0 ? remoteUpdatedAt : undefined,
  };
}

function hydrateAppBootstrapToLocalStorage(data: AppBootstrapData) {
  try {
    localStorage.setItem(`pwa-preview-${data.id}-code`, data.code);
    localStorage.setItem(`pwa-preview-${data.id}-language`, data.language);
    localStorage.setItem(`pwa-preview-${data.id}-name`, data.name);
    if (data.hasGeneratedIcon) {
      localStorage.setItem(`pwa-preview-${data.id}-has-generated-icon`, "1");
    } else {
      localStorage.removeItem(`pwa-preview-${data.id}-has-generated-icon`);
    }
    if (
      typeof data.remoteUpdatedAtHint === "number" &&
      Number.isFinite(data.remoteUpdatedAtHint) &&
      data.remoteUpdatedAtHint > 0
    ) {
      localStorage.setItem(
        `pwa-preview-${data.id}-remote-updated-at`,
        String(data.remoteUpdatedAtHint),
      );
    }

    if (data.assets.length > 0) {
      localStorage.setItem(`pwa-preview-${data.id}-assets`, JSON.stringify(data.assets));
    } else {
      localStorage.removeItem(`pwa-preview-${data.id}-assets`);
    }
  } catch {
    // localStorage hydration is best-effort
  }
}

async function fetchRemoteBootstrapData(id: string): Promise<AppBootstrapData | null> {
  try {
    const remoteResp = await fetch(`/api/apps/${id}`, { cache: "no-store" });
    if (!remoteResp.ok) return null;
    const shared = (await remoteResp.json()) as SharedPreviewResponse;
    return {
      id,
      code: shared.code,
      language: shared.language,
      name: shared.name,
      hasGeneratedIcon: Boolean(shared.hasGeneratedIcon),
      assets: (shared.assets ?? []).map((asset) => ({
        assetKey: asset.assetKey,
        mimeType: asset.mimeType || "application/octet-stream",
        url: buildPreviewAssetUrl(id, asset.assetKey),
        displayName: asset.displayName,
        rolePrompt: asset.rolePrompt,
        sourceType: asset.sourceType,
        svgText: asset.svgText,
      })),
      remoteUpdatedAtHint:
        typeof shared.updatedAt === "number" && Number.isFinite(shared.updatedAt)
          ? shared.updatedAt
          : undefined,
    };
  } catch {
    return null;
  }
}

export async function loadAppBootstrapData(id: string): Promise<AppBootstrapData | null> {
  const local = readAppBootstrapFromLocal(id);
  if (local) {
    const remote = await fetchRemoteBootstrapData(id);
    if (
      remote &&
      typeof local.remoteUpdatedAtHint === "number" &&
      typeof remote.remoteUpdatedAtHint === "number" &&
      remote.remoteUpdatedAtHint > local.remoteUpdatedAtHint
    ) {
      hydrateAppBootstrapToLocalStorage(remote);
      return remote;
    }
    return local;
  }

  const idbRecord = await getPreviewFromIDBWithTimeout(id);
  if (idbRecord) {
    const hydrated: AppBootstrapData = {
      id,
      code: idbRecord.code,
      language: idbRecord.language,
      name: idbRecord.name,
      hasGeneratedIcon: idbRecord.hasGeneratedIcon,
      assets: hydrateBootstrapAssets(id, readPreviewAssets(id)),
    };
    hydrateAppBootstrapToLocalStorage(hydrated);
    return hydrated;
  }

  const remote = await fetchRemoteBootstrapData(id);
  if (!remote) return null;
  hydrateAppBootstrapToLocalStorage(remote);
  return remote;
}
