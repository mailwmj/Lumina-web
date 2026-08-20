import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, useStore, useUpdateNodeInternals } from '@xyflow/react';
import { Loader2, Minus, Plus, Sparkles, Wand2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type ImageSize,
  type StoryboardRatioControlMode,
  type StoryboardGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  canvasAiGateway,
  graphImageResolver,
} from '@/features/canvas/application/canvasServices';
import { polishText } from '@/features/canvas/infrastructure/textPolishService';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  detectAspectRatio,
  parseAspectRatio,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import {
  sanitizeStoryboardPromptText,
  sanitizeStoryboardText,
} from '@/features/canvas/application/storyboardText';
import {
  findReferenceTokens,
  insertReferenceToken,
  removeTextRange,
  resolveReferenceAwareDeleteRange,
  type ReferenceTokenMatch,
} from '@/features/canvas/application/referenceTokenEditing';
import {
  IMAGE_GENERATION_ASPECT_RATIO_OPTIONS,
  IMAGE_GENERATION_RESOLUTION_OPTIONS,
  getModelProvider,
  listConfiguredImageModels,
  pickClosestImageGenerationAspectRatio,
  resolveImageGenerationResolution,
  resolveConfiguredImageModel,
  UNCONFIGURED_IMAGE_MODEL,
} from '@/features/canvas/models';
import { ModelParamsControls } from '@/features/canvas/ui/ModelParamsControls';
import { resolveImageProviderRuntime } from '@/features/canvas/application/imageProviderRuntime';
import { resolveTextModelSelection } from '@/features/canvas/application/textModelSelection';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import {
  UiButton,
  UiTooltip,
} from '@/components/ui';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_FOOTER_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_MODEL_CHIP_CLASS,
  NODE_CONTROL_PARAMS_CHIP_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { openSettingsDialog } from '@/features/settings/settingsEvents';

type StoryboardGenNodeProps = {
  id: string;
  data: StoryboardGenNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

interface AspectRatioChoice {
  value: string;
  label: string;
}

interface PickerAnchor {
  left: number;
  top: number;
}

const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };

const STORYBOARD_NODE_HORIZONTAL_PADDING_PX = 24;
const STORYBOARD_GRID_GAP_PX = 2;
const STORYBOARD_GRID_BASE_CELL_HEIGHT_PX = 78;
const STORYBOARD_GRID_MAX_WIDTH_PX = 320;
const STORYBOARD_CONTROL_ROW_WIDTH_PX = 274;
const STORYBOARD_PARAMS_ROW_WIDTH_PX = 350; // Must fit ModelParamsControls min-width (300px) + some margin
const STORYBOARD_GEN_NODE_MIN_WIDTH_PX = 380; // Must fit ModelParamsControls minimum width
const STORYBOARD_GEN_NODE_MIN_HEIGHT_PX = 380; // Increased to fit all components including 3-row global prompt
const STORYBOARD_GLOBAL_PROMPT_HEIGHT_PX = 54; // 3 rows * ~13px line height + padding
const STORYBOARD_GLOBAL_PROMPT_MARGIN_PX = 8; // mb-2 = 0.5rem = 8px
const GRID_CONTROL_CONTAINER_CLASS = 'flex h-5 items-center gap-0.5 rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-1';
const GRID_CONTROL_LABEL_CLASS = 'text-[9px] text-text-muted';
const GRID_CONTROL_BUTTON_CLASS = 'flex h-3 w-3 items-center justify-center rounded text-text-muted transition-colors hover:bg-[var(--ui-hover)] hover:text-text-dark';
const GRID_CONTROL_ICON_CLASS = 'h-1.5 w-1.5';
const GRID_CONTROL_VALUE_CLASS = 'min-w-[14px] text-center text-[9px] font-semibold text-text-dark';
const GRID_SUMMARY_CLASS = 'flex h-5 items-center rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-1.5 font-mono text-[9px] text-text-muted';
const FRAME_GRID_GAP_PX = 2;
const CONTROL_ROW_HEIGHT_PX = 20;
const CONTROL_ROW_MARGIN_BOTTOM_PX = 10;
const FRAME_GRID_MARGIN_BOTTOM_PX = 8;
const PARAM_ROW_HEIGHT_PX = 20;
const NODE_VERTICAL_PADDING_PX = 24;
// The p-3 storyboard card leaves 9px more below its centered 24px buttons
// than the p-2 generation cards. Pull the shared footer into that padding so
// every model row keeps the same measured 8px button-to-border inset.
const STORYBOARD_FOOTER_BOTTOM_OFFSET_PX = 9;
const FRAME_CELL_MIN_WIDTH_PX = 24;
const FRAME_CELL_MIN_HEIGHT_PX = 16;
const GRID_LINE_THICKNESS_PERCENT = 0.4;
const RATIO_CONTROL_MODE_BUTTON_CLASS =
  'flex h-5 items-center rounded-full border px-1.5 text-[9px] transition-colors';
const FRIENDLY_ASPECT_RATIO_CANDIDATES = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '21:9',
  '9:21',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
];

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number,
  zoom: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  return {
    left: Math.max(0, (textareaRect.left - containerRect.left) / safeZoom + caretOffset.left),
    top: Math.max(0, (textareaRect.top - containerRect.top) / safeZoom + caretOffset.top),
  };
}

function resolvePointerAnchor(
  container: HTMLDivElement | null,
  clientX: number,
  clientY: number,
  zoom: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  return {
    left: Math.max(0, (clientX - containerRect.left) / safeZoom),
    top: Math.max(0, (clientY - containerRect.top) / safeZoom),
  };
}

function resolveReferenceIndexFromDescription(
  description: string,
  maxImageCount: number
): number | null {
  const firstReference = findReferenceTokens(description, maxImageCount)[0];
  if (!firstReference) {
    return null;
  }

  return firstReference.value - 1;
}

interface FrameDescriptionHighlightSpanProps {
  token: ReferenceTokenMatch;
  imageUrl?: string;
}

function FrameDescriptionHighlightSpan({ token, imageUrl }: FrameDescriptionHighlightSpanProps) {
  return (
    <span
      data-highlight-ref="true"
      data-image-url={imageUrl || ''}
      data-index={token.value}
      className="pointer-events-auto relative z-0 cursor-default text-[var(--accent-foreground)] before:absolute before:-inset-x-[4px] before:-inset-y-[1px] before:-z-10 before:rounded-[7px] before:bg-accent/85 before:content-['']"
    >
      {token.token}
    </span>
  );
}

function renderFrameDescriptionWithHighlights(
  description: string,
  maxImageCount: number,
  imageUrls?: string[]
): ReactNode {
  if (!description) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(description, maxImageCount);
  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{description.slice(lastIndex, matchStart)}</span>
      );
    }

    const imageUrl = imageUrls && imageUrls[token.value - 1] ? imageUrls[token.value - 1] : undefined;
    segments.push(
      <FrameDescriptionHighlightSpan
        key={`ref-${matchStart}`}
        token={token}
        imageUrl={imageUrl}
      />
    );

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < description.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{description.slice(lastIndex)}</span>);
  }

  return segments;
}

function buildFrameDescriptionDrafts(
  frames: StoryboardGenNodeData['frames']
): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const frame of frames) {
    drafts[frame.id] = frame.description;
  }
  return drafts;
}

function areFrameDescriptionDraftsEqual(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }

  return true;
}

type GridStepperControlProps = {
  label: string;
  value: number;
  onDecrease: () => void;
  onIncrease: () => void;
};

function GridStepperControl({
  label,
  value,
  onDecrease,
  onIncrease,
}: GridStepperControlProps) {
  const { t } = useTranslation();
  const decreaseLabel = t('common.decrease', { name: label });
  const increaseLabel = t('common.increase', { name: label });

  return (
    <div className={GRID_CONTROL_CONTAINER_CLASS}>
      <span className={GRID_CONTROL_LABEL_CLASS}>{label}</span>
      <UiTooltip content={decreaseLabel}>
        <button
          type="button"
          aria-label={decreaseLabel}
          className={GRID_CONTROL_BUTTON_CLASS}
          onClick={(event) => {
            event.stopPropagation();
            onDecrease();
          }}
        >
          <Minus className={GRID_CONTROL_ICON_CLASS} />
        </button>
      </UiTooltip>
      <span className={GRID_CONTROL_VALUE_CLASS}>{value}</span>
      <UiTooltip content={increaseLabel}>
        <button
          type="button"
          aria-label={increaseLabel}
          className={GRID_CONTROL_BUTTON_CLASS}
          onClick={(event) => {
            event.stopPropagation();
            onIncrease();
          }}
        >
          <Plus className={GRID_CONTROL_ICON_CLASS} />
        </button>
      </UiTooltip>
    </div>
  );
}

function ratioValueToAspectRatioString(ratioValue: number): string {
  if (!Number.isFinite(ratioValue) || ratioValue <= 0) {
    return DEFAULT_ASPECT_RATIO;
  }

  const scaledWidth = Math.max(1, Math.round(ratioValue * 1000));
  const scaledHeight = 1000;
  const gcd = (left: number, right: number): number => {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b !== 0) {
      const temp = b;
      b = a % b;
      a = temp;
    }
    return a || 1;
  };

  const divisor = gcd(scaledWidth, scaledHeight);
  return `${Math.round(scaledWidth / divisor)}:${Math.round(scaledHeight / divisor)}`;
}

function pickClosestAspectRatioFromCandidates(
  targetRatio: number,
  candidates: readonly string[]
): string {
  let closest = candidates[0] ?? DEFAULT_ASPECT_RATIO;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(Math.log(parseAspectRatio(candidate) / targetRatio));
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

function formatFriendlyAspectRatio(ratioValue: number): string {
  if (!Number.isFinite(ratioValue) || ratioValue <= 0) {
    return DEFAULT_ASPECT_RATIO;
  }

  const snapped = pickClosestAspectRatioFromCandidates(
    ratioValue,
    FRIENDLY_ASPECT_RATIO_CANDIDATES
  );
  const snappedValue = parseAspectRatio(snapped);
  const snapDistance = Math.abs(Math.log(snappedValue / ratioValue));
  if (snapDistance <= Math.log(1.04)) {
    return snapped;
  }

  if (ratioValue >= 1) {
    return `${ratioValue.toFixed(2)}:1`;
  }

  return `1:${(1 / ratioValue).toFixed(2)}`;
}

function resolveStoryboardAspectRatios(
  mode: StoryboardRatioControlMode,
  controlRatioValue: number,
  rows: number,
  cols: number
): {
  cellRatioValue: number;
  overallRatioValue: number;
  cellAspectRatio: string;
  overallAspectRatio: string;
  cellAspectRatioLabel: string;
  overallAspectRatioLabel: string;
} {
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const safeControl = Number.isFinite(controlRatioValue) && controlRatioValue > 0
    ? controlRatioValue
    : 1;

  const cellRatioValue = mode === 'cell'
    ? safeControl
    : safeControl * (safeRows / safeCols);
  const overallRatioValue = mode === 'overall'
    ? safeControl
    : safeControl * (safeCols / safeRows);

  return {
    cellRatioValue,
    overallRatioValue,
    cellAspectRatio: ratioValueToAspectRatioString(cellRatioValue),
    overallAspectRatio: ratioValueToAspectRatioString(overallRatioValue),
    cellAspectRatioLabel: formatFriendlyAspectRatio(cellRatioValue),
    overallAspectRatioLabel: formatFriendlyAspectRatio(overallRatioValue),
  };
}

function generateFrameId(): string {
  return `frame-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function toCssAspectRatio(aspectRatio: string): string {
  const [width = '1', height = '1'] = aspectRatio.split(':');
  return `${width} / ${height}`;
}

/**
 * 将 ImageSize 解析为像素宽度
 */
function resolveSizeToPixels(size: string): number {
  const sizeMap: Record<string, number> = {
    '0.5K': 512,
    '1K': 1024,
    '2K': 2048,
    '4K': 4096,
  };
  return sizeMap[size] ?? 1024;
}

/**
 * 生成网格图片的 dataURL
 * 根据用户设置的分辨率、行列数和比例生成白底黑线的网格图
 * 用于帮助 API 更好地生成分镜
 */
function generateGridImageDataUrl(
  aspectRatio: string,
  rows: number,
  cols: number,
  resolution: string,
  lineThicknessPercent: number = GRID_LINE_THICKNESS_PERCENT
): string {
  const [ratioW = '16', ratioH = '9'] = aspectRatio.split(':');
  const ratioWNum = parseFloat(ratioW);
  const ratioHNum = parseFloat(ratioH);

  // 根据分辨率计算画布的总像素尺寸
  const totalPixels = resolveSizeToPixels(resolution);

  // 根据比例计算画布的实际宽高
  // 宽度 = 总像素，高度根据比例计算
  const canvasWidth = totalPixels;
  const canvasHeight = Math.round(totalPixels * (ratioHNum / ratioWNum));
  const thickness = Math.max(
    1,
    Math.round((Math.min(canvasWidth, canvasHeight) * lineThicknessPercent) / 100)
  );

  // 计算单个格子的像素尺寸
  const cellWidth = canvasWidth / cols;
  const cellHeight = canvasHeight / rows;

  // 创建 canvas 并绘制
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to create canvas context');
  }

  // 白色背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 黑色线条
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = thickness;

  // 绘制内部垂直线 (不包含最左边和最右边)
  for (let i = 1; i < cols; i++) {
    const x = i * cellWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
  }

  // 绘制内部水平线 (不包含最上边和最下边)
  for (let i = 1; i < rows; i++) {
    const y = i * cellHeight;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasWidth, y);
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}

export const StoryboardGenNode = memo(({ id, data, selected, width, height }: StoryboardGenNodeProps) => {
  const { t } = useTranslation();
  const zoom = useStore((state) => state.transform[2]);
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const workflowNodes = useCanvasStore(selectWorkflowNodes);
  const edges = useCanvasStore((state) => state.edges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const openAiImageApi = useSettingsStore((state) => state.openAiImageApi);
  const chaomoImageApi = useSettingsStore((state) => state.chaomoImageApi);
  const customImageApis = useSettingsStore((state) => state.customImageApis);
  const lastImageModelSelection = useSettingsStore((state) => state.lastImageModelSelection);
  const setLastImageModelSelection = useSettingsStore((state) => state.setLastImageModelSelection);
  const updateLastImageGenerationOptions = useSettingsStore(
    (state) => state.updateLastImageGenerationOptions
  );
  const storyboardGenKeepStyleConsistent = useSettingsStore(
    (state) => state.storyboardGenKeepStyleConsistent
  );
  const storyboardGenDisableTextInImage = useSettingsStore(
    (state) => state.storyboardGenDisableTextInImage
  );
  const storyboardGenAutoInferEmptyFrame = useSettingsStore(
    (state) => state.storyboardGenAutoInferEmptyFrame
  );
  const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
    (state) => state.ignoreAtTagWhenCopyingAndGenerating
  );
  const enableStoryboardGenGridPreviewShortcut = useSettingsStore(
    (state) => state.enableStoryboardGenGridPreviewShortcut
  );
  const showStoryboardGenAdvancedRatioControls = useSettingsStore(
    (state) => state.showStoryboardGenAdvancedRatioControls
  );
  const textApis = useSettingsStore((state) => state.textApis);
  const imagePolishConfig = useSettingsStore((state) => state.imagePolishConfig);

  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeFrameTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [pickerFrameIndex, setPickerFrameIndex] = useState<number | 'global' | null>(null);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  const [referenceHover, setReferenceHover] = useState<{
    index: number;
    imageUrl: string;
    anchorRect: DOMRect;
  } | null>(null);
  const lastPointerAnchorRef = useRef<{ frameIndex: number; anchor: PickerAnchor } | null>(null);
  const globalPromptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const globalPromptAnchorRef = useRef<PickerAnchor | null>(null);
  const frameTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const frameHighlightRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const highlightMouseLeaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [polishingFrameIndex, setPolishingFrameIndex] = useState<number | null>(null);
  const nodeData = data as StoryboardGenNodeData;
  const selectedPolishModel = useMemo(
    () => resolveTextModelSelection(
      textApis,
      imagePolishConfig.textApiId ?? undefined,
      imagePolishConfig.textModelId ?? undefined
    ),
    [imagePolishConfig.textApiId, imagePolishConfig.textModelId, textApis]
  );
  const [frameDescriptionDrafts, setFrameDescriptionDrafts] = useState<Record<string, string>>(() =>
    buildFrameDescriptionDrafts(nodeData.frames)
  );
  const frameDescriptionDraftsRef = useRef(frameDescriptionDrafts);
  const [globalPromptDraft, setGlobalPromptDraft] = useState<string>(() => nodeData.globalPrompt ?? '');
  const globalPromptDraftRef = useRef(globalPromptDraft);
  const incomingImages = useMemo(
    () => graphImageResolver.collectInputImages(id, workflowNodes, edges),
    [id, workflowNodes, edges]
  );
  const incomingImageItems = useMemo(
    () =>
      incomingImages.map((imageUrl, index) => ({
        imageUrl,
        displayUrl: resolveImageDisplayUrl(imageUrl),
        label: `图${index + 1}`,
      })),
    [incomingImages]
  );
  const incomingImageViewerList = useMemo(
    () => incomingImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [incomingImageItems]
  );

  const imageModels = useMemo(
    () =>
      listConfiguredImageModels({
        openAiImageApi,
        chaomoImageApi,
        customImageApis,
        lastImageModelSelection,
      }),
    [chaomoImageApi, customImageApis, lastImageModelSelection, openAiImageApi]
  );

  const configuredModel = useMemo(
    () =>
      resolveConfiguredImageModel(
        { openAiImageApi, chaomoImageApi, customImageApis, lastImageModelSelection },
        nodeData.model
      ),
    [chaomoImageApi, customImageApis, lastImageModelSelection, nodeData.model, openAiImageApi]
  );
  const hasConfiguredModel = configuredModel !== null;
  const selectedModel = configuredModel ?? UNCONFIGURED_IMAGE_MODEL;
  const providerRuntime = useMemo(
    () => resolveImageProviderRuntime(selectedModel.providerId, {
      openAiImageApi,
      chaomoImageApi,
      customImageApis,
    }),
    [chaomoImageApi, customImageApis, openAiImageApi, selectedModel.providerId]
  );
  const providerApiKey = providerRuntime.apiKey;
  const effectiveExtraParams = useMemo(
    () => ({ ...(nodeData.extraParams ?? {}) }),
    [nodeData.extraParams]
  );
  const resolutionOptions = IMAGE_GENERATION_RESOLUTION_OPTIONS;

  const selectedResolution = useMemo((): AspectRatioChoice => {
    return resolveImageGenerationResolution(nodeData.size);
  }, [nodeData.size]);

  const aspectRatioOptions = useMemo<AspectRatioChoice[]>(
    () => [{
      value: AUTO_REQUEST_ASPECT_RATIO,
      label: t('modelParams.autoAspectRatio'),
    }, ...IMAGE_GENERATION_ASPECT_RATIO_OPTIONS],
    [t]
  );

  const selectedAspectRatio = useMemo((): AspectRatioChoice => {
    const nodeAspectRatio = nodeData.requestAspectRatio;
    const found = nodeAspectRatio ? aspectRatioOptions.find((item) => item.value === nodeAspectRatio) : undefined;
    if (found) {
      return found;
    }
    return aspectRatioOptions[0];
  }, [aspectRatioOptions, nodeData.requestAspectRatio]);

  const ratioControlMode: StoryboardRatioControlMode = showStoryboardGenAdvancedRatioControls
    ? (nodeData.ratioControlMode === 'overall' ? 'overall' : 'cell')
    : 'cell';
  const controlAspectRatioValue = useMemo(() => {
    if (selectedAspectRatio.value === AUTO_REQUEST_ASPECT_RATIO) {
      return nodeData.aspectRatio || DEFAULT_ASPECT_RATIO;
    }
    return selectedAspectRatio.value || DEFAULT_ASPECT_RATIO;
  }, [nodeData.aspectRatio, selectedAspectRatio.value]);
  const resolvedAspectRatios = useMemo(
    () => resolveStoryboardAspectRatios(
      ratioControlMode,
      parseAspectRatio(controlAspectRatioValue),
      nodeData.gridRows,
      nodeData.gridCols
    ),
    [controlAspectRatioValue, nodeData.gridCols, nodeData.gridRows, ratioControlMode]
  );
  const frameAspectRatioValue = resolvedAspectRatios.cellAspectRatio;

  const baseFrameLayout = useMemo(() => {
    const aspectRatio = Math.max(0.1, parseAspectRatio(frameAspectRatioValue));
    let cellWidth = STORYBOARD_GRID_BASE_CELL_HEIGHT_PX * aspectRatio;
    let gridWidth = nodeData.gridCols * cellWidth + Math.max(0, nodeData.gridCols - 1) * STORYBOARD_GRID_GAP_PX;

    if (gridWidth > STORYBOARD_GRID_MAX_WIDTH_PX) {
      const scale = STORYBOARD_GRID_MAX_WIDTH_PX / gridWidth;
      cellWidth *= scale;
      gridWidth =
        nodeData.gridCols * cellWidth + Math.max(0, nodeData.gridCols - 1) * STORYBOARD_GRID_GAP_PX;
    }

    const roundedCellWidth = Math.max(FRAME_CELL_MIN_WIDTH_PX, Math.round(cellWidth));
    const roundedCellHeight = Math.max(FRAME_CELL_MIN_HEIGHT_PX, Math.round(roundedCellWidth / aspectRatio));
    const roundedGridWidth =
      nodeData.gridCols * roundedCellWidth + Math.max(0, nodeData.gridCols - 1) * STORYBOARD_GRID_GAP_PX;
    const roundedGridHeight =
      nodeData.gridRows * roundedCellHeight + Math.max(0, nodeData.gridRows - 1) * FRAME_GRID_GAP_PX;
    const nodeInnerWidth = Math.max(
      STORYBOARD_CONTROL_ROW_WIDTH_PX,
      STORYBOARD_PARAMS_ROW_WIDTH_PX,
      roundedGridWidth
    );
    const nodeWidth = Math.max(
      STORYBOARD_GEN_NODE_MIN_WIDTH_PX,
      Math.round(nodeInnerWidth + STORYBOARD_NODE_HORIZONTAL_PADDING_PX)
    );
    const nodeHeight = Math.max(
      STORYBOARD_GEN_NODE_MIN_HEIGHT_PX,
      Math.round(
        NODE_VERTICAL_PADDING_PX +
        CONTROL_ROW_HEIGHT_PX +
        CONTROL_ROW_MARGIN_BOTTOM_PX +
        STORYBOARD_GLOBAL_PROMPT_HEIGHT_PX +
        STORYBOARD_GLOBAL_PROMPT_MARGIN_PX +
        FRAME_GRID_MARGIN_BOTTOM_PX +
        roundedGridHeight +
        PARAM_ROW_HEIGHT_PX
      )
    );

    return {
      nodeWidth,
      nodeHeight,
    };
  }, [frameAspectRatioValue, nodeData.gridCols, nodeData.gridRows]);

  const requestResolution = selectedModel.resolveRequest({
    referenceImageCount: incomingImages.length,
  });
  const totalFrames = useMemo(
    () => (nodeData.gridRows ?? 1) * (nodeData.gridCols ?? 1),
    [nodeData.gridRows, nodeData.gridCols]
  );
  const resolvedNodeWidth = Math.max(
    baseFrameLayout.nodeWidth,
    Math.round(width ?? baseFrameLayout.nodeWidth)
  );
  const resolvedNodeHeight = Math.max(
    baseFrameLayout.nodeHeight,
    Math.round(height ?? baseFrameLayout.nodeHeight)
  );
  const frameLayout = useMemo(() => {
    const cols = Math.max(1, nodeData.gridCols);
    const rows = Math.max(1, nodeData.gridRows);
    const aspectRatio = Math.max(0.1, parseAspectRatio(frameAspectRatioValue));
    const innerWidth = Math.max(120, resolvedNodeWidth - STORYBOARD_NODE_HORIZONTAL_PADDING_PX);
    const availableGridHeight = Math.max(
      72,
      resolvedNodeHeight
      - NODE_VERTICAL_PADDING_PX
      - CONTROL_ROW_HEIGHT_PX
      - CONTROL_ROW_MARGIN_BOTTOM_PX
      - STORYBOARD_GLOBAL_PROMPT_HEIGHT_PX
      - STORYBOARD_GLOBAL_PROMPT_MARGIN_PX
      - FRAME_GRID_MARGIN_BOTTOM_PX
      - PARAM_ROW_HEIGHT_PX
    );
    const widthLimitedCellWidth =
      (innerWidth - Math.max(0, cols - 1) * STORYBOARD_GRID_GAP_PX) / cols;
    const heightLimitedCellHeight =
      (availableGridHeight - Math.max(0, rows - 1) * FRAME_GRID_GAP_PX) / rows;
    const heightLimitedCellWidth = heightLimitedCellHeight * aspectRatio;
    const resolvedCellWidth = Math.floor(Math.min(widthLimitedCellWidth, heightLimitedCellWidth));
    const cellWidth = Math.max(FRAME_CELL_MIN_WIDTH_PX, resolvedCellWidth);
    const gridWidth = cols * cellWidth + Math.max(0, cols - 1) * STORYBOARD_GRID_GAP_PX;
    const paramsRowWidth = Math.max(
      STORYBOARD_PARAMS_ROW_WIDTH_PX,
      Math.floor(innerWidth)
    );

    return {
      cellWidth,
      gridWidth,
      paramsRowWidth,
      cellAspectRatio: toCssAspectRatio(frameAspectRatioValue),
    };
  }, [frameAspectRatioValue, nodeData.gridCols, nodeData.gridRows, resolvedNodeHeight, resolvedNodeWidth]);

  useEffect(() => {
    frameDescriptionDraftsRef.current = frameDescriptionDrafts;
  }, [frameDescriptionDrafts]);

  useEffect(() => {
    globalPromptDraftRef.current = globalPromptDraft;
  }, [globalPromptDraft]);

  useEffect(() => {
    const nextDrafts = buildFrameDescriptionDrafts(nodeData.frames);
    setFrameDescriptionDrafts((previous) =>
      areFrameDescriptionDraftsEqual(previous, nextDrafts) ? previous : nextDrafts
    );
  }, [nodeData.frames]);

  useEffect(() => {
    if (nodeData.globalPrompt !== undefined && nodeData.globalPrompt !== globalPromptDraft) {
      setGlobalPromptDraft(nodeData.globalPrompt);
    }
  }, [nodeData.globalPrompt]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedNodeHeight, resolvedNodeWidth, updateNodeInternals]);

  // Sync model, size, aspect ratio with node data
  useEffect(() => {
    if (!hasConfiguredModel) {
      return;
    }
    if (nodeData.model !== selectedModel.id) {
      updateNodeData(id, { model: selectedModel.id });
    }

    if (nodeData.size !== selectedResolution.value) {
      updateNodeData(id, { size: selectedResolution.value as ImageSize });
    }

    if (nodeData.requestAspectRatio !== selectedAspectRatio.value) {
      updateNodeData(id, { requestAspectRatio: selectedAspectRatio.value });
    }
  }, [
    id,
    hasConfiguredModel,
    nodeData,
    selectedModel.id,
    selectedResolution.value,
    selectedAspectRatio.value,
    updateNodeData,
  ]);

  useEffect(() => {
    if (incomingImages.length === 0) {
      setShowImagePicker(false);
      setPickerFrameIndex(null);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }

    setPickerActiveIndex((previous) => Math.min(previous, incomingImages.length - 1));
  }, [incomingImages.length]);

  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }

      setShowImagePicker(false);
      setPickerFrameIndex(null);
      setPickerCursor(null);
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, []);

  // Handle @图x hover preview by checking if mouse is over a highlight span
  // We query all spans in this node and check coordinates directly since textarea overlays the highlight div
  useEffect(() => {
    const checkHighlightUnderMouse = (event: MouseEvent) => {
      // Find all highlight spans in this node
      const highlightSpans = rootRef.current?.querySelectorAll('[data-highlight-ref]');
      if (!highlightSpans || highlightSpans.length === 0) return;

      for (const span of highlightSpans) {
        const spanRect = span.getBoundingClientRect();
        const isOverSpan =
          event.clientX >= spanRect.left &&
          event.clientX <= spanRect.right &&
          event.clientY >= spanRect.top &&
          event.clientY <= spanRect.bottom;

        if (isOverSpan) {
          const imageUrl = (span as HTMLElement).dataset.imageUrl;
          const index = (span as HTMLElement).dataset.index;
          if (imageUrl && index) {
            if (highlightMouseLeaveTimeoutRef.current) {
              clearTimeout(highlightMouseLeaveTimeoutRef.current);
              highlightMouseLeaveTimeoutRef.current = null;
            }
            setReferenceHover({
              index: parseInt(index, 10),
              imageUrl,
              anchorRect: spanRect,
            });
            return;
          }
        }
      }

      // Not over any highlight span - set timeout to clear
      if (!highlightMouseLeaveTimeoutRef.current) {
        highlightMouseLeaveTimeoutRef.current = setTimeout(() => {
          setReferenceHover(null);
          highlightMouseLeaveTimeoutRef.current = null;
        }, 100);
      }
    };

    document.addEventListener('mousemove', checkHighlightUnderMouse, true);
    return () => {
      document.removeEventListener('mousemove', checkHighlightUnderMouse, true);
      if (highlightMouseLeaveTimeoutRef.current) {
        clearTimeout(highlightMouseLeaveTimeoutRef.current);
      }
    };
  }, []);

  // Auto-generate frames when grid changes
  useEffect(() => {
    const currentFrames = nodeData.frames;
    const targetCount = totalFrames;

    if (currentFrames.length === targetCount) {
      return;
    }

    const newFrames: StoryboardGenNodeData['frames'] = [];
    for (let i = 0; i < targetCount; i++) {
      if (i < currentFrames.length) {
        newFrames.push(currentFrames[i]);
      } else {
        newFrames.push({
          id: generateFrameId(),
          description: '',
          referenceIndex: null,
        });
      }
    }

    updateNodeData(id, { frames: newFrames });
  }, [id, nodeData.frames, totalFrames, updateNodeData]);

  // Build prompt from frames
  const buildPrompt = useCallback((): string => {
    if (!nodeData) {
      return '';
    }

    const { gridRows, gridCols, frames } = nodeData;
    const parts: string[] = [];

    const promptDirectives: string[] = [
      `生成一张${gridRows}×${gridCols}的${gridRows * gridCols}宫格分镜图`,
    ];
    if (storyboardGenKeepStyleConsistent) {
      promptDirectives.push('图片风格与参考图保持一致');
    }
    if (storyboardGenDisableTextInImage) {
      promptDirectives.push('禁止添加描述文本');
    }
    parts.push(`${promptDirectives.join('，')}。`);

    // 添加全局提示词（用户自定义的整体描述，如画风、情节等）
    const globalPrompt = sanitizeStoryboardPromptText(globalPromptDraftRef.current ?? '');
    if (globalPrompt) {
      parts.push(`${globalPrompt}`);
    }

    frames.forEach((frame, index) => {
      const frameDescription = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;
      const sanitizedDescription = sanitizeStoryboardPromptText(frameDescription);
      if (!sanitizedDescription) {
        if (storyboardGenAutoInferEmptyFrame) {
          parts.push(`分镜${index + 1}：依据之前的内容进行推测`);
        }
        return;
      }

      parts.push(`分镜${index + 1}：${sanitizedDescription}`);
    });

    return parts.join('\n');
  }, [
    nodeData,
    storyboardGenAutoInferEmptyFrame,
    storyboardGenDisableTextInImage,
    storyboardGenKeepStyleConsistent,
  ]);

  const resolveEffectiveRequestAspectRatio = useCallback(async (): Promise<string> => {
    const safeRows = Math.max(1, nodeData.gridRows);
    const safeCols = Math.max(1, nodeData.gridCols);
    if (selectedAspectRatio.value !== AUTO_REQUEST_ASPECT_RATIO) {
      return selectedAspectRatio.value;
    }

    let autoControlRatioValue = 1;
    if (incomingImages.length > 0) {
      try {
        const sourceAspectRatio = await detectAspectRatio(incomingImages[0]);
        autoControlRatioValue = Math.max(0.1, parseAspectRatio(sourceAspectRatio));
      } catch {
        autoControlRatioValue = 1;
      }
    }

    const autoResolvedRatios = resolveStoryboardAspectRatios(
      ratioControlMode,
      autoControlRatioValue,
      safeRows,
      safeCols
    );
    return pickClosestImageGenerationAspectRatio(autoResolvedRatios.overallRatioValue);
  }, [
    incomingImages,
    nodeData.gridCols,
    nodeData.gridRows,
    ratioControlMode,
    selectedAspectRatio.value,
  ]);

  const handlePolishFrame = useCallback(async (frameIndex: number) => {
    if (!selectedPolishModel) {
      void showErrorDialog(t('node.textModel.required'), t('settings.polishPrompt'));
      return;
    }
    const frame = nodeData.frames[frameIndex];
    if (!frame) return;
    const frameDescription = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;

    if (!frameDescription.trim()) {
      void showErrorDialog('请先填写分镜内容后再润色', '润色提示');
      return;
    }
    setPolishingFrameIndex(frameIndex);
    try {
      const result = await polishText({
        text: frameDescription,
        customPrompt: imagePolishConfig.prompt,
        promptType: 'image',
        reasoningEffort: imagePolishConfig.reasoningEffort ?? undefined,
      }, selectedPolishModel.apiConfig);
      const newFrames = nodeData.frames.map((f, i) =>
        i === frameIndex ? { ...f, description: result.polished } : f
      );
      setFrameDescriptionDrafts((prev) => ({
        ...prev,
        [frame.id]: result.polished,
      }));
      updateNodeData(id, { frames: newFrames });
    } catch (err) {
      const message = err instanceof Error ? err.message : '润色失败';
      void showErrorDialog(message, '润色失败');
    } finally {
      setPolishingFrameIndex(null);
    }
  }, [imagePolishConfig, nodeData.frames, selectedPolishModel, t, updateNodeData, id]);

  const handleGenerate = useCallback(async (previewGridOnly = false) => {
    if (!nodeData) {
      return;
    }

    const safeRows = Math.max(1, nodeData.gridRows);
    const safeCols = Math.max(1, nodeData.gridCols);
    const resolvedRequestAspectRatio = await resolveEffectiveRequestAspectRatio();

    if (previewGridOnly) {
      const gridImageDataUrl = generateGridImageDataUrl(
        resolvedRequestAspectRatio,
        safeRows,
        safeCols,
        selectedResolution.value
      );
      const newNodePosition = findNodePosition(
        id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      const previewNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        newNodePosition,
        {
          displayName: t('node.storyboardGen.gridPreviewTitle'),
          resultKind: 'storyboardGenOutput',
          imageUrl: gridImageDataUrl,
          previewImageUrl: gridImageDataUrl,
          aspectRatio: resolvedRequestAspectRatio,
          isGenerating: false,
          generationStartedAt: null,
          requestAspectRatio: resolvedRequestAspectRatio,
        }
      );
      addEdge(id, previewNodeId);
      setSelectedNode(null);
      setError(null);
      return;
    }

    if (!hasConfiguredModel) {
      const errorMessage = t('node.storyboardGen.modelRequired');
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      return;
    }

    const prompt = buildPrompt();
    if (!prompt) {
      const errorMessage = '请填写至少一个分镜内容描述';
      setError(errorMessage);
      void showErrorDialog(errorMessage, '错误');
      return;
    }

    if (!providerApiKey) {
      const errorMessage = '请在设置中填写 API Key';
      setError(errorMessage);
      void showErrorDialog(errorMessage, '错误');
      return;
    }

    const generationDurationMs = selectedModel.expectedDurationMs ?? 60000;
    const generationStartedAt = Date.now();
    const runtimeDiagnostics = await getRuntimeDiagnostics();

    // Create new image node with generating state immediately
    // Use auto-positioning to avoid collisions with existing nodes
    const newNodePosition = findNodePosition(
      id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT
    );
    const newNodeId = addNode(
      CANVAS_NODE_TYPES.exportImage,
      newNodePosition,
      {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs,
        displayName: EXPORT_RESULT_DISPLAY_NAME.storyboardGenOutput,
        resultKind: 'storyboardGenOutput',
        prompt: '',
        model: selectedModel.id,
        size: selectedResolution.value as ImageSize,
        requestAspectRatio: resolvedRequestAspectRatio,
      }
    );

    // Connect the storyboard node to the new image node
    addEdge(id, newNodeId);

    setSelectedNode(null);
    setError(null);

    try {
      await canvasAiGateway.setApiKey(providerRuntime.backendProviderId, providerApiKey);

      // 生成网格图片作为最后一张参考图片
      const gridImageDataUrl = generateGridImageDataUrl(
        resolvedRequestAspectRatio,
        safeRows,
        safeCols,
        selectedResolution.value
      );

      // 将网格图片作为最后一张参考图片
      const allReferenceImages = [...incomingImages, gridImageDataUrl];

      const metadataFrameNotes = nodeData.frames
        .slice(0, safeRows * safeCols)
        .map((frame) => {
          const description = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;
          return sanitizeStoryboardText(description, ignoreAtTagWhenCopyingAndGenerating);
        });

      const projectId = useProjectStore.getState().getCurrentProject()?.id;
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt,
        model: requestResolution.requestModel,
        size: selectedResolution.value,
        aspectRatio: resolvedRequestAspectRatio,
        referenceImages: allReferenceImages,
        extraParams: effectiveExtraParams,
        providerConfig: providerRuntime.providerConfig,
        projectId,
      });
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'storyboardGen',
        providerId: selectedModel.providerId,
        requestModel: requestResolution.requestModel,
        requestSize: selectedResolution.value,
        requestAspectRatio: resolvedRequestAspectRatio,
        prompt,
        extraParams: effectiveExtraParams,
        referenceImageCount: allReferenceImages.length,
        referenceImagePlaceholders: createReferenceImagePlaceholders(allReferenceImages.length),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'storyboardGen',
        generationProviderId: selectedModel.providerId,
        generationProviderName: getModelProvider(
          selectedModel.providerId,
          selectedModel.providerName
        ).name,
        generationModelName: selectedModel.displayName,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationDebugContext,
        generationStoryboardMetadata: {
          gridRows: safeRows,
          gridCols: safeCols,
          frameNotes: metadataFrameNotes,
        },
      });
    } catch (generationError) {
      const resolvedError = resolveErrorContent(generationError, '生成失败');
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'storyboardGen',
        providerId: selectedModel.providerId,
        requestModel: requestResolution.requestModel,
        requestSize: selectedResolution.value,
        requestAspectRatio: resolvedRequestAspectRatio,
        prompt,
        extraParams: effectiveExtraParams,
        referenceImageCount: incomingImages.length + 1,
        referenceImagePlaceholders: createReferenceImagePlaceholders(incomingImages.length + 1),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };
      const reportText = buildGenerationErrorReport({
        errorMessage: resolvedError.message,
        errorDetails: resolvedError.details,
        context: generationDebugContext,
      });
      setError(resolvedError.message);
      void showErrorDialog(resolvedError.message, '错误', resolvedError.details, reportText);
      // Clear generating state and mark as failed
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationProviderId: null,
        generationProviderName: null,
        generationModelName: null,
        generationClientSessionId: null,
        generationStoryboardMetadata: undefined,
        generationError: resolvedError.message,
        generationErrorDetails: resolvedError.details ?? null,
        generationDebugContext,
      });
    }
  }, [
    providerApiKey,
    providerRuntime.providerConfig,
    nodeData,
    incomingImages,
    requestResolution.requestModel,
    effectiveExtraParams,
    hasConfiguredModel,
    selectedModel.expectedDurationMs,
    selectedModel.id,
    selectedModel.providerId,
    selectedModel.providerName,
    setSelectedNode,
    selectedAspectRatio.value,
    selectedResolution.value,
    addNode,
    addEdge,
    buildPrompt,
    selectedModel.id,
    findNodePosition,
    updateNodeData,
    resolveEffectiveRequestAspectRatio,
    t,
    ignoreAtTagWhenCopyingAndGenerating,
  ]);

  const handleRowChange = useCallback(
    (delta: number) => {
      if (!nodeData) {
        return;
      }
      const newRows = Math.max(1, Math.min(9, nodeData.gridRows + delta));
      updateNodeData(id, { gridRows: newRows });
      updateLastImageGenerationOptions({ storyboardGridRows: newRows });
    },
    [nodeData, updateLastImageGenerationOptions, updateNodeData]
  );

  const handleColChange = useCallback(
    (delta: number) => {
      if (!nodeData) {
        return;
      }
      const newCols = Math.max(1, Math.min(9, nodeData.gridCols + delta));
      updateNodeData(id, { gridCols: newCols });
      updateLastImageGenerationOptions({ storyboardGridCols: newCols });
    },
    [nodeData, updateLastImageGenerationOptions, updateNodeData]
  );

  const handleFrameDescriptionChange = useCallback(
    (index: number, description: string) => {
      const frame = nodeData.frames[index];
      if (!frame) {
        return;
      }

      setFrameDescriptionDrafts((previous) =>
        previous[frame.id] === description
          ? previous
          : {
            ...previous,
            [frame.id]: description,
          }
      );

      const referenceIndex = resolveReferenceIndexFromDescription(description, incomingImages.length);
      if (frame.description === description && frame.referenceIndex === referenceIndex) {
        return;
      }

      const newFrames = [...nodeData.frames];
      newFrames[index] = { ...frame, description, referenceIndex };
      updateNodeData(id, { frames: newFrames });
    },
    [id, incomingImages.length, nodeData.frames, updateNodeData]
  );

  const closeImagePicker = useCallback(() => {
    setShowImagePicker(false);
    setPickerFrameIndex(null);
    setPickerCursor(null);
    setPickerActiveIndex(0);
    globalPromptAnchorRef.current = null;
  }, []);

  const syncFrameHighlightScroll = useCallback((frameId: string) => {
    const textarea = frameTextareaRefs.current[frameId];
    const highlight = frameHighlightRefs.current[frameId];
    if (!textarea || !highlight) {
      return;
    }

    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  const insertImageReference = useCallback((imageIndex: number) => {
    if (!nodeData || pickerFrameIndex === null) {
      return;
    }

    const marker = `@图${imageIndex + 1}`;

    if (pickerFrameIndex === 'global') {
      // Handle global prompt
      const cursor = pickerCursor ?? globalPromptDraftRef.current.length;
      const { nextText: nextDescription, nextCursor } = insertReferenceToken(
        globalPromptDraftRef.current,
        cursor,
        marker
      );
      setGlobalPromptDraft(nextDescription);
      updateNodeData(id, { globalPrompt: nextDescription });
      closeImagePicker();
      requestAnimationFrame(() => {
        globalPromptTextareaRef.current?.focus();
        globalPromptTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
      return;
    }

    // Handle frame description
    const frame = nodeData.frames[pickerFrameIndex];
    if (!frame) {
      closeImagePicker();
      return;
    }

    const currentDescription = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;
    const cursor = pickerCursor ?? currentDescription.length;
    const { nextText: nextDescription, nextCursor } = insertReferenceToken(
      currentDescription,
      cursor,
      marker
    );
    handleFrameDescriptionChange(pickerFrameIndex, nextDescription);
    closeImagePicker();

    requestAnimationFrame(() => {
      activeFrameTextareaRef.current?.focus();
      activeFrameTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [closeImagePicker, handleFrameDescriptionChange, nodeData, pickerCursor, pickerFrameIndex]);

  const handleFrameDescriptionKeyDown = useCallback(
    (index: number, event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (showImagePicker && incomingImages.length > 0 && pickerFrameIndex === index) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
          return;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setPickerActiveIndex((previous) =>
            previous === 0 ? incomingImages.length - 1 : previous - 1
          );
          return;
        }

        if (event.key === 'Enter') {
          event.preventDefault();
          insertImageReference(pickerActiveIndex);
          return;
        }
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        const frame = nodeData.frames[index];
        if (!frame) {
          return;
        }

        const currentDescription = frameDescriptionDraftsRef.current[frame.id] ?? frame.description;
        const selectionStart = event.currentTarget.selectionStart ?? currentDescription.length;
        const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
        const deleteDirection = event.key === 'Backspace' ? 'backward' : 'forward';
        const deleteRange = resolveReferenceAwareDeleteRange(
          currentDescription,
          selectionStart,
          selectionEnd,
          deleteDirection,
          incomingImages.length
        );
        if (deleteRange) {
          event.preventDefault();
          const { nextText, nextCursor } = removeTextRange(currentDescription, deleteRange);
          handleFrameDescriptionChange(index, nextText);
          requestAnimationFrame(() => {
            activeFrameTextareaRef.current?.focus();
            activeFrameTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
            syncFrameHighlightScroll(frame.id);
          });
          return;
        }
      }

      if (event.key === '@' && incomingImages.length > 0) {
        event.preventDefault();
        const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
        const pointerAnchor = lastPointerAnchorRef.current;
        if (pointerAnchor && pointerAnchor.frameIndex === index) {
          setPickerAnchor(pointerAnchor.anchor);
        } else {
          setPickerAnchor(resolvePickerAnchor(rootRef.current, event.currentTarget, cursor, zoom));
        }
        setPickerFrameIndex(index);
        setPickerCursor(cursor);
        setPickerActiveIndex(0);
        setShowImagePicker(true);
        activeFrameTextareaRef.current = event.currentTarget;
        return;
      }

      if (event.key === 'Escape' && showImagePicker) {
        event.preventDefault();
        closeImagePicker();
        return;
      }

      // 敲回车后同步 highlight 层的滚动位置
      if (event.key === 'Enter') {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const frame = nodeData.frames[index];
            if (frame) {
              syncFrameHighlightScroll(frame.id);
            }
          });
        });
      }
    },
    [
      closeImagePicker,
      handleFrameDescriptionChange,
      incomingImages.length,
      insertImageReference,
      nodeData.frames,
      pickerActiveIndex,
      pickerFrameIndex,
      showImagePicker,
      syncFrameHighlightScroll,
      zoom,
    ]
  );

  const handleGlobalPromptKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showImagePicker && incomingImages.length > 0 && pickerFrameIndex === 'global') {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setPickerActiveIndex((previous) =>
            previous === 0 ? incomingImages.length - 1 : previous - 1
          );
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          insertImageReference(pickerActiveIndex);
          return;
        }
      }

      if (event.key === '@' && incomingImages.length > 0) {
        event.preventDefault();
        const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
        const anchor = globalPromptAnchorRef.current ?? PICKER_FALLBACK_ANCHOR;
        setPickerAnchor(anchor);
        setPickerFrameIndex('global');
        setPickerCursor(cursor);
        setPickerActiveIndex(0);
        setShowImagePicker(true);
        globalPromptTextareaRef.current = event.currentTarget;
        return;
      }

      if (event.key === 'Escape' && showImagePicker) {
        event.preventDefault();
        closeImagePicker();
        return;
      }

      // 敲回车后同步 highlight 层的滚动位置
      if (event.key === 'Enter') {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const highlight = frameHighlightRefs.current['__globalPrompt__'];
            const textarea = globalPromptTextareaRef.current;
            if (highlight && textarea) {
              highlight.scrollTop = textarea.scrollTop;
              highlight.scrollLeft = textarea.scrollLeft;
            }
          });
        });
      }
    },
    [
      closeImagePicker,
      incomingImages.length,
      insertImageReference,
      pickerActiveIndex,
      pickerFrameIndex,
      showImagePicker,
    ]
  );

  if (!nodeData) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/95 p-3 transition-colors duration-150
        ${resolveNodeSurfaceStateClass(selected)}
      `}
      style={{
        width: `${resolvedNodeWidth}px`,
        height: `${resolvedNodeHeight}px`,
      }}
      onClick={() => setSelectedNode(id)}
    >
      {/* Frame summary + grid settings */}
      <div className="mb-2.5 flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <GridStepperControl
            label={t('node.storyboardGen.rowsShort')}
            value={nodeData.gridRows}
            onDecrease={() => handleRowChange(-1)}
            onIncrease={() => handleRowChange(1)}
          />
          <GridStepperControl
            label={t('node.storyboardGen.colsShort')}
            value={nodeData.gridCols}
            onDecrease={() => handleColChange(-1)}
            onIncrease={() => handleColChange(1)}
          />
        </div>

        {showStoryboardGenAdvancedRatioControls && (
          <div className="min-w-0 flex-1 rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-2 py-0.5 text-center font-mono text-[10px] text-text-muted">
            <span>{t('node.storyboardGen.cellAspectRatio')}: {resolvedAspectRatios.cellAspectRatioLabel}</span>
            <span className="mx-1 text-[var(--ui-border-strong)]">|</span>
            <span>{t('node.storyboardGen.overallAspectRatio')}: {resolvedAspectRatios.overallAspectRatioLabel}</span>
          </div>
        )}

        <div className="flex items-center gap-1">
          {showStoryboardGenAdvancedRatioControls && (
            <div className="flex h-5 items-center rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-0.5">
              <button
                type="button"
                className={`${RATIO_CONTROL_MODE_BUTTON_CLASS} ${ratioControlMode === 'overall'
                  ? 'border-accent/55 bg-accent/18 text-text-dark'
                  : 'border-transparent bg-transparent text-text-muted hover:bg-[var(--ui-hover)]'
                  }`}
                onClick={(event) => {
                  event.stopPropagation();
                  updateNodeData(id, { ratioControlMode: 'overall' });
                  updateLastImageGenerationOptions({ storyboardRatioControlMode: 'overall' });
                }}
              >
                {t('node.storyboardGen.ratioModeOverall')}
              </button>
              <button
                type="button"
                className={`${RATIO_CONTROL_MODE_BUTTON_CLASS} ${ratioControlMode === 'cell'
                  ? 'border-accent/55 bg-accent/18 text-text-dark'
                  : 'border-transparent bg-transparent text-text-muted hover:bg-[var(--ui-hover)]'
                  }`}
                onClick={(event) => {
                  event.stopPropagation();
                  updateNodeData(id, { ratioControlMode: 'cell' });
                  updateLastImageGenerationOptions({ storyboardRatioControlMode: 'cell' });
                }}
              >
                {t('node.storyboardGen.ratioModeCell')}
              </button>
            </div>
          )}
          <div className={GRID_SUMMARY_CLASS}>
            {t('node.storyboardGen.frameCount', { count: totalFrames })}
          </div>
        </div>
      </div>

      {/* Global Prompt Input - 整体提示词输入框（在行列选择框下面） */}
      <div
        className="mb-2 flex justify-center"
        style={{
          flex: '0 0 18%',
          minHeight: '54px',
        }}
      >
        <div
          className="relative overflow-hidden rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
          style={{
            width: `${frameLayout.paramsRowWidth}px`,
            height: '100%',
          }}
        >
          <div
            ref={(element) => {
              frameHighlightRefs.current['__globalPrompt__'] = element;
            }}
            aria-hidden="true"
            data-highlight-container="true"
            className="ui-scrollbar pointer-events-none absolute inset-0 overflow-y-auto overflow-x-hidden text-[10px] leading-4 text-text-dark"
            style={{ scrollbarGutter: 'stable', zIndex: 5 }}
          >
            <div className="min-h-full whitespace-pre-wrap break-words px-1.5 py-1 text-left">
              {renderFrameDescriptionWithHighlights(
                globalPromptDraft,
                incomingImages.length,
                incomingImages
              )}
            </div>
          </div>
          <textarea
            ref={globalPromptTextareaRef}
            value={globalPromptDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              setGlobalPromptDraft(nextValue);
              updateNodeData(id, { globalPrompt: nextValue });
              // onChange 后同步 scrollTop，用两个 requestAnimationFrame 确保同步
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  const highlight = frameHighlightRefs.current['__globalPrompt__'];
                  const textarea = globalPromptTextareaRef.current;
                  if (highlight && textarea) {
                    highlight.scrollTop = textarea.scrollTop;
                    highlight.scrollLeft = textarea.scrollLeft;
                  }
                });
              });
            }}
            onKeyDown={handleGlobalPromptKeyDown}
            onScroll={() => {
              const highlight = frameHighlightRefs.current['__globalPrompt__'];
              const textarea = globalPromptTextareaRef.current;
              if (highlight && textarea) {
                highlight.scrollTop = textarea.scrollTop;
                highlight.scrollLeft = textarea.scrollLeft;
              }
            }}
            onPointerDown={(event) => {
              globalPromptAnchorRef.current = resolvePointerAnchor(rootRef.current, event.clientX, event.clientY, zoom);
            }}
            onFocus={() => {
              const highlight = frameHighlightRefs.current['__globalPrompt__'];
              const textarea = globalPromptTextareaRef.current;
              if (highlight && textarea) {
                highlight.scrollTop = textarea.scrollTop;
                highlight.scrollLeft = textarea.scrollLeft;
              }
            }}
            placeholder={t('node.storyboardGen.globalPromptPlaceholder') || '整体提示词（可选）：如画风、情节、氛围等描述'}
            wrap="soft"
            className="ui-scrollbar nodrag nowheel absolute inset-0 z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden bg-transparent px-1.5 py-1 text-left text-[10px] leading-4 text-transparent caret-text-dark selection:text-transparent placeholder:text-text-muted/50 focus:border-accent/50 focus:outline-none"
            style={{ scrollbarGutter: 'stable' }}
          />
        </div>
      </div>

      {/* Frame Grid */}
      <div className="mb-2 flex min-h-0 flex-1 items-center justify-center">
        <div
          className="grid gap-0.5"
          style={{
            width: `${frameLayout.gridWidth}px`,
            gridTemplateColumns: `repeat(${nodeData.gridCols}, ${frameLayout.cellWidth}px)`,
          }}
        >
          {nodeData.frames.map((frame, index) => {
            const frameDescription = frameDescriptionDrafts[frame.id] ?? frame.description;
            return (
              <div
                key={frame.id}
                data-frame-cell
                className="relative overflow-hidden rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
                style={{ aspectRatio: frameLayout.cellAspectRatio }}
              >
                <div
                  ref={(element) => {
                    frameHighlightRefs.current[frame.id] = element;
                  }}
                  aria-hidden="true"
                  data-highlight-container="true"
                  className="ui-scrollbar pointer-events-none absolute inset-0 overflow-y-auto overflow-x-hidden text-[10px] leading-4 text-text-dark"
                  style={{ scrollbarGutter: 'stable', zIndex: 5 }}
                >
                  <div className="min-h-full whitespace-pre-wrap break-words px-1.5 py-1 text-left">
                    {renderFrameDescriptionWithHighlights(
                      frameDescription,
                      incomingImages.length,
                      incomingImages
                    )}
                  </div>
                </div>
                <textarea
                  ref={(element) => {
                    frameTextareaRefs.current[frame.id] = element;
                  }}
                  value={frameDescription}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    handleFrameDescriptionChange(index, nextValue);
                    // onChange 后同步 scrollTop，用两个 requestAnimationFrame 确保同步
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                        syncFrameHighlightScroll(frame.id);
                      });
                    });
                  }}
                  onKeyDown={(event) => handleFrameDescriptionKeyDown(index, event)}
                  onScroll={() => syncFrameHighlightScroll(frame.id)}
                  onPointerDown={(event) => {
                    lastPointerAnchorRef.current = {
                      frameIndex: index,
                      anchor: resolvePointerAnchor(rootRef.current, event.clientX, event.clientY, zoom),
                    };
                  }}
                  onFocus={(event) => {
                    activeFrameTextareaRef.current = event.currentTarget;
                    syncFrameHighlightScroll(frame.id);
                  }}
                  placeholder={t('node.storyboardGen.framePlaceholder', {
                    index: String(index + 1).padStart(2, '0'),
                  })}
                  wrap="soft"
                  className="ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden bg-transparent px-1.5 py-1 text-left text-[10px] leading-4 text-transparent caret-text-dark selection:text-transparent placeholder:text-text-muted/40 focus:border-accent/50 focus:outline-none whitespace-pre-wrap break-words"
                  style={{ scrollbarGutter: 'stable' }}
                />
                <UiTooltip content={t('node.imageEdit.polishPrompt')}>
                  <button
                    type="button"
                    aria-label={t('node.imageEdit.polishPrompt')}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handlePolishFrame(index);
                    }}
                    disabled={polishingFrameIndex === index}
                    className="absolute right-0.5 top-0.5 z-20 rounded bg-[var(--ui-surface-elevated)] p-0.5 opacity-0 transition-opacity hover:bg-[var(--ui-hover)] hover:opacity-100 focus:opacity-100 group-hover:opacity-100"
                  >
                    {polishingFrameIndex === index ? (
                      <Loader2 className="h-3 w-3 animate-spin text-accent" />
                    ) : (
                      <Wand2 className="h-3 w-3 text-text-muted" />
                    )}
                  </button>
                </UiTooltip>
              </div>
            );
          })}
        </div>
      </div>

      {showImagePicker && incomingImageItems.length > 0 && (
        <div
          className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] shadow-[var(--ui-shadow-panel)]"
          style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <div
            className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {incomingImageItems.map((item, imageIndex) => (
              <button
                key={`${item.imageUrl}-${imageIndex}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  insertImageReference(imageIndex);
                }}
                onMouseEnter={() => setPickerActiveIndex(imageIndex)}
                className={`flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:bg-[var(--ui-hover)] ${pickerActiveIndex === imageIndex
                  ? 'border-accent/45 bg-accent/10'
                  : ''
                  }`}
              >
                <CanvasNodeImage
                  src={item.displayUrl}
                  alt={item.label}
                  viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                  viewerImageList={incomingImageViewerList}
                  className="h-8 w-8 rounded object-cover"
                  showResolutionPreview={false}
                />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {referenceHover && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] overflow-hidden rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] shadow-[var(--ui-shadow-tooltip)]"
          style={{
            left: Math.max(10, referenceHover.anchorRect.left + referenceHover.anchorRect.width / 2 - 75),
            top: referenceHover.anchorRect.bottom + 10,
            width: 150,
            height: 150,
          }}
        >
          <img
            src={resolveImageDisplayUrl(referenceHover.imageUrl)}
            alt={`图${referenceHover.index}`}
            className="h-full w-full object-contain"
            draggable={false}
          />
        </div>,
        document.body
      )}

      {error && <div className="mb-1.5 shrink-0 text-[10px] text-red-400">{error}</div>}

      {/* AI Parameters */}
      <div
        className={`${NODE_CONTROL_FOOTER_CLASS} relative mx-auto justify-between`}
        style={{
          width: `${frameLayout.paramsRowWidth}px`,
          marginBottom: -STORYBOARD_FOOTER_BOTTOM_OFFSET_PX,
        }}
      >
        {hasConfiguredModel ? (
          <ModelParamsControls
            imageModels={imageModels}
            selectedModel={selectedModel}
            resolutionOptions={resolutionOptions}
            selectedResolution={selectedResolution}
            selectedAspectRatio={selectedAspectRatio}
            aspectRatioOptions={aspectRatioOptions}
            onModelChange={(modelId) => {
              const model = imageModels.find((item) => item.id === modelId);
              if (!model) {
                return;
              }
              updateNodeData(id, { model: modelId });
              setLastImageModelSelection({ providerId: model.providerId, modelId });
            }}
            onResolutionChange={(resolution) => {
              const size = resolution as ImageSize;
              updateNodeData(id, { size });
              updateLastImageGenerationOptions({ size });
            }}
            onAspectRatioChange={(aspectRatio) => {
              updateNodeData(id, { requestAspectRatio: aspectRatio });
              updateLastImageGenerationOptions({ requestAspectRatio: aspectRatio });
            }}
            extraParams={nodeData.extraParams}
            onExtraParamChange={(key, value) => {
              const extraParams = {
                ...(nodeData.extraParams ?? {}),
                [key]: value,
              };
              updateNodeData(id, {
                extraParams: {
                  ...extraParams,
                },
              });
              updateLastImageGenerationOptions({ extraParams });
            }}
            triggerSize="sm"
            chipClassName={NODE_CONTROL_CHIP_CLASS}
            modelChipClassName={NODE_CONTROL_MODEL_CHIP_CLASS}
            paramsChipClassName={NODE_CONTROL_PARAMS_CHIP_CLASS}
            modelPanelAlign="center"
            paramsPanelAlign="center"
            paramsPanelClassName="w-[420px] p-3"
          />
        ) : (
          <UiButton
            variant="muted"
            size="sm"
            onClick={() => openSettingsDialog({ category: 'imageApis' })}
          >
            {t('modelParams.configureImageModel')}
          </UiButton>
        )}

        <UiButton
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            const previewGridOnly =
              enableStoryboardGenGridPreviewShortcut && event.ctrlKey && event.altKey && event.shiftKey;
            void handleGenerate(previewGridOnly);
          }}
          variant="primary"
          size="sm"
          className={`!min-w-0 shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          disabled={!hasConfiguredModel}
        >
          <Sparkles className={NODE_CONTROL_ICON_CLASS} strokeWidth={2.8} />
          {t('canvas.generate')}
        </UiButton>
      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
      />
      <NodeResizeHandle
        minWidth={baseFrameLayout.nodeWidth}
        minHeight={baseFrameLayout.nodeHeight}
        maxWidth={1800}
        maxHeight={1400}
      />
    </div>
  );
});

StoryboardGenNode.displayName = 'StoryboardGenNode';
