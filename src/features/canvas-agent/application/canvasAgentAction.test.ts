import { describe, expect, it } from 'vitest';

import { parsePendingCanvasAgentAction } from './canvasAgentAction';
import { MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES } from './restrictedCanvasAgentImage';

describe('canvas Agent action parser', () => {
  it('parses an image import with remotely fetchable or inline raster sources', () => {
    const action = parsePendingCanvasAgentAction({
      actionId: 'action-1',
      createdAt: 123,
      request: {
        type: 'import_images',
        projectId: 'project-1',
        baseRevision: 'revision-1',
        images: [
          { clientId: 'remote', source: 'https://example.com/product.jpg' },
          { clientId: 'inline', source: 'data:image/webp;base64,AA==' },
        ],
      },
    });

    expect(action.request).toMatchObject({
      type: 'import_images',
      projectId: 'project-1',
      images: [
        { clientId: 'remote', source: 'https://example.com/product.jpg' },
        { clientId: 'inline', source: 'data:image/webp;base64,AA==' },
      ],
    });
  });

  it('rejects local paths, file URLs, and unsupported data URLs', () => {
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

    expect(() => parsePendingCanvasAgentAction(payload('/tmp/model.png'))).toThrow(/HTTPS URL/);
    expect(() => parsePendingCanvasAgentAction(payload('C:\\Users\\agent\\model.png'))).toThrow(/HTTPS URL/);
    expect(() => parsePendingCanvasAgentAction(payload('file:///tmp/model.png'))).toThrow(/HTTPS URL/);
    expect(() => parsePendingCanvasAgentAction(payload('./model.png'))).toThrow(/HTTPS URL/);
    expect(() => parsePendingCanvasAgentAction(payload('data:text/plain;base64,AA=='))).toThrow(/raster image/);
  });

  it('rejects an inline image that exceeds the restricted import byte limit', () => {
    const oversizedPayload = 'A'.repeat(
      Math.ceil((MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES + 1) * 4 / 3 / 4) * 4,
    );

    expect(() => parsePendingCanvasAgentAction({
      actionId: 'action-1',
      createdAt: 123,
      request: {
        type: 'import_images',
        projectId: 'project-1',
        baseRevision: 'revision-1',
        images: [{
          clientId: 'image',
          source: `data:image/png;base64,${oversizedPayload}`,
        }],
      },
    })).toThrow(/maximum size/);
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
