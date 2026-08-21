import { useTranslation } from 'react-i18next';

import { RefreshCw } from '@/components/ui/icons';
import { UiButton } from '@/components/ui';

export function WebAppUpdateNotice({
  isReady,
  onReload,
}: {
  isReady: boolean;
  onReload: () => void;
}) {
  const { t } = useTranslation();

  if (!isReady) {
    return null;
  }

  return (
    <aside
      role="status"
      className="absolute bottom-3 left-3 z-20 flex max-w-[min(460px,calc(100%-24px))] items-center gap-3 border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] px-3 py-2 shadow-[var(--ui-shadow-panel)]"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-text-dark">{t('webUpdate.title')}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-text-muted">{t('webUpdate.message')}</p>
      </div>
      <UiButton size="sm" variant="primary" className="shrink-0 gap-1.5" onClick={onReload}>
        <RefreshCw className="h-3.5 w-3.5" />
        {t('webUpdate.reload')}
      </UiButton>
    </aside>
  );
}
