import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

import { UiButton, UiCheckbox, UiInput, UiSelect } from '@/components/ui';
import { getLogConfig, resetLogConfig, setLogConfig, useLogStore } from '@/lib/logger';

export function LoggingSettings(): JSX.Element {
  const { t } = useTranslation();
  const [config, setLocal] = useState(getLogConfig());
  const [moduleText, setModuleText] = useState(
    Object.entries(config.moduleLevels).map(([key, value]) => `${key}=${value}`).join(',')
  );

  const commitModuleText = (text: string) => {
    setModuleText(text);
    const moduleLevels: Record<string, 'debug' | 'info' | 'warn' | 'error'> = {};
    for (const part of text.split(',').map((value) => value.trim()).filter(Boolean)) {
      const [key, value] = part.split('=');
      if (key && (value === 'debug' || value === 'info' || value === 'warn' || value === 'error')) {
        moduleLevels[key] = value;
      }
    }
    setLogConfig({ moduleLevels });
    setLocal(getLogConfig());
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-text-dark">
          {t('logger.settings.globalLevel')}
        </label>
        <UiSelect
          className="h-9 w-40 font-mono text-sm"
          value={config.level}
          onChange={(event) => {
            setLogConfig({ level: event.target.value as 'debug' | 'info' | 'warn' | 'error' });
            setLocal(getLogConfig());
          }}
        >
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </UiSelect>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-text-dark">
          {t('logger.settings.moduleOverride')}
        </label>
        <UiInput
          type="text"
          className="h-9 max-w-xl font-mono text-sm"
          value={moduleText}
          onChange={(event) => commitModuleText(event.target.value)}
          placeholder={t('logger.settings.moduleOverridePlaceholder')}
        />
        <p className="mt-1.5 text-xs text-text-muted">
          {t('logger.settings.moduleOverrideHint')}
        </p>
      </div>

      <div className="flex flex-wrap gap-4 border-y border-[var(--ui-border-soft)] py-4">
        {([
          ['console', 'logger.settings.consoleOutput'],
          ['persist', 'logger.settings.persist'],
          ['consoleTimestamps', 'logger.settings.consoleTimestamps'],
        ] as const).map(([key, labelKey]) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
            <UiCheckbox
              aria-label={t(labelKey)}
              checked={config[key]}
              onCheckedChange={(checked) => {
                setLogConfig({ [key]: checked });
                setLocal(getLogConfig());
              }}
            />
            <span>{t(labelKey)}</span>
          </label>
        ))}
      </div>

      <div className="flex gap-2">
        <UiButton
          size="sm"
          onClick={async () => {
            try {
              await invoke('open_log_dir');
            } catch {
              alert(t('logger.settings.openFolderError'));
            }
          }}
        >
          {t('logger.settings.openFolder')}
        </UiButton>
        <UiButton
          size="sm"
          onClick={() => {
            const entries = useLogStore.getState().snapshot().slice(-100);
            navigator.clipboard.writeText(
              entries.map((entry) => `[${entry.level}] ${entry.target}: ${entry.message}`).join('\n')
            );
          }}
        >
          {t('logger.settings.copyAll')}
        </UiButton>
        <UiButton
          size="sm"
          onClick={() => {
            resetLogConfig();
            setLocal(getLogConfig());
            setModuleText('');
          }}
        >
          {t('logger.settings.reset')}
        </UiButton>
      </div>
    </div>
  );
}
