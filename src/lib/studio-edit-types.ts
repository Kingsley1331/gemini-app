"use client";

export type StudioEditTargetKind =
  | "dom"
  | "sprite"
  | "canvas-text"
  | "canvas-shape";
export type StudioEditPanel = "code" | "ai" | "asset";
export type StudioGenerationMode = "component" | "asset";
export type StudioCanvasPaintMode = "fill" | "stroke" | "fill-stroke";

export type StudioRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StudioSelectedTarget = {
  id: string;
  kind: StudioEditTargetKind;
  label: string;
  tagName?: string;
  elementId?: string;
  className?: string;
  textPreview?: string;
  domPath?: string;
  assetKey?: string;
  assetUrl?: string;
  canvasOperation?: string;
  canvasPaintMode?: StudioCanvasPaintMode;
  styleHints?: string[];
  bounds: StudioRect;
  collisionBounds?: StudioRect | null;
  sourceHints: string[];
};

export type StudioComponentMatchKind =
  | "asset-placeholder"
  | "asset-key"
  | "text"
  | "id"
  | "class"
  | "tag"
  | "canvas-operation"
  | "style"
  | "component-name"
  | "fallback";

export type StudioComponentExtraction = {
  componentName: string | null;
  matchKind: StudioComponentMatchKind;
  reason: string;
  snippet: string;
  startOffset: number;
  endOffset: number;
  lineStart: number;
  lineEnd: number;
};

export type StudioEditUiState = {
  isEnabled: boolean;
  isPaused: boolean;
  hoveredTarget: StudioSelectedTarget | null;
  selectedTarget: StudioSelectedTarget | null;
  activePanel: StudioEditPanel | null;
  codePanelWidth: number;
  aiPanelWidth: number;
  componentDraft: string;
  aiPrompt: string;
  generatedComponent: string;
  generatedSummary: string;
  generationMode: StudioGenerationMode | null;
};

export const DEFAULT_STUDIO_EDIT_UI_STATE: StudioEditUiState = {
  isEnabled: false,
  isPaused: false,
  hoveredTarget: null,
  selectedTarget: null,
  activePanel: null,
  codePanelWidth: 420,
  aiPanelWidth: 380,
  componentDraft: "",
  aiPrompt: "",
  generatedComponent: "",
  generatedSummary: "",
  generationMode: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeStudioRect(value: unknown): StudioRect | null {
  if (!isRecord(value)) return null;
  const left = toNumber(value.left);
  const top = toNumber(value.top);
  const width = toNumber(value.width);
  const height = toNumber(value.height);
  if (left === null || top === null || width === null || height === null) {
    return null;
  }
  return { left, top, width, height };
}

export function normalizeStudioSelectedTarget(
  value: unknown,
): StudioSelectedTarget | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (
    value.kind !== "dom" &&
    value.kind !== "sprite" &&
    value.kind !== "canvas-text" &&
    value.kind !== "canvas-shape"
  ) {
    return null;
  }
  const bounds = normalizeStudioRect(value.bounds);
  if (!bounds) return null;

  return {
    id: value.id,
    kind: value.kind,
    label:
      typeof value.label === "string" && value.label.trim()
        ? value.label
        : value.kind === "sprite"
          ? "Sprite"
          : value.kind === "canvas-text"
            ? "Canvas text"
            : value.kind === "canvas-shape"
              ? "Canvas shape"
          : "Element",
    tagName: typeof value.tagName === "string" ? value.tagName : undefined,
    elementId: typeof value.elementId === "string" ? value.elementId : undefined,
    className: typeof value.className === "string" ? value.className : undefined,
    textPreview:
      typeof value.textPreview === "string" ? value.textPreview : undefined,
    domPath: typeof value.domPath === "string" ? value.domPath : undefined,
    assetKey: typeof value.assetKey === "string" ? value.assetKey : undefined,
    assetUrl: typeof value.assetUrl === "string" ? value.assetUrl : undefined,
    canvasOperation:
      typeof value.canvasOperation === "string" ? value.canvasOperation : undefined,
    canvasPaintMode:
      value.canvasPaintMode === "fill" ||
      value.canvasPaintMode === "stroke" ||
      value.canvasPaintMode === "fill-stroke"
        ? value.canvasPaintMode
        : undefined,
    styleHints: Array.isArray(value.styleHints)
      ? value.styleHints.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [],
    bounds,
    collisionBounds: normalizeStudioRect(value.collisionBounds),
    sourceHints: Array.isArray(value.sourceHints)
      ? value.sourceHints.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [],
  };
}

export function areStudioRectsEqual(
  left: StudioRect | null | undefined,
  right: StudioRect | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function areStudioSelectedTargetsEqual(
  left: StudioSelectedTarget | null | undefined,
  right: StudioSelectedTarget | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.tagName === right.tagName &&
    left.elementId === right.elementId &&
    left.className === right.className &&
    left.textPreview === right.textPreview &&
    left.domPath === right.domPath &&
    left.assetKey === right.assetKey &&
    left.assetUrl === right.assetUrl &&
    left.canvasOperation === right.canvasOperation &&
    left.canvasPaintMode === right.canvasPaintMode &&
    (left.styleHints || []).join("\n") === (right.styleHints || []).join("\n") &&
    areStudioRectsEqual(left.bounds, right.bounds) &&
    areStudioRectsEqual(left.collisionBounds, right.collisionBounds) &&
    left.sourceHints.join("\n") === right.sourceHints.join("\n")
  );
}

export function areStudioEditUiStatesEqual(
  left: StudioEditUiState | null | undefined,
  right: StudioEditUiState | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  return (
    left.isEnabled === right.isEnabled &&
    left.isPaused === right.isPaused &&
    areStudioSelectedTargetsEqual(left.hoveredTarget, right.hoveredTarget) &&
    areStudioSelectedTargetsEqual(left.selectedTarget, right.selectedTarget) &&
    left.activePanel === right.activePanel &&
    left.codePanelWidth === right.codePanelWidth &&
    left.aiPanelWidth === right.aiPanelWidth &&
    left.componentDraft === right.componentDraft &&
    left.aiPrompt === right.aiPrompt &&
    left.generatedComponent === right.generatedComponent &&
    left.generatedSummary === right.generatedSummary &&
    left.generationMode === right.generationMode
  );
}

export function normalizeStudioEditUiState(value: unknown): StudioEditUiState | null {
  if (!isRecord(value)) return null;

  return {
    isEnabled: value.isEnabled === true,
    isPaused: value.isPaused === true,
    hoveredTarget: normalizeStudioSelectedTarget(value.hoveredTarget),
    selectedTarget: normalizeStudioSelectedTarget(value.selectedTarget),
    activePanel:
      value.activePanel === "code" ||
      value.activePanel === "ai" ||
      value.activePanel === "asset"
        ? value.activePanel
        : null,
    codePanelWidth:
      typeof value.codePanelWidth === "number" && Number.isFinite(value.codePanelWidth)
        ? value.codePanelWidth
        : DEFAULT_STUDIO_EDIT_UI_STATE.codePanelWidth,
    aiPanelWidth:
      typeof value.aiPanelWidth === "number" && Number.isFinite(value.aiPanelWidth)
        ? value.aiPanelWidth
        : DEFAULT_STUDIO_EDIT_UI_STATE.aiPanelWidth,
    componentDraft:
      typeof value.componentDraft === "string" ? value.componentDraft : "",
    aiPrompt: typeof value.aiPrompt === "string" ? value.aiPrompt : "",
    generatedComponent:
      typeof value.generatedComponent === "string" ? value.generatedComponent : "",
    generatedSummary:
      typeof value.generatedSummary === "string" ? value.generatedSummary : "",
    generationMode:
      value.generationMode === "component" || value.generationMode === "asset"
        ? value.generationMode
        : null,
  };
}
