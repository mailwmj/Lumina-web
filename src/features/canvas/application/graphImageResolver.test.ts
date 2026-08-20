import { describe, expect, it } from 'vitest';

import { canvasNodeFactory } from './canvasServices';
import { DefaultGraphImageResolver } from './graphImageResolver';
import { CANVAS_NODE_TYPES, type CanvasEdge } from '../domain/canvasNodes';

describe('DefaultGraphImageResolver', () => {
  it('collects stable asset references and legacy URLs through one interface', () => {
    const assetImage = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      assetId: 'asset-image-1',
      imageUrl: null,
    });
    assetImage.id = 'asset-image';
    const legacyImage = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      imageUrl: 'C:\\projects\\legacy.png',
    });
    legacyImage.id = 'legacy-image';
    const target = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.storyboardGen, { x: 0, y: 0 });
    target.id = 'target';
    const edges: CanvasEdge[] = [
      { id: 'asset-edge', source: assetImage.id, target: target.id },
      { id: 'legacy-edge', source: legacyImage.id, target: target.id },
    ];

    expect(new DefaultGraphImageResolver().collectInputImages(
      target.id,
      [assetImage, legacyImage, target],
      edges,
    )).toEqual([
      { kind: 'image', assetId: 'asset-image-1', legacyUrl: null },
      { kind: 'image', assetId: null, legacyUrl: 'C:\\projects\\legacy.png' },
    ]);
  });
});
