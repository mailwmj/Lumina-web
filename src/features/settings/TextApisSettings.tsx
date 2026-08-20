import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { discoverTextModels } from '@/commands/ai';
import { UiCheckbox, UiTooltip } from '@/components/ui';
import { Eye, EyeOff, Loader2, Plus } from '@/components/ui/icons';
import { testTextApi } from '@/features/canvas/infrastructure/textPolishService';
import { ProviderListShell } from '@/features/settings/providers/ProviderListShell';
import {
  createTextApiConfig,
  type DiscoveredImageModel,
  type ImageModelCatalog,
  type TextApiConfig,
} from '@/stores/settingsStore';

interface TextApisSettingsProps {
  apis: TextApiConfig[];
  onChange: (apis: TextApiConfig[]) => void;
  onDetailChange?: (isOpen: boolean) => void;
}

interface AsyncState {
  isLoading: boolean;
  error: string | null;
}

const IDLE_STATE: AsyncState = { isLoading: false, error: null };

export function TextApisSettings({ apis, onChange, onDetailChange }: TextApisSettingsProps) {
  const { t } = useTranslation();
  const [discoveryByApi, setDiscoveryByApi] = useState<Record<string, AsyncState>>({});
  const [testingApiId, setTestingApiId] = useState<string | null>(null);
  const [revealedApiIds, setRevealedApiIds] = useState<Set<string>>(() => new Set());
  const [manualModelIds, setManualModelIds] = useState<Record<string, string>>({});

  const updateApi = useCallback((apiId: string, next: TextApiConfig) => {
    onChange(apis.map((api) => (api.id === apiId ? next : api)));
  }, [apis, onChange]);

  const toggleApiKey = (apiId: string) => {
    setRevealedApiIds((current) => {
      const next = new Set(current);
      if (next.has(apiId)) next.delete(apiId);
      else next.add(apiId);
      return next;
    });
  };

  const handleDiscover = useCallback(async (api: TextApiConfig) => {
    setDiscoveryByApi((current) => ({
      ...current,
      [api.id]: { isLoading: true, error: null },
    }));
    try {
      const discovered = await discoverTextModels({
        base_url: api.baseUrl,
        api_key: api.apiKey,
      });
      const discoveredIds = new Set(discovered.map((model) => model.id));
      const preservedSelectedModels = api.selectedModelIds
        .filter((modelId) => !discoveredIds.has(modelId))
        .map((modelId) => ({ id: modelId }));
      const modelCatalog: ImageModelCatalog = {
        models: [...discovered, ...preservedSelectedModels],
        refreshedAt: Date.now(),
      };
      updateApi(api.id, { ...api, modelCatalog });
      setDiscoveryByApi((current) => ({
        ...current,
        [api.id]: IDLE_STATE,
      }));
    } catch (error) {
      setDiscoveryByApi((current) => ({
        ...current,
        [api.id]: {
          isLoading: false,
          error: error instanceof Error ? error.message : t('settings.textModelsFetchFailed'),
        },
      }));
    }
  }, [t, updateApi]);

  const addManualModel = (api: TextApiConfig) => {
    const modelId = manualModelIds[api.id]?.trim();
    if (!modelId) return;

    const models = api.modelCatalog?.models ?? [];
    updateApi(api.id, {
      ...api,
      modelId: api.modelId || modelId,
      modelCatalog: {
        models: models.some((model) => model.id === modelId)
          ? models
          : [...models, { id: modelId }],
        refreshedAt: Date.now(),
      },
      selectedModelIds: Array.from(new Set([...api.selectedModelIds, modelId])),
    });
    setManualModelIds((current) => ({ ...current, [api.id]: '' }));
  };

  const changeModelSelection = (api: TextApiConfig, modelId: string, selected: boolean) => {
    const selectedModelIds = selected
      ? Array.from(new Set([...api.selectedModelIds, modelId]))
      : api.selectedModelIds.filter((candidate) => candidate !== modelId);
    const defaultModelId = api.modelId === modelId && !selected
      ? selectedModelIds[0] ?? ''
      : api.modelId || selectedModelIds[0] || '';
    updateApi(api.id, { ...api, modelId: defaultModelId, selectedModelIds });
  };

  const renderDetail = (api: TextApiConfig) => {
    const discoveryState = discoveryByApi[api.id] ?? IDLE_STATE;
    const catalogModels = api.modelCatalog?.models ?? [];
    const visibleModels: DiscoveredImageModel[] = [
      ...catalogModels,
      ...api.selectedModelIds
        .filter((modelId) => !catalogModels.some((model) => model.id === modelId))
        .map((modelId) => ({ id: modelId })),
    ];
    const selectedModelIdSet = new Set(api.selectedModelIds);
    const testModelId = selectedModelIdSet.has(api.modelId)
      ? api.modelId
      : api.selectedModelIds[0] ?? '';
    const isRevealed = revealedApiIds.has(api.id);

    return (
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-dark">
            {t('settings.textApiName')}
          </span>
          <input
            value={api.name}
            onChange={(event) => updateApi(api.id, { ...api, name: event.target.value })}
            placeholder={t('settings.textApiNamePlaceholder')}
            className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark placeholder:text-text-muted"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-dark">
            {t('settings.textApiBaseUrl')}
          </span>
          <input
            type="url"
            value={api.baseUrl}
            onChange={(event) => updateApi(api.id, {
              ...api,
              baseUrl: event.target.value,
              modelCatalog: null,
            })}
            placeholder="https://api.example.com/v1"
            className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark placeholder:text-text-muted"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-dark">
            {t('settings.textApiKey')}
          </span>
          <div className="relative">
            <input
              type={isRevealed ? 'text' : 'password'}
              value={api.apiKey}
              onChange={(event) => updateApi(api.id, { ...api, apiKey: event.target.value })}
              placeholder={t('settings.enterApiKey')}
              className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 pr-10 text-sm text-text-dark placeholder:text-text-muted"
            />
            <UiTooltip content={isRevealed ? t('settings.hideApiKey') : t('settings.showApiKey')}>
              <button
                type="button"
                aria-label={isRevealed ? t('settings.hideApiKey') : t('settings.showApiKey')}
                onClick={() => toggleApiKey(api.id)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-[var(--ui-hover)]"
              >
                {isRevealed
                  ? <EyeOff className="h-4 w-4 text-text-muted" />
                  : <Eye className="h-4 w-4 text-text-muted" />}
              </button>
            </UiTooltip>
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-dark">
            {t('settings.textApiManualModel')}
          </span>
          <div className="flex gap-2">
            <input
              value={manualModelIds[api.id] ?? ''}
              onChange={(event) => setManualModelIds((current) => ({
                ...current,
                [api.id]: event.target.value,
              }))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addManualModel(api);
                }
              }}
              placeholder="gpt-5.6-terra"
              className="min-w-0 flex-1 rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark placeholder:text-text-muted"
            />
            <UiTooltip content={t('settings.textApiAddModel')}>
              <button
                type="button"
                aria-label={t('settings.textApiAddModel')}
                onClick={() => addManualModel(api)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-dark bg-surface-dark text-text-dark transition-colors hover:bg-[var(--ui-hover)]"
              >
                <Plus className="h-4 w-4" />
              </button>
            </UiTooltip>
          </div>
        </label>

        <div className="border-t border-[var(--ui-border-soft)] pt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-text-dark">
              {t('settings.textModelsSelect')}
            </span>
            <button
              type="button"
              onClick={() => void handleDiscover(api)}
              disabled={discoveryState.isLoading || !api.apiKey || !api.baseUrl}
              className="inline-flex h-7 shrink-0 items-center rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark transition-colors hover:bg-surface-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {discoveryState.isLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {discoveryState.isLoading
                ? t('settings.textModelsFetching')
                : t('settings.textModelsFetch')}
            </button>
          </div>
          {discoveryState.error && (
            <p className="mt-2 text-xs text-red-400">{discoveryState.error}</p>
          )}
          {visibleModels.length === 0 && !discoveryState.error && (
            <p className="mt-2 text-xs text-text-muted">{t('settings.textModelsEmpty')}</p>
          )}
          {visibleModels.length > 0 && (
            <div className="ui-scrollbar mt-2 max-h-40 space-y-1 overflow-y-auto">
              {visibleModels.map((model) => (
                <label
                  key={model.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-xs text-text-dark hover:bg-bg-dark"
                >
                  <UiCheckbox
                    aria-label={model.label || model.id}
                    checked={selectedModelIdSet.has(model.id)}
                    onCheckedChange={(selected) => changeModelSelection(api, model.id, selected)}
                  />
                  <span className="min-w-0 break-words">{model.label || model.id}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={async () => {
            setTestingApiId(api.id);
            try {
              const result = await testTextApi({ ...api, modelId: testModelId });
              window.alert(t('settings.textApiTestSucceeded', { message: result.message }));
            } catch (error) {
              window.alert(t('settings.textApiTestFailed', {
                message: error instanceof Error ? error.message : t('common.error'),
              }));
            } finally {
              setTestingApiId(null);
            }
          }}
          disabled={testingApiId === api.id || !api.apiKey || !api.baseUrl || !testModelId}
          className="inline-flex h-8 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark disabled:opacity-50"
        >
          {testingApiId === api.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {testingApiId === api.id
            ? t('settings.textApiTesting')
            : t('settings.textApiTest')}
        </button>
      </div>
    );
  };

  return (
    <ProviderListShell<TextApiConfig>
      items={apis}
      getItemId={(api) => api.id}
      getItemTitle={(api) => api.name || t('settings.textApiUntitled')}
      getItemSubtitle={(api) => api.baseUrl || '—'}
      getItemMeta={(api) =>
        api.selectedModelIds.length > 0
          ? t('settings.providerModelsCount', { count: api.selectedModelIds.length })
          : undefined
      }
      onAdd={() => {
        const config = createTextApiConfig();
        onChange([...apis, config]);
        return config.id;
      }}
      onRemove={(id) => onChange(apis.filter((api) => api.id !== id))}
      onDetailChange={onDetailChange}
      renderDetail={renderDetail}
      addLabel={t('settings.addTextApi')}
      removeLabel={t('settings.removeTextApi')}
      emptyLabel={t('settings.noTextApisConfigured')}
    />
  );
}
