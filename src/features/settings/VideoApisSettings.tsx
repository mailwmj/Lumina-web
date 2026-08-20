import { useTranslation } from 'react-i18next';

import { UiCheckbox } from '@/components/ui';
import { ProviderListShell } from '@/features/settings/providers/ProviderListShell';
import {
  DEFAULT_VIDEO_SD10_POLISH_PROMPT,
  type VideoApiConfig,
} from '@/stores/settingsStore';

interface VideoApisSettingsProps {
  apis: VideoApiConfig[];
  onChange: (apis: VideoApiConfig[]) => void;
  onDetailChange?: (isOpen: boolean) => void;
}

function createCustomVideoApiConfig(): VideoApiConfig {
  return {
    id: `custom-video-${crypto.randomUUID()}`,
    name: '',
    apiKey: '',
    baseUrl: '',
    modelId: 'custom-video-model',
    enabled: false,
    protocol: 'volcengine-seedance',
    defaultPolishPrompt: DEFAULT_VIDEO_SD10_POLISH_PROMPT,
  };
}

export function VideoApisSettings({ apis, onChange, onDetailChange }: VideoApisSettingsProps) {
  const { t } = useTranslation();

  const updateApi = (id: string, next: VideoApiConfig) => {
    onChange(apis.map((api) => (api.id === id ? next : api)));
  };

  return (
    <ProviderListShell<VideoApiConfig>
      items={apis}
      getItemId={(api) => api.id}
      getItemTitle={(api) => api.name || t('settings.videoApiName')}
      getItemSubtitle={(api) => api.baseUrl || '—'}
      getItemMeta={(api) => api.modelId || undefined}
      onAdd={() => {
        const config = createCustomVideoApiConfig();
        onChange([...apis, config]);
        return config.id;
      }}
      onRemove={(id) => onChange(apis.filter((api) => api.id !== id))}
      onDetailChange={onDetailChange}
      renderDetail={(api) => (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-dark">
              {t('settings.videoApiName')}
            </span>
            <input
              type="text"
              value={api.name}
              onChange={(event) => updateApi(api.id, { ...api, name: event.target.value })}
              className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-dark">
              {t('settings.videoApiKey')}
            </span>
            <input
              type="password"
              value={api.apiKey}
              onChange={(event) => updateApi(api.id, { ...api, apiKey: event.target.value })}
              placeholder={t('settings.enterApiKey')}
              className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-dark">
              {t('settings.videoApiBaseUrl')}
            </span>
            <input
              type="text"
              value={api.baseUrl}
              onChange={(event) => updateApi(api.id, { ...api, baseUrl: event.target.value })}
              placeholder="https://ai.yunxinapi.com/hub/volcengine"
              className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-dark">
              {t('settings.videoApiModel')}
            </span>
            <input
              type="text"
              value={api.modelId}
              onChange={(event) => updateApi(api.id, { ...api, modelId: event.target.value })}
              className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 text-sm text-text-dark"
            />
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
            <UiCheckbox
              aria-label={t('settings.videoApiEnabled')}
              checked={api.enabled}
              onCheckedChange={(enabled) => updateApi(api.id, { ...api, enabled })}
            />
            {t('settings.videoApiEnabled')}
          </label>
        </div>
      )}
      addLabel={t('settings.addVideoApi')}
      removeLabel={t('settings.removeVideoApi')}
      emptyLabel={t('settings.noVideoApisConfigured')}
    />
  );
}
