export type AppAssetSourceType = "upload" | "generated" | "edited";

export type AppAsset = {
  assetKey: string;
  mimeType: string;
  url: string;
  data?: string;
  displayName?: string;
  rolePrompt?: string;
  sourceType?: AppAssetSourceType;
  svgText?: string;
};

export function sanitizeAssetKey(raw: string, fallback = "asset"): string {
  const normalized = raw
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);

  return normalized || fallback;
}

export function isSvgMimeType(mimeType: string | undefined): boolean {
  return (mimeType || "").toLowerCase().includes("svg");
}

export function isVisualAsset(mimeType: string | undefined): boolean {
  return (mimeType || "").toLowerCase().startsWith("image/");
}
