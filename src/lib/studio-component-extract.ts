"use client";

import type {
  StudioComponentExtraction,
  StudioSelectedTarget,
} from "@/lib/studio-edit-types";

const FUNCTION_DECLARATION_REGEX =
  /(?:^|\n)\s*export\s+default\s+function\s+([A-Z]\w*)\s*\(|(?:^|\n)\s*function\s+([A-Z]\w*)\s*\(|(?:^|\n)\s*const\s+([A-Z]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;

function splitLinesWithOffsets(source: string) {
  const lines = source.split("\n");
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  return { lines, offsets };
}

function offsetToLine(offsets: number[], offset: number): number {
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    if (offset >= offsets[index]) return index + 1;
  }
  return 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBalancedBlock(source: string, blockStartOffset: number) {
  const firstBrace = source.indexOf("{", blockStartOffset);
  if (firstBrace < 0) return null;
  let depth = 0;
  let endOffset = -1;

  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endOffset = index + 1;
        break;
      }
    }
  }

  if (endOffset < 0) return null;
  return {
    startOffset: blockStartOffset,
    endOffset,
    snippet: source.slice(blockStartOffset, endOffset),
  };
}

function extractFunctionBlocks(source: string) {
  const matches: Array<{
    componentName: string | null;
    startOffset: number;
    endOffset: number;
    snippet: string;
  }> = [];

  for (const match of source.matchAll(FUNCTION_DECLARATION_REGEX)) {
    const componentName = match[1] || match[2] || match[3] || null;
    const matchIndex = match.index ?? 0;
    const block = extractBalancedBlock(source, matchIndex + (match[0].startsWith("\n") ? 1 : 0));
    if (!block) continue;
    matches.push({
      componentName,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      snippet: block.snippet,
    });
  }

  return matches;
}

function getTagNameCandidates(target: StudioSelectedTarget): string[] {
  const candidates = new Set<string>();
  if (target.tagName) {
    candidates.add(target.tagName.toLowerCase());
  }
  if (target.domPath) {
    const parts = target.domPath.split(">").map((entry) => entry.trim());
    for (const part of parts) {
      const tagMatch = part.match(/^([a-zA-Z0-9_-]+)/);
      if (tagMatch?.[1]) {
        candidates.add(tagMatch[1].toLowerCase());
      }
    }
  }
  return Array.from(candidates);
}

function indexOfTagEnd(source: string, openIndex: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if ((char === '"' || char === "'") && source[index - 1] !== "\\") {
      quote = quote === char ? null : quote ? quote : char;
      continue;
    }
    if (!quote && char === ">") {
      return index;
    }
  }
  return -1;
}

function extractJsxElementRange(
  source: string,
  openIndex: number,
  tagName: string,
): { startOffset: number; endOffset: number } | null {
  const openTagEnd = indexOfTagEnd(source, openIndex);
  if (openTagEnd < 0) return null;

  const openTagText = source.slice(openIndex, openTagEnd + 1);
  if (/\/>$/.test(openTagText.trim())) {
    return {
      startOffset: openIndex,
      endOffset: openTagEnd + 1,
    };
  }

  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tagName)}(?=[\\s>/])`, "g");
  tagPattern.lastIndex = openIndex;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source)) !== null) {
    const tagIndex = match.index;
    const isClosing = source[tagIndex + 1] === "/";
    const tagEnd = indexOfTagEnd(source, tagIndex);
    if (tagEnd < 0) break;
    const tagText = source.slice(tagIndex, tagEnd + 1).trim();
    const isSelfClosing = /\/>$/.test(tagText);

    if (!isClosing) {
      depth += 1;
      if (isSelfClosing) {
        depth -= 1;
      }
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          startOffset: openIndex,
          endOffset: tagEnd + 1,
        };
      }
    }
  }

  return null;
}

function findNarrowJsxMatch(
  source: string,
  target: StudioSelectedTarget,
  matchOffset: number,
): { startOffset: number; endOffset: number; reason: string } | null {
  const tagNames = getTagNameCandidates(target);
  for (const tagName of tagNames) {
    const openTagRegex = new RegExp(`<${escapeRegExp(tagName)}(?=[\\s>/])`, "g");
    const candidates: Array<{ startOffset: number; endOffset: number }> = [];
    let openMatch: RegExpExecArray | null;
    while ((openMatch = openTagRegex.exec(source)) !== null) {
      const range = extractJsxElementRange(source, openMatch.index, tagName);
      if (!range) continue;
      candidates.push(range);
    }

    const containingCandidate = candidates.find(
      (candidate) =>
        matchOffset >= candidate.startOffset && matchOffset <= candidate.endOffset,
    );
    if (containingCandidate) {
      return {
        ...containingCandidate,
        reason: `Focused on the matched <${tagName}> JSX block for the selected target.`,
      };
    }

    if (candidates.length > 0) {
      const nearestCandidate = candidates.reduce((best, current) => {
        const bestDistance = Math.min(
          Math.abs(matchOffset - best.startOffset),
          Math.abs(matchOffset - best.endOffset),
        );
        const currentDistance = Math.min(
          Math.abs(matchOffset - current.startOffset),
          Math.abs(matchOffset - current.endOffset),
        );
        return currentDistance < bestDistance ? current : best;
      });
      return {
        ...nearestCandidate,
        reason: `Focused on the nearest <${tagName}> JSX block for the selected target.`,
      };
    }
  }

  return null;
}

function buildExtractionFromOffsets(
  source: string,
  offsets: number[],
  startOffset: number,
  endOffset: number,
  componentName: string | null,
  matchKind: StudioComponentExtraction["matchKind"],
  reason: string,
): StudioComponentExtraction {
  return {
    componentName,
    matchKind,
    reason,
    snippet: source.slice(startOffset, endOffset).trim(),
    startOffset,
    endOffset,
    lineStart: offsetToLine(offsets, startOffset),
    lineEnd: offsetToLine(offsets, Math.max(endOffset - 1, 0)),
  };
}

function buildSearchTerms(target: StudioSelectedTarget): Array<{
  kind: StudioComponentExtraction["matchKind"];
  value: string;
  reason: string;
}> {
  const terms: Array<{
    kind: StudioComponentExtraction["matchKind"];
    value: string;
    reason: string;
  }> = [];

  if (target.assetKey) {
    terms.push({
      kind: "asset-placeholder",
      value: `__ASSET_${target.assetKey}__`,
      reason: `Matched the selected asset placeholder for ${target.assetKey}.`,
    });
    terms.push({
      kind: "asset-key",
      value: target.assetKey,
      reason: `Matched the selected sprite asset key ${target.assetKey}.`,
    });
  }

  const textValue = (target.textPreview || "").trim();
  if (textValue.length >= 3) {
    terms.push({
      kind: "text",
      value: textValue,
      reason: "Matched visible text from the selected preview node.",
    });
  }

  if (target.canvasOperation) {
    terms.push({
      kind: "canvas-operation",
      value: target.canvasOperation,
      reason: `Matched the selected canvas operation "${target.canvasOperation}".`,
    });
  }

  if (target.elementId) {
    terms.push({
      kind: "id",
      value: target.elementId,
      reason: `Matched the selected target id "${target.elementId}".`,
    });
  }

  const classes = (target.className || "")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3);
  for (const className of classes.slice(0, 3)) {
    terms.push({
      kind: "class",
      value: className,
      reason: `Matched the selected target class "${className}".`,
    });
  }

  if (target.label.length >= 3) {
    terms.push({
      kind: "text",
      value: target.label,
      reason: `Matched the selected target label "${target.label}".`,
    });
  }

  if (target.tagName) {
    terms.push({
      kind: "tag",
      value: `<${target.tagName.toLowerCase()}`,
      reason: `Matched the selected tag name ${target.tagName.toLowerCase()}.`,
    });
  }

  if (target.styleHints?.length) {
    for (const styleHint of target.styleHints.slice(0, 4)) {
      if (styleHint.length < 3) continue;
      terms.push({
        kind: "style",
        value: styleHint,
        reason: `Matched a canvas style hint reported from the preview: ${styleHint}.`,
      });
    }
  }

  if (target.sourceHints.length > 0) {
    for (const hint of target.sourceHints.slice(0, 5)) {
      if (hint.length < 3) continue;
      terms.push({
        kind: "component-name",
        value: hint,
        reason: `Matched a source hint reported from the preview: ${hint}.`,
      });
    }
  }

  return terms;
}

function findBestSearchMatch(source: string, target: StudioSelectedTarget) {
  const searchTerms = buildSearchTerms(target);
  for (const term of searchTerms) {
    const regex = new RegExp(escapeRegExp(term.value), "i");
    const match = regex.exec(source);
    if (!match || match.index === undefined) continue;
    return {
      matchKind: term.kind,
      reason: term.reason,
      offset: match.index,
    };
  }
  return null;
}

export function extractEditableComponentBlock(
  source: string,
  target: StudioSelectedTarget | null,
): StudioComponentExtraction {
  const { lines, offsets } = splitLinesWithOffsets(source);
  const fallbackLineEnd = Math.max(1, lines.length);

  if (!target) {
    return {
      componentName: null,
      matchKind: "fallback",
      reason: "No selected target was available, so the full file is editable.",
      snippet: source,
      startOffset: 0,
      endOffset: source.length,
      lineStart: 1,
      lineEnd: fallbackLineEnd,
    };
  }

  const bestMatch = findBestSearchMatch(source, target);
  const functionBlocks = extractFunctionBlocks(source);

  if (bestMatch) {
    const containingBlock = functionBlocks.find(
      (block) =>
        bestMatch.offset >= block.startOffset && bestMatch.offset <= block.endOffset,
    );
    if (containingBlock) {
      const narrowJsxRange = findNarrowJsxMatch(
        containingBlock.snippet,
        target,
        bestMatch.offset - containingBlock.startOffset,
      );
      if (narrowJsxRange) {
        return buildExtractionFromOffsets(
          source,
          offsets,
          containingBlock.startOffset + narrowJsxRange.startOffset,
          containingBlock.startOffset + narrowJsxRange.endOffset,
          containingBlock.componentName,
          bestMatch.matchKind,
          `${bestMatch.reason} ${narrowJsxRange.reason}`,
        );
      }

      return buildExtractionFromOffsets(
        source,
        offsets,
        containingBlock.startOffset,
        containingBlock.endOffset,
        containingBlock.componentName,
        bestMatch.matchKind,
        `${bestMatch.reason} Falling back to the containing component block.`,
      );
    }

    const lineIndex = offsetToLine(offsets, bestMatch.offset) - 1;
    const startLine = Math.max(0, lineIndex - 8);
    const endLine = Math.min(lines.length, lineIndex + 9);
    const startOffset = offsets[startLine] ?? 0;
    const endOffset =
      endLine >= lines.length ? source.length : (offsets[endLine] ?? source.length);
    return {
      componentName: null,
      matchKind: bestMatch.matchKind,
      reason: `${bestMatch.reason} Falling back to the nearest editable line range.`,
      snippet: source.slice(startOffset, endOffset).trim(),
      startOffset,
      endOffset,
      lineStart: startLine + 1,
      lineEnd: endLine,
    };
  }

  const firstComponentBlock =
    functionBlocks.find((block) => block.componentName === "App") || functionBlocks[0];
  if (firstComponentBlock) {
    return {
      componentName: firstComponentBlock.componentName,
      matchKind: "fallback",
      reason:
        "Studio could not confidently map the selected target to a narrower source block, so the closest component block was chosen.",
      snippet: firstComponentBlock.snippet.trim(),
      startOffset: firstComponentBlock.startOffset,
      endOffset: firstComponentBlock.endOffset,
      lineStart: offsetToLine(offsets, firstComponentBlock.startOffset),
      lineEnd: offsetToLine(offsets, Math.max(firstComponentBlock.endOffset - 1, 0)),
    };
  }

  return {
    componentName: null,
    matchKind: "fallback",
    reason:
      "Studio could not isolate a component boundary, so the full file is editable.",
    snippet: source,
    startOffset: 0,
    endOffset: source.length,
    lineStart: 1,
    lineEnd: fallbackLineEnd,
  };
}
