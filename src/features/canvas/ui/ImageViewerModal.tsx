import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, RotateCcw, X } from '@/components/ui/icons';
import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { useImageViewerTransform } from '../hooks/useImageViewerTransform';
import { UiTooltip } from '@/components/ui';

export interface ImageViewerModalProps {
  open: boolean;
  imageUrl: string;
  imageList: string[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
}

export function ImageViewerModal({
  open,
  imageUrl,
  imageList,
  currentIndex,
  onClose,
  onNavigate,
}: ImageViewerModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const viewerControlClass =
    'inline-flex h-9 items-center justify-center rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] px-3 text-xs text-text-dark shadow-[var(--ui-shadow-toolbar)]';
  const [isVisible, setIsVisible] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0);
  const [displayImageUrl, setDisplayImageUrl] = useState(imageUrl);
  const closeTimerRef = useRef<number | null>(null);

  const {
    containerRef,
    imageRef,
    scaleDisplayRef,
    viewerOpacity,
    resetView,
    handleImageMouseDown,
    handleContainerMouseMove,
    handleContainerMouseUp,
    handleImageMouseMove,
    handleImageLoad,
    isPointOnImageContent,
  } = useImageViewerTransform(open && isVisible);

  useEffect(() => {
    if (!isVisible) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isVisible]);

  useEffect(() => {
    if (open) {
      setDisplayImageUrl(imageUrl);
      setIsVisible(true);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setOverlayOpacity(0);
      requestAnimationFrame(() => {
        setOverlayOpacity(1);
      });
      return;
    }
    if (!isVisible) return;
    setOverlayOpacity(0);
    closeTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      setDisplayImageUrl('');
    }, 400);
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open, isVisible]);

  useEffect(() => {
    if (!open || !imageUrl) {
      return;
    }
    setDisplayImageUrl(imageUrl);
  }, [open, imageUrl]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    resetView();
  }, [open, imageUrl, resetView]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        onNavigate('prev');
      } else if (e.key === 'ArrowRight') {
        onNavigate('next');
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onNavigate, onClose]);

  if (!isVisible) return null;

  return (
    <div
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] overflow-hidden bg-black/95`}
      style={{
        opacity: overlayOpacity,
        transition: 'opacity 400ms ease',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden p-4"
        style={{ overscrollBehavior: 'contain' }}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        onMouseLeave={handleContainerMouseUp}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="relative">
          <img
            ref={imageRef}
            src={displayImageUrl}
            alt={t('viewer.imageAlt')}
            className="select-none transition-opacity duration-300"
            style={{
              opacity: viewerOpacity * overlayOpacity,
              transformOrigin: 'center',
              width: '95vw',
              height: '95vh',
              objectFit: 'contain',
            }}
            onLoad={handleImageLoad}
            onMouseDown={handleImageMouseDown}
            onMouseMove={handleImageMouseMove}
            onClick={(e) => {
              if (isPointOnImageContent(e.clientX, e.clientY)) {
                e.stopPropagation();
              } else {
                onClose();
              }
            }}
            draggable={false}
          />
        </div>

        <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
          {imageList.length > 1 && (
            <div className="flex items-center gap-3">
              <UiTooltip content={t('viewer.prev')}>
                <button
                  type="button"
                  aria-label={t('viewer.prev')}
                  onClick={() => onNavigate('prev')}
                  disabled={currentIndex <= 0}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] text-text-dark transition-colors hover:bg-[var(--ui-surface-elevated)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </UiTooltip>
              <UiTooltip content={t('viewer.next')}>
                <button
                  type="button"
                  aria-label={t('viewer.next')}
                  onClick={() => onNavigate('next')}
                  disabled={currentIndex >= imageList.length - 1}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] text-text-dark transition-colors hover:bg-[var(--ui-surface-elevated)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </UiTooltip>
            </div>
          )}

          <div className="flex items-center gap-4">
            {imageList.length > 1 && (
              <div className={viewerControlClass}>
                {currentIndex + 1} / {imageList.length}
              </div>
            )}
            <div
              ref={scaleDisplayRef}
              className={`${viewerControlClass} min-w-[74px]`}
            >
              100%
            </div>
            <UiTooltip content={t('viewer.reset')}>
              <button
                type="button"
                aria-label={t('viewer.reset')}
                onClick={resetView}
                className={`${viewerControlClass} w-9 px-0 transition-colors hover:bg-[var(--ui-surface-elevated)]`}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </UiTooltip>
            <UiTooltip content={t('common.close')}>
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={onClose}
                className={`${viewerControlClass} w-9 px-0 transition-colors hover:bg-[var(--ui-surface-elevated)]`}
              >
                <X className="h-4 w-4" />
              </button>
            </UiTooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
