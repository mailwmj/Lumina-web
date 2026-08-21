import { describe, expect, it, vi } from 'vitest';

import { createBrowserBatchImageCropGateway } from './browserBatchImageCropGateway';

function createCanvas() {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
    fillStyle: '',
  };
  return {
    getContext: vi.fn(() => context),
    toBlob: (callback: BlobCallback) => callback(new Blob(['preview'], { type: 'image/jpeg' })),
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

describe('browser batch crop preview preparation', () => {
  it('creates bounded preview URLs and the existing centered review suggestion from a selected file', async () => {
    const decodeImage = vi.fn().mockResolvedValue({ width: 1000, height: 2000, close: vi.fn() });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:source')
      .mockReturnValueOnce('blob:preview')
      .mockReturnValueOnce('blob:thumbnail');
    const gateway = createBrowserBatchImageCropGateway({
      createCanvas,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      decodeImage,
    });

    const prepared = await gateway.prepare(
      'batch-1',
      new File(['source'], 'look.jpg', { type: 'image/jpeg' }),
      0,
      { width: 1440, height: 1920 },
    );

    expect(prepared).toMatchObject({
      sourcePath: 'blob:source',
      previewPath: 'blob:preview',
      thumbnailPath: 'blob:thumbnail',
      fileName: 'look.jpg',
      width: 1000,
      height: 2000,
      suggestion: {
        crop: { x: 0, y: expect.closeTo(1 / 6), width: 1, height: expect.closeTo(2 / 3) },
        requiresReview: true,
      },
    });
    expect(decodeImage).toHaveBeenCalledOnce();
  });

  it.each([
    new File(['source'], 'look.gif', { type: 'image/gif' }),
    new File([new Uint8Array(60 * 1024 * 1024 + 1)], 'look.jpg', { type: 'image/jpeg' }),
  ])('rejects a file that cannot enter the batch', async (file) => {
    const gateway = createBrowserBatchImageCropGateway({
      createCanvas,
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn(),
      decodeImage: vi.fn(),
    });

    await expect(gateway.prepare('batch-1', file, 0, { width: 1440, height: 1920 })).rejects.toThrow(
      file.type === 'image/gif' ? 'UNSUPPORTED_FORMAT' : 'FILE_TOO_LARGE',
    );
  });

  it('renders the final crop from the source at the exact target size', async () => {
    const canvases: HTMLCanvasElement[] = [];
    const gateway = createBrowserBatchImageCropGateway({
      createCanvas: () => {
        const canvas = createCanvas();
        canvases.push(canvas);
        return canvas;
      },
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn(),
      decodeImage: vi.fn().mockResolvedValue({ width: 3000, height: 2000, close: vi.fn() }),
      readSource: vi.fn().mockResolvedValue(new Blob(['original'], { type: 'image/png' })),
    });

    const output = await gateway.renderCrop({
      sourcePath: 'blob:original',
      rotationDegrees: 0,
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      target: { width: 1440, height: 1920 },
    });

    expect(output.type).toBe('image/jpeg');
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 1440, height: 1920 });
  });

  it('renders the fixed canvas and its binary blank mask as batch-owned URLs', async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:fixed-canvas')
      .mockReturnValueOnce('blob:blank-mask');
    const gateway = createBrowserBatchImageCropGateway({
      createCanvas,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      decodeImage: vi.fn().mockResolvedValue({ width: 1000, height: 2000, close: vi.fn() }),
      readSource: vi.fn().mockResolvedValue(new Blob(['original'], { type: 'image/png' })),
    });

    const rendered = await gateway.renderFixedCanvas('batch-1', {
      sourcePath: 'blob:original',
      targetWidth: 1440,
      targetHeight: 1440,
      rotationDegrees: 0,
      transform: { zoom: 100, pan: { x: 0, y: 0 } },
      stretches: [],
    });

    expect(rendered).toEqual({
      renderedPath: 'blob:fixed-canvas',
      blankMaskPath: 'blob:blank-mask',
    });
  });
});
