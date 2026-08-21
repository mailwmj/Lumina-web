import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { Check, Download, FolderOpen, Loader2 } from '@/components/ui/icons';
import { UiChipButton, UiPanel, UiTooltip } from '@/components/ui';
import { resolveDownloadableCanvasMedia } from '@/features/canvas/application/imageBatchDownload';
import { outputBrowserMediaFiles } from '@/features/assets/application/browserMediaOutput';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import type { CanvasWorkflowNode } from '@/features/canvas/domain/canvasNodes';
import { logger } from '@/lib/logger';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface MultiSelectionActionToolbarProps {
  selectedNodes: readonly CanvasWorkflowNode[];
}

type DownloadFeedback = 'idle' | 'saving' | 'saved';

const TOOLBAR_CHIP_CLASS =
  'h-8 rounded-full px-2.5 text-xs !border-transparent !bg-transparent text-text-dark hover:!border-transparent hover:!bg-[var(--ui-hover)]';

export const MultiSelectionActionToolbar = memo(({
  selectedNodes,
}: MultiSelectionActionToolbarProps) => {
  const { t } = useTranslation();
  const downloadableMedia = useMemo(
    () => resolveDownloadableCanvasMedia(selectedNodes),
    [selectedNodes],
  );
  const selectedNodeIds = useMemo(
    () => selectedNodes.map((node) => node.id),
    [selectedNodes],
  );
  const [feedback, setFeedback] = useState<DownloadFeedback>('idle');
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSavedFeedback = useCallback(() => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setFeedback('saved');
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback('idle');
      feedbackTimerRef.current = null;
    }, 1800);
  }, []);

  const outputBrowserMedia = useCallback(async (intent: 'download' | 'directory') => {
    if (downloadableMedia.length === 0 || feedback === 'saving') {
      return;
    }
    const files = downloadableMedia.map((media) => ({
      id: media.nodeId,
      fileName: media.suggestedFileName,
      ...(media.assetId ? { assetId: media.assetId } : {}),
      ...(media.source ? { source: media.source } : {}),
    }));

    setFeedback('saving');
    try {
      const result = await outputBrowserMediaFiles({
        intent,
        archiveFileName: 'lumina-media-' + Date.now() + '.zip',
        files,
      });
      if (result.failures.length > 0) {
        void showErrorDialog(t('fileOutput.partialFailure', {
          saved: result.files.length,
          total: files.length,
          files: result.failures.map((failure) => failure.fileName).join(', '),
        }), t('common.error'));
      }
      if (result.files.length > 0) {
        setSavedFeedback();
      } else {
        setFeedback('idle');
      }
    } catch (error) {
      logger.error('Failed to output selected browser media', error);
      setFeedback('idle');
      void showErrorDialog(t('fileOutput.failed'), t('common.error'));
    }
  }, [downloadableMedia, feedback, setSavedFeedback, t]);

  useEffect(() => () => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
  }, []);

  if (selectedNodes.length < 2 || downloadableMedia.length === 0) {
    return null;
  }

  const buttonLabel = feedback === 'saved'
    ? t('nodeToolbar.downloadedMedia', { count: downloadableMedia.length })
    : t('nodeToolbar.downloadAllMedia', { count: downloadableMedia.length });

  return (
    <ReactFlowNodeToolbar
      nodeId={selectedNodeIds}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={NODE_TOOLBAR_OFFSET}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="no-scrollbar flex h-12 max-w-[calc(100vw-24px)] items-center gap-0.5 overflow-x-auto rounded-full px-1.5 py-1 shadow-[var(--ui-shadow-toolbar)]">
        <UiChipButton
          className={TOOLBAR_CHIP_CLASS + (feedback === 'saved' ? ' !bg-emerald-500/16 !text-emerald-500' : '')}
          disabled={feedback === 'saving'}
          onClick={(event) => {
            event.stopPropagation();
            void outputBrowserMedia('download');
          }}
        >
          {feedback === 'saving' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : feedback === 'saved' ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {buttonLabel}
        </UiChipButton>
        <UiTooltip content={t('fileOutput.saveToFolder')}>
          <UiChipButton
            aria-label={t('fileOutput.saveToFolder')}
            className={TOOLBAR_CHIP_CLASS + ' w-8 justify-center px-0'}
            disabled={feedback === 'saving'}
            onClick={(event) => {
              event.stopPropagation();
              void outputBrowserMedia('directory');
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </UiChipButton>
        </UiTooltip>
      </UiPanel>
    </ReactFlowNodeToolbar>
  );
});

MultiSelectionActionToolbar.displayName = 'MultiSelectionActionToolbar';
