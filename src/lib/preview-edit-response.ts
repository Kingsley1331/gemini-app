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
  chatContent: string;
  previewCodeBlock: ExtractedPreviewCodeBlock;
};

export const previewEditResponseFormatInstruction = `
13. COMPACT PREVIEW EDIT OUTPUT FORMAT (MANDATORY FOR THIS REQUEST):
   - Return exactly two sections in this exact order using these markers:
     <<CHAT_DIFF>>
     <brief user-facing response with only the changed section, minimal snippet, or patch>
     <<END_CHAT_DIFF>>
     <<FULL_UPDATED_CODE>>
     <one single previewable fenced code block containing the complete updated runnable app>
     <<END_FULL_UPDATED_CODE>>
   - The code inside <<FULL_UPDATED_CODE>> must be the complete updated runnable app.
   - Do NOT include the full app code anywhere inside <<CHAT_DIFF>>.
   - Keep <<CHAT_DIFF>> concise. If the requested edit is small, show only the changed area there.
   - Use the same language as the app for both sections when you include code.
`;

export function normalizePreviewLanguage(language: string): string {
  if (language === "javascript") return "jsx";
  if (language === "typescript") return "tsx";
  return language;
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
  const chatDiffMatch = rawResponse.match(
    /<<CHAT_DIFF>>\s*([\s\S]*?)\s*<<END_CHAT_DIFF>>/i,
  );
  const fullUpdatedCodeMatch = rawResponse.match(
    /<<FULL_UPDATED_CODE>>\s*([\s\S]*?)\s*<<END_FULL_UPDATED_CODE>>/i,
  );

  if (!fullUpdatedCodeMatch) return null;

  const previewCodeBlock = extractLatestPreviewableCodeBlock(fullUpdatedCodeMatch[1] || "");
  if (!previewCodeBlock) return null;

  const chatContent = chatDiffMatch?.[1]?.trim() || "Updated the preview.";

  return {
    chatContent,
    previewCodeBlock,
  };
}
