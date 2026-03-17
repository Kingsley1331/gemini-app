"use client";

import type { StudioComponentExtraction } from "@/lib/studio-edit-types";

export function applyComponentPatchToCode(
  source: string,
  extraction: StudioComponentExtraction,
  nextSnippet: string,
): string {
  const sanitizedSnippet = nextSnippet.replace(/\r\n/g, "\n").trim();
  return (
    source.slice(0, extraction.startOffset) +
    sanitizedSnippet +
    source.slice(extraction.endOffset)
  );
}
