"use client";

import type { AppAsset } from "@/lib/app-assets";

const STUDIO_SESSION_STORAGE_PREFIX = "studio-session:";
const STUDIO_SESSION_VERSION = 1;

export type StudioSessionImage = {
  url: string;
  mimeType: string;
  data: string;
};

export type StudioSessionMessageAttachment = {
  url: string;
  mimeType: string;
  data?: string;
};

export type StudioSessionMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: StudioSessionMessageAttachment[];
};

export type StudioCodePreviewUiState = {
  activeTab: "preview" | "code" | "assets";
  draftCode: string;
  sourceCode: string;
  diffViewMode: "split" | "combined";
};

export type StudioSessionState = {
  input: string;
  isRichText: boolean;
  richTextContent: string;
  selectedImage: StudioSessionImage | null;
  isConversationOpen: boolean;
  messages: StudioSessionMessage[];
  previewCode: string;
  previewComparisonCode: string | null;
  previewLanguage: string;
  previewTitle: string;
  previewAssets: AppAsset[];
  codePreviewUi: StudioCodePreviewUiState | null;
};

export function areStudioCodePreviewUiStatesEqual(
  left: StudioCodePreviewUiState | null | undefined,
  right: StudioCodePreviewUiState | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  return (
    left.activeTab === right.activeTab &&
    left.draftCode === right.draftCode &&
    left.sourceCode === right.sourceCode &&
    left.diffViewMode === right.diffViewMode
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

function normalizeImage(value: unknown): StudioSessionImage | null {
  if (!isRecord(value)) return null;

  const mimeType = typeof value.mimeType === "string" ? value.mimeType : "";
  const data = typeof value.data === "string" ? value.data : "";
  if (!mimeType || !data) return null;

  const url =
    typeof value.url === "string" && value.url.length > 0
      ? value.url
      : toDataUrl(mimeType, data);

  return {
    url: url.startsWith("blob:") ? toDataUrl(mimeType, data) : url,
    mimeType,
    data,
  };
}

function normalizeAttachments(value: unknown): StudioSessionMessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const attachments = value
    .map((entry) => {
      if (!isRecord(entry)) return null;

      const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : "";
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const fallbackUrl = data && mimeType ? toDataUrl(mimeType, data) : "";
      const rawUrl = typeof entry.url === "string" ? entry.url : fallbackUrl;
      if (!mimeType || !rawUrl) return null;

      const normalized: StudioSessionMessageAttachment = {
        url: rawUrl.startsWith("blob:") && fallbackUrl ? fallbackUrl : rawUrl,
        mimeType,
      };
      if (typeof data === "string") {
        normalized.data = data;
      }
      return normalized;
    })
    .filter(isNonNull);

  return attachments.length > 0 ? attachments : undefined;
}

function normalizeMessages(value: unknown): StudioSessionMessage[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;

      const id = typeof entry.id === "string" ? entry.id : `${Date.now()}`;
      const role = entry.role === "user" ? "user" : entry.role === "assistant" ? "assistant" : null;
      const content = typeof entry.content === "string" ? entry.content : "";
      if (!role) return null;

      const normalized: StudioSessionMessage = {
        id,
        role,
        content,
      };
      const attachments = normalizeAttachments(entry.attachments);
      if (attachments) {
        normalized.attachments = attachments;
      }
      return normalized;
    })
    .filter(isNonNull);
}

function normalizePreviewAssets(value: unknown): AppAsset[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry, index) => {
      if (!isRecord(entry)) return null;

      const assetKey =
        typeof entry.assetKey === "string" && entry.assetKey.length > 0
          ? entry.assetKey
          : `asset_${index + 1}`;
      const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : "";
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const fallbackUrl = data && mimeType ? toDataUrl(mimeType, data) : "";
      const rawUrl = typeof entry.url === "string" ? entry.url : fallbackUrl;
      if (!mimeType || !rawUrl) return null;

      const normalized: AppAsset = {
        assetKey,
        mimeType,
        url: rawUrl.startsWith("blob:") && fallbackUrl ? fallbackUrl : rawUrl,
      };
      if (typeof data === "string") {
        normalized.data = data;
      }
      if (typeof entry.storagePath === "string") {
        normalized.storagePath = entry.storagePath;
      }
      if (typeof entry.displayName === "string") {
        normalized.displayName = entry.displayName;
      }
      if (typeof entry.rolePrompt === "string") {
        normalized.rolePrompt = entry.rolePrompt;
      }
      if (
        entry.sourceType === "upload" ||
        entry.sourceType === "generated" ||
        entry.sourceType === "edited"
      ) {
        normalized.sourceType = entry.sourceType;
      }
      if (typeof entry.svgText === "string") {
        normalized.svgText = entry.svgText;
      }
      return normalized;
    })
    .filter(isNonNull);
}

function normalizeCodePreviewUi(value: unknown): StudioCodePreviewUiState | null {
  if (!isRecord(value)) return null;

  const activeTab =
    value.activeTab === "preview" || value.activeTab === "code" || value.activeTab === "assets"
      ? value.activeTab
      : null;
  const draftCode = typeof value.draftCode === "string" ? value.draftCode : null;
  const sourceCode = typeof value.sourceCode === "string" ? value.sourceCode : null;
  const diffViewMode =
    value.diffViewMode === "split" || value.diffViewMode === "combined"
      ? value.diffViewMode
      : null;

  if (!activeTab || draftCode === null || sourceCode === null || !diffViewMode) {
    return null;
  }

  return {
    activeTab,
    draftCode,
    sourceCode,
    diffViewMode,
  };
}

export function getStudioSessionKey(appId?: string, draftId?: string): string {
  if (draftId) return `draft:${draftId}`;
  if (appId) return `app:${appId}`;
  return "default";
}

export function loadStudioSession(sessionKey: string): StudioSessionState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(
      `${STUDIO_SESSION_STORAGE_PREFIX}${sessionKey}`,
    );
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== STUDIO_SESSION_VERSION || !isRecord(parsed.state)) {
      return null;
    }

    const state = parsed.state;

    return {
      input: typeof state.input === "string" ? state.input : "",
      isRichText: state.isRichText === true,
      richTextContent: typeof state.richTextContent === "string" ? state.richTextContent : "",
      selectedImage: normalizeImage(state.selectedImage),
      isConversationOpen: state.isConversationOpen === true,
      messages: normalizeMessages(state.messages),
      previewCode: typeof state.previewCode === "string" ? state.previewCode : "",
      previewComparisonCode:
        typeof state.previewComparisonCode === "string" ? state.previewComparisonCode : null,
      previewLanguage: typeof state.previewLanguage === "string" ? state.previewLanguage : "tsx",
      previewTitle: typeof state.previewTitle === "string" ? state.previewTitle : "Studio Preview",
      previewAssets: normalizePreviewAssets(state.previewAssets),
      codePreviewUi: normalizeCodePreviewUi(state.codePreviewUi),
    };
  } catch (error) {
    console.warn("Failed to restore Studio session:", error);
    return null;
  }
}

export function saveStudioSession(sessionKey: string, state: StudioSessionState) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      `${STUDIO_SESSION_STORAGE_PREFIX}${sessionKey}`,
      JSON.stringify({
        version: STUDIO_SESSION_VERSION,
        state,
      }),
    );
  } catch (error) {
    console.warn("Failed to persist Studio session:", error);
  }
}

export function removeStudioSession(sessionKey: string) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(
      `${STUDIO_SESSION_STORAGE_PREFIX}${sessionKey}`,
    );
  } catch (error) {
    console.warn("Failed to clear Studio session:", error);
  }
}
