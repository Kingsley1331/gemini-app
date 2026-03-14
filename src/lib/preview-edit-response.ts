export const PREVIEWABLE_RESPONSE_LANGUAGES = new Set([
  "html",
  "jsx",
  "tsx",
  "javascript",
  "typescript",
]);

export type ExtractedPreviewCodeBlock = {
  language: string;
  code: string;
};

export type ParsedPreviewEditResponse = {
  chatSummary: string;
  chatDiff: string;
  chatContent: string;
  previewCodeBlock: ExtractedPreviewCodeBlock;
};

export const PREVIEW_DIFF_LINE_MARKERS = {
  removed: "-",
  added: "+",
} as const;

export const previewEditResponseFormatInstruction = `
13. COMPACT PREVIEW EDIT OUTPUT FORMAT (MANDATORY FOR THIS REQUEST):
   - Return exactly three sections in this exact order using these markers:
     <<CHAT_SUMMARY>>
     <a short 1-2 sentence plain-English summary of what changed>
     <<END_CHAT_SUMMARY>>
     <<CHAT_DIFF>>
     <a concise unified diff in a single \`\`\`diff fenced block showing only the changed lines>
     <<END_CHAT_DIFF>>
     <<FULL_UPDATED_CODE>>
     <one single previewable fenced code block containing the complete updated runnable app>
     <<END_FULL_UPDATED_CODE>>
   - The code inside <<FULL_UPDATED_CODE>> must be the complete updated runnable app.
   - <<CHAT_SUMMARY>> must always be present and should briefly explain what was changed and why, if relevant.
   - Keep <<CHAT_SUMMARY>> short and do not include code fences inside it.
   - Do NOT include the full app code anywhere inside <<CHAT_DIFF>>.
   - <<CHAT_DIFF>> must be a real unified diff using \`-\` for removed lines and \`+\` for added lines.
   - Keep <<CHAT_DIFF>> concise and include only the minimal surrounding context needed to understand the change.
   - Do not include explanatory prose before or after the diff inside <<CHAT_DIFF>>.
   - Use \`\`\`diff for <<CHAT_DIFF>> and the app's actual language for <<FULL_UPDATED_CODE>>.
`;

export function normalizePreviewLanguage(language: string): string {
  if (language === "javascript") return "jsx";
  if (language === "typescript") return "tsx";
  return language;
}

export function getPreviewDiffSemanticsText(): string {
  return `New code appears with ${PREVIEW_DIFF_LINE_MARKERS.added} additions while the current preview code appears with ${PREVIEW_DIFF_LINE_MARKERS.removed} deletions.`;
}

export function extractLatestPreviewableCodeBlock(
  content: string,
): ExtractedPreviewCodeBlock | null {
  const codeBlockRegex = /```([a-zA-Z0-9_-]+)[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let latestMatch: ExtractedPreviewCodeBlock | null = null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = (match[1] || "").toLowerCase();
    if (!PREVIEWABLE_RESPONSE_LANGUAGES.has(language)) continue;

    latestMatch = {
      language,
      code: (match[2] || "").trim(),
    };
  }

  return latestMatch;
}

export function parsePreviewEditResponse(
  rawResponse: string,
): ParsedPreviewEditResponse | null {
  const chatSummaryMatch = rawResponse.match(
    /<<CHAT_SUMMARY>>\s*([\s\S]*?)\s*<<END_CHAT_SUMMARY>>/i,
  );
  const chatDiffMatch = rawResponse.match(
    /<<CHAT_DIFF>>\s*([\s\S]*?)\s*<<END_CHAT_DIFF>>/i,
  );
  const fullUpdatedCodeMatch = rawResponse.match(
    /<<FULL_UPDATED_CODE>>\s*([\s\S]*?)\s*<<END_FULL_UPDATED_CODE>>/i,
  );

  if (!fullUpdatedCodeMatch) return null;

  const previewCodeBlock = extractLatestPreviewableCodeBlock(fullUpdatedCodeMatch[1] || "");
  if (!previewCodeBlock) return null;

  const chatSummary = chatSummaryMatch?.[1]?.trim() || "Updated the preview.";
  const chatDiff = chatDiffMatch?.[1]?.trim() || "";
  const chatContent = [chatSummary, chatDiff].filter(Boolean).join("\n\n");

  return {
    chatSummary,
    chatDiff,
    chatContent,
    previewCodeBlock,
  };
}
