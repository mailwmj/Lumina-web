import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function readStoredZipEntryNames(archive: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const byteCount = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    names.push(archive.subarray(nameStart, nameStart + nameLength).toString('utf8'));
    offset = dataStart + byteCount;
  }
  return names;
}

async function openBatchCrop(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => ({ usage: 0, quota: 8 * 1024 * 1024 * 1024 }),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /图片裁剪|Image Crop/ }).click();
  await page.getByRole('button', { name: '1440×1920' }).click();
}

async function readBatchAssets(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Array<{
        projectId: string;
        mimeType: string;
        sourceMetadata: { fileName?: string };
        referencedByProject: boolean;
        hasHistory: boolean;
      }>>(
        (resolve, reject) => {
          const transaction = database.transaction(['projects', 'history', 'assets'], 'readonly');
          const request = transaction.objectStore('assets').getAll();
          const projects = transaction.objectStore('projects').getAll();
          const history = transaction.objectStore('history').getAll();
          transaction.oncomplete = () => {
            const projectById = new Map((projects.result as Array<{ id: string; nodesJson: string }>)
              .map((project) => [project.id, project]));
            const historyProjectIds = new Set(
              (history.result as Array<{ projectId: string }>).map((record) => record.projectId),
            );
            resolve((request.result as Array<{
              assetId: string;
              projectId: string;
              mimeType: string;
              sourceMetadata: { fileName?: string };
            }>).map((asset) => ({
              projectId: asset.projectId,
              mimeType: asset.mimeType,
              sourceMetadata: asset.sourceMetadata,
              referencedByProject: projectById.get(asset.projectId)?.nodesJson.includes(asset.assetId) ?? false,
              hasHistory: historyProjectIds.has(asset.projectId),
            })));
          };
          transaction.onerror = () => reject(transaction.error);
        },
      );
    } finally {
      database.close();
    }
  });
}

test('exports a browser batch crop as a persisted JPEG asset and download', async ({ page }) => {
  await openBatchCrop(page);
  await page.getByTestId('batch-crop-file-input').setInputFiles({
    name: 'look.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });

  await expect(page.getByRole('button', { name: /确认当前|Confirm Current/ })).toBeVisible();
  await page.getByRole('button', { name: /确认当前|Confirm Current/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /批量导出 1 张|Export 1 Images/ }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('look_1440x1920.jpg');
  await expect(page.getByText(/浏览器下载|Browser Downloads/)).toBeVisible();

  await expect.poll(() => readBatchAssets(page)).toEqual([
    expect.objectContaining({
      mimeType: 'image/jpeg',
      sourceMetadata: { fileName: 'look_1440x1920.jpg' },
      referencedByProject: true,
      hasHistory: true,
    }),
  ]);
});

test('packs completed browser batch crops into a stable ZIP', async ({ page }) => {
  await openBatchCrop(page);
  await page.getByTestId('batch-crop-file-input').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: pngBytes },
    { name: 'second.png', mimeType: 'image/png', buffer: pngBytes },
  ]);

  const confirmCurrent = page.getByRole('button', { name: /确认当前|Confirm Current/ });
  await expect(confirmCurrent).toBeVisible();
  await confirmCurrent.click();
  await expect(confirmCurrent).toBeVisible();
  await confirmCurrent.click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /批量导出 2 张|Export 2 Images/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('lumina-batch-crop.zip');
  expect(readStoredZipEntryNames(await readFile((await download.path())!))).toEqual([
    'first_1440x1920.jpg',
    'second_1440x1920.jpg',
  ]);
});

test('keeps the batch usable after an unsupported file is rejected', async ({ page }) => {
  await openBatchCrop(page);
  await page.getByTestId('batch-crop-file-input').setInputFiles({
    name: 'unsupported.gif',
    mimeType: 'image/gif',
    buffer: pngBytes,
  });
  await page.getByTestId('batch-crop-file-input').setInputFiles({
    name: 'accepted.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect(page.getByRole('heading', { name: 'accepted.png' })).toBeVisible();
  await expect(page.getByText('unsupported.gif', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1/100', { exact: true })).toBeVisible();
});
