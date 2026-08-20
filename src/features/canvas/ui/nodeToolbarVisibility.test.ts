import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasWorkflowNode,
} from '@/features/canvas/domain/canvasNodes';
import { canShowNodeActionToolbar } from './nodeToolbarVisibility';

function createPendingImageResult(isGenerating: boolean): CanvasWorkflowNode {
  return {
    id: 'image-result',
    type: CANVAS_NODE_TYPES.exportImage,
    data: {
      imageUrl: null,
      aspectRatio: '1:1',
      isGenerating,
    },
  };
}

describe('canShowNodeActionToolbar', () => {
  it('hides the toolbar while an image result placeholder is generating', () => {
    expect(canShowNodeActionToolbar(createPendingImageResult(true))).toBe(false);
  });

  it('restores the toolbar once image generation has finished', () => {
    expect(canShowNodeActionToolbar(createPendingImageResult(false))).toBe(true);
  });
});
