// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BatchImageCropWorkbench } from './BatchImageCropWorkbench';
import {
  writeBrowserBatchCropResult,
} from './infrastructure/browserBatchImageCropAssets';
import { browserBatchImageCropGateway } from './infrastructure/browserBatchImageCropGateway';
import { outputBrowserMediaFiles } from '@/features/assets/application/browserMediaOutput';

const repository = {
  write: vi.fn(),
  hydrateObjectUrl: vi.fn(),
  releaseObjectUrl: vi.fn(),
  delete: vi.fn(),
};

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
  writeBrowserBatchCropResult: vi.fn(),
}));
vi.mock('@/features/assets/application/browserMediaOutput', () => ({
  outputBrowserMediaFiles: vi.fn(),
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
  let recordResult = vi.fn();

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    onExit = vi.fn();
    recordResult = vi.fn().mockResolvedValue(undefined);
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
    vi.mocked(outputBrowserMediaFiles).mockResolvedValue({
      disposition: 'download',
      permission: 'not-requested',
      files: [{
        id: 'image-1',
        fileName: 'look_1440x1920.jpg',
        byteCount: 3,
        sha256: 'hash',
      }],
      failures: [],
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<BatchImageCropWorkbench
        onExit={onExit}
        backHandlerRef={backHandlerRef}
        projectId="project-1"
        resultSink={{ record: recordResult }}
      />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('prepares selected browser files and outputs completed crop assets as one browser batch', async () => {
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
    await vi.waitFor(() => expect(outputBrowserMediaFiles).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'download',
      archiveFileName: 'lumina-batch-crop.zip',
      files: [{
        id: expect.any(String),
        assetId: 'asset-output',
        fileName: 'look_1440x1920.jpg',
      }],
    })));
    expect(recordResult).toHaveBeenCalledWith({
      assetId: 'asset-output',
      fileName: 'look_1440x1920.jpg',
      target: { id: '1440x1920', width: 1440, height: 1920 },
    });
    expect(container.textContent).toContain('浏览器下载');

    await act(async () => findButton(container, '保存到文件夹').click());
    await vi.waitFor(() => expect(outputBrowserMediaFiles).toHaveBeenLastCalledWith(expect.objectContaining({
      intent: 'directory',
      archiveFileName: 'lumina-batch-crop.zip',
      files: [{
        id: expect.any(String),
        assetId: 'asset-output',
        fileName: 'look_1440x1920.jpg',
      }],
    })));
  });

  it('shows the names of browser output files that could not be saved', async () => {
    vi.mocked(outputBrowserMediaFiles).mockResolvedValueOnce({
      disposition: 'unavailable',
      permission: 'not-requested',
      files: [],
      failures: [{
        id: 'image-1',
        fileName: 'look_1440x1920.jpg',
        reason: 'asset_unavailable',
      }],
    });
    await act(async () => findButton(container, '1440×1920').click());
    const input = container.querySelector('[data-testid="batch-crop-file-input"]') as HTMLInputElement;
    const file = new File(['source'], 'look.jpg', { type: 'image/jpeg', lastModified: 1 });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(browserBatchImageCropGateway.prepare).toHaveBeenCalled());

    await act(async () => findButton(container, '批量导出 1 张').click());
    await vi.waitFor(() => expect(outputBrowserMediaFiles).toHaveBeenCalled());
    expect(container.textContent).toContain('已保存 0/1 个文件，失败：look_1440x1920.jpg');
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
  });
});
