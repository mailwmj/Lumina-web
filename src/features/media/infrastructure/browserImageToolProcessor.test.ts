import { describe, expect, it, vi } from 'vitest';

import { NODE_TOOL_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { AssetMetadata, AssetRepository } from '@/features/assets/domain/assetRepository';
import { createBrowserImageToolProcessor } from './browserImageToolProcessor';

vi.mock('./browserCanvasImage', () => ({
  cropBrowserImage: vi.fn(),
  annotateBrowserImage: vi.fn(),
  splitBrowserImage: vi.fn(async () => [{
    blob: new Blob(['frame'], { type: 'image/png' }),
    width: 20,
    height: 10,
  }]),
}));

function createRepository(): AssetRepository {
  const sourceMetadata: AssetMetadata = {
    assetId: 'source-asset',
    projectId: 'project-1',
    kind: 'image',
    mimeType: 'image/png',
    byteCount: 1,
    createdAt: 1,
    sourceKind: 'derived',
    width: 120,
    height: 80,
    durationMs: null,
    sourceMetadata: {
      storyboardMetadata: JSON.stringify({
        gridRows: 2,
        gridCols: 3,
        frameNotes: ['opening'],
        exportOptions: {
          showFrameIndex: true,
          showFrameNote: true,
          notePlacement: 'bottom',
          imageFit: 'contain',
          frameIndexPrefix: 'S',
          cellGap: 12,
          outerPadding: 16,
          fontSize: 5,
          backgroundColor: '#101010',
          textColor: '#fefefe',
        },
      }),
    },
    lifecycleState: 'active',
  };
  let writeCount = 0;

  return {
    async write(input) {
      writeCount += 1;
      return {
        ...sourceMetadata,
        assetId: `derived-${writeCount}`,
        blob: input.blob,
        width: input.width ?? null,
        height: input.height ?? null,
        sourceMetadata: input.sourceMetadata ?? {},
      } as AssetMetadata;
    },
    async getMetadata(assetId) {
      return assetId === sourceMetadata.assetId ? sourceMetadata : null;
    },
  } as AssetRepository;
}

describe('browser image tool processor', () => {
  it('requires an active project before a derived image operation can create output', async () => {
    const processor = createBrowserImageToolProcessor({
      getAssetRepository: () => null,
      createFrameId: () => 'frame-1',
    });

    await expect(processor.process(NODE_TOOL_TYPES.crop, 'data:image/png;base64,', {}))
      .rejects.toThrow('An active project is required before processing an image.');
  });

  it('restores stored storyboard export options when splitting a derived browser asset', async () => {
    const processor = createBrowserImageToolProcessor({
      getAssetRepository: createRepository,
      createFrameId: () => 'frame-1',
    });

    await expect(processor.process(NODE_TOOL_TYPES.splitStoryboard, 'blob:source', {
      projectId: 'project-1',
      sourceAssetId: 'source-asset',
    })).resolves.toMatchObject({
      rows: 2,
      cols: 3,
      storyboardFrames: [{ note: 'opening' }],
      storyboardExportOptions: {
        imageFit: 'contain',
        outerPadding: 16,
        textColor: '#fefefe',
      },
    });
  });
});
