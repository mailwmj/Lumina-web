import {
  memo,
  useCallback,
  useState,
  useEffect,
  useMemo,
  useRef,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Video, Image as ImageIcon, Music } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type SD2VideoGenNodeData,
  type SD2GenerationMode,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import { resolveImageDisplayUrl, resolveVideoDisplayUrl, resolveAudioDisplayUrl } from '@/features/canvas/application/imageData';
import {
  TEXT_GENERATION_MAX_HEIGHT,
  TEXT_GENERATION_MAX_WIDTH,
  TEXT_GENERATION_MIN_HEIGHT,
  TEXT_GENERATION_MIN_WIDTH,
} from '@/features/canvas/application/textGenerationLayout';
import {
  findReferenceTokens,
  resolveReferenceAwareDeleteRange,
  removeTextRange,
  insertReferenceToken,
} from '@/features/canvas/application/referenceTokenEditing';
import { usePreserveNodeCenterOnAutoResize } from '@/features/canvas/ui/usePreserveNodeCenterOnAutoResize';

type SD2VideoGenNodeProps = NodeProps & {
  id: string;
  data: SD2VideoGenNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

const SD_2_0_MODEL = 'doubao-seedance-2-0-260128';
const SD_2_0_FAST_MODEL = 'doubao-seedance-2-0-fast-260128';

const GENERATION_MODES: { value: SD2GenerationMode; labelKey: string; icon: React.ReactNode }[] = [
  { value: 'multimodal', labelKey: 'node.sd2VideoGen.mode.multimodal', icon: <ImageIcon className="h-3 w-3" /> },
  { value: 'edit', labelKey: 'node.sd2VideoGen.mode.edit', icon: <Video className="h-3 w-3" /> },
  { value: 'extend', labelKey: 'node.sd2VideoGen.mode.extend', icon: <Music className="h-3 w-3" /> },
];

const MODE_LIMITS: Record<SD2GenerationMode, { images: number; audios: number; videos: number }> = {
  multimodal: { images: 9, audios: 3, videos: 3 },
  edit: { images: 9, audios: 0, videos: 1 },
  extend: { images: 0, audios: 0, videos: 3 },
};

function isModeSupportingAudio(mode: SD2GenerationMode): boolean {
  return mode === 'multimodal' || mode === 'edit';
}

function isSD2FastModel(modelId: string): boolean {
  return modelId === SD_2_0_FAST_MODEL;
}

function getResolutionsForModel(modelId: string): string[] {
  if (isSD2FastModel(modelId)) {
    return ['480p', '720p'];
  }
  return ['480p', '720p', '1080p'];
}

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = TEXT_GENERATION_MIN_WIDTH;
const MIN_HEIGHT = TEXT_GENERATION_MIN_HEIGHT;
const MAX_WIDTH = TEXT_GENERATION_MAX_WIDTH;
const MAX_HEIGHT = TEXT_GENERATION_MAX_HEIGHT;

interface PickerAnchor {
  left: number;
  top: number;
}

const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;

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
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

function renderPromptWithHighlights(
  prompt: string,
  imageUrls: string[],
  videoUrls: string[],
  audioLabels: string[]
): ReactNode {
  if (!prompt) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(prompt, Math.max(imageUrls.length, videoUrls.length, audioLabels.length));

  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>
      );
    }

    let previewUrl = '';
    let previewLabel = '';

    if (token.type === 'image' && imageUrls[token.value - 1]) {
      previewUrl = imageUrls[token.value - 1];
      previewLabel = `图${token.value}`;
    } else if (token.type === 'video' && videoUrls[token.value - 1]) {
      previewUrl = videoUrls[token.value - 1];
      previewLabel = `视频${token.value}`;
    } else if (token.type === 'audio' && audioLabels[token.value - 1]) {
      previewLabel = `音频${token.value}`;
    }

    segments.push(
      <span
        key={`ref-${matchStart}`}
        data-highlight-ref="true"
        data-ref-type={token.type}
        data-ref-index={token.value}
        data-preview-url={previewUrl}
        data-preview-label={previewLabel}
        className="relative z-0 text-[var(--accent-foreground)] before:absolute before:-inset-x-[4px] before:-inset-y-[1px] before:-z-10 before:rounded-[7px] before:bg-accent/85 before:content-['']"
      >
        {matchText}
      </span>
    );

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }

  return segments;
}

export const SD2VideoGenNode = memo(({ id, data, selected, width, height }: SD2VideoGenNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const workflowNodes = useCanvasStore(selectWorkflowNodes);
  const edges = useCanvasStore((state) => state.edges);

  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));

  usePreserveNodeCenterOnAutoResize({
    nodeId: id,
    height: resolvedHeight,
    enabled: !data.isSizeManuallyAdjusted,
  });

  const generationMode = data.generationMode || 'multimodal';
  const limits = MODE_LIMITS[generationMode];
  const currentModel = data.model || SD_2_0_MODEL;
  const availableResolutions = getResolutionsForModel(currentModel);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const promptInputContainerRef = useRef<HTMLDivElement>(null);
  const highlightMouseLeaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [referenceHover, setReferenceHover] = useState<{
    refType: 'image' | 'video' | 'audio';
    index: number;
    previewUrl: string;
    anchorRect: DOMRect;
  } | null>(null);

  const [promptDraft, setPromptDraft] = useState(data.prompt || '');

  // Update node internals when dimensions change
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // Get connected nodes from edges
  const connectedImageNodes = useMemo(() => {
    if (limits.images === 0) return [];
    const imageEdges = edges.filter(
      (e) => e.target === id && e.targetHandle === 'target-images'
    );
    return imageEdges
      .map((edge) => workflowNodes.find((node) => node.id === edge.source))
      .filter((n) => n && n.type === CANVAS_NODE_TYPES.upload);
  }, [edges, id, workflowNodes, limits.images]);

  const connectedAudioNodes = useMemo(() => {
    if (limits.audios === 0 || !isModeSupportingAudio(generationMode)) return [];
    const audioEdges = edges.filter(
      (e) => e.target === id && e.targetHandle === 'target-audios'
    );
    return audioEdges
      .map((edge) => workflowNodes.find((node) => node.id === edge.source))
      .filter(
        (n) =>
          n &&
          (n.type === CANVAS_NODE_TYPES.audioUpload ||
            n.type === CANVAS_NODE_TYPES.audioUploadRef)
      );
  }, [edges, id, workflowNodes, limits.audios, limits.images, generationMode]);

  const connectedVideoNodes = useMemo(() => {
    if (limits.videos === 0) return [];
    const videoEdges = edges.filter(
      (e) => e.target === id && e.targetHandle === 'target-videos'
    );
    return videoEdges
      .map((edge) => workflowNodes.find((node) => node.id === edge.source))
      .filter(
        (n) =>
          n &&
          (n.type === CANVAS_NODE_TYPES.videoUpload ||
            n.type === CANVAS_NODE_TYPES.videoUploadRef)
      );
  }, [edges, id, workflowNodes, limits.videos]);

  // Prepare display URLs and labels for references
  const imageUrlsForHighlight = useMemo(() => {
    return connectedImageNodes.map((node) => {
      const nodeData = node!.data as { imageUrl?: string; previewImageUrl?: string };
      return resolveImageDisplayUrl(nodeData.previewImageUrl || nodeData.imageUrl || '');
    });
  }, [connectedImageNodes]);

  const videoUrlsForHighlight = useMemo(() => {
    return connectedVideoNodes.map((node) => {
      const nodeData = node!.data as { videoUrl?: string; previewVideoUrl?: string };
      return resolveVideoDisplayUrl(nodeData.previewVideoUrl || nodeData.videoUrl || '');
    });
  }, [connectedVideoNodes]);

  const audioLabelsForHighlight = useMemo(() => {
    return connectedAudioNodes.map((node) => {
      const nodeData = node!.data as { sourceFileName?: string };
      return nodeData.sourceFileName || '';
    });
  }, [connectedAudioNodes]);

  // Reference picker items based on current mode
  const referencePickerItems = useMemo(() => {
    const items: { type: 'image' | 'video' | 'audio'; index: number; label: string; previewUrl?: string }[] = [];

    if (limits.images > 0) {
      connectedImageNodes.forEach((node, idx) => {
        const nodeData = node!.data as { imageUrl?: string; previewImageUrl?: string };
        items.push({
          type: 'image',
          index: idx + 1,
          label: `图${idx + 1}`,
          previewUrl: resolveImageDisplayUrl(nodeData.previewImageUrl || nodeData.imageUrl || ''),
        });
      });
    }

    if (limits.videos > 0) {
      connectedVideoNodes.forEach((node, idx) => {
        const nodeData = node!.data as { videoUrl?: string; previewVideoUrl?: string };
        items.push({
          type: 'video',
          index: idx + 1,
          label: `视频${idx + 1}`,
          previewUrl: resolveVideoDisplayUrl(nodeData.previewVideoUrl || nodeData.videoUrl || ''),
        });
      });
    }

    if (limits.audios > 0 && isModeSupportingAudio(generationMode)) {
      connectedAudioNodes.forEach((node, idx) => {
        const nodeData = node!.data as { sourceFileName?: string };
        items.push({
          type: 'audio',
          index: idx + 1,
          label: `音频${idx + 1}`,
          previewUrl: resolveAudioDisplayUrl(nodeData.sourceFileName || ''),
        });
      });
    }

    return items;
  }, [limits, connectedImageNodes, connectedVideoNodes, connectedAudioNodes, generationMode]);

  // Update promptDraft when data.prompt changes externally
  useEffect(() => {
    setPromptDraft(data.prompt || '');
  }, [data.prompt]);

  const syncPromptHighlightScroll = () => {
    if (!promptRef.current || !promptHighlightRef.current) {
      return;
    }
    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  };

  // Picker state
  const [showReferencePicker, setShowReferencePicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<{ left: number; top: number }>({ left: 8, top: 8 });
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const promptDraftRef = useRef(promptDraft);

  // Sync promptDraftRef when promptDraft changes
  useEffect(() => {
    promptDraftRef.current = promptDraft;
  }, [promptDraft]);

  const commitPromptDraft = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    updateNodeData(id, { prompt: nextPrompt });
  }, [id, updateNodeData]);

  // Handle clicking outside to close reference picker
  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      setShowReferencePicker(false);
      setPickerCursor(null);
    };
    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  const insertReference = useCallback((refType: 'image' | 'video' | 'audio', refIndex: number) => {
    const markers = { image: '图', video: '视频', audio: '音频' };
    const marker = `@${markers[refType]}${refIndex}`;
    const currentPrompt = promptDraftRef.current;
    const cursor = pickerCursor ?? currentPrompt.length;
    const { nextText: nextPrompt, nextCursor } = insertReferenceToken(currentPrompt, cursor, marker);

    setPromptDraft(nextPrompt);
    commitPromptDraft(nextPrompt);
    setShowReferencePicker(false);
    setPickerCursor(null);
    setPickerActiveIndex(0);

    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  }, [commitPromptDraft, pickerCursor]);

  const handlePromptKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const currentPrompt = promptDraftRef.current;
    const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;

    // Handle backspace/delete with reference awareness
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const deletionDirection = event.key === 'Backspace' ? 'backward' : 'forward';
      const deleteRange = resolveReferenceAwareDeleteRange(
        currentPrompt,
        selectionStart,
        selectionEnd,
        deletionDirection,
        Math.max(imageUrlsForHighlight.length, videoUrlsForHighlight.length, audioLabelsForHighlight.length)
      );
      if (deleteRange) {
        event.preventDefault();
        const { nextText, nextCursor } = removeTextRange(currentPrompt, deleteRange);
        setPromptDraft(nextText);
        commitPromptDraft(nextText);
        requestAnimationFrame(() => {
          promptRef.current?.focus();
          promptRef.current?.setSelectionRange(nextCursor, nextCursor);
          syncPromptHighlightScroll();
        });
        return;
      }
    }

    // Keyboard navigation in picker
    if (showReferencePicker && referencePickerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous + 1) % referencePickerItems.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((previous) =>
          previous === 0 ? referencePickerItems.length - 1 : previous - 1
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const item = referencePickerItems[pickerActiveIndex];
        if (item) {
          insertReference(item.type, item.index);
        }
        return;
      }
    }

    // Show picker on @ key
    if (event.key === '@' && referencePickerItems.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
      setPickerAnchor(resolvePickerAnchor(promptInputContainerRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setShowReferencePicker(true);
      setPickerActiveIndex(0);
      return;
    }

    // Close picker on Escape
    if (event.key === 'Escape' && showReferencePicker) {
      event.preventDefault();
      setShowReferencePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }
  }, [commitPromptDraft, imageUrlsForHighlight.length, videoUrlsForHighlight.length, audioLabelsForHighlight.length, showReferencePicker, referencePickerItems.length, insertReference, pickerActiveIndex]);

  // Handle @ references hover preview
  useEffect(() => {
    const checkHighlightUnderMouse = (event: MouseEvent) => {
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
          const refType = (span as HTMLElement).dataset.refType as 'image' | 'video' | 'audio';
          const refIndex = (span as HTMLElement).dataset.refIndex;
          const previewUrl = (span as HTMLElement).dataset.previewUrl || '';
          if (refType && refIndex) {
            if (highlightMouseLeaveTimeoutRef.current) {
              clearTimeout(highlightMouseLeaveTimeoutRef.current);
              highlightMouseLeaveTimeoutRef.current = null;
            }
            setReferenceHover({
              refType,
              index: parseInt(refIndex, 10),
              previewUrl,
              anchorRect: spanRect,
            });
          }
          return;
        }
      }

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

  const handleModelChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const newModel = e.target.value;
    const newResolution = isSD2FastModel(newModel) && data.resolution === '1080p'
      ? '720p'
      : data.resolution;
    updateNodeData(id, { model: newModel, resolution: newResolution });
  }, [id, updateNodeData, data.resolution]);

  const handleModeChange = useCallback((mode: SD2GenerationMode) => {
    updateNodeData(id, {
      generationMode: mode,
      referenceImageIds: [],
      referenceAudioIds: [],
      referenceVideoIds: [],
    });
  }, [id, updateNodeData]);

  const handleResolutionChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    updateNodeData(id, { resolution: e.target.value as '480p' | '720p' | '1080p' });
  }, [id, updateNodeData]);

  const handleDurationChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    updateNodeData(id, { duration: parseInt(e.target.value, 10) });
  }, [id, updateNodeData]);

  const handleAspectRatioChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    updateNodeData(id, { aspectRatio: e.target.value });
  }, [id, updateNodeData]);

  const handleHasAudioChange = useCallback((checked: boolean) => {
    updateNodeData(id, { hasAudio: checked });
  }, [id, updateNodeData]);

  const handleWatermarkChange = useCallback((checked: boolean) => {
    updateNodeData(id, { watermark: checked });
  }, [id, updateNodeData]);

  const currentResolution = data.resolution || (availableResolutions.includes('1080p') ? '1080p' : '720p');

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150
        ${resolveNodeSurfaceStateClass(selected)}
      `}
      style={{
        width: resolvedWidth,
        height: resolvedHeight,
      }}
      onClick={() => {
        const setSelectedNode = useCanvasStore.getState().setSelectedNode;
        setSelectedNode(id);
      }}
    >
      {/* 输入 Handle（左侧） */}
      {limits.images > 0 && (
        <Handle
          type="target"
          id="target-images"
          position={Position.Left}
          style={{ top: '15%' }}
        />
      )}
      {limits.audios > 0 && isModeSupportingAudio(generationMode) && (
        <Handle
          type="target"
          id="target-audios"
          position={Position.Left}
          style={{ top: '50%' }}
        />
      )}
      {limits.videos > 0 && (
        <Handle
          type="target"
          id="target-videos"
          position={Position.Left}
          style={{ top: '85%' }}
        />
      )}

      <div className="flex h-full flex-col gap-2 overflow-hidden">

        {/* 模式选择器 */}
        <div className="flex flex-wrap gap-1 shrink-0">
          {GENERATION_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => handleModeChange(mode.value)}
              className={`
                inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors
                ${generationMode === mode.value
                  ? 'bg-accent text-[var(--accent-foreground)]'
                  : 'border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'}
              `}
            >
              {mode.icon}
              <span>{t(mode.labelKey)}</span>
            </button>
          ))}
        </div>

        {/* 模型选择 */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-text-muted">{t('node.videoGen.model')}:</span>
          <select
            className="flex-1 rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-2 py-1 font-mono text-xs text-text-dark"
            value={currentModel}
            onChange={handleModelChange}
          >
            <option value={SD_2_0_MODEL}>Seedance 2.0</option>
            <option value={SD_2_0_FAST_MODEL}>Seedance 2.0 Fast</option>
          </select>
        </div>

        {/* 参考素材预览区 */}
        {(connectedImageNodes.length > 0 || connectedVideoNodes.length > 0 || connectedAudioNodes.length > 0) && (
          <div className="flex flex-wrap gap-2 shrink-0 rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-2">
            {/* 图片预览 */}
            {connectedImageNodes.map((node, idx) => {
              const nodeData = node!.data as { imageUrl?: string; previewImageUrl?: string };
              const displayUrl = resolveImageDisplayUrl(nodeData.previewImageUrl || nodeData.imageUrl || '');
              return (
                <div key={node!.id} className="relative">
                  <img
                    src={displayUrl}
                    alt={`图${idx + 1}`}
                    className="h-12 w-12 object-cover rounded border border-border"
                  />
                  <span className="absolute -bottom-1 -right-1 bg-accent text-[var(--accent-foreground)] text-[10px] px-1 rounded">
                    图{idx + 1}
                  </span>
                </div>
              );
            })}

            {/* 视频预览 */}
            {connectedVideoNodes.map((node, idx) => {
              const nodeData = node!.data as { videoUrl?: string; previewVideoUrl?: string };
              const displayUrl = resolveVideoDisplayUrl(nodeData.previewVideoUrl || nodeData.videoUrl || '');
              return (
                <div key={node!.id} className="relative">
                  <video
                    src={displayUrl}
                    className="h-12 w-12 object-cover rounded border border-border"
                  />
                  <span className="absolute -bottom-1 -right-1 rounded bg-accent px-1 text-[10px] text-[var(--accent-foreground)]">
                    视频{idx + 1}
                  </span>
                </div>
              );
            })}

            {/* 音频预览 */}
            {connectedAudioNodes.map((node, idx) => {
              const nodeData = node!.data as { sourceFileName?: string };
              return (
                <div
                  key={node!.id}
                  className="relative flex h-12 w-12 flex-col items-center justify-center gap-0.5 overflow-hidden rounded border border-[rgb(var(--edge-rgb)/0.45)] bg-[rgb(var(--edge-rgb)/0.16)] p-0.5"
                >
                  <Music className="h-4 w-4 shrink-0 text-[var(--edge)]" />
                  <span className="w-full truncate text-center text-[9px] leading-tight text-[var(--edge)]">
                    {nodeData.sourceFileName || `音频${idx + 1}`}
                  </span>
                  <span className="absolute -bottom-0.5 -right-0.5 rounded bg-[var(--edge)] px-1 text-[10px] text-white">
                    音频{idx + 1}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* 参考素材计数 */}
        <div className="flex flex-wrap gap-2 shrink-0 text-xs text-text-muted">
          {limits.images > 0 && (
            <span className={connectedImageNodes.length >= limits.images ? 'text-accent' : ''}>
              {t('node.sd2VideoGen.imageCount', { current: connectedImageNodes.length, max: limits.images })}
            </span>
          )}
          {limits.audios > 0 && isModeSupportingAudio(generationMode) && (
            <span className={connectedAudioNodes.length >= limits.audios ? 'text-accent' : ''}>
              {t('node.sd2VideoGen.audioCount', { current: connectedAudioNodes.length, max: limits.audios })}
            </span>
          )}
          {limits.videos > 0 && (
            <span className={connectedVideoNodes.length >= limits.videos ? 'text-accent' : ''}>
              {t('node.sd2VideoGen.videoCount', { current: connectedVideoNodes.length, max: limits.videos })}
            </span>
          )}
        </div>

        {/* 控制选项 */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* 分辨率 */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-muted">{t('node.videoGen.resolution')}:</span>
            <select
              className="rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-2 py-1 font-mono text-xs text-text-dark"
              value={currentResolution}
              onChange={handleResolutionChange}
            >
              {availableResolutions.map((res) => (
                <option key={res} value={res}>{res}</option>
              ))}
            </select>
          </div>

          {/* 时长 */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-muted">{t('node.videoGen.duration')}:</span>
            <select
              className="rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-2 py-1 font-mono text-xs text-text-dark"
              value={data.duration || 5}
              onChange={handleDurationChange}
            >
              {[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((sec) => (
                <option key={sec} value={sec}>{sec}{t('node.videoGen.durationUnit')}</option>
              ))}
            </select>
          </div>

          {/* 宽高比 */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-muted">{t('node.imageNode.aspectRatio')}:</span>
            <select
              className="rounded border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-2 py-1 font-mono text-xs text-text-dark"
              value={data.aspectRatio || '16:9'}
              onChange={handleAspectRatioChange}
            >
              <option value="16:9">16:9</option>
              <option value="4:3">4:3</option>
              <option value="1:1">1:1</option>
              <option value="3:4">3:4</option>
              <option value="9:16">9:16</option>
              <option value="21:9">21:9</option>
            </select>
          </div>

          {/* 音频开关 - 仅多模态和编辑模式 */}
          {isModeSupportingAudio(generationMode) && (
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={data.hasAudio ?? true}
                onChange={(e) => handleHasAudioChange(e.target.checked)}
                className="h-3 w-3 rounded border-border bg-bg-dark text-accent focus:ring-accent"
              />
              <span className="text-xs text-text-muted">{t('node.videoGen.hasAudio')}</span>
            </label>
          )}

          {/* 水印 */}
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={data.watermark ?? false}
              onChange={(e) => handleWatermarkChange(e.target.checked)}
              className="h-3 w-3 rounded border-border bg-bg-dark text-accent focus:ring-accent"
            />
            <span className="text-xs text-text-muted">{t('node.videoGen.watermark')}</span>
          </label>
        </div>

        {/* 提示词输入 */}
        <div ref={promptInputContainerRef} className="relative min-h-0 flex-1 rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-2">
          <div className="relative h-full min-h-0">
            <div
              ref={promptHighlightRef}
              aria-hidden="true"
              className="ui-scrollbar absolute inset-0 overflow-y-auto overflow-x-hidden text-sm leading-6 text-text-dark pointer-events-none"
              style={{ scrollbarGutter: 'stable' }}
            >
              <div className="min-h-full whitespace-pre-wrap break-words px-1 py-0.5">
                {renderPromptWithHighlights(
                  promptDraft,
                  imageUrlsForHighlight,
                  videoUrlsForHighlight,
                  audioLabelsForHighlight
                )}
              </div>
            </div>
            <textarea
              ref={promptRef}
              value={promptDraft}
              onChange={(e) => {
                const nextValue = e.target.value;
                setPromptDraft(nextValue);
                updateNodeData(id, { prompt: nextValue });
              }}
              onKeyDown={handlePromptKeyDown}
              onScroll={syncPromptHighlightScroll}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={t('node.videoGen.promptPlaceholder')}
              className="ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-transparent caret-text-dark outline-none selection:text-transparent placeholder:text-text-muted/80 focus:border-transparent whitespace-pre-wrap break-words"
              style={{ scrollbarGutter: 'stable' }}
            />
          </div>

          {showReferencePicker && referencePickerItems.length > 0 && (
            <div
              className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] shadow-[var(--ui-shadow-panel)]"
              style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
              onMouseDown={(event) => event.stopPropagation()}
              onMouseDownCapture={(event) => event.stopPropagation()}
              onWheelCapture={(event) => event.stopPropagation()}
            >
              <div
                className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
                onWheelCapture={(event) => event.stopPropagation()}
              >
                {referencePickerItems.map((item, index) => (
                  <button
                    key={`${item.type}-${item.index}`}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      insertReference(item.type, item.index);
                    }}
                    onMouseEnter={() => setPickerActiveIndex(index)}
                    className={`flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:bg-[var(--ui-hover)] ${
                      pickerActiveIndex === index
                        ? 'border-accent/45 bg-accent/10'
                        : ''
                    }`}
                  >
                    {item.type === 'image' && (
                      <img
                        src={item.previewUrl}
                        alt={item.label}
                        className="h-8 w-8 rounded object-cover"
                        draggable={false}
                      />
                    )}
                    {item.type === 'video' && (
                      <video
                        src={item.previewUrl}
                        className="h-8 w-8 rounded object-cover"
                        draggable={false}
                      />
                    )}
                    {item.type === 'audio' && (
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-[rgb(var(--edge-rgb)/0.16)]">
                        <Music className="h-4 w-4 text-[var(--edge)]" />
                      </div>
                    )}
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
              {referenceHover.refType === 'image' && (
                <img
                  src={referenceHover.previewUrl}
                  alt={`图${referenceHover.index}`}
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              )}
              {referenceHover.refType === 'video' && (
                <video
                  src={referenceHover.previewUrl}
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              )}
              {referenceHover.refType === 'audio' && (
                <div className="relative flex h-full w-full items-center justify-center bg-[rgb(var(--edge-rgb)/0.16)]">
                  <Music className="h-12 w-12 text-[var(--edge)]" />
                  <span className="absolute bottom-1 right-1 rounded bg-[var(--edge)] px-1.5 py-0.5 text-[10px] font-medium text-white">
                    音频{referenceHover.index}
                  </span>
                  <span className="absolute bottom-1 left-1 right-1 truncate text-center text-[10px] text-[var(--edge)]" title={referenceHover.previewUrl}>
                    {referenceHover.previewUrl}
                  </span>
                </div>
              )}
            </div>,
            document.body
          )}
        </div>

        {/* 生成按钮 */}
        <button
          type="button"
          disabled
          className={`
            shrink-0 w-full rounded py-2 text-xs font-medium transition-colors
            bg-accent/50 text-[var(--accent-foreground)] cursor-not-allowed opacity-50
          `}
        >
          {t('node.sd2VideoGen.unavailable')}
        </button>
      </div>

      {/* 输出 Handle（右侧） */}
      <Handle
        type="source"
        id="source"
        position={Position.Right}
      />

      {/* 拖动改变大小 */}
      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />
    </div>
  );
});

SD2VideoGenNode.displayName = 'SD2VideoGenNode';
