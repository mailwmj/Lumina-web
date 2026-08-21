import { describe, expect, it } from 'vitest';

import {
  createBrowserDiagnosticReport,
  createCredentialFreeBrowserSettingsExport,
} from './browserSettingsDiagnostics';
import { createBrowserSettingsDiagnosticsService } from './browserSettingsDiagnosticsService';

describe('browser settings diagnostics', () => {
  it('removes provider and bridge credentials from a settings export', () => {
    const exported = createCredentialFreeBrowserSettingsExport({
      version: 31,
      settings: {
        downloadPresetPaths: ['C:\\Users\\name\\Downloads'],
        openAiImageApi: {
          apiKey: 'image-secret',
          baseUrl: 'https://user:url-secret@images.example.test/v1?api_key=query-secret#fragment-secret',
        },
        textApis: [{ id: 'text', apiKey: 'text-secret', baseUrl: 'https://text.example.test' }],
        videoApis: [{ id: 'video', apiKey: 'video-secret', baseUrl: 'https://video.example.test' }],
        externalAgentConnection: { enabled: true, token: 'bridge-secret' },
      },
    });

    expect(exported).toEqual({
      version: 31,
      settings: {
        openAiImageApi: { baseUrl: 'https://images.example.test/v1' },
        textApis: [{ id: 'text', baseUrl: 'https://text.example.test' }],
        videoApis: [{ id: 'video', baseUrl: 'https://video.example.test' }],
        externalAgentConnection: { enabled: true },
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(/secret|api_key|Downloads/);
  });

  it('creates a diagnostic report with browser and gateway state but no settings values', () => {
    const report = createBrowserDiagnosticReport({
      appVersion: '0.2.32',
      online: false,
      generatedAt: '2026-08-21T00:00:00.000Z',
      capabilities: {
        browser: 'safari',
        isRecommendedBrowser: false,
        hasIndexedDb: true,
        hasStorageEstimate: false,
        hasServiceWorker: true,
        issues: ['browser-not-recommended', 'storage-estimate-unavailable'],
      },
      storage: {
        supported: true,
        persisted: false,
        persistResult: false,
        usage: 20,
        quota: 100,
        available: 80,
      },
    });

    expect(report).toEqual({
      reportVersion: 1,
      generatedAt: '2026-08-21T00:00:00.000Z',
      appVersion: '0.2.32',
      runtime: 'web',
      online: false,
      gateway: { available: false },
      capabilities: {
        browser: 'safari',
        isRecommendedBrowser: false,
        hasIndexedDb: true,
        hasStorageEstimate: false,
        hasServiceWorker: true,
        issues: ['browser-not-recommended', 'storage-estimate-unavailable'],
      },
      storage: {
        supported: true,
        persisted: false,
        persistResult: false,
        usage: 20,
        quota: 100,
        available: 80,
      },
    });
    expect(JSON.stringify(report)).not.toMatch(/secret|apiKey|token/i);
  });

  it('downloads credential-free settings and diagnostics through the browser download boundary', async () => {
    const downloads: Array<{ value: unknown; fileName: string }> = [];
    const service = createBrowserSettingsDiagnosticsService({
      getAppVersion: async () => '0.2.32',
      getOnline: () => true,
      getCapabilities: () => ({
        browser: 'chrome',
        isRecommendedBrowser: true,
        hasIndexedDb: true,
        hasStorageEstimate: true,
        hasServiceWorker: true,
        issues: [],
      }),
      readStorage: async () => ({
        supported: true,
        persisted: true,
        persistResult: null,
        usage: 10,
        quota: 100,
        available: 90,
      }),
      now: () => '2026-08-21T00:00:00.000Z',
      downloadJson: (value, fileName) => downloads.push({ value, fileName }),
    });

    service.downloadSettings({
      openAiImageApi: { apiKey: 'image-secret', baseUrl: 'https://images.example.test' },
    });
    await service.downloadDiagnostics();

    expect(downloads).toEqual([
      {
        fileName: 'lumina-settings.json',
        value: {
          version: 31,
          settings: {
            openAiImageApi: { baseUrl: 'https://images.example.test' },
          },
        },
      },
      {
        fileName: 'lumina-browser-diagnostics.json',
        value: {
          reportVersion: 1,
          generatedAt: '2026-08-21T00:00:00.000Z',
          appVersion: '0.2.32',
          runtime: 'web',
          online: true,
          gateway: { available: true },
          capabilities: {
            browser: 'chrome',
            isRecommendedBrowser: true,
            hasIndexedDb: true,
            hasStorageEstimate: true,
            hasServiceWorker: true,
            issues: [],
          },
          storage: {
            supported: true,
            persisted: true,
            persistResult: null,
            usage: 10,
            quota: 100,
            available: 90,
          },
        },
      },
    ]);
    expect(JSON.stringify(downloads)).not.toMatch(/secret/);
  });
});
