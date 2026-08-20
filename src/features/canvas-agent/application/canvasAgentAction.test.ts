import { describe, expect, it } from 'vitest';

import { parsePendingCanvasAgentAction } from './canvasAgentAction';

describe('canvas Agent action parser', () => {
  it('parses an image import with supported source types', () => {
    const action = parsePendingCanvasAgentAction({
      actionId: 'action-1',
      createdAt: 123,
      request: {
        type: 'import_images',
        projectId: 'project-1',
        baseRevision: 'revision-1',
        images: [
          { clientId: 'local', source: '/tmp/model.png' },
          { clientId: 'remote', source: 'https://example.com/product.jpg' },
          { clientId: 'inline', source: 'data:image/webp;base64,AA==' },
        ],
      },
    });

    expect(action.request).toMatchObject({
      type: 'import_images',
      projectId: 'project-1',
      images: [
        { clientId: 'local', source: '/tmp/model.png' },
        { clientId: 'remote', source: 'https://example.com/product.jpg' },
        { clientId: 'inline', source: 'data:image/webp;base64,AA==' },
      ],
    });
  });

  it('rejects relative paths and unsupported data URLs', () => {
    const payload = (source: string) => ({
      actionId: 'action-1',
      createdAt: 123,
      request: {
        type: 'import_images',
        projectId: 'project-1',
        baseRevision: 'revision-1',
        images: [{ clientId: 'image', source }],
      },
    });

    expect(() => parsePendingCanvasAgentAction(payload('./model.png'))).toThrow(/absolute local path/);
    expect(() => parsePendingCanvasAgentAction(payload('data:text/plain;base64,AA=='))).toThrow(/raster image/);
  });

  it('deduplicates requested node IDs while preserving order', () => {
    const action = parsePendingCanvasAgentAction({
      actionId: 'action-1',
      createdAt: 123,
      request: {
        type: 'get_node_images',
        projectId: 'project-1',
        nodeIds: ['result-2', 'result-1', 'result-2'],
        maxDimension: 768,
      },
    });

    expect(action.request).toMatchObject({ nodeIds: ['result-2', 'result-1'] });
  });
});
