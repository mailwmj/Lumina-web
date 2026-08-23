import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Download } from '@/components/ui/icons';
import { UiButton } from '@/components/ui';
import type { BrowserProjectBackupService } from '@/features/assets/application/browserProjectBackup';
import type { LuminaProjectExportProgress } from '@/features/assets/application/luminaProjectExport';
import { resolveLuminaProjectExportError } from '@/features/assets/ui/luminaProjectExportError';
import type { BrowserStorageStatusService } from '@/features/assets/application/browserStorageStatus';
import type { BrowserStorageStatus } from '@/runtime/browserStorage';
import { useProjectStore } from '@/stores/projectStore';

function formatStorageBytes(value: number | null): string {
  if (value === null) {
    return '-';
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function StorageStatusNotice({
  backupService,
  storageStatusService,
}: {
  backupService: BrowserProjectBackupService | null;
  storageStatusService: BrowserStorageStatusService | null;
}) {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.currentProject);
  const getCurrentProjectExportRecord = useProjectStore((state) => state.getCurrentProjectExportRecord);
  const [status, setStatus] = useState<BrowserStorageStatus | null>(null);
  const [hasCapacityIssue, setHasCapacityIssue] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupProgress, setBackupProgress] = useState<LuminaProjectExportProgress | null>(null);

  const refresh = useCallback(async (requestPersistence = false) => {
    if (storageStatusService) {
      setStatus(await storageStatusService.read(requestPersistence));
    }
  }, [storageStatusService]);

  useEffect(() => {
    if (!storageStatusService) {
      return;
    }
    void refresh(true);
    const onCapacityError = () => {
      setHasCapacityIssue(true);
      void refresh();
    };
    return storageStatusService.subscribeToCapacityErrors(onCapacityError);
  }, [storageStatusService, refresh]);

  const handleBackup = async () => {
    if (!project || !backupService) {
      return;
    }
    const projectRecord = getCurrentProjectExportRecord();
    if (!projectRecord) {
      return;
    }
    setIsBackingUp(true);
    setBackupError(null);
    setBackupProgress(null);
    try {
      await backupService.download([projectRecord.id], {
        onProgress: setBackupProgress,
        projectRecords: [projectRecord],
      });
    } catch (error) {
      setBackupError(resolveLuminaProjectExportError(error, t));
    } finally {
      setIsBackingUp(false);
      setBackupProgress(null);
    }
  };

  const hasPersistenceRisk = Boolean(project)
    && status?.supported !== false
    && status?.persisted === false;
  const usage = status?.usage ?? null;
  const quota = status?.quota ?? null;
  if (!storageStatusService || (!hasPersistenceRisk && !hasCapacityIssue)) {
    return null;
  }

  return (
    <aside
      role="alert"
      className="absolute left-3 top-3 z-20 flex max-w-[min(620px,calc(100%-24px))] items-center gap-3 border border-[var(--ui-warning-border)] bg-[var(--ui-surface-panel)] px-3 py-2 shadow-[var(--ui-shadow-panel)]"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-text-dark">
          {hasCapacityIssue ? t('storage.capacityTitle') : t('storage.persistenceTitle')}
        </p>
        <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
          {hasCapacityIssue ? t('storage.capacityMessage') : t('storage.persistenceMessage')}
          {usage !== null && quota !== null
            ? ` ${t('storage.usage', {
              usage: formatStorageBytes(usage),
              quota: formatStorageBytes(quota),
            })}`
            : null}
        </p>
        {backupError ? <p className="mt-1 text-[11px] text-[var(--ui-danger-text)]">{backupError}</p> : null}
      </div>
      <UiButton
        size="sm"
        className="shrink-0 gap-1.5"
        onClick={() => void handleBackup()}
        disabled={!project || !backupService || isBackingUp}
      >
        <Download className="h-3.5 w-3.5" />
        {isBackingUp && backupProgress
          ? t('storage.backingUpProgress', {
            completed: backupProgress.completedEntries,
            total: backupProgress.totalEntries,
          })
          : isBackingUp ? t('storage.backingUp') : t('storage.backup')}
      </UiButton>
    </aside>
  );
}
