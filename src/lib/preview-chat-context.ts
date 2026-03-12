"use client";

import type { AppAsset } from "@/lib/app-assets";
import { isVisualAsset } from "@/lib/app-assets";

const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type ChatRequestAttachment = {
  mimeType: string;
  data: string;
};

export type ChatRequestMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: ChatRequestAttachment[];
};

type BuildPreviewContextMessageParams = {
  title: string;
  code: string;
  language: string;
  assets?: AppAsset[];
};

function normalizeAttachmentMimeType(mimeType: string | undefined): string | null {
  const normalized = (mimeType || "").toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return INLINE_IMAGE_MIME_TYPES.has(normalized) ? normalized : null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

async function readBlobAsBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

async function resolveInlineAttachment(
  asset: AppAsset,
): Promise<ChatRequestAttachment | null> {
  const normalizedMimeType = normalizeAttachmentMimeType(asset.mimeType);
  if (!normalizedMimeType || !isVisualAsset(asset.mimeType)) return null;

  if (asset.data) {
    return {
      mimeType: normalizedMimeType,
      data: asset.data,
    };
  }

  if (!asset.url || typeof window === "undefined") return null;

  try {
    const resolvedUrl = new URL(asset.url, window.location.href);
    if (resolvedUrl.origin !== window.location.origin) return null;

    const response = await fetch(resolvedUrl.toString(), { cache: "no-store" });
    if (!response.ok) return null;

    const responseMimeType = normalizeAttachmentMimeType(
      response.headers.get("content-type") || asset.mimeType,
    );
    if (!responseMimeType) return null;

    const blob = await response.blob();
    const data = await readBlobAsBase64(blob);
    if (!data) return null;

    return {
      mimeType: responseMimeType,
      data,
    };
  } catch {
    return null;
  }
}

function buildAssetContextLine(
  asset: AppAsset,
  index: number,
  hasInlineAttachment: boolean,
): string {
  const parts = [
    `${index + 1}. ${asset.assetKey}`,
    `(mime: ${asset.mimeType || "application/octet-stream"})`,
    `(placeholder: __ASSET_${asset.assetKey}__)`,
  ];

  if (asset.displayName) {
    parts.push(`(name: ${asset.displayName})`);
  }
  if (asset.sourceType) {
    parts.push(`(source: ${asset.sourceType})`);
  }
  if (asset.rolePrompt) {
    parts.push(`(purpose: ${asset.rolePrompt})`);
  }
  parts.push(hasInlineAttachment ? "(attached inline)" : "(manifest only)");

  return parts.join(" ");
}

export async function buildPreviewContextRequestMessage({
  title,
  code,
  language,
  assets = [],
}: BuildPreviewContextMessageParams): Promise<ChatRequestMessage | null> {
  const trimmedCode = code.trim();
  const normalizedLanguage = (language || "tsx").trim() || "tsx";

  if (!trimmedCode && assets.length === 0) {
    return null;
  }

  const resolvedAttachments = await Promise.all(
    assets.map(async (asset) => ({
      asset,
      attachment: await resolveInlineAttachment(asset),
    })),
  );

  const assetManifest =
    resolvedAttachments.length > 0
      ? resolvedAttachments
          .map(({ asset, attachment }, index) =>
            buildAssetContextLine(asset, index, Boolean(attachment)),
          )
          .join("\n")
      : "None.";

  const content = [
    `Current app context: "${title || "Untitled App"}".`,
    "",
    "Treat this as the current source of truth before answering the next user request.",
    "Modify this app instead of starting over unless the user explicitly asks for a rewrite.",
    "When the user requests a change, update the preview by returning the revised runnable app code right away.",
    "Do not ask whether to provide the full file, and do not describe the update instead of applying it.",
    "Keep any non-code explanation brief unless the user asks for more detail.",
    "",
    `\`\`\`${normalizedLanguage}`,
    trimmedCode,
    "```",
    "",
    "Asset manifest:",
    assetManifest,
    "",
    "Rules:",
    "- Preserve existing asset placeholders exactly as listed.",
    "- Use attached visual assets directly when updating the app.",
    "- If an asset is manifest-only, keep its placeholder references intact in code.",
  ].join("\n");

  const attachments = resolvedAttachments
    .flatMap(({ attachment }) => (attachment ? [attachment] : []));

  return {
    role: "user",
    content,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}
