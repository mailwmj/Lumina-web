// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import type { ImageModelDefinition } from '@/features/canvas/models/types';
import { BatchAiFillDialog } from './BatchAiFillDialog';
import { createDefaultFixedCanvasDraft, type BatchCropImageItem } from './domain';

const defaultPrompt = '延续背景，只补全空白区域。';
const item: BatchCropImageItem = {
  id: 'image-1',
  sourcePath: '/fixtures/source.jpg',
  fileName: 'source.jpg',
  fileSize: 1024,
  previewPath: '/fixtures/preview.jpg',
  thumbnailPath: '/fixtures/thumbnail.jpg',
  width: 100,
  height: 200,
  rotationDegrees: 0,
  compositionMode: 'fixed',
  status: 'fixedFill',
  cropStatus: 'auto',
  crop: { x: 0, y: 0, width: 1, height: 1 },
  automaticCrop: { x: 0, y: 0, width: 1, height: 1 },
  requiresReview: false,
  lowResolution: false,
  fixedCanvas: {
    ...createDefaultFixedCanvasDraft(defaultPrompt),
    stage: 'fill',
  },
};

const model: ImageModelDefinition = {
  id: 'provider/edit-model',
  mediaType: 'image',
  displayName: 'Edit Model',
  providerId: 'provider',
  providerName: 'Provider',
  description: '',
  eta: '1min',
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  aspectRatios: [{ value: '1:1', label: '1:1' }],
  resolutions: [{ value: '1K', label: '1K' }, { value: '2K', label: '2K' }],
  resolveRequest: () => ({ requestModel: 'provider/edit-model', modeLabel: 'edit' }),
};

describe('BatchAiFillDialog', () => {
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

  it('uses the standard custom selects and preloads an editable prompt', async () => {
    const onSubmit = vi.fn();
    await act(async () => root.render(
      <BatchAiFillDialog
        isOpen
        item={item}
        target={{ id: '1440x1440', width: 1440, height: 1440 }}
        models={[model]}
        defaultModelId={model.id}
        defaultResolution="1K"
        submitting={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />
    ));

    const modelTrigger = document.querySelector('button[aria-label="AI 模型"]');
    expect(modelTrigger?.getAttribute('aria-haspopup')).toBe('listbox');
    expect(container.textContent).not.toContain('1440×1440');
    const prompt = document.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(prompt?.value).toBe(i18n.t('batchCrop.fixed.ai.defaultPrompt'));

    await act(async () => {
      if (!prompt) return;
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setValue?.call(prompt, '继续补全街道背景');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('开始补全'));
    await act(async () => submit?.click());

    expect(onSubmit).toHaveBeenCalledWith({
      modelId: model.id,
      resolution: '1K',
      prompt: '继续补全街道背景',
    });
  });

  it('does not close when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    await act(async () => root.render(
      <BatchAiFillDialog
        isOpen
        item={item}
        target={{ id: '1440x1440', width: 1440, height: 1440 }}
        models={[model]}
        defaultModelId={model.id}
        defaultResolution="2K"
        submitting={false}
        onClose={onClose}
        onSubmit={() => undefined}
      />
    ));

    const backdrop = document.querySelector('[data-testid="ui-modal-backdrop"]');
    expect(backdrop).toBeInstanceOf(HTMLDivElement);
    await act(async () => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('resets the prompt to the localized default every time it opens', async () => {
    const renderDialog = async (isOpen: boolean) => act(async () => root.render(
      <BatchAiFillDialog
        isOpen={isOpen}
        item={{
          ...item,
          fixedCanvas: {
            ...item.fixedCanvas,
            ai: { ...item.fixedCanvas.ai, prompt: 'previous submitted prompt' },
          },
        }}
        target={{ id: '1440x1440', width: 1440, height: 1440 }}
        models={[model]}
        defaultModelId={model.id}
        defaultResolution="2K"
        submitting={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />
    ));

    await renderDialog(true);
    const prompt = document.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(prompt, 'temporary edit');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await renderDialog(false);
    await renderDialog(true);

    expect((document.querySelector('textarea') as HTMLTextAreaElement).value)
      .toBe(i18n.t('batchCrop.fixed.ai.defaultPrompt'));
  });

  it('keeps cancel available while a submission is in flight', async () => {
    const onClose = vi.fn();
    await act(async () => root.render(
      <BatchAiFillDialog
        isOpen
        item={item}
        target={{ id: '1440x1440', width: 1440, height: 1440 }}
        models={[model]}
        defaultModelId={model.id}
        defaultResolution="2K"
        submitting
        onClose={onClose}
        onSubmit={() => undefined}
      />
    ));

    const cancel = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '取消') as HTMLButtonElement | undefined;
    expect(cancel?.disabled).toBe(false);
    await act(async () => cancel?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
