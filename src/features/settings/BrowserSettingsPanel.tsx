import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Download, FileText } from '@/components/ui/icons';
import { UiButton } from '@/components/ui';
import type { BrowserSettingsDiagnosticsService } from '@/features/settings/application/browserSettingsDiagnosticsService';
import { selectSettingsData } from '@/features/settings/domain/settingsSchema';
import { useSettingsStore } from '@/stores/settingsStore';

export function BrowserSettingsPanel({
  diagnosticsService,
}: {
  diagnosticsService: BrowserSettingsDiagnosticsService | null;
}) {
  const { t } = useTranslation();
  const [isPreparingDiagnostics, setIsPreparingDiagnostics] = useState(false);

  const exportSettings = () => {
    diagnosticsService?.downloadSettings(selectSettingsData(useSettingsStore.getState()));
  };

  const exportDiagnostics = async () => {
    if (!diagnosticsService || isPreparingDiagnostics) {
      return;
    }
    setIsPreparingDiagnostics(true);
    try {
      await diagnosticsService.downloadDiagnostics();
    } finally {
      setIsPreparingDiagnostics(false);
    }
  };

  return (
    <>
      <section className="border-t border-[var(--ui-border-soft)] pt-5">
        <h3 className="text-sm font-medium text-text-dark">{t('settings.browserDownloads')}</h3>
        <p className="mt-1 text-xs leading-5 text-text-muted">{t('settings.browserDownloadsDesc')}</p>
      </section>

      <section className="border-t border-[var(--ui-border-soft)] pt-5">
        <h3 className="text-sm font-medium text-text-dark">{t('settings.webData')}</h3>
        <p className="mt-1 text-xs leading-5 text-text-muted">{t('settings.webDataDesc')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <UiButton
            size="sm"
            variant="muted"
            className="gap-1.5"
            disabled={!diagnosticsService}
            onClick={exportSettings}
          >
            <Download className="h-3.5 w-3.5" />
            {t('settings.exportSettings')}
          </UiButton>
          <UiButton
            size="sm"
            variant="muted"
            className="gap-1.5"
            disabled={!diagnosticsService || isPreparingDiagnostics}
            onClick={() => void exportDiagnostics()}
          >
            <FileText className="h-3.5 w-3.5" />
            {isPreparingDiagnostics ? t('settings.preparingDownload') : t('settings.downloadDiagnostics')}
          </UiButton>
        </div>
      </section>
    </>
  );
}
