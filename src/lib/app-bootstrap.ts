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
  assets?: Array<{
    assetKey: string;
    mimeType: string;
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
  return {
    id,
    code,
    language: localStorage.getItem(`pwa-preview-${id}-language`) || "tsx",
    name: localStorage.getItem(`pwa-preview-${id}-name`) || "My App",
    hasGeneratedIcon: localStorage.getItem(`pwa-preview-${id}-has-generated-icon`) === "1",
    assets: hydrateBootstrapAssets(id, readPreviewAssets(id)),
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

    if (data.assets.length > 0) {
      localStorage.setItem(`pwa-preview-${data.id}-assets`, JSON.stringify(data.assets));
    } else {
      localStorage.removeItem(`pwa-preview-${data.id}-assets`);
    }
  } catch {
    // localStorage hydration is best-effort
  }
}

export async function loadAppBootstrapData(id: string): Promise<AppBootstrapData | null> {
  const local = readAppBootstrapFromLocal(id);
  if (local) return local;

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

  try {
    const remoteResp = await fetch(`/api/apps/${id}`, { cache: "no-store" });
    if (!remoteResp.ok) return null;
    const shared = (await remoteResp.json()) as SharedPreviewResponse;
    const hydrated: AppBootstrapData = {
      id,
      code: shared.code,
      language: shared.language,
      name: shared.name,
      hasGeneratedIcon: Boolean(shared.hasGeneratedIcon),
      assets: (shared.assets ?? []).map((asset) => ({
        assetKey: asset.assetKey,
        mimeType: asset.mimeType || "application/octet-stream",
        url: buildPreviewAssetUrl(id, asset.assetKey),
      })),
    };

    hydrateAppBootstrapToLocalStorage(hydrated);
    return hydrated;
  } catch {
    return null;
  }
}
