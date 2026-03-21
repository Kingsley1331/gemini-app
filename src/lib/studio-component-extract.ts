"use client";

import type {
  StudioComponentExtraction,
  StudioSelectedTarget,
} from "@/lib/studio-edit-types";

const FUNCTION_DECLARATION_PATTERNS = [
  /(?:^|\n)\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|\n)\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b[^{]*\{/g,
] as const;

const GENERIC_CANVAS_HINTS = new Set([
  "arc",
  "canvas",
  "drawimage",
  "fill",
  "fill-stroke",
  "line",
  "path",
  "rect",
  "shape",
  "sprite",
  "stroke",
  "text",
]);

const COMMON_CANVAS_TOKENS = [
  "arc",
  "arcTo",
  "beginPath",
  "bezierCurveTo",
  "clearRect",
  "clip",
  "closePath",
  "drawImage",
  "ellipse",
  "fill",
  "fillRect",
  "fillStyle",
  "fillText",
  "font",
  "globalAlpha",
  "lineTo",
  "lineWidth",
  "measureText",
  "moveTo",
  "quadraticCurveTo",
  "rect",
  "restore",
  "rotate",
  "roundRect",
  "save",
  "scale",
  "setTransform",
  "stroke",
  "strokeRect",
  "strokeStyle",
  "strokeText",
  "textAlign",
  "textBaseline",
  "translate",
];

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

  const seenOffsets = new Set<number>();

  for (const pattern of FUNCTION_DECLARATION_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const componentName = match[1] || null;
      const matchIndex = match.index ?? 0;
      const block = extractBalancedBlock(
        source,
        matchIndex + (match[0].startsWith("\n") ? 1 : 0),
      );
      if (!block || seenOffsets.has(block.startOffset)) continue;
      seenOffsets.add(block.startOffset);
      matches.push({
        componentName,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        snippet: block.snippet,
      });
    }
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

type SearchTerm = {
  kind: StudioComponentExtraction["matchKind"];
  value: string;
  reason: string;
  priority: number;
};

function buildSearchTerms(target: StudioSelectedTarget): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const pushTerm = (
    kind: StudioComponentExtraction["matchKind"],
    value: string | undefined | null,
    reason: string,
    priority: number,
  ) => {
    const trimmed = (value || "").trim();
    if (trimmed.length < 3) return;
    terms.push({ kind, value: trimmed, reason, priority });
  };

  const isCanvasTarget =
    target.kind === "canvas-text" ||
    target.kind === "canvas-shape" ||
    target.kind === "sprite";

  if (target.assetKey) {
    pushTerm(
      "asset-placeholder",
      `__ASSET_${target.assetKey}__`,
      `Matched the selected asset placeholder for ${target.assetKey}.`,
      100,
    );
    pushTerm(
      "asset-key",
      target.assetKey,
      `Matched the selected sprite asset key ${target.assetKey}.`,
      96,
    );
  }

  const textValue = (target.textPreview || "").trim();
  if (textValue.length >= 3) {
    pushTerm(
      "text",
      textValue,
      "Matched visible text from the selected preview node.",
      isCanvasTarget ? 95 : 92,
    );
  }

  if (target.elementId) {
    pushTerm(
      "id",
      target.elementId,
      `Matched the selected target id "${target.elementId}".`,
      90,
    );
  }

  const classes = (target.className || "")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3);
  for (const className of classes.slice(0, 3)) {
    pushTerm(
      "class",
      className,
      `Matched the selected target class "${className}".`,
      82,
    );
  }

  if (target.tagName) {
    pushTerm(
      "tag",
      `<${target.tagName.toLowerCase()}`,
      `Matched the selected tag name ${target.tagName.toLowerCase()}.`,
      60,
    );
  }

  if (target.styleHints?.length) {
    for (const styleHint of target.styleHints.slice(0, 4)) {
      pushTerm(
        "style",
        styleHint,
        `Matched a canvas style hint reported from the preview: ${styleHint}.`,
        isCanvasTarget ? 88 : 68,
      );
    }
  }

  if (target.sourceHints.length > 0) {
    for (const hint of target.sourceHints.slice(0, 5)) {
      const normalizedHint = hint.trim().toLowerCase();
      if (
        hint.length < 3 ||
        (target.kind !== "dom" && GENERIC_CANVAS_HINTS.has(normalizedHint))
      ) {
        continue;
      }
      pushTerm(
        "component-name",
        hint,
        `Matched a source hint reported from the preview: ${hint}.`,
        isCanvasTarget ? 86 : 72,
      );
    }
  }

  if (target.label.length >= 3) {
    pushTerm(
      "text",
      target.label,
      `Matched the selected target label "${target.label}".`,
      isCanvasTarget ? 70 : 80,
    );
  }

  if (target.canvasOperation) {
    pushTerm(
      "canvas-operation",
      target.canvasOperation,
      `Matched the selected canvas operation "${target.canvasOperation}".`,
      isCanvasTarget ? 20 : 62,
    );
  }

  return terms;
}

function buildSearchTermsLegacyCompatibility(target: StudioSelectedTarget): Array<{
  kind: StudioComponentExtraction["matchKind"];
  value: string;
  reason: string;
}> {
  return buildSearchTerms(target).map(({ kind, value, reason }) => ({
    kind,
    value,
    reason,
  }));
}

function findBestSearchMatch(source: string, target: StudioSelectedTarget) {
  const searchTerms = buildSearchTerms(target);
  const canvasTokens =
    target.kind === "canvas-text" ||
    target.kind === "canvas-shape" ||
    target.kind === "sprite"
      ? buildCanvasSearchTokens(target)
      : [];

  let bestMatch:
    | {
        matchKind: StudioComponentExtraction["matchKind"];
        reason: string;
        offset: number;
        score: number;
        termLength: number;
      }
    | null = null;

  for (const term of searchTerms) {
    const regex = new RegExp(escapeRegExp(term.value), "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      if (match.index === undefined) continue;
      let score = term.priority * 1000 + Math.min(term.value.length, 120);

      if (canvasTokens.length > 0) {
        const context = source
          .slice(Math.max(0, match.index - 240), Math.min(source.length, match.index + 240))
          .toLowerCase();
        const uniqueNearbyTokenHits = canvasTokens.filter((token) =>
          context.includes(token),
        ).length;
        score += uniqueNearbyTokenHits * 40;
        if (target.canvasOperation && context.includes(target.canvasOperation.toLowerCase())) {
          score += 20;
        }
      }

      if (
        !bestMatch ||
        score > bestMatch.score ||
        (score === bestMatch.score && term.value.length > bestMatch.termLength)
      ) {
        bestMatch = {
          matchKind: term.kind,
          reason: term.reason,
          offset: match.index,
          score,
          termLength: term.value.length,
        };
      }
    }
  }

  if (!bestMatch) {
    const fallbackTerms = buildSearchTermsLegacyCompatibility(target);
    for (const term of fallbackTerms) {
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

  return {
    matchKind: bestMatch.matchKind,
    reason: bestMatch.reason,
    offset: bestMatch.offset,
  };
}

function normalizeCanvasToken(value: string | undefined | null): string | null {
  const trimmed = (value || "").trim();
  if (trimmed.length < 2) return null;
  return trimmed.toLowerCase();
}

function buildCanvasSearchTokens(target: StudioSelectedTarget): string[] {
  const tokens = new Set<string>();
  const pushToken = (value: string | undefined | null) => {
    const normalized = normalizeCanvasToken(value);
    if (!normalized || GENERIC_CANVAS_HINTS.has(normalized)) return;
    tokens.add(normalized);
  };

  pushToken(target.canvasOperation);
  pushToken(target.textPreview);

  if (target.label && !/^canvas\s+(shape|text|target|rect|path)$/i.test(target.label)) {
    pushToken(target.label);
  }

  if (target.assetKey) {
    pushToken(target.assetKey);
  }

  for (const hint of target.styleHints || []) {
    pushToken(hint);
    const valuePortion = hint.split(":").slice(1).join(":").trim();
    pushToken(valuePortion);
  }

  for (const hint of target.sourceHints || []) {
    pushToken(hint);
  }

  return Array.from(tokens);
}

function lineContainsCanvasToken(line: string, token: string): boolean {
  return line.toLowerCase().includes(token);
}

function isCanvasRelevantLine(
  line: string,
  target: StudioSelectedTarget,
  tokens: string[],
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (
    target.canvasOperation &&
    lineContainsCanvasToken(line, target.canvasOperation.toLowerCase())
  ) {
    return true;
  }

  if (tokens.some((token) => lineContainsCanvasToken(line, token))) {
    return true;
  }

  return COMMON_CANVAS_TOKENS.some((token) => line.includes(token));
}

function isCanvasSupportLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  return (
    COMMON_CANVAS_TOKENS.some((token) => line.includes(token)) ||
    /\b(?:const|let|var)\b/.test(trimmed) ||
    /\b(?:ctx|context|canvas)\b/.test(trimmed) ||
    /[([{,]\s*$/.test(trimmed)
  );
}

function findCanvasStatementRange(
  source: string,
  target: StudioSelectedTarget,
  matchOffset: number,
): { startOffset: number; endOffset: number; reason: string } | null {
  const { lines, offsets } = splitLinesWithOffsets(source);
  if (lines.length === 0) return null;

  const tokens = buildCanvasSearchTokens(target);
  const lineIndex = Math.max(0, offsetToLine(offsets, matchOffset) - 1);
  let startLine = lineIndex;
  let endLine = lineIndex;

  for (let steps = 0; startLine > 0 && steps < 8; steps += 1) {
    const previousLine = lines[startLine - 1];
    if (!previousLine.trim()) break;
    if (
      isCanvasRelevantLine(previousLine, target, tokens) ||
      isCanvasSupportLine(previousLine)
    ) {
      startLine -= 1;
      continue;
    }
    break;
  }

  for (let steps = 0; endLine < lines.length - 1 && steps < 10; steps += 1) {
    const nextLine = lines[endLine + 1];
    if (!nextLine.trim()) break;
    if (isCanvasRelevantLine(nextLine, target, tokens) || isCanvasSupportLine(nextLine)) {
      endLine += 1;
      continue;
    }
    break;
  }

  const startOffset = offsets[startLine] ?? 0;
  const endOffset =
    endLine + 1 >= lines.length ? source.length : (offsets[endLine + 1] ?? source.length);

  if (endOffset <= startOffset) return null;

  return {
    startOffset,
    endOffset,
    reason:
      "Focused on the nearest canvas drawing statements and supporting style setup for the selected target.",
  };
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
      if (target.kind === "canvas-text" || target.kind === "canvas-shape") {
        const canvasStatementRange = findCanvasStatementRange(
          containingBlock.snippet,
          target,
          bestMatch.offset - containingBlock.startOffset,
        );
        if (canvasStatementRange) {
          return buildExtractionFromOffsets(
            source,
            offsets,
            containingBlock.startOffset + canvasStatementRange.startOffset,
            containingBlock.startOffset + canvasStatementRange.endOffset,
            containingBlock.componentName,
            bestMatch.matchKind,
            `${bestMatch.reason} ${canvasStatementRange.reason}`,
          );
        }
      }

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

    const canvasStatementRange =
      target.kind === "canvas-text" || target.kind === "canvas-shape"
        ? findCanvasStatementRange(source, target, bestMatch.offset)
        : null;
    const lineIndex = offsetToLine(offsets, bestMatch.offset) - 1;
    const startLine =
      canvasStatementRange ? offsetToLine(offsets, canvasStatementRange.startOffset) - 1 : Math.max(0, lineIndex - 8);
    const endLine = canvasStatementRange
      ? offsetToLine(offsets, Math.max(canvasStatementRange.endOffset - 1, 0))
      : Math.min(lines.length, lineIndex + 9);
    const startOffset = canvasStatementRange?.startOffset ?? (offsets[startLine] ?? 0);
    const endOffset =
      canvasStatementRange?.endOffset ??
      (endLine >= lines.length ? source.length : (offsets[endLine] ?? source.length));
    return {
      componentName: null,
      matchKind: bestMatch.matchKind,
      reason: canvasStatementRange
        ? `${bestMatch.reason} ${canvasStatementRange.reason}`
        : `${bestMatch.reason} Falling back to the nearest editable line range.`,
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
