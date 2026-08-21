import {
  createBrowserDiagnosticReport,
  createCredentialFreeBrowserSettingsExport,
} from '@/features/settings/application/browserSettingsDiagnostics';
import { SETTINGS_SCHEMA_VERSION } from '@/features/settings/domain/settingsRepository';
import {
  readBrowserCapabilities,
  type BrowserCapabilities,
} from '@/runtime/browserCapabilities';
import {
  readBrowserStorageStatus,
  type BrowserStorageStatus,
} from '@/runtime/browserStorage';
import { runtime } from '@/runtime/runtime';

export interface BrowserSettingsDiagnosticsService {
  downloadSettings<TSettings extends object>(settings: TSettings): void;
  downloadDiagnostics(): Promise<void>;
}

export interface BrowserSettingsDiagnosticsDependencies {
  getAppVersion(): Promise<string>;
  getOnline(): boolean;
  getCapabilities(): BrowserCapabilities;
  readStorage(): Promise<BrowserStorageStatus>;
  now(): string;
  downloadJson(value: unknown, fileName: string): void;
}

interface DownloadDocument {
  createElement(tagName: 'a'): HTMLAnchorElement;
  body: { appendChild(element: HTMLAnchorElement): void };
}

interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export function downloadBrowserJson(
  value: unknown,
  fileName: string,
  {
    documentRef = document,
    objectUrlApi = URL,
  }: {
    documentRef?: DownloadDocument;
    objectUrlApi?: ObjectUrlApi;
  } = {},
): void {
  const objectUrl = objectUrlApi.createObjectURL(new Blob([
    JSON.stringify(value, null, 2),
  ], { type: 'application/json' }));
  const anchor = documentRef.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentRef.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    objectUrlApi.revokeObjectURL(objectUrl);
  }
}

const defaultDependencies: BrowserSettingsDiagnosticsDependencies = {
  getAppVersion: () => runtime.getAppVersion(),
  getOnline: () => typeof navigator !== 'undefined' && navigator.onLine,
  getCapabilities: () => readBrowserCapabilities(),
  readStorage: () => readBrowserStorageStatus(),
  now: () => new Date().toISOString(),
  downloadJson: downloadBrowserJson,
};

export function createBrowserSettingsDiagnosticsService(
  dependencies: Partial<BrowserSettingsDiagnosticsDependencies> = {},
): BrowserSettingsDiagnosticsService {
  const resolved = { ...defaultDependencies, ...dependencies };
  return {
    downloadSettings(settings) {
      resolved.downloadJson(createCredentialFreeBrowserSettingsExport({
        settings,
        version: SETTINGS_SCHEMA_VERSION,
      }), 'lumina-settings.json');
    },
    async downloadDiagnostics() {
      const [appVersion, storage] = await Promise.all([
        resolved.getAppVersion(),
        resolved.readStorage(),
      ]);
      resolved.downloadJson(createBrowserDiagnosticReport({
        appVersion,
        online: resolved.getOnline(),
        generatedAt: resolved.now(),
        capabilities: resolved.getCapabilities(),
        storage,
      }), 'lumina-browser-diagnostics.json');
    },
  };
}
