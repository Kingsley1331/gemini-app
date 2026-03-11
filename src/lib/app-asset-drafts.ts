"use client";

import type { AppAsset } from "@/lib/app-assets";

type AssetUploadResponse = {
  asset?: {
    assetKey: string;
    mimeType: string;
    storagePath: string;
    url: string;
    displayName?: string;
    rolePrompt?: string;
    sourceType?: "upload" | "generated" | "edited";
    svgText?: string;
  };
  details?: string;
  error?: string;
};

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unable to encode asset."));
        return;
      }
      const [, base64 = ""] = reader.result.split(",", 2);
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error("Unable to encode asset."));
    reader.readAsDataURL(blob);
  });
}

export async function getAssetBlob(asset: AppAsset): Promise<Blob> {
  if (asset.data) {
    return base64ToBlob(asset.data, asset.mimeType);
  }
  if (asset.svgText && asset.mimeType.toLowerCase().includes("svg")) {
    return new Blob([asset.svgText], { type: asset.mimeType || "image/svg+xml" });
  }
  if (!asset.url) {
    throw new Error(`Asset "${asset.displayName || asset.assetKey}" is missing file data.`);
  }
  const response = await fetch(asset.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load asset "${asset.displayName || asset.assetKey}".`);
  }
  return await response.blob();
}

export async function uploadDraftAppAsset(id: string, asset: AppAsset): Promise<AppAsset> {
  const blob = await getAssetBlob(asset);
  const formData = new FormData();
  formData.set("file", blob, asset.displayName || `${asset.assetKey}.${asset.mimeType.split("/")[1] || "bin"}`);
  formData.set("assetKey", asset.assetKey);
  formData.set("mimeType", blob.type || asset.mimeType || "application/octet-stream");
  if (asset.displayName) formData.set("displayName", asset.displayName);
  if (asset.rolePrompt) formData.set("rolePrompt", asset.rolePrompt);
  if (asset.sourceType) formData.set("sourceType", asset.sourceType);
  if (asset.svgText) formData.set("svgText", asset.svgText);

  const response = await fetch(`/api/apps/${encodeURIComponent(id)}/assets`, {
    method: "POST",
    body: formData,
  });
  const payload = (await response.json().catch(() => ({}))) as AssetUploadResponse;
  if (!response.ok || !payload.asset) {
    throw new Error(payload.details || payload.error || "Unable to upload asset.");
  }

  return {
    ...asset,
    assetKey: payload.asset.assetKey,
    mimeType: payload.asset.mimeType || asset.mimeType,
    url: payload.asset.url,
    storagePath: payload.asset.storagePath,
    displayName: payload.asset.displayName || asset.displayName,
    rolePrompt: payload.asset.rolePrompt || asset.rolePrompt,
    sourceType: payload.asset.sourceType || asset.sourceType,
    svgText: payload.asset.svgText ?? asset.svgText,
    data: asset.data,
  };
}

function assetBelongsToAppId(id: string, asset: AppAsset): boolean {
  if (!asset.storagePath) return false;
  const draftPath = `draft-apps/${id}/assets/${asset.assetKey}`;
  const sharedPath = `shared-apps/${id}/assets/${asset.assetKey}`;
  return asset.storagePath === draftPath || asset.storagePath === sharedPath;
}

export async function ensureDraftAppAssets(id: string, assets: AppAsset[]): Promise<AppAsset[]> {
  return await Promise.all(
    assets.map(async (asset) => {
      if (asset.storagePath && assetBelongsToAppId(id, asset)) return asset;
      return await uploadDraftAppAsset(id, asset);
    })
  );
}
