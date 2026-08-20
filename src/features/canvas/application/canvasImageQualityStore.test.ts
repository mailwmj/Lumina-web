import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_RETAINED_ORIGINAL_IMAGE_NODES,
  useCanvasImageQualityStore,
} from './canvasImageQualityStore';

describe('canvas image quality store', () => {
  beforeEach(() => {
    useCanvasImageQualityStore.getState().clearRetainedOriginalNodes();
  });

  it('retains only the most recently decoded originals', () => {
    const { retainOriginalNode } = useCanvasImageQualityStore.getState();
    for (let index = 0; index < MAX_RETAINED_ORIGINAL_IMAGE_NODES + 1; index += 1) {
      retainOriginalNode(`image-${index}`);
    }

    expect(useCanvasImageQualityStore.getState().retainedOriginalNodeIds).toEqual(
      Array.from({ length: MAX_RETAINED_ORIGINAL_IMAGE_NODES }, (
        _value,
        index
      ) => `image-${index + 1}`)
    );
  });

  it('refreshes the recency of an already retained original', () => {
    const { retainOriginalNode } = useCanvasImageQualityStore.getState();
    retainOriginalNode('image-1');
    retainOriginalNode('image-2');
    retainOriginalNode('image-3');
    retainOriginalNode('image-1');
    retainOriginalNode('image-4');

    expect(useCanvasImageQualityStore.getState().retainedOriginalNodeIds).toEqual([
      'image-3',
      'image-1',
      'image-4',
    ]);
  });

  it('drops retained originals that leave the viewport', () => {
    const { retainOriginalNode, retainVisibleOriginalNodes } = useCanvasImageQualityStore.getState();
    retainOriginalNode('image-1');
    retainOriginalNode('image-2');
    retainVisibleOriginalNodes(['image-2']);

    expect(useCanvasImageQualityStore.getState().retainedOriginalNodeIds).toEqual(['image-2']);
  });

  it('leaves inspection mode even when no original was retained or requested', () => {
    const { clearRetainedOriginalNodes, setOriginalImageMode } = useCanvasImageQualityStore.getState();
    setOriginalImageMode(true);
    clearRetainedOriginalNodes();

    expect(useCanvasImageQualityStore.getState().isOriginalImageMode).toBe(false);
  });
});
