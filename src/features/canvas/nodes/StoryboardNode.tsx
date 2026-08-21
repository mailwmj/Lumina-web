import {
  memo,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Download, FolderOpen, ImagePlus, SlidersHorizontal, SquareArrowOutUpRight } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import type { StoryboardMergeResult } from '@/features/media/domain/mediaProcessor';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import type {
  StoryboardExportOptions,
  StoryboardFrameItem,
  StoryboardSplitNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
} from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import {
  canvasToDataUrl,
  loadImageElement,
  persistImageLocally,
  reduceAspectRatio,
} from '@/features/canvas/application/imageData';
import { UiButton, UiCheckbox, UiChipButton, UiInput, UiPanel, UiSelect, UiTooltip } from '@/components/ui';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_ICON_BUTTON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { logger } from '@/lib/logger';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import { canvasMediaProcessor } from '@/features/canvas/application/canvasServices';
import {
  resolveMediaReferences,
  type MediaReference,
} from '@/features/assets/application/mediaDisplayResolver';
import { useMediaDisplayUrl, useMediaDisplayUrls } from '@/features/assets/ui/useMediaDisplayUrl';
import { outputBrowserUrlFiles } from '@/features/assets/application/browserMediaOutput';
import { runtimeMediaDisplayResolver } from '@/runtime/mediaRuntime';

type StoryboardNodeProps = NodeProps & {
  id: string;
  data: StoryboardSplitNodeData;
  selected?: boolean;
};

const STORYBOARD_NODE_WIDTH_PX = 318;
const STORYBOARD_NODE_MIN_HEIGHT_PX = 320;
const STORYBOARD_GRID_GAP_PX = 1;
const EXPORT_MAX_DIMENSION = 4096;
const EXPORT_TRACE_PREFIX = '[StoryboardExport]';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizePathSegment(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const sanitized = Array.from(trimmed)
    .filter((ch) => !/[<>:"/\\|?*]/.test(ch) && ch >= ' ')
    .join('')
    .trim()
    .replace(/\.+$/g, '');

  return sanitized || fallback;
}

function sanitizeExportLabel(raw: string, maxLength = 50): string {
  const compact = sanitizePathSegment(raw, '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.slice(0, maxLength);
}

function createStoryboardFrameFileStem(projectName: string, index: number, note: string): string {
  const frameNo = String(index + 1).padStart(2, '0');
  const noteLabel = sanitizeExportLabel(note, 60);
  return noteLabel ? `${projectName}_${frameNo}_${noteLabel}` : `${projectName}_${frameNo}`;
}

function toCssAspectRatio(aspectRatio: string): string {
  const [rawWidth = '1', rawHeight = '1'] = aspectRatio.split(':');
  const width = Number(rawWidth);
  const height = Number(rawHeight);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1 / 1';
  }

  return `${width} / ${height}`;
}

function createDefaultExportOptions(): StoryboardExportOptions {
  return {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
  };
}

function resolveExportOptions(options: StoryboardSplitNodeData['exportOptions']): StoryboardExportOptions {
  const merged = {
    ...createDefaultExportOptions(),
    ...(options ?? {}),
  };

  const rawFontSize = Number.isFinite(merged.fontSize) ? merged.fontSize : 4;
  const normalizedFontPercent = rawFontSize > 20
    ? Math.round(rawFontSize / 6)
    : rawFontSize;

  return {
    ...merged,
    fontSize: clamp(Math.round(normalizedFontPercent), 1, 20),
  };
}

function trimTextToWidth(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  const safeText = text.trim();
  if (!safeText) {
    return '';
  }

  if (context.measureText(safeText).width <= maxWidth) {
    return safeText;
  }

  let content = safeText;
  while (content.length > 1) {
    content = content.slice(0, -1);
    const withEllipsis = `${content}...`;
    if (context.measureText(withEllipsis).width <= maxWidth) {
      return withEllipsis;
    }
  }

  return '...';
}

async function applyStoryboardTextOverlay(
  imageSource: string,
  frames: StoryboardFrameItem[],
  options: StoryboardExportOptions,
  rows: number,
  cols: number,
  layout: StoryboardMergeResult
): Promise<string> {
  if (!options.showFrameIndex && !options.showFrameNote) {
    return imageSource;
  }

  const image = await loadImageElement(imageSource);
  const canvas = document.createElement('canvas');
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('导出画布初始化失败');
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.font = `${Math.max(500, Math.round(layout.fontSize * 1.2))} ${layout.fontSize}px sans-serif`;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const row = Math.floor(index / Math.max(1, cols));
    const col = index % Math.max(1, cols);
    if (row >= rows) {
      break;
    }

    const x = layout.padding + col * (layout.cellWidth + layout.gap);
    const y = layout.padding + row * (layout.cellHeight + layout.noteHeight + layout.gap);

    if (options.showFrameIndex) {
      const label = `${options.frameIndexPrefix || 'S'}${index + 1}`;
      const badgePaddingX = Math.max(6, Math.round(layout.fontSize * 0.35));
      const badgeHeight = Math.max(18, Math.round(layout.fontSize * 1.15));
      const textWidth = context.measureText(label).width;
      const badgeWidth = Math.round(textWidth + badgePaddingX * 2);

      context.fillStyle = 'rgba(0,0,0,0.65)';
      context.fillRect(x + 6, y + 6, badgeWidth, badgeHeight);
      context.fillStyle = options.textColor;
      context.fillText(label, x + 6 + badgePaddingX, y + 6 + badgeHeight / 2);
    }

    if (options.showFrameNote) {
      const note = trimTextToWidth(
        context,
        frame.note || '',
        Math.max(20, layout.cellWidth - 14)
      );

      if (!note) {
        continue;
      }

      if (options.notePlacement === 'overlay') {
        const overlayHeight = Math.max(18, Math.round(layout.fontSize * 1.35));
        const overlayY = y + layout.cellHeight - overlayHeight;
        context.fillStyle = 'rgba(0, 0, 0, 0.6)';
        context.fillRect(x, overlayY, layout.cellWidth, overlayHeight);
        context.fillStyle = options.textColor;
        context.fillText(note, x + 7, overlayY + overlayHeight / 2);
      } else if (layout.noteHeight > 0) {
        const noteY = y + layout.cellHeight + layout.noteHeight / 2;
        context.fillStyle = options.textColor;
        context.fillText(note, x + 4, noteY);
      }
    }
  }

  return canvasToDataUrl(canvas);
}

interface FrameCardProps {
  nodeId: string;
  frame: StoryboardFrameItem;
  index: number;
  frameAspectRatioCss: string;
  imageFit: StoryboardExportOptions['imageFit'];
  viewerImageList: string[];
  draggedFrameId: string | null;
  dropTargetFrameId: string | null;
  onSortStart: (frameId: string) => void;
  onSortHover: (frameId: string) => void;
  onTogglePicker: (frameId: string, x: number, y: number) => void;
  onEditFrame: (frame: StoryboardFrameItem) => void;
}

interface IncomingImageItem {
  assetId: string | null;
  previewAssetId: string | null;
  imageUrl: string | null;
  previewImageUrl: string | null;
  displayUrl: string;
  viewerUrl: string;
  referenceKey: string;
  label: string;
}

interface PanelAnchor {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

function createFrameImageReference(frame: StoryboardFrameItem): MediaReference {
  return {
    kind: 'image',
    assetId: frame.assetId,
    legacyUrl: frame.imageUrl ?? frame.previewImageUrl,
  };
}

function createFramePreviewReference(frame: StoryboardFrameItem): MediaReference {
  return {
    kind: 'image',
    assetId: frame.previewAssetId ?? frame.assetId,
    legacyUrl: frame.previewImageUrl ?? frame.imageUrl,
  };
}

const FrameCard = memo(
  ({
    nodeId,
    frame,
    index,
    frameAspectRatioCss,
    imageFit,
    viewerImageList,
    draggedFrameId,
    dropTargetFrameId,
    onSortStart,
    onSortHover,
    onTogglePicker,
    onEditFrame,
  }: FrameCardProps) => {
    const { t } = useTranslation();
    const updateStoryboardFrame = useCanvasStore((state) => state.updateStoryboardFrame);

    const imageSource = useMediaDisplayUrl(createFramePreviewReference(frame));
    const viewerSource = useMediaDisplayUrl(createFrameImageReference(frame));

    const dragging = draggedFrameId === frame.id;
    const asDropTarget = dropTargetFrameId === frame.id && !dragging;

    return (
      <div
        onPointerEnter={(event) => {
          event.stopPropagation();
          onSortHover(frame.id);
        }}
        onPointerMove={(event) => {
          event.stopPropagation();
          onSortHover(frame.id);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className={`nodrag relative bg-bg-dark/85 transition-colors ${dragging
          ? 'z-10 opacity-55 ring-1 ring-accent/65'
          : asDropTarget
            ? 'z-10 ring-1 ring-emerald-400/70'
            : ''
          }`}
      >
        <div
          className={`group/frame relative overflow-hidden bg-surface-dark ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ aspectRatio: frameAspectRatioCss }}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onSortStart(frame.id);
          }}
        >
          {frame.assetId || frame.imageUrl || frame.previewImageUrl ? (
            <CanvasNodeImage
              src={imageSource ?? ''}
              alt={`Frame ${index + 1}`}
              viewerSourceUrl={viewerSource}
              viewerImageList={viewerImageList}
              className={`h-full w-full ${imageFit === 'contain' ? 'object-contain' : 'object-cover'}`}
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-text-muted">
              空分镜
            </div>
          )}

          <UiTooltip content={t('common.edit')}>
            <button
              type="button"
              aria-label={t('common.edit')}
              className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition-all duration-150 hover:bg-black/75 group-hover/frame:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onEditFrame(frame);
              }}
            >
              <SquareArrowOutUpRight className="h-3 w-3" />
            </button>
          </UiTooltip>

          <UiTooltip content={t('common.replace')}>
            <button
              type="button"
              aria-label={t('common.replace')}
              className="absolute bottom-1 right-1 rounded bg-black/60 p-1 text-white opacity-0 transition-all duration-150 hover:bg-black/75 group-hover/frame:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePicker(frame.id, event.clientX, event.clientY);
              }}
            >
              <ImagePlus className="h-3 w-3" />
            </button>
          </UiTooltip>
        </div>

        <textarea
          value={frame.note}
          onChange={(event) => {
            const nextValue = event.target.value;
            updateStoryboardFrame(nodeId, frame.id, {
              note: nextValue,
            });
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
          placeholder={t('node.storyboardGen.framePlaceholder', { index: String(index + 1).padStart(2, '0') })}
          className="ui-scrollbar nodrag nowheel h-10 w-full resize-none overflow-y-auto border-0 border-t border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-2 py-1 text-[10px] text-text-dark outline-none focus:border-accent"
        />
      </div>
    );
  }
);

FrameCard.displayName = 'FrameCard';

export const StoryboardNode = memo(({ id, data, selected, width, height }: StoryboardNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerMenuRef = useRef<HTMLDivElement>(null);
  const exportSettingsTriggerRef = useRef<HTMLDivElement>(null);
  const exportSettingsPanelRef = useRef<HTMLDivElement>(null);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const workflowNodes = useCanvasStore(selectWorkflowNodes);
  const edges = useCanvasStore((state) => state.edges);
  const reorderStoryboardFrame = useCanvasStore((state) => state.reorderStoryboardFrame);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const updateStoryboardFrame = useCanvasStore((state) => state.updateStoryboardFrame);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const currentProjectName = useProjectStore((state) => state.currentProject?.name);

  const [draggedFrameId, setDraggedFrameId] = useState<string | null>(null);
  const [dropTargetFrameId, setDropTargetFrameId] = useState<string | null>(null);
  const [pickerState, setPickerState] = useState<{ frameId: string; x: number; y: number } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isPackingSingleImages, setIsPackingSingleImages] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExportPanelOpen, setIsExportPanelOpen] = useState(false);
  const [isExportPanelVisible, setIsExportPanelVisible] = useState(false);
  const [exportPanelAnchor, setExportPanelAnchor] = useState<PanelAnchor | null>(null);

  const orderedFrames = useMemo(
    () => [...data.frames].sort((a, b) => a.order - b.order),
    [data.frames]
  );

  const frameAspectRatio = useMemo(() => {
    return (
      data.frameAspectRatio ??
      orderedFrames.find((frame) => typeof frame.aspectRatio === 'string')?.aspectRatio ??
      '1:1'
    );
  }, [data.frameAspectRatio, orderedFrames]);

  const frameAspectRatioCss = useMemo(
    () => toCssAspectRatio(frameAspectRatio),
    [frameAspectRatio]
  );

  const gridCols = Math.max(1, data.gridCols);
  const gridRows = Math.max(1, data.gridRows);
  const totalFrames = orderedFrames.length;
  const resolvedNodeWidth = Math.max(STORYBOARD_NODE_WIDTH_PX, Math.round(width ?? STORYBOARD_NODE_WIDTH_PX));
  const resolvedNodeHeight = Math.max(
    STORYBOARD_NODE_MIN_HEIGHT_PX,
    Math.round(height ?? STORYBOARD_NODE_MIN_HEIGHT_PX)
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedNodeHeight, resolvedNodeWidth, updateNodeInternals]);

  const exportOptions = useMemo(
    () => resolveExportOptions(data.exportOptions),
    [data.exportOptions]
  );

  const incomingImageRefs = useMemo(() => {
    const nodeById = new Map(workflowNodes.map((node) => [node.id, node] as const));
    const sourceNodeIds = edges
      .filter((edge) => edge.target === id)
      .map((edge) => edge.source);

    const dedupedImages = new Map<string, {
      assetId: string | null;
      previewAssetId: string | null;
      imageUrl: string | null;
      previewImageUrl: string | null;
    }>();
    for (const sourceNodeId of sourceNodeIds) {
      const sourceNode = nodeById.get(sourceNodeId);
      if (!sourceNode) {
        continue;
      }
      if (!isUploadNode(sourceNode) && !isImageEditNode(sourceNode) && !isExportImageNode(sourceNode)) {
        continue;
      }
      const assetId = sourceNode.data.assetId?.trim() || null;
      const imageUrl = sourceNode.data.imageUrl;
      if (!assetId && !imageUrl) {
        continue;
      }
      const referenceKey = assetId ? `asset:${assetId}` : `legacy:${imageUrl}`;
      if (!dedupedImages.has(referenceKey)) {
        dedupedImages.set(referenceKey, {
          assetId,
          previewAssetId: sourceNode.data.previewAssetId?.trim() || null,
          imageUrl,
          previewImageUrl: sourceNode.data.previewImageUrl ?? null,
        });
      }
    }

    return Array.from(dedupedImages.entries()).map(([referenceKey, item]) => ({
      ...item,
      referenceKey,
    }));
  }, [edges, id, workflowNodes]);

  const incomingPreviewReferences = useMemo(
    () => incomingImageRefs.map((item) => ({
      kind: 'image' as const,
      assetId: item.previewAssetId ?? item.assetId,
      legacyUrl: item.previewImageUrl ?? item.imageUrl,
    })),
    [incomingImageRefs],
  );
  const incomingViewerReferences = useMemo(
    () => incomingImageRefs.map((item) => ({
      kind: 'image' as const,
      assetId: item.assetId,
      legacyUrl: item.imageUrl ?? item.previewImageUrl,
    })),
    [incomingImageRefs],
  );
  const incomingDisplayUrls = useMediaDisplayUrls(incomingPreviewReferences);
  const incomingViewerUrls = useMediaDisplayUrls(incomingViewerReferences);

  const incomingImageItems = useMemo<IncomingImageItem[]>(
    () =>
      incomingImageRefs.map((item, index) => ({
        assetId: item.assetId,
        previewAssetId: item.previewAssetId,
        imageUrl: item.imageUrl,
        previewImageUrl: item.previewImageUrl,
        displayUrl: incomingDisplayUrls[index] ?? '',
        viewerUrl: incomingViewerUrls[index] ?? '',
        referenceKey: item.referenceKey,
        label: `图${index + 1}`,
      })),
    [incomingDisplayUrls, incomingImageRefs, incomingViewerUrls]
  );
  const frameViewerReferences = useMemo(
    () => orderedFrames.map(createFrameImageReference),
    [orderedFrames],
  );
  const frameViewerUrls = useMediaDisplayUrls(frameViewerReferences);
  const frameViewerImageList = useMemo(
    () => frameViewerUrls.filter((item): item is string => Boolean(item)),
    [frameViewerUrls]
  );
  const incomingImageViewerList = useMemo(
    () => incomingViewerUrls.filter((item): item is string => Boolean(item)),
    [incomingViewerUrls]
  );

  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!rootRef.current) {
        return;
      }

      const target = event.target as Node;
      const insideRoot = rootRef.current.contains(target);
      const insidePickerMenu = pickerMenuRef.current?.contains(target) ?? false;
      const insideExportPanel = exportSettingsPanelRef.current?.contains(target) ?? false;
      const insideExportTrigger = exportSettingsTriggerRef.current?.contains(target) ?? false;
      const insideSelectMenu = target instanceof Element && target.closest('[role="listbox"]') !== null;

      if (!insideRoot && !insidePickerMenu) {
        setPickerState(null);
      }

      if (!insideExportPanel && !insideExportTrigger && !insideSelectMenu) {
        setIsExportPanelOpen(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, []);

  useEffect(() => {
    if (!isExportPanelOpen) {
      setIsExportPanelVisible(false);
      return;
    }

    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setIsExportPanelVisible(true);
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) {
        cancelAnimationFrame(raf2);
      }
    };
  }, [isExportPanelOpen]);

  const getPanelAnchor = useCallback((triggerElement: HTMLDivElement | null): PanelAnchor | null => {
    if (!triggerElement) {
      return null;
    }
    const rect = triggerElement.getBoundingClientRect();
    const shouldOpenBelow = rect.top < 360;
    return {
      left: rect.left + rect.width / 2,
      top: shouldOpenBelow ? rect.bottom + 8 : rect.top - 8,
      placement: shouldOpenBelow ? 'below' : 'above',
    };
  }, []);

  const patchExportOptions = useCallback(
    (patch: Partial<StoryboardExportOptions>) => {
      updateNodeData(id, {
        exportOptions: {
          ...exportOptions,
          ...patch,
        },
      });
    },
    [exportOptions, id, updateNodeData]
  );

  const handleSortStart = useCallback((frameId: string) => {
    setDraggedFrameId(frameId);
    setDropTargetFrameId(frameId);
    setPickerState(null);
  }, []);

  const handleSortHover = useCallback(
    (frameId: string) => {
      if (!draggedFrameId) {
        return;
      }
      setDropTargetFrameId(frameId);
    },
    [draggedFrameId]
  );

  const finalizeSort = useCallback(() => {
    if (!draggedFrameId) {
      return;
    }

    if (dropTargetFrameId && dropTargetFrameId !== draggedFrameId) {
      reorderStoryboardFrame(id, draggedFrameId, dropTargetFrameId);
    }

    setDraggedFrameId(null);
    setDropTargetFrameId(null);
  }, [draggedFrameId, dropTargetFrameId, id, reorderStoryboardFrame]);

  useEffect(() => {
    if (!draggedFrameId) {
      return;
    }

    const handlePointerUp = () => {
      finalizeSort();
    };

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [draggedFrameId, finalizeSort]);

  const handleEditFrame = useCallback(
    async (frame: StoryboardFrameItem) => {
      let releaseFrame: () => void = () => undefined;
      try {
        const resolvedFrame = await resolveMediaReferences(
          runtimeMediaDisplayResolver,
          [createFrameImageReference(frame)],
        );
        releaseFrame = resolvedFrame.release;
        const sourceImage = resolvedFrame.urls[0];
        if (!sourceImage) {
          setExportError('该分镜没有可编辑图片');
          return;
        }
        const frameIndex = orderedFrames.findIndex((item) => item.id === frame.id);
        const frameTitle = frameIndex >= 0
          ? `分镜 ${frameIndex + 1}`
          : EXPORT_RESULT_DISPLAY_NAME.storyboardFrameEdit;

        const frameImage = await loadImageElement(sourceImage);
        const projectId = useProjectStore.getState().getCurrentProject()?.id;
        const written = await canvasMediaProcessor.writeDerivedImage({
          source: sourceImage,
          projectId,
          width: frameImage.naturalWidth,
          height: frameImage.naturalHeight,
        });
        const prepared = written ? null : await canvasMediaProcessor.prepareImage(sourceImage, { projectId });
        const createdNodeId = addDerivedExportNode(
          id,
          prepared?.imageUrl ?? null,
          written?.aspectRatio ?? prepared?.aspectRatio ?? '1:1',
          prepared?.previewImageUrl ?? null,
          {
            ...(written ? { assetId: written.assetId } : {}),
            defaultTitle: frameTitle,
            resultKind: 'storyboardFrameEdit',
            connectSource: true,
          }
        );
        void createdNodeId;
      } catch (error) {
        setExportError(error instanceof Error ? error.message : '创建编辑节点失败');
      } finally {
        releaseFrame();
      }
    },
    [addDerivedExportNode, id, orderedFrames]
  );

  const handleExport = useCallback(async () => {
    if (isExporting) {
      return;
    }

    const traceId = `${id}-${Date.now()}`;
    const traceStart = performance.now();
    logger.info(`${EXPORT_TRACE_PREFIX} start`, {
      traceId,
      nodeId: id,
      rows: gridRows,
      cols: gridCols,
      frameCount: orderedFrames.length,
    });

    setIsExporting(true);
    setExportError(null);
    let releaseFrameSources: () => void = () => undefined;

    try {
      const stageFrameStart = performance.now();
      const resolvedFrames = await resolveMediaReferences(
        runtimeMediaDisplayResolver,
        orderedFrames.map(createFrameImageReference),
      );
      releaseFrameSources = resolvedFrames.release;
      const frameSources = resolvedFrames.urls.map((source) => source ?? '');
      if (frameSources.every((source) => !source)) {
        throw new Error('没有可导出的图片');
      }
      logger.info(`${EXPORT_TRACE_PREFIX} frame-sources-ready`, {
        traceId,
        elapsedMs: Math.round(performance.now() - stageFrameStart),
        nonEmptyFrames: frameSources.filter((source) => source.length > 0).length,
      });

      const options = exportOptions;
      const rawGap = clamp(Math.round(options.cellGap), 0, 120);
      const rawPadding = clamp(Math.round(options.outerPadding), 0, 360);
      const fontPercent = clamp(Number.isFinite(options.fontSize) ? options.fontSize : 4, 1, 20);
      const firstFrameSource = frameSources.find((source) => source.length > 0) ?? null;
      let referenceFrameHeight = 1024;
      if (firstFrameSource) {
        const fontProbeStart = performance.now();
        try {
          const referenceImage = await loadImageElement(firstFrameSource);
          referenceFrameHeight = Math.max(
            64,
            referenceImage.naturalHeight || referenceImage.height || referenceFrameHeight
          );
        } catch {
          // Keep fallback size when reference frame cannot be read.
        }
        logger.info(`${EXPORT_TRACE_PREFIX} font-reference-resolved`, {
          traceId,
          elapsedMs: Math.round(performance.now() - fontProbeStart),
          referenceFrameHeight,
        });
      }
      const rawFontSize = clamp(
        Math.round(referenceFrameHeight * (fontPercent / 100)),
        10,
        240
      );
      const rawNoteHeight =
        options.showFrameNote && options.notePlacement === 'bottom'
          ? Math.max(Math.round(rawFontSize * 1.7), 24)
          : 0;

      const mergeStart = performance.now();
      const projectId = useProjectStore.getState().getCurrentProject()?.id;
      const mergeResult = await canvasMediaProcessor.mergeStoryboard({
        frameSources,
        rows: gridRows,
        cols: gridCols,
        cellGap: rawGap,
        outerPadding: rawPadding,
        noteHeight: rawNoteHeight,
        fontSize: rawFontSize,
        backgroundColor: options.backgroundColor,
        maxDimension: EXPORT_MAX_DIMENSION,
        showFrameIndex: options.showFrameIndex,
        showFrameNote: options.showFrameNote,
        notePlacement: options.notePlacement,
        imageFit: options.imageFit,
        frameIndexPrefix: options.frameIndexPrefix,
        textColor: options.textColor,
        frameNotes: orderedFrames.map((frame) => frame.note ?? ''),
        projectId,
      });
      logger.info(`${EXPORT_TRACE_PREFIX} merge-done`, {
        traceId,
        elapsedMs: Math.round(performance.now() - mergeStart),
        canvasWidth: mergeResult.canvasWidth,
        canvasHeight: mergeResult.canvasHeight,
        textOverlayApplied: mergeResult.textOverlayApplied,
      });

      const aspectRatio = reduceAspectRatio(mergeResult.canvasWidth, mergeResult.canvasHeight);
      const needsOverlay = (options.showFrameIndex || options.showFrameNote) && !mergeResult.textOverlayApplied;
      let finalImagePath = mergeResult.imagePath;
      let finalPreviewPath = mergeResult.imagePath;

      if (needsOverlay) {
        const overlayStart = performance.now();
        const mergedBlob = await applyStoryboardTextOverlay(
          mergeResult.imagePath,
          orderedFrames,
          options,
          gridRows,
          gridCols,
          mergeResult
        );
        logger.info(`${EXPORT_TRACE_PREFIX} overlay-done`, {
          traceId,
          elapsedMs: Math.round(performance.now() - overlayStart),
          dataUrlLength: mergedBlob.length,
        });
        const persistStart = performance.now();
        finalImagePath = await persistImageLocally(mergedBlob);
        finalPreviewPath = finalImagePath;
        logger.info(`${EXPORT_TRACE_PREFIX} overlay-persisted`, {
          traceId,
          elapsedMs: Math.round(performance.now() - persistStart),
          persistedPath: finalImagePath,
        });
      }

      const metadataStart = performance.now();
      const metadataFrameNotes = orderedFrames.map((frame) => frame.note ?? '');
      const imagePathWithMetadata = await canvasMediaProcessor.embedStoryboardMetadata(finalImagePath, {
        gridRows,
        gridCols,
        frameNotes: metadataFrameNotes,
      }).catch((error) => {
        logger.warn('[StoryboardMetadata] embed failed on storyboard export', error);
        return finalImagePath;
      });
      finalImagePath = imagePathWithMetadata;
      finalPreviewPath = imagePathWithMetadata;
      logger.info(`${EXPORT_TRACE_PREFIX} metadata-embedded`, {
        traceId,
        elapsedMs: Math.round(performance.now() - metadataStart),
        imagePath: finalImagePath,
      });

      const createNodeStart = performance.now();
      const browserAsset = await canvasMediaProcessor.writeDerivedImage({
        source: finalImagePath,
        projectId,
        width: mergeResult.canvasWidth,
        height: mergeResult.canvasHeight,
        metadata: {
          gridRows,
          gridCols,
          frameNotes: metadataFrameNotes,
          exportOptions: options,
        },
      });
      const createdNodeId = addDerivedExportNode(
        id,
        browserAsset ? null : finalImagePath,
        browserAsset?.aspectRatio ?? aspectRatio,
        browserAsset ? null : finalPreviewPath,
        {
          ...(browserAsset ? { assetId: browserAsset.assetId } : {}),
          defaultTitle: EXPORT_RESULT_DISPLAY_NAME.storyboardSplitExport,
          resultKind: 'storyboardSplitExport',
          connectSource: true,
        }
      );
      logger.info(`${EXPORT_TRACE_PREFIX} derived-node-created`, {
        traceId,
        elapsedMs: Math.round(performance.now() - createNodeStart),
        createdNodeId,
      });

      logger.info(`${EXPORT_TRACE_PREFIX} done`, {
        traceId,
        totalElapsedMs: Math.round(performance.now() - traceStart),
      });
    } catch (error) {
      logger.error(`${EXPORT_TRACE_PREFIX} failed`, {
        traceId,
        elapsedMs: Math.round(performance.now() - traceStart),
        error,
      });
      setExportError(error instanceof Error ? error.message : '导出失败');
    } finally {
      releaseFrameSources();
      setIsExporting(false);
    }
  }, [
    addDerivedExportNode,
    exportOptions,
    gridCols,
    gridRows,
    id,
    isExporting,
    orderedFrames,
  ]);

  const handlePackSingleImages = useCallback(async (intent: 'download' | 'directory' = 'download') => {
    if (isExporting || isPackingSingleImages) {
      return;
    }

    setExportError(null);
    setIsPackingSingleImages(true);
    let releaseFrameSources: () => void = () => undefined;

    try {
      const resolvedFrames = await resolveMediaReferences(
        runtimeMediaDisplayResolver,
        orderedFrames.map(createFrameImageReference),
      );
      releaseFrameSources = resolvedFrames.release;
      const frameEntries = orderedFrames
        .map((frame, index) => ({
          source: resolvedFrames.urls[index] ?? '',
          index,
          note: frame.note ?? '',
        }))
        .filter((item) => item.source.length > 0);

      if (frameEntries.length === 0) {
        throw new Error('该分镜没有可导出的图片');
      }

        const fileProjectName = sanitizeExportLabel(currentProjectName ?? '', 40) || 'storyboard';
        const result = await outputBrowserUrlFiles({
          intent,
          archiveFileName: `${fileProjectName}-storyboard.zip`,
          forceArchive: true,
          files: frameEntries.map((item) => ({
            id: orderedFrames[item.index]?.id ?? String(item.index),
            fileName: `${createStoryboardFrameFileStem(fileProjectName, item.index, item.note)}.png`,
            url: item.source,
          })),
        });
        if (result.failures.length > 0) {
          setExportError(t('fileOutput.partialFailure', {
            saved: result.files.length,
            total: result.files.length + result.failures.length,
            files: result.failures.map((failure) => failure.fileName).join(', '),
          }));
        }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '打包下载失败');
    } finally {
      releaseFrameSources();
      setIsPackingSingleImages(false);
    }
  }, [
    currentProjectName,
    isExporting,
    isPackingSingleImages,
    orderedFrames,
    t,
  ]);

  const isAnyExporting = isExporting || isPackingSingleImages;

  const handleTogglePicker = useCallback((frameId: string, x: number, y: number) => {
    setPickerState((previous) => {
      if (previous?.frameId === frameId) {
        return null;
      }
      return { frameId, x, y };
    });
  }, []);

  const handleReplaceFromInput = useCallback(
    (frameId: string, referenceKey: string) => {
      setExportError(null);
      const matched = incomingImageItems.find((item) => item.referenceKey === referenceKey);
      if (!matched) {
        return;
      }
      updateStoryboardFrame(id, frameId, {
        assetId: matched.assetId,
        previewAssetId: matched.previewAssetId,
        imageUrl: matched.imageUrl,
        previewImageUrl: matched.previewImageUrl ?? matched.imageUrl,
      });
      setPickerState(null);
    },
    [id, incomingImageItems, updateStoryboardFrame]
  );

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150
        ${resolveNodeSurfaceStateClass(selected)}
      `}
      style={{ width: `${resolvedNodeWidth}px`, height: `${resolvedNodeHeight}px` }}
      onClick={() => setSelectedNode(id)}
    >
      <div
        className="ui-scrollbar nowheel min-h-0 flex-1 overflow-auto"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <div
          className="grid overflow-hidden rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-border-soft)]"
          style={{
            gap: `${STORYBOARD_GRID_GAP_PX}px`,
            gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
          }}
        >
          {orderedFrames.map((frame, index) => (
            <FrameCard
              key={frame.id}
              nodeId={id}
              frame={frame}
              index={index}
              frameAspectRatioCss={frameAspectRatioCss}
              imageFit={exportOptions.imageFit}
              viewerImageList={frameViewerImageList}
              draggedFrameId={draggedFrameId}
              dropTargetFrameId={dropTargetFrameId}
              onSortStart={handleSortStart}
              onSortHover={handleSortHover}
              onTogglePicker={handleTogglePicker}
              onEditFrame={(targetFrame) => {
                void handleEditFrame(targetFrame);
              }}
            />
          ))}
        </div>
      </div>

      {pickerState && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={pickerMenuRef}
            className="nowheel fixed z-[140] w-[120px] overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] shadow-[var(--ui-shadow-panel)]"
            style={{ left: `${pickerState.x}px`, top: `${pickerState.y}px` }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {incomingImageItems.length > 0 ? (
              <div
                className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
                onWheelCapture={(event) => event.stopPropagation()}
              >
                {incomingImageItems.map((item) => (
                  <button
                    key={`${pickerState.frameId}-${item.referenceKey}`}
                    type="button"
                    className="flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:bg-[var(--ui-hover)]"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleReplaceFromInput(pickerState.frameId, item.referenceKey);
                    }}
                    title={item.label}
                  >
                    <CanvasNodeImage
                      src={item.displayUrl}
                      alt={item.label}
                      viewerSourceUrl={item.viewerUrl}
                      viewerImageList={incomingImageViewerList}
                      className="h-8 w-8 rounded object-cover"
                      draggable={false}
                      showResolutionPreview={false}
                    />
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-2 py-2 text-sm text-text-muted">
                暂无输入图片
              </div>
            )}
          </div>,
          document.body
        )
        : null}

      <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div ref={exportSettingsTriggerRef} className="nodrag relative flex">
            <UiChipButton
              active={isExportPanelOpen}
              className={NODE_CONTROL_CHIP_CLASS}
              onClick={(event) => {
                event.stopPropagation();
                if (isExportPanelOpen) {
                  setIsExportPanelOpen(false);
                  return;
                }
                setExportPanelAnchor(getPanelAnchor(exportSettingsTriggerRef.current));
                setIsExportPanelOpen(true);
              }}
            >
              <SlidersHorizontal className={`${NODE_CONTROL_ICON_CLASS} shrink-0`} />
              <span>导出设置</span>
            </UiChipButton>
          </div>

          <div className="truncate text-[11px] text-text-muted/80">
            {gridRows} x {gridCols} | {totalFrames} 格
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <UiButton
            size="sm"
            variant="muted"
            className={`nodrag ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              void handlePackSingleImages();
            }}
            disabled={isAnyExporting}
          >
            <Download className={NODE_CONTROL_ICON_CLASS} />
            {isPackingSingleImages ? '打包中...' : '打包下载'}
          </UiButton>
          <UiTooltip content={t('fileOutput.saveToFolder')}>
            <UiButton
              size="sm"
              variant="muted"
              aria-label={t('fileOutput.saveToFolder')}
              className={`nodrag ${NODE_CONTROL_ICON_BUTTON_CLASS}`}
              onClick={(event) => {
                event.stopPropagation();
                void handlePackSingleImages('directory');
              }}
              disabled={isAnyExporting}
            >
              <FolderOpen className={NODE_CONTROL_ICON_CLASS} />
            </UiButton>
          </UiTooltip>
          <UiButton
            size="sm"
            variant="primary"
            className={`nodrag ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              void handleExport();
            }}
            disabled={isAnyExporting}
          >
            <Download className={NODE_CONTROL_ICON_CLASS} />
            {isExporting ? '导出中...' : '合并分镜'}
          </UiButton>
        </div>
      </div>

      {typeof document !== 'undefined' && isExportPanelOpen && createPortal(
        <div
          ref={exportSettingsPanelRef}
          className={`fixed z-[120] w-[340px] transition-opacity duration-200 ease-out ${isExportPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          style={exportPanelAnchor
            ? {
              left: exportPanelAnchor.left,
              top: exportPanelAnchor.top,
              transform: `translateX(-50%) ${exportPanelAnchor.placement === 'above' ? 'translateY(-100%)' : 'translateY(0)'}`,
            }
            : undefined}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <UiPanel className="p-2.5">
            <div className="space-y-2 text-xs text-text-muted">
              <label className="flex items-center gap-2">
                <UiCheckbox
                  aria-label="显示分镜序号"
                  checked={exportOptions.showFrameIndex}
                  onCheckedChange={(checked) => patchExportOptions({ showFrameIndex: checked })}
                />
                显示分镜序号
              </label>

              <label className="flex items-center gap-2">
                <UiCheckbox
                  aria-label="显示分镜描述"
                  checked={exportOptions.showFrameNote}
                  onCheckedChange={(checked) => patchExportOptions({ showFrameNote: checked })}
                />
                显示分镜描述
              </label>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1">图片填充</div>
                  <UiSelect
                    value={exportOptions.imageFit}
                    onChange={(event) =>
                      patchExportOptions({
                        imageFit: event.target.value === 'contain' ? 'contain' : 'cover',
                      })
                    }
                  >
                    <option value="cover">填充满格子</option>
                    <option value="contain">完整显示</option>
                  </UiSelect>
                </div>
                <div>
                  <div className="mb-1">序号前缀</div>
                  <UiInput
                    value={exportOptions.frameIndexPrefix}
                    maxLength={4}
                    className="h-8"
                    onChange={(event) => patchExportOptions({ frameIndexPrefix: event.target.value })}
                  />
                </div>
                <div>
                  <div className="mb-1">描述位置</div>
                  <UiSelect
                    value={exportOptions.notePlacement}
                    onChange={(event) =>
                      patchExportOptions({
                        notePlacement: event.target.value === 'bottom' ? 'bottom' : 'overlay',
                      })
                    }
                  >
                    <option value="overlay">图上遮罩</option>
                    <option value="bottom">图下文字</option>
                  </UiSelect>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1">间距</div>
                  <UiInput
                    type="number"
                    min={0}
                    max={120}
                    value={exportOptions.cellGap}
                    className="h-8"
                    onChange={(event) =>
                      patchExportOptions({ cellGap: Number(event.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <div className="mb-1">字号(%)</div>
                  <UiInput
                    type="number"
                    min={1}
                    max={20}
                    value={exportOptions.fontSize}
                    className="h-8"
                    onChange={(event) =>
                      patchExportOptions({ fontSize: Number(event.target.value) || 4 })
                    }
                  />
                </div>
                <div>
                  <div className="mb-1">{t('storyboard.export.outerPadding')}</div>
                  <UiInput
                    type="number"
                    min={0}
                    max={360}
                    value={exportOptions.outerPadding}
                    className="h-8"
                    onChange={(event) =>
                      patchExportOptions({ outerPadding: Number(event.target.value) || 0 })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2">
                  <span>背景</span>
                  <input
                    type="color"
                    value={exportOptions.backgroundColor}
                    onChange={(event) => patchExportOptions({ backgroundColor: event.target.value })}
                    className="h-7 w-full rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span>文字</span>
                  <input
                    type="color"
                    value={exportOptions.textColor}
                    onChange={(event) => patchExportOptions({ textColor: event.target.value })}
                    className="h-7 w-full rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
                  />
                </label>
              </div>
            </div>
          </UiPanel>
        </div>,
        document.body
      )}

      {exportError && <div className="mt-2 shrink-0 text-xs text-red-400">{exportError}</div>}

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
        minWidth={STORYBOARD_NODE_WIDTH_PX}
        minHeight={STORYBOARD_NODE_MIN_HEIGHT_PX}
        maxWidth={1800}
        maxHeight={1600}
      />

    </div>
  );
});

StoryboardNode.displayName = 'StoryboardNode';
