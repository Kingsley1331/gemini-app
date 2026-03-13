"use client";

import type { AppAsset } from "@/lib/app-assets";

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

function buildAssetContextLine(
  asset: AppAsset,
  index: number,
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
  parts.push("(manifest only)");

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

  const assetManifest =
    assets.length > 0
      ? assets
          .map((asset, index) =>
            buildAssetContextLine(asset, index),
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
    "- Use the listed visual assets via their placeholders when updating the app.",
    "- Keep placeholder references intact in code for assets listed in the manifest.",
  ].join("\n");

  return {
    role: "user",
    content,
  };
}
