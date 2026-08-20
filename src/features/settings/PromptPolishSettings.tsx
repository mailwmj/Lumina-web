import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { UiSelect } from '@/components/ui';
import { listConfiguredTextModels } from '@/features/canvas/application/textModelSelection';
import {
  TEXT_REASONING_EFFORTS,
  type TextReasoningEffort,
} from '@/features/canvas/models/types';
import {
  DEFAULT_IMAGE_POLISH_PROMPT,
  DEFAULT_TEXT_POLISH_PROMPT,
  DEFAULT_VIDEO_SD10_POLISH_PROMPT,
  DEFAULT_VIDEO_SD15_PROMPT,
  type PromptPolishConfig,
  type TextApiConfig,
  type VideoApiConfig,
} from '@/stores/settingsStore';

interface PromptPolishSettingsProps {
  textApis: TextApiConfig[];
  imagePolishConfig: PromptPolishConfig;
  textPolishConfig: PromptPolishConfig;
  videoApis: VideoApiConfig[];
  onImagePolishConfigChange: (config: PromptPolishConfig) => void;
  onTextPolishConfigChange: (config: PromptPolishConfig) => void;
  onVideoApisChange: (apis: VideoApiConfig[]) => void;
}

interface PolishProfileSectionProps {
  title: string;
  description: string;
  templateTitle: string;
  templateDescription: string;
  defaultPrompt: string;
  textApis: TextApiConfig[];
  config: PromptPolishConfig;
  onChange: (config: PromptPolishConfig) => void;
}

function textModelValue(apiId: string, modelId: string): string {
  return JSON.stringify([apiId, modelId]);
}

function defaultVideoPolishPrompt(api: VideoApiConfig): string {
  if (api.defaultPolishPrompt) {
    return api.defaultPolishPrompt;
  }
  return api.modelId.includes('1-5-pro')
    ? DEFAULT_VIDEO_SD15_PROMPT
    : DEFAULT_VIDEO_SD10_POLISH_PROMPT;
}

function PolishProfileSection({
  title,
  description,
  templateTitle,
  templateDescription,
  defaultPrompt,
  textApis,
  config,
  onChange,
}: PolishProfileSectionProps) {
  const { t } = useTranslation();
  const textModels = useMemo(() => listConfiguredTextModels(textApis), [textApis]);
  const hasExplicitSelection = Boolean(config.textApiId || config.textModelId);
  const selectedValue = config.textApiId && config.textModelId
    ? textModelValue(config.textApiId, config.textModelId)
    : '';
  const hasUnavailableSelection = hasExplicitSelection && !textModels.some((model) =>
    model.apiId === config.textApiId && model.modelId === config.textModelId
  );
  const unavailableLabel = t('node.textModel.unavailable', {
    apiId: config.textApiId || '—',
    modelId: config.textModelId || '—',
  });

  return (
    <section className="border-b border-[var(--ui-border-soft)] py-4">
      <h3 className="text-sm font-medium text-text-dark">{title}</h3>
      <p className="mt-1 text-xs text-text-muted">{description}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-dark">
            {t('settings.promptPolishModel')}
          </span>
          <UiSelect
            value={selectedValue}
            onChange={(event) => {
              const selected = textModels.find((model) =>
                textModelValue(model.apiId, model.modelId) === event.target.value
              );
              if (!selected) return;
              onChange({
                ...config,
                textApiId: selected.apiId,
                textModelId: selected.modelId,
              });
            }}
            disabled={textModels.length === 0}
            className="h-9 w-full text-sm disabled:opacity-50"
          >
            {(!hasExplicitSelection || hasUnavailableSelection) && (
              <option value={selectedValue} disabled>
                {hasUnavailableSelection
                  ? unavailableLabel
                  : t('settings.promptPolishModelEmpty')}
              </option>
            )}
            {textModels.map((model) => (
              <option
                key={textModelValue(model.apiId, model.modelId)}
                value={textModelValue(model.apiId, model.modelId)}
              >
                {model.apiName} / {model.modelId}
              </option>
            ))}
          </UiSelect>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-dark">
            {t('settings.textApiReasoningEffort')}
          </span>
          <UiSelect
            value={config.reasoningEffort ?? ''}
            onChange={(event) => onChange({
              ...config,
              reasoningEffort: event.target.value
                ? event.target.value as TextReasoningEffort
                : null,
            })}
            className="h-9 w-full text-sm"
          >
            <option value="">{t('node.textModel.reasoningDefault')}</option>
            {TEXT_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {t(`node.textModel.reasoning.${effort}`)}
              </option>
            ))}
          </UiSelect>
        </label>
      </div>

      <div className="mb-2 mt-4 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-medium text-text-dark">{templateTitle}</h4>
          <p className="mt-1 text-xs text-text-muted">{templateDescription}</p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...config, prompt: defaultPrompt })}
          className="shrink-0 text-xs text-accent hover:underline"
        >
          {t('common.restoreDefault')}
        </button>
      </div>
      <textarea
        value={config.prompt}
        onChange={(event) => onChange({ ...config, prompt: event.target.value })}
        rows={7}
        className="w-full resize-y rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark"
      />
    </section>
  );
}

export function PromptPolishSettings({
  textApis,
  imagePolishConfig,
  textPolishConfig,
  videoApis,
  onImagePolishConfigChange,
  onTextPolishConfigChange,
  onVideoApisChange,
}: PromptPolishSettingsProps) {
  const { t } = useTranslation();
  const [selectedVideoApiId, setSelectedVideoApiId] = useState(videoApis[0]?.id ?? '');

  useEffect(() => {
    if (!videoApis.some((api) => api.id === selectedVideoApiId)) {
      setSelectedVideoApiId(videoApis[0]?.id ?? '');
    }
  }, [selectedVideoApiId, videoApis]);

  const selectedVideoApi = videoApis.find((api) => api.id === selectedVideoApiId) ?? null;
  const updateVideoApi = (next: VideoApiConfig) => {
    onVideoApisChange(videoApis.map((api) => api.id === next.id ? next : api));
  };

  return (
    <>
      <PolishProfileSection
        title={t('settings.imagePolish')}
        description={t('settings.imagePolishDesc')}
        templateTitle={t('settings.imagePolishPromptTemplate')}
        templateDescription={t('settings.imagePolishPromptPlaceholder')}
        defaultPrompt={DEFAULT_IMAGE_POLISH_PROMPT}
        textApis={textApis}
        config={imagePolishConfig}
        onChange={onImagePolishConfigChange}
      />

      <PolishProfileSection
        title={t('settings.textPolish')}
        description={t('settings.textPolishDesc')}
        templateTitle={t('settings.textPolishPromptTemplate')}
        templateDescription={t('settings.textPolishPromptPlaceholder')}
        defaultPrompt={DEFAULT_TEXT_POLISH_PROMPT}
        textApis={textApis}
        config={textPolishConfig}
        onChange={onTextPolishConfigChange}
      />

      <section className="py-4">
        <div className="mb-3 flex items-end justify-between gap-3">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-sm font-medium text-text-dark">
              {t('settings.videoPolishPromptTemplate')}
            </span>
            <UiSelect
              value={selectedVideoApiId}
              onChange={(event) => setSelectedVideoApiId(event.target.value)}
              disabled={videoApis.length === 0}
              className="h-9 w-full text-sm disabled:opacity-50"
            >
              {videoApis.length === 0 && <option value="">-</option>}
              {videoApis.map((api) => (
                <option key={api.id} value={api.id}>{api.name} / {api.modelId}</option>
              ))}
            </UiSelect>
          </label>
          <button
            type="button"
            disabled={!selectedVideoApi}
            onClick={() => selectedVideoApi && updateVideoApi({
              ...selectedVideoApi,
              polishPrompt: defaultVideoPolishPrompt(selectedVideoApi),
            })}
            className="mb-2 shrink-0 text-xs text-accent hover:underline disabled:opacity-50"
          >
            {t('common.restoreDefault')}
          </button>
        </div>
        {selectedVideoApi ? (
          <textarea
            value={selectedVideoApi.polishPrompt ?? ''}
            onChange={(event) => updateVideoApi({
              ...selectedVideoApi,
              polishPrompt: event.target.value,
            })}
            rows={8}
            placeholder={t('settings.videoPolishPromptPlaceholder')}
            className="w-full resize-y rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark placeholder:text-text-muted"
          />
        ) : (
          <p className="text-xs text-text-muted">{t('settings.noVideoApisConfigured')}</p>
        )}
      </section>
    </>
  );
}
