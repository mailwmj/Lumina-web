import {
  createCredentialFreeSettingsExport,
} from '@/features/settings/application/settingsRepository';
import type { SettingsExport } from '@/features/settings/domain/settingsRepository';
import type { BrowserCapabilities } from '@/runtime/browserCapabilities';
import type { BrowserStorageStatus } from '@/runtime/browserStorage';

export interface BrowserDiagnosticReport {
  reportVersion: 1;
  generatedAt: string;
  appVersion: string;
  runtime: 'web';
  online: boolean;
  gateway: { available: boolean };
  capabilities: BrowserCapabilities;
  storage: BrowserStorageStatus;
}

export function createCredentialFreeBrowserSettingsExport<TState extends object>(
  snapshot: SettingsExport<TState>,
): SettingsExport<TState> {
  const exported = createCredentialFreeSettingsExport({
    state: snapshot.settings,
    version: snapshot.version,
  });
  delete (exported.settings as Record<string, unknown>).downloadPresetPaths;
  return exported;
}

export function createBrowserDiagnosticReport({
  appVersion,
  online,
  generatedAt,
  capabilities,
  storage,
}: Omit<BrowserDiagnosticReport, 'reportVersion' | 'runtime' | 'gateway'>): BrowserDiagnosticReport {
  return {
    reportVersion: 1,
    generatedAt,
    appVersion,
    runtime: 'web',
    online,
    gateway: { available: online },
    capabilities,
    storage,
  };
}
