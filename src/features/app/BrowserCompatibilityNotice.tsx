import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { X } from '@/components/ui/icons';
import { UiTooltip } from '@/components/ui';
import type {
  BrowserCapabilities,
  BrowserCapabilityIssue,
  BrowserKind,
} from '@/runtime/browserCapabilities';

const browserLabelKeys: Record<BrowserKind, string> = {
  chrome: 'browserCompatibility.browserChrome',
  edge: 'browserCompatibility.browserEdge',
  firefox: 'browserCompatibility.browserFirefox',
  safari: 'browserCompatibility.browserSafari',
  unknown: 'browserCompatibility.browserUnknown',
};

const issueKeys: Record<BrowserCapabilityIssue, string> = {
  'browser-not-recommended': 'browserCompatibility.browserNotRecommended',
  'indexeddb-unavailable': 'browserCompatibility.indexedDbUnavailable',
  'storage-estimate-unavailable': 'browserCompatibility.storageEstimateUnavailable',
  'service-worker-unavailable': 'browserCompatibility.serviceWorkerUnavailable',
};

export function BrowserCompatibilityNotice({
  capabilities,
}: {
  capabilities: BrowserCapabilities;
}) {
  const { t } = useTranslation();
  const [isDismissed, setIsDismissed] = useState(false);

  if (isDismissed || capabilities.issues.length === 0) {
    return null;
  }

  const browser = t(browserLabelKeys[capabilities.browser]);
  return (
    <aside
      role="alert"
      className="absolute right-3 top-3 z-20 flex max-w-[min(420px,calc(100%-24px))] gap-3 border border-[var(--ui-warning-border)] bg-[var(--ui-surface-panel)] px-3 py-2 shadow-[var(--ui-shadow-panel)]"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-text-dark">{t('browserCompatibility.title')}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
          {t('browserCompatibility.message')}
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-4 text-text-muted">
          {capabilities.issues.map((issue) => (
            <li key={issue}>{t(issueKeys[issue], { browser })}</li>
          ))}
        </ul>
      </div>
      <UiTooltip content={t('common.close')}>
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={() => setIsDismissed(true)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[var(--ui-hover)] hover:text-text-dark"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </UiTooltip>
    </aside>
  );
}
