import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type AudioUploadRefNodeData,
  type CanvasNode,
  type UploadImageNodeData,
  type VideoUploadRefNodeData,
  nodeHasImage,
} from './canvasNodes';

function uploadNode(data: UploadImageNodeData): CanvasNode {
  return {
    id: 'upload-1',
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data,
  };
}

describe('canvas media references', () => {
  it('recognizes both legacy URL and stable assetId image nodes', () => {
    expect(nodeHasImage(uploadNode({
      imageUrl: 'C:\\projects\\legacy.png',
      aspectRatio: '1:1',
    }))).toBe(true);

    expect(nodeHasImage(uploadNode({
      assetId: 'asset-image-1',
      imageUrl: null,
      aspectRatio: '1:1',
    }))).toBe(true);
  });

  it('allows audio and video nodes to expand to stable asset references', () => {
    const audio: AudioUploadRefNodeData = {
      assetId: 'asset-audio-1',
      audioUrl: null,
      sourceFileName: 'voice.wav',
    };
    const video: VideoUploadRefNodeData = {
      assetId: 'asset-video-1',
      videoUrl: null,
      sourceFileName: 'clip.mov',
    };

    expect([audio.assetId, video.assetId]).toEqual(['asset-audio-1', 'asset-video-1']);
  });
});
