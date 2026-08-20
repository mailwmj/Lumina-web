import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES } from './canvasNodes';
import { getMenuNodeDefinitions } from './nodeRegistry';

describe('getMenuNodeDefinitions', () => {
  it('keeps the canvas creation menu in its intended two-column order', () => {
    expect(getMenuNodeDefinitions().map((definition) => definition.type)).toEqual([
      CANVAS_NODE_TYPES.upload,
      CANVAS_NODE_TYPES.imageEdit,
      CANVAS_NODE_TYPES.textGeneration,
      CANVAS_NODE_TYPES.seedanceAutoVideo,
      CANVAS_NODE_TYPES.videoUpload,
      CANVAS_NODE_TYPES.audioUpload,
      CANVAS_NODE_TYPES.storyboardGen,
      CANVAS_NODE_TYPES.textAnnotation,
    ]);
  });
});
