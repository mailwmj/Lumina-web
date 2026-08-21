// @vitest-environment happy-dom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { useSettingsStore } from '@/stores/settingsStore';
import { createDefaultFixedCanvasDraft, type BatchCropImageItem } from '../domain';
import { writeBrowserBatchCropResult } from '../infrastructure/browserBatchImageCropAssets';
import { browserBatchImageCropGateway } from '../infrastructure/browserBatchImageCropGateway';
import { useBatchAiFill } from './useBatchAiFill';

const model = vi.hoisted(() => ({
  id: 'provider/edit-model',
  mediaType: 'image' as const,
  displayName: 'Edit Model',
  providerId: 'provider',
  providerName: 'Provider',
  description: '',
  eta: '1min',
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  aspectRatios: [{ value: '1:1', label: '1:1' }],
  resolutions: [{ value: '1K', label: '1K' }],
  resolveRequest: ({ referenceImageCount }: { referenceImageCount: number }) => ({
    requestModel: 'provider/edit-model',
    modeLabel: referenceImageCount > 0 ? 'edit' : 'generate',
  }),
}));

const repository = vi.hoisted(() => ({
  hydrateObjectUrl: vi.fn(),
  releaseObjectUrl: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('@/runtime/mediaRuntime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/runtime/mediaRuntime')>(),
  getRuntimeAssetRepository: () => repository,
}));
vi.mock('@/features/canvas/application/canvasServices', () => ({
  canvasAiGateway: {
    setApiKey: vi.fn(),
    submitGenerateImageJob: vi.fn(),
    getGenerateImageJob: vi.fn(),
    retryGenerateImageJob: vi.fn(),
  },
}));
vi.mock('@/features/canvas/application/imageProviderRuntime', () => ({
  resolveImageProviderRuntime: () => ({
    backendProviderId: 'provider',
    apiKey: 'key',
    providerConfig: { provider_id: 'provider' },
  }),
}));
vi.mock('@/features/canvas/models/availableModels', () => ({
  listConfiguredImageModels: () => [model],
  resolveConfiguredImageModel: () => model,
}));
vi.mock('../infrastructure/browserBatchImageCropGateway', () => ({
  browserBatchImageCropGateway: { renderFixedCanvas: vi.fn() },
}));
vi.mock('../infrastructure/browserBatchImageCropAssets', () => ({
  writeBrowserBatchCropResult: vi.fn(),
}));

function item(): BatchCropImageItem {
  return {
    id: 'image-1',
    sourcePath: 'blob:source',
    fileName: 'look.jpg',
    fileSize: 1,
    previewPath: 'blob:preview',
    thumbnailPath: 'blob:thumbnail',
    width: 100,
    height: 200,
    rotationDegrees: 0,
    compositionMode: 'fixed',
    status: 'fixedReady',
    cropStatus: 'auto',
    crop: { x: 0, y: 0, width: 1, height: 1 },
    automaticCrop: { x: 0, y: 0, width: 1, height: 1 },
    requiresReview: false,
    lowResolution: false,
    fixedCanvas: { ...createDefaultFixedCanvasDraft('prompt'), stage: 'fill', ready: true },
  };
}

describe('useBatchAiFill browser result persistence', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useBatchAiFill>;
  let latestItems: BatchCropImageItem[];

  function Harness() {
    const [items, setItems] = useState([item()]);
    latestItems = items;
    latest = useBatchAiFill({
      batchId: 'batch-1',
      items,
      selectedItem: items[0] ?? null,
      target: { id: '1440x1440', width: 1440, height: 1440 },
      setItems,
      onDialogClose: () => undefined,
      onToast: () => undefined,
    });
    return null;
  }

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    useSettingsStore.setState({ lastBatchAiFillSelection: null });
    repository.hydrateObjectUrl.mockResolvedValue('blob:saved-ai-fill');
    vi.mocked(browserBatchImageCropGateway.renderFixedCanvas)
      .mockResolvedValueOnce({ renderedPath: 'blob:fixed', blankMaskPath: 'blob:mask' })
      .mockResolvedValueOnce({ renderedPath: 'blob:protected', blankMaskPath: 'blob:protected-mask' });
    vi.mocked(writeBrowserBatchCropResult).mockResolvedValue({
      assetId: 'asset-ai-fill',
      fileName: 'look_1440x1440.jpg',
    });
    vi.mocked(canvasAiGateway.setApiKey).mockResolvedValue(undefined);
    vi.mocked(canvasAiGateway.submitGenerateImageJob).mockResolvedValue('job-1');
    vi.mocked(canvasAiGateway.getGenerateImageJob).mockResolvedValue({
      job_id: 'job-1', status: 'succeeded', result: 'data:image/jpeg;base64,AA==', error: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['jpg'], { type: 'image/jpeg' }))));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the successful fill available from a persisted browser asset after polling', async () => {
    await act(async () => latest.submit({ modelId: model.id, resolution: '1K', prompt: 'fill background' }));
    expect(latestItems[0]?.fixedCanvas.ai.status).toBe('processing');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });

    expect(writeBrowserBatchCropResult).toHaveBeenCalledWith(expect.objectContaining({
      batchId: 'batch-1',
      sourceFileName: 'look.jpg',
    }), repository);
    expect(latestItems[0]?.fixedCanvas.ai).toMatchObject({
      status: 'accepted',
      resultAssetId: 'asset-ai-fill',
      resultPath: 'blob:saved-ai-fill',
    });
  });
});
