import { describe, expect, it, vi } from 'vitest';

const imports = vi.hoisted(() => ({
  importImage: vi.fn(),
  importAudio: vi.fn(),
  importVideo: vi.fn(),
}));

vi.mock('@/features/assets/application/browserImageImport', () => ({
  importRuntimeBrowserImageAsset: imports.importImage,
}));

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { importBrowserCanvasMediaFiles } from './browserCanvasMediaImport';

describe('browser canvas media import', () => {
  it('creates asset-backed audio and video nodes with durable source metadata', async () => {
    imports.importAudio
      .mockResolvedValueOnce({
        assetId: 'asset-audio-1', mediaUrl: null, sourceFileName: 'voice.wav',
        sourceMimeType: 'audio/wav', mimeType: 'audio/wav', durationMs: 1_500, width: null, height: null,
      });
    imports.importVideo
      .mockResolvedValueOnce({
        assetId: 'asset-video-1', mediaUrl: null, sourceFileName: 'clip.mp4',
        sourceMimeType: 'video/mp4', mimeType: 'video/mp4', durationMs: 2_500, width: 1_280, height: 720,
      });
    const addNode = vi.fn();

    const failures = await importBrowserCanvasMediaFiles({
      files: [
        new File(['audio'], 'voice.wav', { type: 'audio/wav' }),
        new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      ],
      projectId: 'project-1',
      origin: { x: 12, y: 24 },
      useUploadFilenameAsNodeTitle: true,
      addNode,
      mediaProcessor: {
        importAudio: imports.importAudio,
        importVideo: imports.importVideo,
      },
    });

    expect(failures).toEqual([]);
    expect(addNode).toHaveBeenNthCalledWith(1, CANVAS_NODE_TYPES.audioUpload, { x: 12, y: 24 }, {
      assetId: 'asset-audio-1',
      audioUrl: null,
      sourceFileName: 'voice.wav',
      sourceMimeType: 'audio/wav',
      mimeType: 'audio/wav',
      durationMs: 1_500,
      mediaWidth: null,
      mediaHeight: null,
      displayName: 'voice.wav',
    });
    expect(addNode).toHaveBeenNthCalledWith(2, CANVAS_NODE_TYPES.videoUpload, { x: 252, y: 24 }, {
      assetId: 'asset-video-1',
      videoUrl: null,
      sourceFileName: 'clip.mp4',
      sourceMimeType: 'video/mp4',
      mimeType: 'video/mp4',
      durationMs: 2_500,
      mediaWidth: 1_280,
      mediaHeight: 720,
      displayName: 'clip.mp4',
    });
  });
});
