"use client";

import type { StudioComponentExtraction } from "@/lib/studio-edit-types";

const NAMED_BLOCK_PATTERNS = [
  (name: string) =>
    new RegExp(
      `(?:^|\\n)\\s*export\\s+default\\s+function\\s+${name}\\s*\\(`,
      "g",
    ),
  (name: string) =>
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?function\\s+${name}\\s*\\(`, "g"),
  (name: string) =>
    new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`,
      "g",
    ),
  (name: string) =>
    new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?function\\b[^\\{]*\\{`,
      "g",
    ),
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBalancedBlock(source: string, blockStartOffset: number) {
  const firstBrace = source.indexOf("{", blockStartOffset);
  if (firstBrace < 0) return null;

  let depth = 0;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          startOffset: blockStartOffset,
          endOffset: index + 1,
        };
      }
    }
  }

  return null;
}

function findNamedBlockRange(source: string, componentName: string) {
  const escapedName = escapeRegExp(componentName);

  for (const createPattern of NAMED_BLOCK_PATTERNS) {
    const pattern = createPattern(escapedName);
    const match = pattern.exec(source);
    if (!match || match.index === undefined) continue;

    const blockStartOffset = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const block = extractBalancedBlock(source, blockStartOffset);
    if (block) return block;
  }

  return null;
}

function snippetDeclaresNamedBlock(snippet: string, componentName: string): boolean {
  const escapedName = escapeRegExp(componentName);
  return NAMED_BLOCK_PATTERNS.some((createPattern) => {
    const pattern = createPattern(escapedName);
    const anchored = new RegExp(pattern.source.replace("(?:^|\\n)", "^\\s*"), "i");
    return anchored.test(snippet.trimStart());
  });
}

export function applyComponentPatchToCode(
  source: string,
  extraction: StudioComponentExtraction,
  nextSnippet: string,
): string {
  const sanitizedSnippet = nextSnippet.replace(/\r\n/g, "\n").trim();

  if (
    extraction.componentName &&
    snippetDeclaresNamedBlock(sanitizedSnippet, extraction.componentName)
  ) {
    const namedBlockRange = findNamedBlockRange(source, extraction.componentName);
    if (namedBlockRange) {
      return (
        source.slice(0, namedBlockRange.startOffset) +
        sanitizedSnippet +
        source.slice(namedBlockRange.endOffset)
      );
    }
  }

  return (
    source.slice(0, extraction.startOffset) +
    sanitizedSnippet +
    source.slice(extraction.endOffset)
  );
}
