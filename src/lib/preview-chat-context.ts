"use client";

import type { AppAsset } from "@/lib/app-assets";
import type {
  StudioComponentExtraction,
  StudioSelectedTarget,
} from "@/lib/studio-edit-types";

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

type BuildSelectedComponentContextMessageParams = BuildPreviewContextMessageParams & {
  target: StudioSelectedTarget;
  extraction: StudioComponentExtraction;
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
    "- If the app uses canvas gameplay collisions or hitboxes, preserve and update window.__studioColliderRegistry so collisionBounds stay authoritative.",
  ].join("\n");

  return {
    role: "user",
    content,
  };
}

export async function buildSelectedComponentContextRequestMessage({
  title,
  code,
  language,
  assets = [],
  target,
  extraction,
}: BuildSelectedComponentContextMessageParams): Promise<ChatRequestMessage> {
  const normalizedLanguage = (language || "tsx").trim() || "tsx";
  const assetManifest =
    assets.length > 0
      ? assets
          .map((asset, index) => buildAssetContextLine(asset, index))
          .join("\n")
      : "None.";

  const targetSummary = [
    `kind: ${target.kind}`,
    `label: ${target.label}`,
    target.tagName ? `tag: ${target.tagName}` : null,
    target.elementId ? `id: ${target.elementId}` : null,
    target.className ? `class: ${target.className}` : null,
    target.domPath ? `domPath: ${target.domPath}` : null,
    target.assetKey ? `assetKey: ${target.assetKey}` : null,
    target.canvasOperation ? `canvasOperation: ${target.canvasOperation}` : null,
    target.canvasPaintMode ? `canvasPaintMode: ${target.canvasPaintMode}` : null,
    target.textPreview ? `text: ${target.textPreview}` : null,
    target.styleHints?.length
      ? `styleHints: ${target.styleHints.join(", ")}`
      : null,
    target.sourceHints.length > 0
      ? `sourceHints: ${target.sourceHints.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const content = [
    `Current app context: "${title || "Untitled App"}".`,
    "",
    "You are updating only the selected component/block from the current app.",
    "Do not rewrite unrelated code or return the full app.",
    "",
    "Selected preview target:",
    targetSummary,
    "",
    "Currently extracted editable block:",
    `- componentName: ${extraction.componentName || "unknown"}`,
    `- matchKind: ${extraction.matchKind}`,
    `- lines: ${extraction.lineStart}-${extraction.lineEnd}`,
    `- reason: ${extraction.reason}`,
    "",
    `\`\`\`${normalizedLanguage}`,
    extraction.snippet.trim(),
    "```",
    "",
    "Full app source of truth:",
    `\`\`\`${normalizedLanguage}`,
    code.trim(),
    "```",
    "",
    "Asset manifest:",
    assetManifest,
    "",
    "Rules:",
    "- Return only the updated selected component/block.",
    "- Preserve all asset placeholders exactly as listed.",
    "- Keep the component/block compatible with the existing app around it.",
    "- Avoid unrelated refactors.",
    "- Preserve and update any existing window.__studioColliderRegistry logic for canvas gameplay entities unless the user explicitly asks to remove it.",
  ].join("\n");

  return {
    role: "user",
    content,
  };
}
