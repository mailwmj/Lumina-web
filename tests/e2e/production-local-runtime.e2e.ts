import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startInstalledCanvasMcp } from '../../runtime/installedRuntime.mjs';
import { startProductionLuminaRuntime } from '../../runtime/productionRuntime.mjs';
import { closeStartedRuntime, findAvailableLocalRuntimePort } from '../../runtime/localRuntimeTestSupport.mjs';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

interface StoredBrowserLibrary {
  asset: {
    assetId: string;
    blobSize: number;
    byteCount: number;
    sourceFileName: string | null;
  };
  historyJson: string;
  projectId: string;
  settingsValue: string;
}

test('preserves the browser project library through runtime repair and reinstall at the registered Origin', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-production-runtime-e2e-'));
  const metadataDirectory = path.join(fixture, 'runtime');
  const port = await findAvailableLocalRuntimePort();
  const projectName = `Production runtime ${Date.now()}`;
  const installOptions = { metadataDirectory, portCandidates: [port], runtimeVersion: '0.2.40' };
  const repairOptions = { metadataDirectory, portCandidates: [port], runtimeVersion: '0.2.40' };
  const reinstallOptions = { metadataDirectory, portCandidates: [port], runtimeVersion: '0.2.41' };
  let first: Awaited<ReturnType<typeof startProductionLuminaRuntime>> | undefined;
  let repaired: Awaited<ReturnType<typeof startProductionLuminaRuntime>> | undefined;
  let reinstalled: Awaited<ReturnType<typeof startProductionLuminaRuntime>> | undefined;
  try {
    first = await startProductionLuminaRuntime(installOptions);
    expect(first.status).toBe('started');
    expect(first.metadata.origin).toBe(`http://127.0.0.1:${port}`);
    const installationId = first.metadata.installationId;

    await page.goto(first.metadata.origin);
    await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
    await page.getByRole('button', { name: /新建项目|New Project/ }).click();
    await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(projectName);
    await page.getByRole('button', { name: /确认|Confirm/ }).click();
    await expect(page.getByText(projectName, { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /设置|Settings/ }).click();
    await page.getByRole('checkbox', { name: /上传节点自动使用文件名|Use uploaded filename/ }).click();
    await page.getByRole('button', { name: /保存|Save/ }).click();
    await page.locator('input[type="file"]').first().setInputFiles({
      buffer: pngBytes,
      mimeType: 'image/png',
      name: 'runtime-library.png',
    });
    await expect.poll(() => storedBrowserLibrary(page, projectName)).not.toBeNull();
    const libraryBeforeRestart = await storedBrowserLibrary(page, projectName);
    expect(libraryBeforeRestart).toEqual(expect.objectContaining({
      asset: expect.objectContaining({
        blobSize: pngBytes.length,
        byteCount: pngBytes.length,
        sourceFileName: 'runtime-library.png',
      }),
      historyJson: expect.any(String),
      projectId: expect.any(String),
      settingsValue: expect.stringContaining('useUploadFilenameAsNodeTitle'),
    }));

    const gatewayStatus = await page.evaluate(async () => {
      const response = await fetch('/api/generation/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return response.status;
    });
    expect(gatewayStatus).toBe(401);

    const opened = first.runtime.bridge.ensureOpen();
    expect(opened.status).toBe('awaiting_browser');
    await page.goto(bridgeUrl(opened.bootstrap));
    await page.getByRole('heading', { name: projectName, exact: true }).click();
    await expect(page.locator('.react-flow__pane')).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expect.poll(
      () => first?.runtime.bridge.ensureOpen().status,
      { timeout: 15_000 },
    ).toBe('connected');

    await first.runtime.close();
    first = undefined;

    repaired = await startProductionLuminaRuntime(repairOptions);
    expect(repaired.status).toBe('started');
    expect(repaired.metadata.installationId).toBe(installationId);
    expect(repaired.metadata.origin).toBe(`http://127.0.0.1:${port}`);
    expect(repaired.metadata.runtimeVersion).toBe('0.2.40');
    await page.goto(repaired.metadata.origin);
    await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
    await expect.poll(() => storedBrowserLibrary(page, projectName)).toEqual(libraryBeforeRestart);
    await repaired.runtime.close();
    repaired = undefined;

    reinstalled = await startProductionLuminaRuntime(reinstallOptions);
    expect(reinstalled.status).toBe('started');
    expect(reinstalled.metadata.installationId).toBe(installationId);
    expect(reinstalled.metadata.origin).toBe(`http://127.0.0.1:${port}`);
    expect(reinstalled.metadata.runtimeVersion).toBe('0.2.41');
    await page.goto(reinstalled.metadata.origin);
    await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
    await expect.poll(() => storedBrowserLibrary(page, projectName)).toEqual(libraryBeforeRestart);
    await page.getByRole('heading', { name: projectName, exact: true }).click();
    await expect(page.locator('.react-flow__node img')).toHaveCount(1);
  } finally {
    await closeStartedRuntime(first);
    await closeStartedRuntime(repaired);
    await closeStartedRuntime(reinstalled);
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('reuses the installed runtime Chrome Origin and opens the bridge read-only', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-installed-canvas-mcp-e2e-'));
  const metadataDirectory = path.join(fixture, 'runtime');
  const port = await findAvailableLocalRuntimePort();
  const projectName = `Installed MCP ${Date.now()}`;
  const options = { metadataDirectory, portCandidates: [port] };
  let existing: Awaited<ReturnType<typeof startProductionLuminaRuntime>> | undefined;
  let bridge: { ensureOpen(): { status: string; bootstrap?: { canonicalOrigin: string } } } | undefined;
  let releaseMcp: (() => Promise<void>) | undefined;
  let mcpLaunch: Promise<unknown> | undefined;

  try {
    existing = await startProductionLuminaRuntime(options);
    expect(existing.status).toBe('started');
    expect(existing.metadata.origin).toBe(`http://127.0.0.1:${port}`);

    mcpLaunch = startInstalledCanvasMcp({
      startRuntime: () => startProductionLuminaRuntime(options),
      startMcp: async (companion, onClose) => {
        bridge = companion;
        await new Promise<void>((resolve) => {
          releaseMcp = async () => {
            await onClose();
            resolve();
          };
        });
      },
    });

    await expect.poll(() => bridge?.ensureOpen().status).toBe('awaiting_browser');
    const opened = bridge?.ensureOpen();
    expect(opened?.status).toBe('awaiting_browser');
    if (opened?.status !== 'awaiting_browser' || !opened.bootstrap) {
      throw new Error('Installed MCP did not provide a Chrome bridge bootstrap.');
    }
    expect(opened.bootstrap.canonicalOrigin).toBe(existing.metadata.origin);

    await page.goto(bridgeUrl(opened.bootstrap));
    await page.getByRole('button', { name: /新建项目|New Project/ }).click();
    await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(projectName);
    await page.getByRole('button', { name: /确认|Confirm/ }).click();
    await expect(page.getByRole('heading', {
      name: /允许 Codex 受限编辑|Allow limited Codex editing/,
    })).toBeVisible();
    await page.getByRole('button', { name: /保持只读|Keep read-only/ }).click();
    await expect(page.locator('.react-flow__pane')).toBeVisible();
    await expect.poll(() => bridge?.ensureOpen().status).toBe('connected');
  } finally {
    await releaseMcp?.();
    await mcpLaunch;
    await closeStartedRuntime(existing);
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

function bridgeUrl(bootstrap: { canonicalOrigin: string }) {
  const url = new URL(bootstrap.canonicalOrigin);
  url.searchParams.set('bridge-reload', String(Date.now()));
  url.hash = `lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`;
  return url.toString();
}

async function storedBrowserLibrary(page: Page, projectName: string): Promise<StoredBrowserLibrary | null> {
  return page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<StoredBrowserLibrary | null>((resolve, reject) => {
        const transaction = database.transaction(['projects', 'history', 'assets', 'settings'], 'readonly');
        const projects = transaction.objectStore('projects').getAll();
        const history = transaction.objectStore('history').getAll();
        const assets = transaction.objectStore('assets').getAll();
        const settings = transaction.objectStore('settings').get('settings-storage');
        transaction.oncomplete = () => {
          const project = (projects.result as Array<{ id: string; name?: string }>)
            .find((candidate) => candidate.name === name);
          const projectHistory = (history.result as Array<{ historyJson?: string; projectId?: string }>)
            .find((candidate) => candidate.projectId === project?.id);
          const asset = (assets.result as Array<{
            assetId?: string;
            blob?: Blob;
            byteCount?: number;
            projectId?: string;
            sourceMetadata?: { fileName?: string };
          }>).find((candidate) => (
            candidate.projectId === project?.id
            && candidate.sourceMetadata?.fileName === 'runtime-library.png'
          ));
          const settingsRecord = settings.result as { value?: string } | undefined;
          if (!project || !projectHistory || !asset || typeof settingsRecord?.value !== 'string') {
            resolve(null);
            return;
          }
          resolve({
            asset: {
              assetId: asset.assetId ?? '',
              blobSize: asset.blob?.size ?? 0,
              byteCount: asset.byteCount ?? 0,
              sourceFileName: asset.sourceMetadata?.fileName ?? null,
            },
            historyJson: projectHistory.historyJson ?? '',
            projectId: project.id,
            settingsValue: settingsRecord.value,
          });
        };
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, projectName);
}
