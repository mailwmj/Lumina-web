import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { Copy, Crop, Download, FolderOpen, PenLine, RefreshCw, Scissors, Trash2, Unlink2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import {
  NODE_TOOL_TYPES,
  isExportImageNode,
  isExportVideoNode,
  isGroupNode,
  isImageEditNode,
  isStoryboardGenNode,
  isStoryboardSplitNode,
  isUploadNode,
  type CanvasWorkflowNode,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { getNodeToolPlugins } from '@/features/canvas/tools';
import type { ToolIconKey } from '@/features/canvas/tools';
import { UiChipButton, UiPanel, UiTooltip } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { sanitizeStoryboardText } from '@/features/canvas/application/storyboardText';
import { buildGenerationErrorReport } from '@/features/canvas/application/generationErrorReport';
import { resolveImageFileName } from '@/features/canvas/application/imageMetadata';
import { useMediaDisplayUrl } from '@/features/assets/ui/useMediaDisplayUrl';
import { outputBrowserMediaFiles } from '@/features/assets/application/browserMediaOutput';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { logger } from '@/lib/logger';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeActionToolbarProps {
  node: CanvasWorkflowNode;
}

const toolIconMap: Record<ToolIconKey, typeof Crop> = {
  crop: Crop,
  annotate: PenLine,
  split: Scissors,
};

const TOOLBAR_BUTTON_RADIUS_CLASS = 'rounded-full';
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  '!border-transparent !bg-transparent text-text-dark hover:!border-transparent hover:!bg-[var(--ui-hover)]';

interface ToolbarIconActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  danger?: boolean;
  success?: boolean;
  children: ReactNode;
}

function ToolbarIconAction({
  label,
  danger = false,
  success = false,
  className = '',
  children,
  type = 'button',
  ...props
}: ToolbarIconActionProps) {
  return (
    <UiTooltip content={label}>
      <button
        type={type}
        aria-label={label}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
          success
            ? 'bg-emerald-500/16 text-emerald-500'
            : danger
              ? 'text-text-muted hover:bg-red-500/10 hover:text-red-400'
              : 'text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'
        } ${className}`}
        {...props}
      >
        {children}
      </button>
    </UiTooltip>
  );
}

export const NodeActionToolbar = memo(({ node }: NodeActionToolbarProps) => {
  const { t, i18n } = useTranslation();
  const isImageEdit = isImageEditNode(node);
  const isStoryboardGen = isStoryboardGenNode(node);
  const isStoryboardSplit = isStoryboardSplitNode(node);
  const canCopyStoryboardText = isStoryboardGen || isStoryboardSplit;
  const tools = useMemo(() => getNodeToolPlugins(node), [node]);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const canReupload = isUploadNode(node) && Boolean(node.data.assetId || node.data.imageUrl);
  const [isCopySuccess, setIsCopySuccess] = useState(false);
  const [isCopyTextSuccess, setIsCopyTextSuccess] = useState(false);
  const [isCopyErrorSuccess, setIsCopyErrorSuccess] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTextFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyErrorFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageReference = useMemo(() => {
    if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
      return {
        kind: 'image' as const,
        assetId: node.data.assetId,
        legacyUrl: node.data.imageUrl || node.data.previewImageUrl,
      };
    }
    return { kind: 'image' as const };
  }, [node.data.assetId, node.data.imageUrl, node.data.previewImageUrl, node.type]);
  const imageSource = useMediaDisplayUrl(imageReference);
  const legacyImageSource = imageReference.legacyUrl ?? null;
  const canHandleImage = Boolean(imageSource);
  const imageFileName = useMemo(
    () => resolveImageFileName(
      isUploadNode(node) ? node.data.sourceFileName || legacyImageSource : legacyImageSource,
      `node-${node.id}`
    ),
    [legacyImageSource, node]
  );
  const imageAssetId = (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node))
    ? node.data.assetId?.trim() || null
    : null;

  // Video source for export video nodes
  const videoReference = useMemo(() => {
    if (isExportVideoNode(node)) {
      return {
        kind: 'video' as const,
        assetId: node.data.assetId,
        legacyUrl: node.data.videoUrl,
      };
    }
    return { kind: 'video' as const };
  }, [node]);
  const videoSource = useMediaDisplayUrl(videoReference);
  const canHandleVideo = Boolean(videoSource);
  const videoAssetId = isExportVideoNode(node) ? node.data.assetId?.trim() || null : null;
  const videoFileName = useMemo(
    () => resolveImageFileName(videoReference.legacyUrl, `node-${node.id}.mp4`),
    [node.id, videoReference.legacyUrl],
  );

  const generationError =
    isExportImageNode(node)
    && typeof (node.data as { generationError?: unknown }).generationError === 'string'
      ? ((node.data as { generationError?: string }).generationError ?? '').trim()
      : '';
  const generationErrorDetails =
    isExportImageNode(node)
    && typeof (node.data as { generationErrorDetails?: unknown }).generationErrorDetails === 'string'
      ? ((node.data as { generationErrorDetails?: string }).generationErrorDetails ?? '').trim()
      : '';
  const generationClientSessionId =
    isExportImageNode(node)
    && typeof (node.data as { generationClientSessionId?: unknown }).generationClientSessionId === 'string'
      ? ((node.data as { generationClientSessionId?: string }).generationClientSessionId ?? '').trim()
      : '';
  const generationDebugContext =
    (node.data as { generationDebugContext?: unknown }).generationDebugContext;
  const canCopyGenerationError = isExportImageNode(node) && generationError.length > 0;
  const generationErrorReport = useMemo(
    () =>
      buildGenerationErrorReport({
        errorMessage: generationError || t('ai.error'),
        errorDetails: generationErrorDetails || undefined,
        context: generationClientSessionId
          ? {
            ...(generationDebugContext && typeof generationDebugContext === 'object'
              ? generationDebugContext
              : {}),
            clientSessionId: generationClientSessionId,
          }
          : generationDebugContext,
      }),
    [generationClientSessionId, generationDebugContext, generationError, generationErrorDetails, t]
  );

  const resolveToolLabel = useCallback((toolType: NodeToolType) => {
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('tool.crop');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('tool.annotate');
    }
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      return t('tool.split');
    }
    return '';
  }, [t]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      if (copyTextFeedbackTimerRef.current) {
        clearTimeout(copyTextFeedbackTimerRef.current);
      }
      if (copyErrorFeedbackTimerRef.current) {
        clearTimeout(copyErrorFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleCopyImage = useCallback(async () => {
    if (!imageSource) {
      return;
    }

    setIsCopySuccess(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setIsCopySuccess(false);
      copyFeedbackTimerRef.current = null;
    }, 1100);

    try {
      const response = await fetch(imageSource);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type || 'image/png']: blob }),
        ]);
      } else {
        await navigator.clipboard.writeText(imageSource);
      }
    } catch (error) {
      logger.error('Failed to copy image to clipboard', error);
    }
  }, [imageSource]);

  const storyboardText = useMemo(() => {
    if (isStoryboardGen) {
      return node.data.frames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(frame.description ?? ''),
        }))
        .join('\n');
    }
    if (isStoryboardSplit) {
      const orderedFrames = [...node.data.frames].sort((a, b) => a.order - b.order);
      return orderedFrames
        .map((frame, index) => t('nodeToolbar.storyboardLine', {
          index: String(index + 1).padStart(2, '0'),
          content: sanitizeStoryboardText(frame.note ?? ''),
        }))
        .join('\n');
    }
    return '';
  }, [isStoryboardGen, isStoryboardSplit, node, t, i18n.language]);

  const handleCopyStoryboardText = useCallback(async () => {
    if (!storyboardText) {
      return;
    }

    setIsCopyTextSuccess(true);
    if (copyTextFeedbackTimerRef.current) {
      clearTimeout(copyTextFeedbackTimerRef.current);
    }
    copyTextFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyTextSuccess(false);
      copyTextFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(storyboardText);
    } catch (error) {
      logger.error('Failed to copy storyboard text', error);
    }
  }, [storyboardText]);

  const handleCopyGenerationError = useCallback(async () => {
    if (!canCopyGenerationError) {
      return;
    }

    setIsCopyErrorSuccess(true);
    if (copyErrorFeedbackTimerRef.current) {
      clearTimeout(copyErrorFeedbackTimerRef.current);
    }
    copyErrorFeedbackTimerRef.current = setTimeout(() => {
      setIsCopyErrorSuccess(false);
      copyErrorFeedbackTimerRef.current = null;
    }, 1100);

    try {
      await navigator.clipboard.writeText(generationErrorReport);
    } catch (error) {
      logger.error('Failed to copy generation error report', error);
    }
  }, [canCopyGenerationError, generationErrorReport]);

  const handleDeleteClick = useCallback(() => {
    deleteNode(node.id);
  }, [deleteNode, node.id]);

  const handleBrowserFileOutput = useCallback(async (
    intent: 'download' | 'directory',
    assetId: string | null,
    source: string | null,
    fileName: string,
  ) => {
    try {
      const result = await outputBrowserMediaFiles({
        intent,
        archiveFileName: fileName,
        files: [{
          id: node.id,
          fileName,
          ...(assetId ? { assetId } : {}),
          ...(source ? { source } : {}),
        }],
      });
      if (result.failures.length > 0) {
        void showErrorDialog(t('fileOutput.partialFailure', {
          saved: result.files.length,
          total: 1,
          files: result.failures.map((failure) => failure.fileName).join(', '),
        }), t('common.error'));
        return;
      }
    } catch (error) {
      logger.error('Failed to output browser media', error);
      void showErrorDialog(t('fileOutput.failed'), t('common.error'));
    }
  }, [node.id, t]);

  const handleBrowserImageDownload = useCallback(async () => {
    await handleBrowserFileOutput('download', imageAssetId, imageSource, imageFileName);
  }, [handleBrowserFileOutput, imageAssetId, imageFileName, imageSource]);

  const handleBrowserImageDirectory = useCallback(async () => {
    await handleBrowserFileOutput('directory', imageAssetId, imageSource, imageFileName);
  }, [handleBrowserFileOutput, imageAssetId, imageFileName, imageSource]);

  const handleBrowserVideoDownload = useCallback(async () => {
    await handleBrowserFileOutput('download', videoAssetId, videoSource, videoFileName);
  }, [handleBrowserFileOutput, videoAssetId, videoFileName, videoSource]);

  const handleBrowserVideoDirectory = useCallback(async () => {
    await handleBrowserFileOutput('directory', videoAssetId, videoSource, videoFileName);
  }, [handleBrowserFileOutput, videoAssetId, videoFileName, videoSource]);

  return (
    <ReactFlowNodeToolbar
      nodeId={node.id}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={NODE_TOOLBAR_OFFSET}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="no-scrollbar flex h-12 max-w-[calc(100vw-24px)] items-center gap-0.5 overflow-x-auto rounded-full px-1.5 py-1 shadow-[var(--ui-shadow-toolbar)]">
        {!isImageEdit && tools.map((tool) => {
          const Icon = toolIconMap[tool.icon] ?? Crop;

          return (
            <UiChipButton
              key={tool.type}
              className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
              onClick={() =>
                canvasEventBus.publish('tool-dialog/open', {
                  nodeId: node.id,
                  toolType: tool.type,
                })
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {resolveToolLabel(tool.type)}
            </UiChipButton>
          );
        })}
        {!isImageEdit && canReupload && (
          <UiChipButton
            key="upload-reupload"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
            onClick={() =>
              canvasEventBus.publish('upload-node/reupload', {
                nodeId: node.id,
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('nodeToolbar.reupload')}
          </UiChipButton>
        )}
        {!isImageEdit && canHandleImage && (
          <ToolbarIconAction
            key="image-copy"
            label={isCopySuccess ? t('nodeToolbar.copied') : t('nodeToolbar.copy')}
            success={isCopySuccess}
            onClick={() => {
              void handleCopyImage();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </ToolbarIconAction>
        )}
        {!isImageEdit && canCopyStoryboardText && (
          <UiChipButton
            key="storyboard-text-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyTextSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyStoryboardText();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copyText')}
          </UiChipButton>
        )}
        {!isImageEdit && canCopyGenerationError && (
          <UiChipButton
            key="generation-error-copy"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopyErrorSuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : '!border-red-500/45 !bg-red-500/15 !text-red-200 hover:!bg-red-500/25'
            }`}
            onClick={() => {
              void handleCopyGenerationError();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {isCopyErrorSuccess ? t('nodeToolbar.copied') : t('nodeToolbar.copyErrorReport')}
          </UiChipButton>
        )}
        {!isImageEdit && canHandleImage && (
          <ToolbarIconAction
            key="image-download"
            label={t('nodeToolbar.download')}
            onClick={(event) => {
              event.stopPropagation();
              void handleBrowserImageDownload();
            }}
          >
            <Download className="h-3.5 w-3.5" />
          </ToolbarIconAction>
        )}
        {!isImageEdit && canHandleImage && (
          <ToolbarIconAction
            key="image-save-to-folder"
            label={t('fileOutput.saveToFolder')}
            onClick={(event) => {
              event.stopPropagation();
              void handleBrowserImageDirectory();
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </ToolbarIconAction>
        )}
        {!isImageEdit && canHandleVideo && (
          <ToolbarIconAction
            key="video-download"
            label={t('nodeToolbar.download')}
            onClick={(event) => {
              event.stopPropagation();
              void handleBrowserVideoDownload();
            }}
          >
            <Download className="h-3.5 w-3.5" />
          </ToolbarIconAction>
        )}
        {!isImageEdit && canHandleVideo && (
          <ToolbarIconAction
            key="video-save-to-folder"
            label={t('fileOutput.saveToFolder')}
            onClick={(event) => {
              event.stopPropagation();
              void handleBrowserVideoDirectory();
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </ToolbarIconAction>
        )}
        {!isImageEdit && isGroupNode(node) && (
          <UiChipButton
            key="group-ungroup"
            className={`h-8 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2.5 text-xs ${TOOLBAR_NEUTRAL_BUTTON_CLASS} hover:!border-amber-400/60 hover:!bg-amber-500/20 hover:!text-amber-200`}
            onClick={(event) => {
              event.stopPropagation();
              ungroupNode(node.id);
            }}
          >
            <Unlink2 className="h-3.5 w-3.5" />
            {t('nodeToolbar.ungroup')}
          </UiChipButton>
        )}
        <div className="mx-1 h-5 w-px shrink-0 bg-[var(--ui-border-soft)]" />
        <ToolbarIconAction
          key="node-delete"
          label={t('common.delete')}
          danger
          onClick={(e) => {
            e.stopPropagation();
            handleDeleteClick();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </ToolbarIconAction>
      </UiPanel>
    </ReactFlowNodeToolbar>
  );
});

NodeActionToolbar.displayName = 'NodeActionToolbar';
