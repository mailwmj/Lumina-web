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

function mediaProcessor() {
  return {
    importAudio: imports.importAudio,
    importVideo: imports.importVideo,
  };
}

describe('browser canvas media import', () => {
  it('creates asset-backed audio and video nodes with durable source metadata', async () => {
    imports.importAudio.mockResolvedValueOnce({
      assetId: 'asset-audio-1', mediaUrl: null, sourceFileName: 'voice.wav',
      sourceMimeType: 'audio/wav', mimeType: 'audio/wav', durationMs: 1_500,
      width: null, height: null,
    });
    imports.importVideo.mockResolvedValueOnce({
      assetId: 'asset-video-1', mediaUrl: null, sourceFileName: 'clip.mp4',
      sourceMimeType: 'video/mp4', mimeType: 'video/mp4', durationMs: 2_500,
      width: 1_280, height: 720,
    });
    const addNode = vi.fn();
    let nextNodeId = 0;
    addNode.mockImplementation(() => `node-${++nextNodeId}`);
    const removeNode = vi.fn();
    const persistProject = vi.fn().mockResolvedValue(undefined);
    const deleteAsset = vi.fn().mockResolvedValue(undefined);

    const failures = await importBrowserCanvasMediaFiles({
      files: [
        new File(['audio'], 'voice.wav', { type: 'audio/wav' }),
        new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      ],
      projectId: 'project-1',
      origin: { x: 12, y: 24 },
      useUploadFilenameAsNodeTitle: true,
      addNode,
      removeNode,
      assertProjectActive: vi.fn(),
      persistProject,
      deleteAsset,
      mediaProcessor: mediaProcessor(),
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
    expect(persistProject).toHaveBeenCalledTimes(2);
    expect(removeNode).not.toHaveBeenCalled();
    expect(deleteAsset).not.toHaveBeenCalled();
  });

  it('removes the node and directly deletes its unreferenced asset when persistence fails', async () => {
    imports.importAudio.mockResolvedValueOnce({
      assetId: 'asset-orphaned', mediaUrl: null, sourceFileName: 'voice.wav',
      sourceMimeType: 'audio/wav', mimeType: 'audio/wav', durationMs: 1_500,
      width: null, height: null,
    });
    const removeNode = vi.fn();
    const deleteAsset = vi.fn().mockResolvedValue(undefined);

    const failures = await importBrowserCanvasMediaFiles({
      files: [new File(['audio'], 'voice.wav', { type: 'audio/wav' })],
      projectId: 'project-1',
      origin: { x: 0, y: 0 },
      useUploadFilenameAsNodeTitle: false,
      addNode: vi.fn(() => 'node-orphaned'),
      removeNode,
      assertProjectActive: vi.fn(),
      persistProject: vi.fn().mockRejectedValue(new Error('Runtime write failed')),
      deleteAsset,
      mediaProcessor: mediaProcessor(),
    });

    expect(failures).toHaveLength(1);
    expect(removeNode).toHaveBeenCalledWith('node-orphaned');
    expect(deleteAsset).toHaveBeenCalledWith('asset-orphaned');
  });

  it('reports a retryable cleanup failure when the Runtime rejects direct deletion', async () => {
    imports.importAudio.mockResolvedValueOnce({
      assetId: 'asset-cleanup-failed', mediaUrl: null, sourceFileName: 'voice.wav',
      sourceMimeType: 'audio/wav', mimeType: 'audio/wav', durationMs: 1_500,
      width: null, height: null,
    });

    const failures = await importBrowserCanvasMediaFiles({
      files: [new File(['audio'], 'voice.wav', { type: 'audio/wav' })],
      projectId: 'project-1',
      origin: { x: 0, y: 0 },
      useUploadFilenameAsNodeTitle: false,
      addNode: vi.fn(() => 'node-orphaned'),
      removeNode: vi.fn(),
      assertProjectActive: vi.fn(),
      persistProject: vi.fn().mockRejectedValue(new Error('Runtime write failed')),
      deleteAsset: vi.fn().mockRejectedValue(new Error('asset still referenced')),
      mediaProcessor: mediaProcessor(),
    });

    expect(failures).toEqual([
      expect.objectContaining({
        cleanupAssetId: 'asset-cleanup-failed',
        retryable: true,
        error: expect.objectContaining({
          name: 'BrowserCanvasMediaImportCleanupError',
          assetId: 'asset-cleanup-failed',
          retryable: true,
        }),
      }),
    ]);
  });

  it('does not insert imported media after the active project changes', async () => {
    imports.importAudio.mockResolvedValueOnce({
      assetId: 'asset-project-changed', mediaUrl: null, sourceFileName: 'voice.wav',
      sourceMimeType: 'audio/wav', mimeType: 'audio/wav', durationMs: 1_500,
      width: null, height: null,
    });
    const addNode = vi.fn(() => 'node-never-added');
    const deleteAsset = vi.fn().mockResolvedValue(undefined);
    const persistProject = vi.fn().mockResolvedValue(undefined);

    const failures = await importBrowserCanvasMediaFiles({
      files: [new File(['audio'], 'voice.wav', { type: 'audio/wav' })],
      projectId: 'project-1',
      origin: { x: 0, y: 0 },
      useUploadFilenameAsNodeTitle: false,
      addNode,
      removeNode: vi.fn(),
      assertProjectActive: vi.fn(() => {
        throw new Error('The active project changed while importing media.');
      }),
      persistProject,
      deleteAsset,
      mediaProcessor: mediaProcessor(),
    });

    expect(failures).toHaveLength(1);
    expect(addNode).not.toHaveBeenCalled();
    expect(deleteAsset).toHaveBeenCalledWith('asset-project-changed');
    expect(persistProject).not.toHaveBeenCalled();
  });
});
