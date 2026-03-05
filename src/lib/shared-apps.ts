export const SHAREABLE_INSTALLS_FLAG = "ENABLE_SHAREABLE_INSTALLS";
export const MAX_SHARED_CODE_LENGTH = 700_000;
export const MAX_SHARED_ASSET_COUNT = 40;
export const MAX_SHARED_ASSET_BASE64_LENGTH = 8_000_000;

export interface SharedAppAssetInput {
  assetKey: string;
  mimeType: string;
  data?: string;
  url?: string;
}

export interface SharedAppPublishInput {
  id: string;
  name: string;
  code: string;
  language: string;
  hasGeneratedIcon: boolean;
  assets?: SharedAppAssetInput[];
}

export interface SharedAppAssetRef {
  assetKey: string;
  mimeType: string;
  storagePath: string;
}

export interface SharedAppDoc {
  id: string;
  name: string;
  code: string;
  language: string;
  hasGeneratedIcon: boolean;
  isPublic: boolean;
  assets: SharedAppAssetRef[];
  icon192Path?: string;
  icon512Path?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SharedAppReadPayload {
  id: string;
  name: string;
  code: string;
  language: string;
  hasGeneratedIcon: boolean;
  assets: Array<{
    assetKey: string;
    mimeType: string;
  }>;
  icon192Url?: string;
  icon512Url?: string;
  updatedAt: number;
}

export function isShareableInstallsEnabled(): boolean {
  const value = process.env[SHAREABLE_INSTALLS_FLAG];
  return value === "1" || value === "true";
}

export function getSharedAppDocPath(id: string): string {
  return `apps/${id}`;
}

export function getSharedAssetStoragePath(id: string, assetKey: string): string {
  return `shared-apps/${id}/assets/${assetKey}`;
}

export function getSharedIconStoragePath(id: string, size: 192 | 512): string {
  return `shared-apps/${id}/icons/icon-${size}.png`;
}
