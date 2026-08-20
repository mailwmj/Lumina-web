import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

import { isVideoGenerationImageCountValid } from './videoGenerationInputRules';

describe('video generation image input rules', () => {
  it('allows text-only or single-reference generation for the single-video node', () => {
    expect(isVideoGenerationImageCountValid(CANVAS_NODE_TYPES.videoSingle, 0)).toBe(true);
    expect(isVideoGenerationImageCountValid(CANVAS_NODE_TYPES.videoSingle, 1)).toBe(true);
    expect(isVideoGenerationImageCountValid(CANVAS_NODE_TYPES.videoSingle, 2)).toBe(false);
  });

  it('requires exactly a first and a last frame for the frame-video node', () => {
    expect(isVideoGenerationImageCountValid(CANVAS_NODE_TYPES.videoFrame, 1)).toBe(false);
    expect(isVideoGenerationImageCountValid(CANVAS_NODE_TYPES.videoFrame, 2)).toBe(true);
    expect(isVideoGenerationImageCountValid(CANVAS_NODE_TYPES.videoFrame, 3)).toBe(false);
  });
});
