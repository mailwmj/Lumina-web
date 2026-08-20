import { memo, useState, useCallback, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Hand,
  MousePointer2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid3X3,
  Trash2,
} from '@/components/ui/icons';
import { useReactFlow } from '@xyflow/react';

import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { UiButton, UiModal, UiTooltip } from '@/components/ui';

interface CanvasToolbarProps {
  isLocked?: boolean;
  interactionMode: CanvasInteractionMode;
  onInteractionModeChange: (mode: CanvasInteractionMode) => void;
}

export type CanvasInteractionMode = 'select' | 'pan';

interface CanvasToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  children: ReactNode;
}

function CanvasToolbarButton({
  label,
  active = false,
  danger = false,
  className = '',
  children,
  type = 'button',
  ...props
}: CanvasToolbarButtonProps) {
  return (
    <UiTooltip content={label}>
      <button
        type={type}
        aria-label={label}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-40 ${
          active
            ? 'bg-accent/18 text-accent'
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

export const CanvasToolbar = memo(({
  isLocked = false,
  interactionMode,
  onInteractionModeChange,
}: CanvasToolbarProps) => {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const clearCanvas = useCanvasStore((state) => state.clearCanvas);
  const snapToGridEnabled = useSettingsStore((state) => state.snapToGridEnabled);
  const setSnapToGridEnabled = useSettingsStore((state) => state.setSnapToGridEnabled);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleClearClick = useCallback(() => {
    if (isLocked) return;
    setShowClearConfirm(true);
  }, [isLocked]);

  const handleClearConfirm = useCallback(() => {
    clearCanvas();
    setShowClearConfirm(false);
  }, [clearCanvas]);

  const handleClearCancel = useCallback(() => {
    setShowClearConfirm(false);
  }, []);

  return (
    <>
      <div className="absolute bottom-3 left-1/2 z-10 flex h-11 max-w-[calc(100vw-136px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] px-1.5 shadow-[var(--ui-shadow-toolbar)] no-scrollbar">
        <div className="flex items-center gap-1">
          <CanvasToolbarButton
            label={t('canvas.toolbar.panMode')}
            onClick={() => onInteractionModeChange('pan')}
            active={interactionMode === 'pan'}
            aria-pressed={interactionMode === 'pan'}
          >
            <Hand className="h-4 w-4" />
          </CanvasToolbarButton>
          <CanvasToolbarButton
            label={t('canvas.toolbar.selectMode')}
            onClick={() => onInteractionModeChange('select')}
            active={interactionMode === 'select'}
            aria-pressed={interactionMode === 'select'}
          >
            <MousePointer2 className="h-4 w-4" />
          </CanvasToolbarButton>
        </div>

        <div className="mx-1 h-5 w-px shrink-0 bg-[var(--ui-border-soft)]" />

        <CanvasToolbarButton
          label={t('canvas.toolbar.zoomIn')}
          onClick={() => zoomIn()}
          disabled={isLocked}
        >
          <ZoomIn className="h-4 w-4" />
        </CanvasToolbarButton>

        <CanvasToolbarButton
          label={t('canvas.toolbar.zoomOut')}
          onClick={() => zoomOut()}
          disabled={isLocked}
        >
          <ZoomOut className="h-4 w-4" />
        </CanvasToolbarButton>

        <CanvasToolbarButton
          label={t('canvas.toolbar.fitView')}
          onClick={() => fitView({ padding: 0.2 })}
        >
          <Maximize2 className="h-4 w-4" />
        </CanvasToolbarButton>

        <div className="mx-1 h-5 w-px shrink-0 bg-[var(--ui-border-soft)]" />

        <CanvasToolbarButton
          label={t('canvas.toolbar.toggleGrid')}
          onClick={() => setSnapToGridEnabled(!snapToGridEnabled)}
          active={snapToGridEnabled}
          aria-pressed={snapToGridEnabled}
        >
          <Grid3X3 className="h-4 w-4" />
        </CanvasToolbarButton>

        <CanvasToolbarButton
          label={t('canvas.toolbar.clear')}
          onClick={handleClearClick}
          disabled={isLocked}
          danger
        >
          <Trash2 className="h-4 w-4" />
        </CanvasToolbarButton>
      </div>

      <UiModal
        isOpen={showClearConfirm}
        title={t('canvas.clearConfirm.title')}
        closeLabel={t('common.close')}
        onClose={handleClearCancel}
        widthClassName="w-[400px] max-w-[calc(100vw-24px)]"
        footer={(
          <>
            <UiButton onClick={handleClearCancel}>{t('common.cancel')}</UiButton>
            <UiButton variant="danger" onClick={handleClearConfirm}>{t('common.confirm')}</UiButton>
          </>
        )}
      >
        <p className="text-sm leading-6 text-text-muted">{t('canvas.clearConfirm.message')}</p>
      </UiModal>
    </>
  );
});

CanvasToolbar.displayName = 'CanvasToolbar';
