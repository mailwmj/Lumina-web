// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BatchImageCropWorkbench } from './BatchImageCropWorkbench';
import {
  cleanupBrowserBatchCropResults,
  downloadBrowserBatchCropResult,
  writeBrowserBatchCropResult,
} from './infrastructure/browserBatchImageCropAssets';
import { browserBatchImageCropGateway } from './infrastructure/browserBatchImageCropGateway';

const repository = {
  write: vi.fn(),
  hydrateObjectUrl: vi.fn(),
  releaseObjectUrl: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('@/runtime/mediaRuntime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/runtime/mediaRuntime')>(),
  getRuntimeAssetRepository: () => repository,
}));
vi.mock('./infrastructure/browserBatchImageCropGateway', () => ({
  browserBatchImageCropGateway: {
    prepare: vi.fn(),
    renderCrop: vi.fn(),
    renderFixedCanvas: vi.fn(),
    renderFixedCanvasBlob: vi.fn(),
    cleanup: vi.fn(),
  },
}));
vi.mock('./infrastructure/browserBatchImageCropAssets', () => ({
  cleanupBrowserBatchCropResults: vi.fn(),
  downloadBrowserBatchCropResult: vi.fn(),
  writeBrowserBatchCropResult: vi.fn(),
}));

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

describe('BatchImageCropWorkbench browser export', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onExit = vi.fn();
  let backHandlerRef: React.MutableRefObject<() => void> = { current: () => undefined };

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    onExit = vi.fn();
    backHandlerRef = { current: () => undefined };
    repository.write.mockResolvedValue({ assetId: 'asset-output' });
    vi.mocked(browserBatchImageCropGateway.prepare).mockResolvedValue({
      sourceKey: 'look.jpg:6:1',
      sourcePath: 'blob:source',
      fileName: 'look.jpg',
      fileSize: 6,
      previewPath: 'blob:preview',
      thumbnailPath: 'blob:thumbnail',
      width: 3000,
      height: 4000,
      suggestion: { crop: { x: 0, y: 0, width: 1, height: 1 }, requiresReview: false },
    });
    vi.mocked(browserBatchImageCropGateway.renderCrop).mockResolvedValue(
      new Blob(['jpg'], { type: 'image/jpeg' }),
    );
    vi.mocked(writeBrowserBatchCropResult).mockResolvedValue({
      assetId: 'asset-output',
      fileName: 'look_1440x1920.jpg',
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<BatchImageCropWorkbench onExit={onExit} backHandlerRef={backHandlerRef} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('prepares selected browser files and downloads only the browser asset written for the crop result', async () => {
    await act(async () => findButton(container, '1440×1920').click());
    const input = container.querySelector('[data-testid="batch-crop-file-input"]') as HTMLInputElement;
    const file = new File(['source'], 'look.jpg', { type: 'image/jpeg', lastModified: 1 });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(browserBatchImageCropGateway.prepare).toHaveBeenCalledWith(
      expect.any(String), file, 0, { id: '1440x1920', width: 1440, height: 1920 },
    ));

    await act(async () => findButton(container, '批量导出 1 张').click());
    await vi.waitFor(() => expect(writeBrowserBatchCropResult).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFileName: 'look.jpg', target: { id: '1440x1920', width: 1440, height: 1920 } }),
      repository,
    ));
    expect(downloadBrowserBatchCropResult).toHaveBeenCalledWith(
      'asset-output',
      'look_1440x1920.jpg',
      repository,
    );
    expect(container.textContent).toContain('浏览器下载');
  });

  it('retains completed browser result assets when leaving the workbench', async () => {
    await act(async () => findButton(container, '1440×1920').click());
    const input = container.querySelector('[data-testid="batch-crop-file-input"]') as HTMLInputElement;
    const file = new File(['source'], 'look.jpg', { type: 'image/jpeg', lastModified: 1 });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(browserBatchImageCropGateway.prepare).toHaveBeenCalled());
    await act(async () => findButton(container, '批量导出 1 张').click());
    await vi.waitFor(() => expect(writeBrowserBatchCropResult).toHaveBeenCalled());
    await act(async () => findButton(container, '确认').click());
    await act(async () => backHandlerRef.current());

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(browserBatchImageCropGateway.cleanup)).toHaveBeenCalledTimes(1);
    expect(cleanupBrowserBatchCropResults).not.toHaveBeenCalled();
  });
});
