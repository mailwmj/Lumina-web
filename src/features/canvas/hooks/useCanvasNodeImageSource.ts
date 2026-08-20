import { useEffect, useMemo, useState } from 'react';

import {
  resolveCanvasImageRenderSource,
} from '@/features/canvas/application/canvasImageRenderPolicy';
import { createCanvasImageDecodeQueue } from '@/features/canvas/application/canvasImageDecodeQueue';
import { useCanvasImageQualityStore } from '@/features/canvas/application/canvasImageQualityStore';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

interface CanvasNodeImageSourceInput {
  nodeId: string;
  imageUrl: string | null | undefined;
  previewImageUrl: string | null | undefined;
}

function preloadImage(source: string): Promise<void> {
  const image = new Image();
  image.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Image failed to load'));
  });

  image.src = source;
  return typeof image.decode === 'function'
    ? image.decode().catch(() => loaded)
    : loaded;
}

const imageDecodeQueue = createCanvasImageDecodeQueue(preloadImage);

export function useCanvasNodeImageSource({
  nodeId,
  imageUrl,
  previewImageUrl,
}: CanvasNodeImageSourceInput): string | null {
  const isFocused = useCanvasImageQualityStore(
    (state) => state.focusedNodeId === nodeId
  );
  const isOriginalRetained = useCanvasImageQualityStore(
    (state) => state.retainedOriginalNodeIds.includes(nodeId)
  );
  const isOriginalRequested = useCanvasImageQualityStore(
    (state) => state.requestedOriginalNodeIds.includes(nodeId)
  );
  const retainOriginalNode = useCanvasImageQualityStore((state) => state.retainOriginalNode);
  const originalDisplaySource = useMemo(
    () => imageUrl ? resolveImageDisplayUrl(imageUrl) : null,
    [imageUrl]
  );
  const previewDisplaySource = useMemo(
    () => previewImageUrl ? resolveImageDisplayUrl(previewImageUrl) : null,
    [previewImageUrl]
  );
  // Nodes enter the canvas with their preview. A focused original is decoded
  // before the source changes, rather than starting a large decode in render.
  const [displaySource, setDisplaySource] = useState<string | null>(
    () => previewDisplaySource ?? originalDisplaySource
  );
  const hasLoadedOriginal = Boolean(
    originalDisplaySource && displaySource === originalDisplaySource
  );
  const shouldRequestOriginal = isFocused || isOriginalRequested;
  const preferredSource = useMemo(() => resolveCanvasImageRenderSource({
    nodeId,
    imageUrl,
    previewImageUrl,
    focusedNodeId: isFocused && hasLoadedOriginal ? nodeId : null,
    retainedOriginalNodeIds: isOriginalRetained && hasLoadedOriginal ? [nodeId] : [],
    requestedOriginalNodeIds: isOriginalRequested && hasLoadedOriginal ? [nodeId] : [],
  }), [
    imageUrl,
    hasLoadedOriginal,
    isFocused,
    isOriginalRetained,
    isOriginalRequested,
    nodeId,
    previewImageUrl,
  ]);
  const preferredDisplaySource = useMemo(
    () => preferredSource ? resolveImageDisplayUrl(preferredSource) : null,
    [preferredSource]
  );

  useEffect(() => {
    if (!preferredDisplaySource) {
      setDisplaySource(null);
      return;
    }

    const shouldPreloadOriginal = (
      shouldRequestOriginal
      && !hasLoadedOriginal
      && originalDisplaySource
      && previewDisplaySource
      && previewDisplaySource !== originalDisplaySource
    );
    if (!shouldPreloadOriginal) {
      if (
        isFocused
        && hasLoadedOriginal
        && previewDisplaySource
        && previewDisplaySource !== originalDisplaySource
        && preferredDisplaySource === originalDisplaySource
      ) {
        retainOriginalNode(nodeId);
      }
      setDisplaySource(preferredDisplaySource);
      return;
    }

    let cancelled = false;
    const task = imageDecodeQueue.enqueue(originalDisplaySource);
    void task.promise
      .then(() => {
        if (!cancelled) {
          setDisplaySource(originalDisplaySource);
          retainOriginalNode(nodeId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDisplaySource(previewDisplaySource);
        }
      });

    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [
    hasLoadedOriginal,
    isFocused,
    isOriginalRequested,
    originalDisplaySource,
    preferredDisplaySource,
    previewDisplaySource,
    retainOriginalNode,
    shouldRequestOriginal,
  ]);

  return displaySource;
}
