import {
  memo,
  useCallback,
  useState,
  useRef,
  useEffect,
  type ImgHTMLAttributes,
  type MouseEvent,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { useCanvasStore } from '@/stores/canvasStore';

export interface CanvasNodeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  viewerSourceUrl?: string | null;
  viewerImageList?: Array<string | null | undefined>;
  disableViewer?: boolean;
  showResolutionPreview?: boolean;
  /** Override resolution - use this when displaying a thumbnail but needing to show original dimensions */
  resolutionOverride?: { width: number; height: number } | null;
}

function normalizeViewerList(
  imageList: Array<string | null | undefined> | undefined,
  currentImageUrl: string
): string[] {
  const deduped: string[] = [];
  for (const rawItem of imageList ?? []) {
    const item = typeof rawItem === 'string' ? rawItem.trim() : '';
    if (!item || deduped.includes(item)) {
      continue;
    }
    deduped.push(item);
  }

  if (!deduped.includes(currentImageUrl)) {
    deduped.unshift(currentImageUrl);
  }

  return deduped.length > 0 ? deduped : [currentImageUrl];
}

/** Load image dimensions from a URL */
function loadImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
}

export const CanvasNodeImage = memo(({
  viewerSourceUrl,
  viewerImageList,
  disableViewer = false,
  showResolutionPreview = true,
  resolutionOverride = null,
  onDoubleClick,
  onLoad,
  onMouseEnter,
  onMouseLeave,
  src,
  ...props
}: CanvasNodeImageProps) => {
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);
  const [resolutionHover, setResolutionHover] = useState<{
    width: number;
    height: number;
    anchorRect: DOMRect;
  } | null>(null);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveringRef = useRef(false);
  const currentAnchorRectRef = useRef<DOMRect | null>(null);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLImageElement>) => {
    onDoubleClick?.(event);

    if (event.defaultPrevented || disableViewer) {
      return;
    }

    const fallbackSrc = event.currentTarget.currentSrc || (typeof src === 'string' ? src : '');
    const resolvedSource =
      typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
        ? viewerSourceUrl.trim()
        : fallbackSrc.trim();
    if (!resolvedSource) {
      return;
    }

    event.stopPropagation();
    openImageViewer(resolvedSource, normalizeViewerList(viewerImageList, resolvedSource));
  }, [disableViewer, onDoubleClick, openImageViewer, src, viewerImageList, viewerSourceUrl]);

  const handleMouseEnter = useCallback((event: MouseEvent<HTMLImageElement>) => {
    onMouseEnter?.(event);
    const img = event.currentTarget;
    const anchorRect = img.getBoundingClientRect();
    currentAnchorRectRef.current = anchorRect;
    isHoveringRef.current = true;

    // If we have a resolution override (original dimensions), use that
    if (resolutionOverride && resolutionOverride.width > 0 && resolutionOverride.height > 0) {
      setResolutionHover({
        width: resolutionOverride.width,
        height: resolutionOverride.height,
        anchorRect,
      });
      return;
    }

    // If we have a viewerSourceUrl (original image), load it to get dimensions
    // This takes priority over thumbnail dimensions
    if (viewerSourceUrl && viewerSourceUrl.trim()) {
      // Debounce to avoid multiple rapid loads
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      loadTimeoutRef.current = setTimeout(async () => {
        if (!isHoveringRef.current) return; // Mouse left before timeout fired
        try {
          const dims = await loadImageDimensions(viewerSourceUrl.trim());
          if (!isHoveringRef.current) return; // Mouse left during load
          setResolutionHover({
            width: dims.width,
            height: dims.height,
            anchorRect: currentAnchorRectRef.current!,
          });
        } catch {
          // Ignore load errors
        }
      }, 100);
    }
  }, [onMouseEnter, resolutionOverride, viewerSourceUrl]);

  const handleImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    onLoad?.(event);
    if (!showResolutionPreview) return;
    const img = event.currentTarget;
    const anchorRect = img.getBoundingClientRect();

    // If we have a resolution override, use that instead of the thumbnail dimensions
    if (resolutionOverride && resolutionOverride.width > 0 && resolutionOverride.height > 0) {
      setResolutionHover({
        width: resolutionOverride.width,
        height: resolutionOverride.height,
        anchorRect,
      });
      return;
    }

    // If we have a viewerSourceUrl, the handleMouseEnter will handle loading original dimensions
    // Only use thumbnail dimensions if no viewerSourceUrl is available
    if (!viewerSourceUrl || !viewerSourceUrl.trim()) {
      setResolutionHover({
        width: img.naturalWidth,
        height: img.naturalHeight,
        anchorRect,
      });
    }
  }, [onLoad, showResolutionPreview, resolutionOverride, viewerSourceUrl]);

  const handleMouseLeave = useCallback((event: MouseEvent<HTMLImageElement>) => {
    onMouseLeave?.(event);
    isHoveringRef.current = false;
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setResolutionHover(null);
  }, [onMouseLeave]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
    };
  }, []);

  return (
    <>
      <img
        {...props}
        // WebKit can retain the previous texture when a transformed canvas node
        // changes image URLs. A new element guarantees the decoded original repaints.
        key={typeof src === 'string' ? src : undefined}
        src={src}
        data-viewer-src={
          typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
            ? viewerSourceUrl.trim()
            : undefined
        }
        onDoubleClick={handleDoubleClick}
        onMouseEnter={showResolutionPreview ? handleMouseEnter : onMouseEnter}
        onMouseLeave={showResolutionPreview ? handleMouseLeave : onMouseLeave}
        onLoad={showResolutionPreview ? handleImageLoad : onLoad}
      />
      {resolutionHover && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] rounded-md border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] px-2 py-1 text-xs text-text-dark shadow-[var(--ui-shadow-tooltip)]"
          style={{
            left: Math.max(10, resolutionHover.anchorRect.left + resolutionHover.anchorRect.width / 2 - 40),
            top: resolutionHover.anchorRect.bottom + 8,
          }}
        >
          {resolutionHover.width} × {resolutionHover.height}
        </div>,
        document.body
      )}
    </>
  );
});

CanvasNodeImage.displayName = 'CanvasNodeImage';
