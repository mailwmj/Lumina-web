import { describe, expect, it, vi } from 'vitest';

import { NODE_TOOL_TYPES } from '@/features/canvas/domain/canvasNodes';
import { createTauriMediaProcessor } from './tauriMediaProcessor';

describe('Tauri MediaProcessor adapter', () => {
  it('preserves the existing media preparation and processing boundaries', async () => {
    const dependencies = {
      prepareImage: vi.fn(async () => ({
        imageUrl: 'prepared.png',
        previewImageUrl: 'preview.png',
        aspectRatio: '16:9',
      })),
      createImagePreview: vi.fn(async () => ({
        previewImageUrl: 'preview.png',
        aspectRatio: '16:9',
      })),
      processImageTool: vi.fn(async () => ({ outputImageUrl: 'cropped.png' })),
      mergeStoryboard: vi.fn(async () => ({
        imagePath: 'storyboard.png',
        canvasWidth: 1920,
        canvasHeight: 1080,
        cellWidth: 960,
        cellHeight: 1080,
        gap: 0,
        padding: 0,
        noteHeight: 0,
        fontSize: 24,
        textOverlayApplied: false,
      })),
      readStoryboardMetadata: vi.fn(async () => ({
        gridRows: 1,
        gridCols: 2,
        frameNotes: ['first', 'second'],
      })),
      writeDerivedImage: vi.fn(async () => null),
      embedStoryboardMetadata: vi.fn(async () => 'storyboard-with-metadata.png'),
      convertVideoToMp4: vi.fn(async () => 'converted.mp4'),
      convertAudioToMp3: vi.fn(async () => 'converted.mp3'),
      importVideo: vi.fn(async () => ({
        assetId: null,
        mediaUrl: 'imported.mp4',
        sourceFileName: 'input.mov',
        sourceMimeType: 'video/quicktime',
        mimeType: 'video/mp4',
        durationMs: null,
        width: null,
        height: null,
      })),
      importAudio: vi.fn(async () => ({
        assetId: null,
        mediaUrl: 'imported.mp3',
        sourceFileName: 'input.wav',
        sourceMimeType: 'audio/wav',
        mimeType: 'audio/mpeg',
        durationMs: null,
        width: null,
        height: null,
      })),
      prepareTemporaryPublicMedia: vi.fn(async () => ({
        key: 'temporary/key',
        url: 'https://media.example/temporary',
        expiresAt: 123,
        contentType: 'video/mp4',
        sizeBytes: 456,
      })),
    };
    const processor = createTauriMediaProcessor(dependencies);

    await expect(processor.prepareImage('input.png', {
      maxPreviewDimension: 512,
      projectId: 'project-1',
    })).resolves.toMatchObject({ imageUrl: 'prepared.png' });
    await expect(processor.createImagePreview('input.png', {
      maxPreviewDimension: 256,
      projectId: 'project-1',
    })).resolves.toMatchObject({ previewImageUrl: 'preview.png' });
    await expect(processor.processImageTool(
      NODE_TOOL_TYPES.crop,
      'input.png',
      { aspectRatio: '1:1' },
    )).resolves.toEqual({ outputImageUrl: 'cropped.png' });

    const mergeRequest = {
      frameSources: ['first.png', 'second.png'],
      rows: 1,
      cols: 2,
      cellGap: 0,
      outerPadding: 0,
      noteHeight: 0,
      fontSize: 24,
      backgroundColor: '#000000',
      maxDimension: 4096,
    };
    await expect(processor.mergeStoryboard(mergeRequest)).resolves.toMatchObject({
      imagePath: 'storyboard.png',
    });
    await expect(processor.readStoryboardMetadata('storyboard.png')).resolves.toMatchObject({
      gridRows: 1,
      gridCols: 2,
    });
    await expect(processor.writeDerivedImage({
      source: 'storyboard.png',
      projectId: 'project-1',
      width: 1920,
      height: 1080,
    })).resolves.toBeNull();
    await expect(processor.embedStoryboardMetadata(
      'storyboard.png',
      { gridRows: 1, gridCols: 2, frameNotes: ['first', 'second'] },
      'project-1',
    )).resolves.toBe('storyboard-with-metadata.png');
    await expect(processor.convertVideoToMp4('input.mov', 'project-1')).resolves.toBe('converted.mp4');
    await expect(processor.convertAudioToMp3('input.wav', 'project-1')).resolves.toBe('converted.mp3');
    const videoFile = new File(['video'], 'input.mov', { type: 'video/quicktime' });
    const audioFile = new File(['audio'], 'input.wav', { type: 'audio/wav' });
    await expect(processor.importVideo(videoFile, 'project-1')).resolves.toMatchObject({
      assetId: null,
      mediaUrl: 'imported.mp4',
    });
    await expect(processor.importAudio(audioFile, 'project-1')).resolves.toMatchObject({
      assetId: null,
      mediaUrl: 'imported.mp3',
    });
    await expect(processor.prepareTemporaryPublicMedia('input.mov', {
      projectId: 'project-1',
      providerId: 'volcengine-seedance',
    })).resolves.toMatchObject({
      key: 'temporary/key',
    });

    expect(dependencies.prepareImage).toHaveBeenCalledWith('input.png', 512, 'project-1');
    expect(dependencies.createImagePreview).toHaveBeenCalledWith('input.png', 256, 'project-1');
    expect(dependencies.processImageTool).toHaveBeenCalledWith(
      NODE_TOOL_TYPES.crop,
      'input.png',
      { aspectRatio: '1:1' },
    );
    expect(dependencies.mergeStoryboard).toHaveBeenCalledWith(mergeRequest);
    expect(dependencies.writeDerivedImage).toHaveBeenCalledWith({
      source: 'storyboard.png',
      projectId: 'project-1',
      width: 1920,
      height: 1080,
    });
    expect(dependencies.convertVideoToMp4).toHaveBeenCalledWith('input.mov', 'project-1');
    expect(dependencies.convertAudioToMp3).toHaveBeenCalledWith('input.wav', 'project-1');
    expect(dependencies.importVideo).toHaveBeenCalledWith(videoFile, 'project-1');
    expect(dependencies.importAudio).toHaveBeenCalledWith(audioFile, 'project-1');
    expect(dependencies.prepareTemporaryPublicMedia).toHaveBeenCalledWith('input.mov', {
      projectId: 'project-1',
      providerId: 'volcengine-seedance',
    });
  });
});
