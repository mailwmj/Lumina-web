// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BatchCropSidebar } from './BatchCropSidebar';
import {
  createDefaultFixedCanvasDraft,
  type BatchCropImageItem,
  type BatchCropItemStatus,
} from './domain';

function createItem(id: string, status: BatchCropItemStatus = 'auto'): BatchCropImageItem {
  return {
    id,
    sourcePath: `/fixtures/${id}.jpg`,
    fileName: `${id}.jpg`,
    fileSize: 1024,
    previewPath: `/fixtures/${id}-preview.jpg`,
    thumbnailPath: `/fixtures/${id}-thumbnail.jpg`,
    width: 100,
    height: 200,
    rotationDegrees: 0,
    compositionMode: 'fixed',
    status,
    cropStatus: 'auto',
    crop: { x: 0, y: 0, width: 1, height: 1 },
    automaticCrop: { x: 0, y: 0, width: 1, height: 1 },
    requiresReview: false,
    lowResolution: false,
    fixedCanvas: createDefaultFixedCanvasDraft('prompt'),
  };
}

describe('BatchCropSidebar item states and keyboard navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

  const renderSidebar = async (items: BatchCropImageItem[], onSelectItem = vi.fn()) => {
    await act(async () => root.render(
      <BatchCropSidebar
        targetId="1440x1440"
        items={items}
        selectedId={items[0]?.id ?? null}
        filter="all"
        phase="idle"
        progress={0}
        progressTotal={0}
        primaryLabel="批量导出"
        primaryDisabled={false}
        targetChangeDisabled={false}
        onTargetChange={() => undefined}
        onSelectItem={onSelectItem}
        onFilterChange={() => undefined}
        onAddPaths={() => undefined}
        onChooseImages={() => undefined}
        onRemoveItem={() => undefined}
        onPrimaryAction={() => undefined}
      />
    ));
    return onSelectItem;
  };

  it('shows explicit visible AI processing, generated, and failed states', async () => {
    await renderSidebar([
      createItem('processing', 'aiProcessing'),
      createItem('generated', 'aiGenerated'),
      createItem('failed', 'aiFailed'),
    ]);

    expect(container.textContent).toContain('AI 生成中');
    expect(container.textContent).toContain('AI 已生成');
    expect(container.textContent).toContain('AI 生成失败');
  });

  it('uses up and down keys to select strict adjacent visible rows and move focus', async () => {
    const onSelectItem = await renderSidebar([
      createItem('first'),
      createItem('second'),
      createItem('third'),
    ]);
    const rows = Array.from(container.querySelectorAll<HTMLDivElement>('div[role="button"]'));
    expect(rows).toHaveLength(3);

    rows[0]?.focus();
    await act(async () => {
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onSelectItem).toHaveBeenLastCalledWith('second');
    expect(document.activeElement).toBe(rows[1]);

    await act(async () => {
      rows[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(onSelectItem).toHaveBeenLastCalledWith('first');
    expect(document.activeElement).toBe(rows[0]);
  });
});
