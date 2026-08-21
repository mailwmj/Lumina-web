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
import { createBatchImageCropSession } from '../application/batchImageCropSession';
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

const providerConfig = vi.hoisted(() => ({ protocol: 'openai-images' }));

const session = createBatchImageCropSession();

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
    providerConfig,
  }),
}));
vi.mock('@/features/canvas/models/availableModels', () => ({
  listConfiguredImageModels: () => [model],
  resolveConfiguredImageModel: () => model,
}));
vi.mock('../infrastructure/browserBatchImageCropGateway', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infrastructure/browserBatchImageCropGateway')>(),
  browserBatchImageCropGateway: { renderFixedCanvas: vi.fn() },
}));
vi.mock('../infrastructure/browserBatchImageCropAssets', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infrastructure/browserBatchImageCropAssets')>(),
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

function processingItem(id: string, jobId: string): BatchCropImageItem {
  return {
    ...item(),
    id,
    fileName: `${id}.jpg`,
    status: 'aiProcessing',
    fixedCanvas: {
      ...item().fixedCanvas,
      ai: {
        status: 'processing',
        prompt: 'fill background',
        modelId: model.id,
        resolution: '1K',
        jobId,
      },
    },
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
      session,
      items,
      selectedItem: items[0] ?? null,
      target: { id: '1440x1440', width: 1440, height: 1440 },
      setItems,
      onDialogClose: () => undefined,
      onToast: () => undefined,
    });
    return null;
  }

  function MultiJobHarness() {
    const [items, setItems] = useState([
      processingItem('image-1', 'job-1'),
      processingItem('image-2', 'job-2'),
    ]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    latestItems = items;
    latest = useBatchAiFill({
      batchId: 'batch-1',
      session,
      items,
      selectedItem: items[selectedIndex] ?? null,
      target: { id: '1440x1440', width: 1440, height: 1440 },
      setItems,
      onDialogClose: () => undefined,
      onToast: () => undefined,
    });
    return <button type="button" onClick={() => setSelectedIndex(1)}>next</button>;
  }

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    providerConfig.protocol = 'openai-images';
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

  it('keeps the successful fill available from batch-owned transient media after polling', async () => {
    await act(async () => latest.submit({ modelId: model.id, resolution: '1K', prompt: 'fill background' }));
    expect(latestItems[0]?.fixedCanvas.ai.status).toBe('processing');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });

    expect(writeBrowserBatchCropResult).not.toHaveBeenCalled();
    expect(latestItems[0]?.fixedCanvas.ai).toMatchObject({
      status: 'accepted',
      resultPath: 'blob:protected',
    });
    expect(latestItems[0]?.fixedCanvas.ai.resultAssetId).toBeUndefined();
  });

  it('does not offer a model that requires public reference URLs', async () => {
    providerConfig.protocol = 'fal';
    await act(async () => {
      useSettingsStore.setState({ customImageApis: [] });
    });

    expect(latest.models).toEqual([]);
    expect(latest.defaultModelId).toBe('');
  });

  it('requeries a failed browser AI fill without resubmitting the task', async () => {
    vi.mocked(canvasAiGateway.submitGenerateImageJob).mockResolvedValue('job-retry');
    vi.mocked(canvasAiGateway.getGenerateImageJob).mockResolvedValue({
      job_id: 'job-retry', status: 'failed', result: null, error: 'temporary provider failure',
    });
    vi.mocked(canvasAiGateway.retryGenerateImageJob).mockResolvedValue({
      job_id: 'job-retry', status: 'succeeded', result: 'data:image/jpeg;base64,AA==', error: null,
    });

    await act(async () => latest.submit({ modelId: model.id, resolution: '1K', prompt: 'fill background' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
    expect(latestItems[0]?.fixedCanvas.ai.status).toBe('failed');

    await act(async () => latest.requerySelected());

    expect(canvasAiGateway.retryGenerateImageJob).toHaveBeenCalledWith('job-retry', { protocol: 'openai-images' });
    expect(canvasAiGateway.submitGenerateImageJob).toHaveBeenCalledTimes(1);
    expect(latestItems[0]?.fixedCanvas.ai.status).toBe('accepted');
  });

  it('continues polling browser AI fills after the selected image changes', async () => {
    vi.mocked(browserBatchImageCropGateway.renderFixedCanvas)
      .mockResolvedValueOnce({ renderedPath: 'blob:protected-1', blankMaskPath: 'blob:mask-1' })
      .mockResolvedValueOnce({ renderedPath: 'blob:protected-2', blankMaskPath: 'blob:mask-2' });
    vi.mocked(writeBrowserBatchCropResult)
      .mockResolvedValueOnce({ assetId: 'asset-ai-fill-1', fileName: 'image-1_1440x1440.jpg' })
      .mockResolvedValueOnce({ assetId: 'asset-ai-fill-2', fileName: 'image-2_1440x1440.jpg' });
    repository.hydrateObjectUrl
      .mockResolvedValueOnce('blob:saved-ai-fill-1')
      .mockResolvedValueOnce('blob:saved-ai-fill-2');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => (
      new Response(new Blob(['jpg'], { type: 'image/jpeg' }))
    )));
    vi.mocked(canvasAiGateway.getGenerateImageJob).mockImplementation(async (jobId) => ({
      job_id: jobId,
      status: 'succeeded',
      result: `data:image/jpeg;base64,${jobId}`,
      error: null,
    }));
    await act(async () => root.render(<MultiJobHarness />));
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(1800);
    });

    expect(canvasAiGateway.getGenerateImageJob).toHaveBeenCalledTimes(2);
    expect(latestItems.map((candidate) => candidate.fixedCanvas.ai.status)).toEqual(['accepted', 'accepted']);
  });
});
