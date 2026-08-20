import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';

import { Check, Download, FolderOpen, Loader2 } from '@/components/ui/icons';
import { UiChipButton, UiPanel } from '@/components/ui';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';
import {
  resolveDownloadableCanvasImages,
  saveCanvasImagesToDirectory,
} from '@/features/canvas/application/imageBatchDownload';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import type { CanvasWorkflowNode } from '@/features/canvas/domain/canvasNodes';
import { logger } from '@/lib/logger';
import { useSettingsStore } from '@/stores/settingsStore';
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
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);
  const downloadableImages = useMemo(
    () => resolveDownloadableCanvasImages(selectedNodes),
    [selectedNodes]
  );
  const selectedNodeIds = useMemo(
    () => selectedNodes.map((node) => node.id),
    [selectedNodes]
  );
  const [downloadMenu, setDownloadMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDownloadMenuVisible, setIsDownloadMenuVisible] = useState(false);
  const [feedback, setFeedback] = useState<DownloadFeedback>('idle');
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const downloadMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeDownloadMenu = useCallback(() => {
    setIsDownloadMenuVisible(false);
    if (downloadMenuCloseTimerRef.current) {
      clearTimeout(downloadMenuCloseTimerRef.current);
    }
    downloadMenuCloseTimerRef.current = setTimeout(() => {
      setDownloadMenu(null);
      downloadMenuCloseTimerRef.current = null;
    }, UI_POPOVER_TRANSITION_MS);
  }, []);

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

  const downloadToDirectory = useCallback(async (targetDir: string) => {
    if (downloadableImages.length === 0 || feedback === 'saving') {
      return;
    }

    setFeedback('saving');
    try {
      const result = await saveCanvasImagesToDirectory(downloadableImages, targetDir);
      if (result.failedNodeIds.length > 0) {
        const message = t('nodeToolbar.downloadImagesPartialFailure', {
          saved: result.savedPaths.length,
          total: downloadableImages.length,
        });
        void showErrorDialog(message, t('common.error'));
      }
      if (result.savedPaths.length > 0) {
        setSavedFeedback();
      } else {
        setFeedback('idle');
      }
    } catch (error) {
      logger.error('Failed to batch download selected images', error);
      setFeedback('idle');
      void showErrorDialog(t('nodeToolbar.downloadImagesFailed'), t('common.error'));
    }
  }, [downloadableImages, feedback, setSavedFeedback, t]);

  const chooseDirectoryAndDownload = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) {
        return;
      }
      await downloadToDirectory(selected);
    } catch (error) {
      logger.error('Failed to choose a directory for batch image download', error);
      void showErrorDialog(t('nodeToolbar.downloadImagesFailed'), t('common.error'));
    }
  }, [downloadToDirectory, t]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const menuElement = downloadMenuRef.current;
      if (!menuElement || !menuElement.contains(event.target as Node)) {
        closeDownloadMenu();
      }
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [closeDownloadMenu, downloadMenu]);

  useEffect(() => {
    if (!downloadMenu) {
      return;
    }
    const frameId = requestAnimationFrame(() => setIsDownloadMenuVisible(true));
    return () => cancelAnimationFrame(frameId);
  }, [downloadMenu]);

  useEffect(() => () => {
    if (downloadMenuCloseTimerRef.current) {
      clearTimeout(downloadMenuCloseTimerRef.current);
    }
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
  }, []);

  if (selectedNodes.length < 2 || downloadableImages.length === 0) {
    return null;
  }

  const buttonLabel = feedback === 'saved'
    ? t('nodeToolbar.downloadedImages', { count: downloadableImages.length })
    : t('nodeToolbar.downloadAllImages', { count: downloadableImages.length });

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
          className={`${TOOLBAR_CHIP_CLASS} ${feedback === 'saved' ? '!bg-emerald-500/16 !text-emerald-500' : ''}`}
          disabled={feedback === 'saving'}
          onClick={(event) => {
            event.stopPropagation();
            if (downloadPresetPaths.length === 0) {
              void chooseDirectoryAndDownload();
              return;
            }
            setDownloadMenu({ x: event.clientX, y: event.clientY });
            setIsDownloadMenuVisible(false);
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
      </UiPanel>

      {downloadMenu && (
        <div
          ref={downloadMenuRef}
          className={`fixed z-[120] min-w-[280px] rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] p-2 shadow-[var(--ui-shadow-panel)] transition-opacity duration-150 ${isDownloadMenuVisible ? 'opacity-100' : 'opacity-0'}`}
          style={{ left: `${downloadMenu.x}px`, top: `${downloadMenu.y}px` }}
        >
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-[var(--ui-hover)]"
            onClick={() => {
              closeDownloadMenu();
              void chooseDirectoryAndDownload();
            }}
          >
            <FolderOpen className="h-4 w-4" />
            {t('nodeToolbar.chooseDirectory')}
          </button>

          <div className="mt-1 space-y-1 border-t border-[var(--ui-border-soft)] pt-2">
            {downloadPresetPaths.map((path) => (
              <button
                key={path}
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-[var(--ui-hover)]"
                onClick={() => {
                  closeDownloadMenu();
                  void downloadToDirectory(path);
                }}
                title={path}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                <span className="truncate">{path}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </ReactFlowNodeToolbar>
  );
});

MultiSelectionActionToolbar.displayName = 'MultiSelectionActionToolbar';
