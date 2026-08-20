import { describe, expect, it } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { buildCanvasAgentSnapshot } from './canvasAgentSnapshot';
import { collectSelectedImagePreviewSources } from './selectedImagePreviews';

describe('external Agent canvas snapshots', () => {
  it('does not expose media paths and invalidates the revision when media changes', () => {
    const upload = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 10, y: 20 }, {
      displayName: 'Reference',
      imageUrl: '/private/project/uploads/original.png',
      previewImageUrl: '/private/project/uploads/preview.jpg',
      sourceFileName: 'original.png',
    });
    const first = buildCanvasAgentSnapshot({
      projectId: 'project-1',
      projectName: 'Project',
      nodes: [upload],
      edges: [],
      selectedNodeIds: [upload.id],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const changed = buildCanvasAgentSnapshot({
      projectId: 'project-1',
      projectName: 'Project',
      nodes: [{
        ...upload,
        data: { ...upload.data, imageUrl: '/private/project/uploads/replaced.png' },
      }],
      edges: [],
      selectedNodeIds: [upload.id],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(first.nodes[0].data).toEqual({
      displayName: 'Reference',
      aspectRatio: '1:1',
      sourceFileName: 'original.png',
    });
    expect(JSON.stringify(first)).not.toContain('/private/project');
    expect(first.selectedImagePreviews).toEqual([]);
    expect(changed.revision).not.toBe(first.revision);
  });

  it('publishes registry-owned creation, field, and handle capabilities', () => {
    const snapshot = buildCanvasAgentSnapshot({
      projectId: 'project-1',
      projectName: 'Project',
      nodes: [],
      edges: [],
      selectedNodeIds: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const imageEdit = snapshot.capabilities.nodeTypes.find(
      (item) => item.nodeType === CANVAS_NODE_TYPES.imageEdit
    );
    const exportImage = snapshot.capabilities.nodeTypes.find(
      (item) => item.nodeType === CANVAS_NODE_TYPES.exportImage
    );
    const videoFrame = snapshot.capabilities.nodeTypes.find(
      (item) => item.nodeType === CANVAS_NODE_TYPES.videoFrame
    );

    expect(imageEdit).toMatchObject({ creatable: true });
    expect(imageEdit?.writableFields).toContain('prompt');
    expect(exportImage).toMatchObject({ creatable: false });
    expect(exportImage?.readableFields).toContain('generationError');
    expect(exportImage?.readableFields).not.toContain('generationErrorDetails');
    expect(videoFrame?.targetHandleIds).toEqual(['target-first', 'target-last']);
  });

  it('collects previews only from explicitly selected image-output nodes', () => {
    const image = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      previewImageUrl: 'data:image/jpeg;base64,image-preview',
    });
    const video = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.videoFrame, { x: 0, y: 0 }, {
      previewImageUrl: 'data:image/jpeg;base64,video-thumbnail',
    });

    expect(collectSelectedImagePreviewSources(
      [image, video],
      [image.id, video.id]
    )).toEqual([{
      nodeId: image.id,
      source: 'data:image/jpeg;base64,image-preview',
    }]);
  });
});
