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

export type ParsedComponentEditResponse = {
  chatSummary: string;
  chatDiff: string;
  chatContent: string;
  componentCodeBlock: ExtractedPreviewCodeBlock;
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

export const componentEditResponseFormatInstruction = `
14. COMPONENT EDIT OUTPUT FORMAT (MANDATORY FOR THIS REQUEST):
   - Return exactly three sections in this exact order using these markers:
     <<CHAT_SUMMARY>>
     <a short 1-2 sentence plain-English summary of what changed>
     <<END_CHAT_SUMMARY>>
     <<CHAT_DIFF>>
     <a concise unified diff in a single \`\`\`diff fenced block showing only the changed lines inside the selected component/block>
     <<END_CHAT_DIFF>>
     <<UPDATED_COMPONENT>>
     <one single fenced code block containing only the updated selected component/block>
     <<END_UPDATED_COMPONENT>>
   - The code inside <<UPDATED_COMPONENT>> must contain only the updated selected component or selected editable block, not the whole app.
   - Preserve the original component/block language.
   - <<CHAT_SUMMARY>> must always be present and should briefly explain what changed and why, if relevant.
   - Do NOT include the full app code anywhere in the response.
`;

export function normalizePreviewLanguage(language: string): string {
  if (language === "javascript") return "jsx";
  if (language === "typescript") return "tsx";
  return language;
}

export function getPreviewDiffSemanticsText(): string {
  return `New code appears with ${PREVIEW_DIFF_LINE_MARKERS.added} additions while the current preview code appears with ${PREVIEW_DIFF_LINE_MARKERS.removed} deletions.`;
}

function normalizeResponseCodeLanguage(
  language: string | undefined,
  preferredLanguage?: string,
): string | null {
  const rawLanguage = (language || "").trim().toLowerCase();
  const alias =
    rawLanguage === "js"
      ? "javascript"
      : rawLanguage === "ts"
        ? "typescript"
        : rawLanguage;

  if (alias && PREVIEWABLE_RESPONSE_LANGUAGES.has(alias)) {
    return alias;
  }

  if (rawLanguage) {
    return null;
  }

  const preferred = (preferredLanguage || "").trim().toLowerCase();
  return PREVIEWABLE_RESPONSE_LANGUAGES.has(preferred) ? preferred : null;
}

function buildFallbackSummary(rawResponse: string, fallback: string): string {
  const cleaned = rawResponse
    .replace(/<<[^>]+>>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || fallback;
}

function inferCodeBlockFromRawResponse(
  rawResponse: string,
  preferredLanguage?: string,
): ExtractedPreviewCodeBlock | null {
  if (/```/.test(rawResponse)) return null;

  const normalizedLanguage = normalizeResponseCodeLanguage("", preferredLanguage);
  if (!normalizedLanguage) return null;

  const trimmed = rawResponse.trim();
  if (!trimmed) return null;

  if (
    /<<CHAT_|<<UPDATED_|<<FULL_UPDATED_CODE>>|<<END_/i.test(trimmed) ||
    /^(summary|diff)\s*:/im.test(trimmed)
  ) {
    return null;
  }

  const looksLikeCode =
    /(?:^|\n)\s*(?:export\s+default|export\s+const|function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|return\s*\(|<\w+|ctx\.\w+|canvas\.\w+)/.test(
      trimmed,
    );

  if (!looksLikeCode) return null;

  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const codeLikeLineCount = lines.filter((line) =>
    /^(?:[{});]|\)|<[/A-Za-z]|(?:export\s+default|export\s+const|function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|return\b|if\b|for\b|while\b|switch\b|ctx\.|canvas\.|use[A-Z]\w*\())/.test(
      line,
    ),
  ).length;
  if (lines.length > 0 && codeLikeLineCount / lines.length < 0.6) {
    return null;
  }

  return {
    language: normalizedLanguage,
    code: trimmed,
  };
}

export function extractLatestPreviewableCodeBlock(
  content: string,
  preferredLanguage?: string,
): ExtractedPreviewCodeBlock | null {
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let latestMatch: ExtractedPreviewCodeBlock | null = null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = normalizeResponseCodeLanguage(match[1] || "", preferredLanguage);
    if (!language) continue;

    latestMatch = {
      language,
      code: (match[2] || "").trim(),
    };
  }

  return latestMatch;
}

export function parsePreviewEditResponse(
  rawResponse: string,
  preferredLanguage?: string,
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

  const previewCodeBlock =
    extractLatestPreviewableCodeBlock(fullUpdatedCodeMatch?.[1] || "", preferredLanguage) ||
    extractLatestPreviewableCodeBlock(rawResponse, preferredLanguage) ||
    inferCodeBlockFromRawResponse(rawResponse, preferredLanguage);
  if (!previewCodeBlock) return null;

  const chatSummary =
    chatSummaryMatch?.[1]?.trim() || buildFallbackSummary(rawResponse, "Updated the preview.");
  const chatDiff = chatDiffMatch?.[1]?.trim() || "";
  const chatContent = [chatSummary, chatDiff].filter(Boolean).join("\n\n");

  return {
    chatSummary,
    chatDiff,
    chatContent,
    previewCodeBlock,
  };
}

export function parseComponentEditResponse(
  rawResponse: string,
  preferredLanguage?: string,
): ParsedComponentEditResponse | null {
  const chatSummaryMatch = rawResponse.match(
    /<<CHAT_SUMMARY>>\s*([\s\S]*?)\s*<<END_CHAT_SUMMARY>>/i,
  );
  const chatDiffMatch = rawResponse.match(
    /<<CHAT_DIFF>>\s*([\s\S]*?)\s*<<END_CHAT_DIFF>>/i,
  );
  const updatedComponentMatch = rawResponse.match(
    /<<UPDATED_COMPONENT>>\s*([\s\S]*?)\s*<<END_UPDATED_COMPONENT>>/i,
  );

  const componentCodeBlock =
    extractLatestPreviewableCodeBlock(
      updatedComponentMatch?.[1] || "",
      preferredLanguage,
    ) ||
    extractLatestPreviewableCodeBlock(rawResponse, preferredLanguage) ||
    inferCodeBlockFromRawResponse(rawResponse, preferredLanguage);
  if (!componentCodeBlock) return null;

  const chatSummary =
    chatSummaryMatch?.[1]?.trim() ||
    buildFallbackSummary(rawResponse, "Updated the component.");
  const chatDiff = chatDiffMatch?.[1]?.trim() || "";
  const chatContent = [chatSummary, chatDiff].filter(Boolean).join("\n\n");

  return {
    chatSummary,
    chatDiff,
    chatContent,
    componentCodeBlock,
  };
}
