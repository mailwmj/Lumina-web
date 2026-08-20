import { describe, expect, it } from 'vitest';
import {
  clampFixedCanvasTransform,
  createBatchCropItemFromPreparedImage,
  createCenteredCrop,
  createDefaultFixedCanvasDraft,
  fitImageWithinBounds,
  fixedCanvasHasBlank,
  isBatchCompositionModeLocked,
  normalizeRotationDegrees,
  resolveFixedCanvasImageBox,
  resolveAvailableStretchDirections,
  resolveAxisSnappedSelection,
  resolveFixedCanvasStatus,
  resolveStretchDestination,
} from './domain';

describe('batch image crop geometry', () => {
  it('centers a portrait crop without changing the requested ratio', () => {
    const crop = createCenteredCrop(4000, 6000, 1440, 1920);

    expect(crop.x).toBeCloseTo(0);
    expect(crop.width).toBeCloseTo(1);
    expect(crop.y).toBeCloseTo(1 / 18);
    expect((4000 * crop.width) / (6000 * crop.height)).toBeCloseTo(1440 / 1920);
  });

  it('centers a square crop inside a landscape image', () => {
    const crop = createCenteredCrop(6000, 4000, 1440, 1440);

    expect(crop.x).toBeCloseTo(1 / 6);
    expect(crop.y).toBe(0);
    expect(crop.width).toBeCloseTo(2 / 3);
    expect(crop.height).toBe(1);
  });

  it('normalizes repeated left and right turns', () => {
    expect(normalizeRotationDegrees(-90)).toBe(270);
    expect(normalizeRotationDegrees(450)).toBe(90);
  });

  it('keeps a portrait preview portrait while fitting it inside the editor', () => {
    const rendered = fitImageWithinBounds(3574, 5361, 1448, 920);

    expect(rendered.width).toBeLessThan(rendered.height);
    expect(rendered.width / rendered.height).toBeCloseTo(3574 / 5361, 3);
    expect(rendered.width).toBe(613);
    expect(rendered.height).toBe(920);
  });

  it('applies the automatic suggestion as soon as a preview is prepared', () => {
    const item = createBatchCropItemFromPreparedImage(
      {
        sourcePath: '/fixtures/source.jpg',
        fileName: 'source.jpg',
        fileSize: 1024,
        previewPath: '/fixtures/preview.jpg',
        thumbnailPath: '/fixtures/thumbnail.jpg',
        width: 3574,
        height: 5361,
        suggestion: {
          crop: { x: 0, y: 1 / 18, width: 1, height: 8 / 9 },
          requiresReview: false,
        },
      },
      { id: '1440x1920', width: 1440, height: 1920 },
      'image-1',
      0,
      'fallback'
    );

    expect(item.status).toBe('auto');
    expect(item.compositionMode).toBe('crop');
    expect(item.crop).toEqual(item.automaticCrop);
    expect(item.errorMessage).toBeUndefined();
  });

  it('defaults newly prepared square outputs to fixed canvas while preserving the crop draft', () => {
    const item = createBatchCropItemFromPreparedImage(
      {
        sourcePath: '/fixtures/source.jpg',
        fileName: 'source.jpg',
        fileSize: 1024,
        previewPath: '/fixtures/preview.jpg',
        thumbnailPath: '/fixtures/thumbnail.jpg',
        width: 3574,
        height: 5361,
        suggestion: {
          crop: { x: 0, y: 1 / 6, width: 1, height: 2 / 3 },
          requiresReview: false,
        },
      },
      { id: '1440x1440', width: 1440, height: 1440 },
      'image-1',
      0,
      'fallback'
    );

    expect(item.compositionMode).toBe('fixed');
    expect(item.status).toBe('fixedCompose');
    expect(item.cropStatus).toBe('auto');
    expect(item.crop).toEqual(item.automaticCrop);
  });

  it('exposes accepted and failed AI results as distinct item states', () => {
    const accepted = createDefaultFixedCanvasDraft();
    accepted.ready = true;
    accepted.ai = { ...accepted.ai, status: 'accepted', resultPath: '/fixtures/filled.jpg' };
    const failed = createDefaultFixedCanvasDraft();
    failed.ready = true;
    failed.ai = { ...failed.ai, status: 'failed', errorMessage: 'provider failed' };

    expect(resolveFixedCanvasStatus(accepted)).toBe('aiGenerated');
    expect(resolveFixedCanvasStatus(failed)).toBe('aiFailed');
  });

  it('keeps the image reviewable when a prepared preview has no suggestion', () => {
    const item = createBatchCropItemFromPreparedImage(
      {
        sourcePath: '/fixtures/source.jpg',
        fileName: 'source.jpg',
        fileSize: 1024,
        previewPath: '/fixtures/preview.jpg',
        thumbnailPath: '/fixtures/thumbnail.jpg',
        width: 3574,
        height: 5361,
      },
      { id: '1440x1920', width: 1440, height: 1920 },
      'image-1',
      0,
      'fallback'
    );

    expect(item.status).toBe('review');
    expect(item.errorMessage).toBe('fallback');
    expect(item.crop).not.toBeNull();
  });

  it('initializes a separate fixed-canvas draft with the editable default prompt', () => {
    const draft = createDefaultFixedCanvasDraft('continue the street background');

    expect(draft.transform).toEqual({ zoom: 100, pan: { x: 0, y: 0 } });
    expect(draft.stage).toBe('compose');
    expect(draft.ai.prompt).toBe('continue the street background');
    expect(draft.stretches).toEqual([]);
  });

  it('contains a portrait source in a square fixed canvas without distorting it', () => {
    const imageBox = resolveFixedCanvasImageBox(
      750,
      1140,
      1440,
      1440,
      { zoom: 100, pan: { x: 0, y: 0 } }
    );

    expect(imageBox.height).toBe(100);
    expect(imageBox.width).toBeCloseTo((750 / 1140) * 100);
    expect(imageBox.x).toBeCloseTo((100 - imageBox.width) / 2);
    expect(imageBox.y).toBe(0);
  });

  it('resolves a directional stretch as one non-destructive destination rectangle', () => {
    const destination = resolveStretchDestination({
      source: { x: 28, y: 5, width: 12, height: 90 },
      direction: 'left',
      amount: 28,
    });

    expect(destination).toEqual({ x: 0, y: 5, width: 40, height: 90 });
  });

  it('snaps a rough tall selection to a full-height vertical strip', () => {
    expect(resolveAxisSnappedSelection(
      { x: 30, y: 12 },
      { x: 42, y: 88 },
      null
    )).toEqual({
      axis: 'vertical',
      selection: { x: 30, y: 0, width: 12, height: 100 },
    });
  });

  it('snaps a rough wide selection to a full-width horizontal strip', () => {
    expect(resolveAxisSnappedSelection(
      { x: 12, y: 38 },
      { x: 88, y: 48 },
      null
    )).toEqual({
      axis: 'horizontal',
      selection: { x: 0, y: 38, width: 100, height: 10 },
    });
  });

  it('keeps the first selection axis after the drag direction changes', () => {
    expect(resolveAxisSnappedSelection(
      { x: 30, y: 10 },
      { x: 90, y: 20 },
      'vertical'
    )).toEqual({
      axis: 'vertical',
      selection: { x: 30, y: 0, width: 60, height: 100 },
    });
  });

  it('detects when fixed-canvas stretches cover the remaining blank columns', () => {
    const fixedCanvas = createDefaultFixedCanvasDraft();
    fixedCanvas.stretches = [
      { id: 'left', source: { x: 25, y: 0, width: 10, height: 100 }, direction: 'left', amount: 25 },
      { id: 'right', source: { x: 65, y: 0, width: 10, height: 100 }, direction: 'right', amount: 25 },
    ];
    const item = { width: 100, height: 200, fixedCanvas };

    expect(fixedCanvasHasBlank(item, { width: 200, height: 200 })).toBe(false);
  });

  it('keeps at least ten percent of a moved image visible on the canvas', () => {
    const transform = clampFixedCanvasTransform(
      100,
      200,
      200,
      200,
      { zoom: 100, pan: { x: 80, y: 80 } }
    );
    const imageBox = resolveFixedCanvasImageBox(100, 200, 200, 200, transform);
    const visibleWidth = Math.max(0, Math.min(100, imageBox.x + imageBox.width) - Math.max(0, imageBox.x));
    const visibleHeight = Math.max(0, Math.min(100, imageBox.y + imageBox.height) - Math.max(0, imageBox.y));

    expect((visibleWidth * visibleHeight) / (imageBox.width * imageBox.height)).toBeGreaterThanOrEqual(0.1);
    expect(Math.abs(transform.pan.x)).toBeLessThanOrEqual(80);
    expect(Math.abs(transform.pan.y)).toBeLessThanOrEqual(80);
  });

  it('treats an accepted AI result as a complete fixed canvas', () => {
    const fixedCanvas = createDefaultFixedCanvasDraft();
    fixedCanvas.ai = {
      ...fixedCanvas.ai,
      status: 'accepted',
      resultPath: '/fixtures/filled.jpg',
    };

    expect(fixedCanvasHasBlank(
      { width: 100, height: 200, fixedCanvas },
      { width: 200, height: 200 }
    )).toBe(false);
  });

  it('hides stretch handles when completed stretches cover the remaining blank area', () => {
    const imageBox = resolveFixedCanvasImageBox(
      100,
      200,
      200,
      200,
      { zoom: 100, pan: { x: 0, y: 0 } }
    );
    const directions = resolveAvailableStretchDirections(
      { x: 30, y: 0, width: 10, height: 100 },
      imageBox,
      [
        { id: 'left', source: { x: 25, y: 0, width: 10, height: 100 }, direction: 'left', amount: 25 },
        { id: 'right', source: { x: 65, y: 0, width: 10, height: 100 }, direction: 'right', amount: 25 },
      ]
    );

    expect(directions).toEqual({ left: false, right: false, top: false, bottom: false });
  });

  it('locks composition mode while AI fill is processing', () => {
    const fixedCanvas = createDefaultFixedCanvasDraft();
    const item = {
      ...createBatchCropItemFromPreparedImage(
        {
          sourcePath: '/fixtures/source.jpg',
          fileName: 'source.jpg',
          fileSize: 1024,
          previewPath: '/fixtures/preview.jpg',
          thumbnailPath: '/fixtures/thumbnail.jpg',
          width: 100,
          height: 200,
        },
        { id: '1440x1440', width: 1440, height: 1440 },
        'image-1',
        0,
        'fallback'
      ),
      status: 'aiProcessing' as const,
      fixedCanvas: {
        ...fixedCanvas,
        ai: { ...fixedCanvas.ai, status: 'processing' as const },
      },
    };

    expect(isBatchCompositionModeLocked(item, false)).toBe(true);
  });
});
