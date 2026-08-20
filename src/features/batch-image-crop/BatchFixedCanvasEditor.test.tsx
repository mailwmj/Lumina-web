// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BatchFixedCanvasEditor } from './BatchFixedCanvasEditor';
import {
  createDefaultFixedCanvasDraft,
  type BatchCropImageItem,
  type BatchCropTarget,
  type FixedCanvasDraft,
} from './domain';

const target = { id: '1440x1440', width: 1440, height: 1440 } as const;

function createItem(
  draft: FixedCanvasDraft,
  dimensions: { width: number; height: number } = { width: 100, height: 200 }
): BatchCropImageItem {
  return {
    id: 'image-1',
    sourcePath: '/fixtures/source.jpg',
    fileName: 'source.jpg',
    fileSize: 1024,
    previewPath: '/fixtures/preview.jpg',
    thumbnailPath: '/fixtures/thumbnail.jpg',
    width: dimensions.width,
    height: dimensions.height,
    rotationDegrees: 0,
    compositionMode: 'fixed',
    status: draft.stage === 'compose' ? 'fixedCompose' : 'fixedFill',
    cropStatus: 'auto',
    crop: { x: 0, y: 0, width: 1, height: 1 },
    automaticCrop: { x: 0, y: 0, width: 1, height: 1 },
    requiresReview: false,
    lowResolution: false,
    fixedCanvas: draft,
  };
}

describe('BatchFixedCanvasEditor interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      top: 0,
      right: 200,
      bottom: 200,
      left: 0,
      toJSON: () => ({}),
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderEditor = async (
    draft: FixedCanvasDraft,
    onChange = vi.fn(),
    options: {
      index?: number;
      total?: number;
      onPrevious?: () => void;
      onNext?: () => void;
      target?: BatchCropTarget;
      dimensions?: { width: number; height: number };
    } = {}
  ) => {
    await act(async () => root.render(
      <BatchFixedCanvasEditor
        item={createItem(draft, options.dimensions)}
        target={options.target ?? target}
        index={options.index ?? 0}
        total={options.total ?? 1}
        busy={false}
        onChange={onChange}
        onOpenAi={() => undefined}
        onRequeryAi={() => undefined}
        onCancelAi={() => undefined}
        onToast={() => undefined}
        onPrevious={options.onPrevious ?? (() => undefined)}
        onNext={options.onNext ?? (() => undefined)}
      />
    ));
    return onChange;
  };

  it('puts proportional scale handles directly on the image in compose stage', async () => {
    await renderEditor(createDefaultFixedCanvasDraft('prompt'));

    expect(container.querySelectorAll('button[aria-label="拖动等比缩放图片"]')).toHaveLength(4);
    expect(container.querySelector('input[aria-label="整图缩放"]')).not.toBeNull();
  });

  it.each([
    { overflowTarget: { id: '1440x1440', width: 1440, height: 1440 }, zoom: 200 },
    { overflowTarget: { id: '1440x1920', width: 1440, height: 1920 }, zoom: 125 },
    { overflowTarget: { id: '1440x2200', width: 1440, height: 2200 }, zoom: 110 },
  ] as const)(
    'lets an enlarged image exceed the $overflowTarget.id canvas without browser width clamping',
    async ({ overflowTarget, zoom }) => {
      await renderEditor({
        ...createDefaultFixedCanvasDraft('prompt'),
        transform: { zoom, pan: { x: 0, y: 0 } },
      }, vi.fn(), {
        target: overflowTarget,
        dimensions: { width: 100, height: 150 },
      });

      const image = container.querySelector('img[alt="source.jpg"]');
      expect(image).toBeInstanceOf(HTMLImageElement);
      expect(Number.parseFloat((image as HTMLImageElement).style.width)).toBeGreaterThan(100);
      expect(image?.className).toContain('max-w-none');
      expect(image?.className).toContain('max-h-none');
    }
  );

  it('draws a source selection and stretches it toward the adjacent blank area', async () => {
    const onChange = vi.fn();
    const fillDraft = {
      ...createDefaultFixedCanvasDraft('prompt'),
      stage: 'fill' as const,
      tool: 'stretch' as const,
    };
    await renderEditor(fillDraft, onChange);
    const canvas = container.querySelector('[data-testid="fixed-canvas"]');
    expect(canvas).toBeInstanceOf(HTMLDivElement);

    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 20, pointerId: 1 }));
    });
    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 180, pointerId: 1 }));
    });
    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 80, clientY: 180, pointerId: 1 }));
    });

    const selectedDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(selectedDraft.selection).toEqual({ x: 30, y: 0, width: 10, height: 100 });

    onChange.mockClear();
    await renderEditor({ ...selectedDraft, tool: 'stretch' }, onChange);
    const stretchLeft = container.querySelector('button[aria-label="向左拉伸"]');
    const nextCanvas = container.querySelector('[data-testid="fixed-canvas"]');
    expect(stretchLeft).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      stretchLeft?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 100, pointerId: 2 }));
    });
    await act(async () => {
      nextCanvas?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 0, clientY: 100, pointerId: 2 }));
    });
    await act(async () => {
      nextCanvas?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 0, clientY: 100, pointerId: 2 }));
    });

    const stretchedDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(stretchedDraft.stretches).toHaveLength(1);
    expect(stretchedDraft.stretches[0]).toMatchObject({ direction: 'left', amount: 30 });
    expect(stretchedDraft.selection).toBeNull();
    expect(stretchedDraft.activeStretchId).toBeNull();
    expect(stretchedDraft.tool).toBe('stretch');
    expect(stretchedDraft.ready).toBe(true);
  });

  it('keeps completed stretch patches passive while drawing another selection', async () => {
    const onChange = vi.fn();
    await renderEditor({
      ...createDefaultFixedCanvasDraft('prompt'),
      stage: 'fill',
      tool: 'stretch',
      activeStretchId: 'left',
      stretches: [
        {
          id: 'left',
          source: { x: 25, y: 0, width: 10, height: 100 },
          direction: 'left',
          amount: 25,
        },
      ],
    }, onChange);
    const patch = container.querySelector('button[aria-label="选择拉伸区域"]');
    const canvas = container.querySelector('[data-testid="fixed-canvas"]');
    expect(patch).toBeInstanceOf(HTMLButtonElement);
    expect(patch?.className).not.toContain('outline-accent');

    await act(async () => {
      patch?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 60,
        clientY: 20,
        pointerId: 6,
      }));
    });
    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 80,
        clientY: 180,
        pointerId: 6,
      }));
    });
    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 80,
        clientY: 180,
        pointerId: 6,
      }));
    });

    const selectedDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(selectedDraft.selection).toEqual({ x: 30, y: 0, width: 10, height: 100 });
    expect(selectedDraft.activeStretchId).toBeNull();
  });

  it('moves and resizes the source selection directly on the canvas', async () => {
    const onChange = vi.fn();
    const fillDraft = {
      ...createDefaultFixedCanvasDraft('prompt'),
      stage: 'fill' as const,
      tool: 'stretch' as const,
      selection: { x: 30, y: 0, width: 10, height: 100 },
    };
    await renderEditor(fillDraft, onChange);
    const selection = container.querySelector('[data-testid="fixed-canvas-selection"]');
    const canvas = container.querySelector('[data-testid="fixed-canvas"]');

    await act(async () => {
      selection?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 70,
        clientY: 100,
        pointerId: 3,
      }));
    });
    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 90,
        clientY: 100,
        pointerId: 3,
      }));
    });
    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 90,
        clientY: 100,
        pointerId: 3,
      }));
    });

    const movedDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(movedDraft.selection).toEqual({ x: 40, y: 0, width: 10, height: 100 });

    onChange.mockClear();
    await renderEditor(movedDraft, onChange);
    const resizeHandle = container.querySelector('button[aria-label="调整选区大小"]');
    const nextCanvas = container.querySelector('[data-testid="fixed-canvas"]');
    await act(async () => {
      resizeHandle?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 80,
        clientY: 20,
        pointerId: 4,
      }));
    });
    await act(async () => {
      nextCanvas?.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 60,
        clientY: 10,
        pointerId: 4,
      }));
    });
    await act(async () => {
      nextCanvas?.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 60,
        clientY: 10,
        pointerId: 4,
      }));
    });

    const resizedDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(resizedDraft.selection).toEqual({ x: 30, y: 0, width: 20, height: 100 });
  });

  it('makes the fixed canvas export-ready as soon as composition is confirmed', async () => {
    const onChange = vi.fn();
    await renderEditor(createDefaultFixedCanvasDraft('prompt'), onChange);

    const confirm = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '确认构图');
    await act(async () => confirm?.click());

    const confirmedDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(confirmedDraft.stage).toBe('fill');
    expect(confirmedDraft.ready).toBe(true);
    expect(container.textContent).not.toContain('完成填充');
  });

  it('shows navigation in fill mode without a stretch-region count', async () => {
    await renderEditor({
      ...createDefaultFixedCanvasDraft('prompt'),
      stage: 'fill',
      ready: true,
      stretches: [
        {
          id: 'left',
          source: { x: 25, y: 0, width: 10, height: 100 },
          direction: 'left',
          amount: 25,
        },
      ],
    }, vi.fn(), { index: 1, total: 3 });

    expect(container.textContent).toContain('2/3');
    expect(container.textContent).not.toContain('个拉伸区域');
  });

  it('moves to the strict next item from the AI processing overlay', async () => {
    const onNext = vi.fn();
    const processingDraft: FixedCanvasDraft = {
      ...createDefaultFixedCanvasDraft('prompt'),
      stage: 'fill',
      ready: true,
      ai: {
        status: 'processing',
        prompt: 'prompt',
        modelId: 'provider/model',
        resolution: '2K',
        jobId: 'job-1',
      },
    };
    await renderEditor(processingDraft, vi.fn(), { index: 0, total: 2, onNext });
    const processNext = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '处理下一张');

    expect(processNext).toBeInstanceOf(HTMLButtonElement);
    expect((processNext as HTMLButtonElement).disabled).toBe(false);
    await act(async () => processNext?.click());
    expect(onNext).toHaveBeenCalledTimes(1);

    await renderEditor(processingDraft, vi.fn(), { index: 1, total: 2, onNext });
    const lastProcessNext = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '处理下一张');
    expect((lastProcessNext as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancels an unfinished selection when Escape is pressed', async () => {
    const onChange = vi.fn();
    await renderEditor({
      ...createDefaultFixedCanvasDraft('prompt'),
      stage: 'fill',
      tool: 'stretch',
    }, onChange);
    const canvas = container.querySelector('[data-testid="fixed-canvas"]');

    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 60,
        clientY: 20,
        pointerId: 5,
      }));
    });
    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 80,
        clientY: 180,
        pointerId: 5,
      }));
    });
    expect(container.querySelector('[data-testid="fixed-canvas-selection"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-testid="fixed-canvas-selection"]')).toBeNull();

    await act(async () => {
      canvas?.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 80,
        clientY: 180,
        pointerId: 5,
      }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps one undo snapshot when a saved composition is changed', async () => {
    const onChange = vi.fn();
    const savedDraft: FixedCanvasDraft = {
      ...createDefaultFixedCanvasDraft('prompt'),
      stage: 'compose',
      ready: true,
      stretches: [
        { id: 'left', source: { x: 25, y: 0, width: 10, height: 100 }, direction: 'left', amount: 25 },
      ],
      ai: {
        status: 'accepted',
        prompt: 'prompt',
        modelId: 'provider/model',
        resolution: '2K',
        resultPath: '/fixtures/filled.jpg',
      },
    };
    await renderEditor(savedDraft, onChange);
    expect(container.querySelectorAll('button[aria-label="拖动等比缩放图片"]')).toHaveLength(4);
    expect(Array.from(container.querySelectorAll('img')).some((image) => image.src.includes('filled.jpg'))).toBe(false);
    const zoom = container.querySelector('input[aria-label="整图缩放"]') as HTMLInputElement | null;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      if (!zoom) return;
      setValue?.call(zoom, '90');
      zoom.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const changedDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(changedDraft.stretches).toEqual([]);
    expect(changedDraft.ai.status).toBe('idle');
    expect(changedDraft.composeUndo?.ai.resultPath).toBe('/fixtures/filled.jpg');

    onChange.mockClear();
    await renderEditor(changedDraft, onChange);
    const undo = container.querySelector('button[aria-label="撤销构图修改"]') as HTMLButtonElement | null;
    await act(async () => undo?.click());

    const restoredDraft = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as FixedCanvasDraft;
    expect(restoredDraft.stage).toBe('fill');
    expect(restoredDraft.stretches).toHaveLength(1);
    expect(restoredDraft.ai.status).toBe('accepted');
    expect(restoredDraft.ready).toBe(true);
    expect(restoredDraft.composeUndo).toBeNull();
  });
});
