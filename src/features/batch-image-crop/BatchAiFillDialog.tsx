import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Sparkles } from '@/components/ui/icons';
import { UiButton, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import type { ImageModelDefinition } from '@/features/canvas/models/types';
import {
  resolveFixedCanvasImageBox,
  resolveStretchDestination,
  type BatchCropImageItem,
  type BatchCropTarget,
} from './domain';
import type { BatchAiFillSubmission } from './hooks/useBatchAiFill';
import { resolveBatchCropDisplayUrl } from './infrastructure/tauriBatchImageCropGateway';

interface BatchAiFillDialogProps {
  isOpen: boolean;
  item: BatchCropImageItem | null;
  target: BatchCropTarget;
  models: ImageModelDefinition[];
  defaultModelId: string;
  defaultResolution: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (submission: BatchAiFillSubmission) => void;
}

export function BatchAiFillDialog({
  isOpen,
  item,
  target,
  models,
  defaultModelId,
  defaultResolution,
  submitting,
  onClose,
  onSubmit,
}: BatchAiFillDialogProps) {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState('');
  const [resolution, setResolution] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (!isOpen || !item) return;
    const model = models.find((candidate) => candidate.id === defaultModelId) ?? models[0] ?? null;
    const modelResolutions = model?.resolutions.map((option) => option.value) ?? [];
    setModelId(model?.id ?? '');
    setResolution(
      (modelResolutions.includes(defaultResolution) ? defaultResolution : '')
      || model?.defaultResolution
      || model?.resolutions[0]?.value
      || ''
    );
    setPrompt(t('batchCrop.fixed.ai.defaultPrompt'));
  }, [defaultModelId, defaultResolution, isOpen, item?.id, models, t]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId) ?? null,
    [modelId, models]
  );
  const resolutions = selectedModel?.resolutions.length
    ? selectedModel.resolutions
    : selectedModel
      ? [{ value: selectedModel.defaultResolution, label: selectedModel.defaultResolution }]
      : [];
  const imageBox = item ? resolveFixedCanvasImageBox(
    item.width,
    item.height,
    target.width,
    target.height,
    item.fixedCanvas.transform
  ) : null;
  const previewSource = item ? resolveBatchCropDisplayUrl(item.previewPath) : '';
  const canSubmit = Boolean(item && selectedModel && resolution && prompt.trim()) && !submitting;

  return (
    <UiModal
      isOpen={isOpen}
      title={t('batchCrop.fixed.ai.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      closeOnBackdrop={false}
      widthClassName="w-[720px] max-w-[calc(100vw-24px)]"
      footer={(
        <>
          <UiButton type="button" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton
            type="button"
            variant="primary"
            disabled={!canSubmit}
            onClick={() => onSubmit({ modelId, resolution, prompt: prompt.trim() })}
            className="gap-1.5"
          >
            <Sparkles className="h-4 w-4" />
            {submitting ? t('batchCrop.fixed.ai.submitting') : t('batchCrop.fixed.ai.start')}
          </UiButton>
        </>
      )}
    >
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-5 max-sm:grid-cols-1">
        <div
          className="relative self-start overflow-hidden border border-[var(--ui-border-strong)] bg-white"
          style={{ aspectRatio: `${target.width} / ${target.height}` }}
        >
          {item && imageBox && (
            <img
              src={previewSource}
              alt={item.fileName}
              className="absolute max-h-none max-w-none object-fill"
              style={{
                left: `${imageBox.x}%`,
                top: `${imageBox.y}%`,
                width: `${imageBox.width}%`,
                height: `${imageBox.height}%`,
              }}
            />
          )}
          {item && imageBox && item.fixedCanvas.stretches.map((operation) => {
            const destination = resolveStretchDestination(operation);
            return (
              <div
                key={operation.id}
                className="absolute overflow-hidden"
                style={{
                  left: `${destination.x}%`,
                  top: `${destination.y}%`,
                  width: `${destination.width}%`,
                  height: `${destination.height}%`,
                }}
              >
                <img
                  src={previewSource}
                  alt=""
                  className="absolute max-h-none max-w-none object-fill"
                  style={{
                    left: `${-((operation.source.x - imageBox.x) / operation.source.width) * 100}%`,
                    top: `${-((operation.source.y - imageBox.y) / operation.source.height) * 100}%`,
                    width: `${(imageBox.width / operation.source.width) * 100}%`,
                    height: `${(imageBox.height / operation.source.height) * 100}%`,
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className="min-w-0 space-y-3.5">
          <div className="flex gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-500">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('batchCrop.fixed.ai.uploadNotice')}</span>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-muted">{t('batchCrop.fixed.ai.model')}</span>
            <UiSelect
              value={modelId}
              aria-label={t('batchCrop.fixed.ai.model')}
              disabled={models.length === 0 || submitting}
              onChange={(event) => {
                const nextId = event.target.value;
                const nextModel = models.find((model) => model.id === nextId);
                setModelId(nextId);
                setResolution(nextModel?.defaultResolution || nextModel?.resolutions[0]?.value || '');
              }}
            >
              {models.length === 0 ? (
                <option value="">{t('batchCrop.fixed.ai.noModel')}</option>
              ) : models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.providerName ? `${model.providerName} · ` : ''}{model.displayName}
                </option>
              ))}
            </UiSelect>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-muted">{t('batchCrop.fixed.ai.resolution')}</span>
            <UiSelect
              value={resolution}
              aria-label={t('batchCrop.fixed.ai.resolution')}
              disabled={!selectedModel || submitting}
              onChange={(event) => setResolution(event.target.value)}
            >
              {resolutions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </UiSelect>
          </label>

          <label className="relative block space-y-1.5">
            <span className="text-xs font-medium text-text-muted">{t('batchCrop.fixed.ai.prompt')}</span>
            <UiTextArea
              value={prompt}
              maxLength={1000}
              rows={4}
              disabled={submitting}
              aria-invalid={!prompt.trim()}
              onChange={(event) => setPrompt(event.target.value)}
              className="min-h-[92px] pb-6 text-xs leading-5"
            />
            <span className="pointer-events-none absolute bottom-2 right-2 font-mono text-[10px] text-text-muted">
              {prompt.length}/1000
            </span>
          </label>
          {!prompt.trim() && (
            <p className="text-[11px] text-red-500">{t('batchCrop.fixed.ai.promptRequired')}</p>
          )}
          <p className="text-[11px] leading-5 text-text-muted">{t('batchCrop.fixed.ai.feeNotice')}</p>
        </div>
      </div>
    </UiModal>
  );
}
