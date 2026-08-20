import { expect, test, type Page } from '@playwright/test';

const projectName = `Reload project ${Date.now()}`;
const annotationText = 'Persisted browser note';

interface StoredProjectRecord {
  id: string;
  name: string;
  nodeCount: number;
  nodesJson: string;
  viewportJson: string;
  historyJson: string;
  storeNames: string[];
}

interface StoredAssetSnapshot {
  assetId: string;
  mimeType: string;
  byteCount: number;
  width: number | null;
  height: number | null;
  sourceFileName: string | null;
  blobHash: string;
  nodeImageUrl: string | null;
  nodePreviewImageUrl: string | null;
}

interface ObjectUrlTrace {
  created: Array<{ url: string; sourceFileName: string | null }>;
  revoked: string[];
  anchorClicks: Array<{ href: string; download: string }>;
}

const OBJECT_URL_TRACE_KEY = '__issue7ObjectUrlTrace';

async function readStoredProject(
  page: Page,
  targetName: string
): Promise<StoredProjectRecord | null> {
  return page.evaluate(async (projectName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return await new Promise<StoredProjectRecord | null>((resolve, reject) => {
      const storeNames = Array.from(database.objectStoreNames);
      const transaction = database.transaction(['projects', 'history'], 'readonly');
      const projectRequest = transaction.objectStore('projects').getAll();
      const historyRequest = transaction.objectStore('history').getAll();
      transaction.oncomplete = () => {
        const project = (projectRequest.result as StoredProjectRecord[])
          .find((item) => item.name === projectName);
        const history = (historyRequest.result as Array<{ projectId: string; historyJson: string }>)
          .find((item) => item.projectId === project?.id);
        database.close();
        resolve(project ? { ...project, historyJson: history?.historyJson ?? '', storeNames } : null);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }, targetName);
}

async function readStoredImageAsset(
  page: Page,
  targetName: string,
): Promise<StoredAssetSnapshot | null> {
  return page.evaluate(async (projectName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return await new Promise<StoredAssetSnapshot | null>((resolve, reject) => {
      const transaction = database.transaction(['projects', 'assets'], 'readonly');
      const projectsRequest = transaction.objectStore('projects').getAll();
      const assetsRequest = transaction.objectStore('assets').getAll();
      transaction.oncomplete = async () => {
        try {
          const project = (projectsRequest.result as Array<{
            id: string;
            name: string;
            nodesJson: string;
          }>).find((item) => item.name === projectName);
          if (!project) {
            database.close();
            resolve(null);
            return;
          }
          const nodes = JSON.parse(project.nodesJson) as Array<{
            data?: {
              assetId?: string | null;
              imageUrl?: string | null;
              previewImageUrl?: string | null;
            };
          }>;
          const node = nodes.find((item) => item.data?.assetId);
          const assetId = node?.data?.assetId;
          const asset = (assetsRequest.result as Array<{
            assetId: string;
            projectId: string;
            mimeType: string;
            byteCount: number;
            width: number | null;
            height: number | null;
            sourceMetadata?: { fileName?: string };
            blob: Blob;
          }>).find((item) => item.assetId === assetId && item.projectId === project.id);
          if (!asset) {
            database.close();
            resolve(null);
            return;
          }
          const bytes = await asset.blob.arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const blobHash = Array.from(new Uint8Array(digest))
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('');
          database.close();
          resolve({
            assetId: asset.assetId,
            mimeType: asset.mimeType,
            byteCount: asset.byteCount,
            width: asset.width,
            height: asset.height,
            sourceFileName: asset.sourceMetadata?.fileName ?? null,
            blobHash,
            nodeImageUrl: node?.data?.imageUrl ?? null,
            nodePreviewImageUrl: node?.data?.previewImageUrl ?? null,
          });
        } catch (error) {
          database.close();
          reject(error);
        }
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }, targetName);
}

async function countStoredAssets(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(['assets'], 'readonly');
      const request = transaction.objectStore('assets').count();
      transaction.oncomplete = () => {
        database.close();
        resolve(request.result);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  });
}

test('restores a text annotation and viewport after a hard reload', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page
    .getByPlaceholder(/请输入项目名称|Enter project name/)
    .fill(projectName);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();

  await expect(page.getByText(projectName, { exact: false })).toBeVisible();
  await page.locator('.react-flow__pane').dblclick();
  await page.getByRole('button', { name: /文本注释|Text Annotation/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await page.locator('.react-flow__node').click();

  const annotation = page.getByPlaceholder(/输入 Markdown 文本|Write Markdown text/);
  await annotation.fill(annotationText);
  await page.getByRole('button', { name: /放大|Zoom In/ }).click();
  await page.waitForTimeout(30);

  await page.reload();
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  await expect(page.getByText(annotationText, { exact: true })).toBeVisible();

  const storedProject = await readStoredProject(page, projectName);
  expect(storedProject).not.toBeNull();
  expect(storedProject?.nodeCount).toBe(1);
  expect(storedProject?.historyJson).toEqual(expect.any(String));
  expect(storedProject?.storeNames).toEqual(
    expect.arrayContaining(['projects', 'history', 'settings', 'meta'])
  );
  const storedNodes = JSON.parse(storedProject?.nodesJson ?? '[]') as Array<{
    position?: { x?: number; y?: number };
    data?: { content?: string };
  }>;
  expect(storedNodes[0]?.data?.content).toBe(annotationText);
  expect(storedNodes[0]?.position?.x).toEqual(expect.any(Number));
  expect(storedNodes[0]?.position?.y).toEqual(expect.any(Number));
  const renderedNodeStyle = await page.locator('.react-flow__node').getAttribute('style');
  expect(renderedNodeStyle).toContain(
    `translate(${storedNodes[0]?.position?.x}px, ${storedNodes[0]?.position?.y}px)`
  );

  const storedViewport = JSON.parse(storedProject?.viewportJson ?? '{}') as { zoom?: number };
  expect(storedViewport.zoom).toEqual(expect.any(Number));
  expect(storedViewport.zoom).not.toBe(1);
  await expect.poll(async () => {
    const style = await page.locator('.react-flow__viewport').getAttribute('style');
    const match = style?.match(/scale\(([^)]+)\)/);
    return match ? Number(match[1]) : 1;
  }).toBeCloseTo(storedViewport.zoom ?? 1, 2);
});

test('imports an image asset, views and downloads it, then rehydrates it after reload', async ({ page }) => {
  const targetName = `Asset project ${Date.now()}`;
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  await page.addInitScript((traceKey) => {
    const trace: ObjectUrlTrace = { created: [], revoked: [], anchorClicks: [] };
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = createObjectURL(blob);
      trace.created.push({
        url,
        sourceFileName: blob instanceof File ? blob.name : null,
      });
      return url;
    };
    URL.revokeObjectURL = (url) => {
      trace.revoked.push(url);
      revokeObjectURL(url);
    };
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      trace.anchorClicks.push({ href: this.href, download: this.download });
      anchorClick.call(this);
    };
    (globalThis as unknown as Record<string, ObjectUrlTrace>)[traceKey] = trace;
  }, OBJECT_URL_TRACE_KEY);

  await page.goto('/');
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page
    .getByPlaceholder(/请输入项目名称|Enter project name/)
    .fill(targetName);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(targetName, { exact: false })).toBeVisible();

  await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 320 } });
  await page.getByRole('button', { name: /^上传$|^Upload$/ }).click();
  const input = page.locator('input[type="file"]').first();
  await expect(input).toHaveCount(1);
  await input.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: pngBytes });

  const image = page.locator('.react-flow__node img').first();
  await expect(image).toBeVisible();
  await expect.poll(async () => image.getAttribute('src')).toMatch(/^blob:/);
  const firstObjectUrl = await image.getAttribute('src');
  let firstAsset: StoredAssetSnapshot | null = null;
  await expect.poll(async () => {
    firstAsset = await readStoredImageAsset(page, targetName);
    return firstAsset !== null;
  }).toBe(true);
  expect(firstAsset).toMatchObject({
    mimeType: 'image/png',
    byteCount: pngBytes.length,
    width: 1,
    height: 1,
    sourceFileName: 'photo.png',
    nodeImageUrl: null,
    nodePreviewImageUrl: null,
  });

  await image.click();
  const downloadPromise = page.waitForEvent('download', { timeout: 1_000 }).catch(() => null);
  const downloadButton = page.getByRole('button', { name: /下载|Download/ });
  await downloadButton.focus();
  await downloadButton.press('Enter');
  const download = await downloadPromise;
  const anchorClicks = await page.evaluate((traceKey) => {
    const trace = (globalThis as unknown as Record<string, ObjectUrlTrace>)[traceKey];
    return trace.anchorClicks;
  }, OBJECT_URL_TRACE_KEY);
  expect(anchorClicks).toContainEqual({ href: firstObjectUrl, download: 'photo.png' });
  expect(download?.suggestedFilename()).toBe('photo.png');

  const nodeUploadInput = page.locator('.react-flow__node input[type="file"]');
  await expect(nodeUploadInput).toHaveCount(1);
  await nodeUploadInput.setInputFiles({
    name: 'node-input.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect.poll(async () => page.locator('.react-flow__node').count()).toBe(1);
  await expect.poll(async () => page.locator('.react-flow__node img').count()).toBe(1);
  await expect.poll(async () => page.evaluate((traceKey) => {
    const trace = (globalThis as unknown as Record<string, ObjectUrlTrace>)[traceKey];
    return trace.created.find((entry) => entry.sourceFileName === 'node-input.png')?.url ?? null;
  }, OBJECT_URL_TRACE_KEY)).not.toBeNull();
  const transientObjectUrl = await page.evaluate((traceKey) => {
    const trace = (globalThis as unknown as Record<string, ObjectUrlTrace>)[traceKey];
    return trace.created.find((entry) => entry.sourceFileName === 'node-input.png')?.url ?? null;
  }, OBJECT_URL_TRACE_KEY);
  expect(transientObjectUrl).not.toBeNull();
  await expect.poll(async () => page.evaluate(({ traceKey, url }) => {
    const trace = (globalThis as unknown as Record<string, ObjectUrlTrace>)[traceKey];
    return trace.revoked.includes(url);
  }, { traceKey: OBJECT_URL_TRACE_KEY, url: transientObjectUrl! })).toBe(true);
  let replacementAsset: StoredAssetSnapshot | null = null;
  await expect.poll(async () => {
    replacementAsset = await readStoredImageAsset(page, targetName);
    return replacementAsset?.sourceFileName === 'node-input.png';
  }).toBe(true);

  await page.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const canvas = document.querySelector('.canvas-surface');
    canvas?.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: 400,
      clientY: 240,
    }));
  }, [...pngBytes]);
  await expect.poll(async () => page.locator('.react-flow__node').count()).toBe(2);
  await expect.poll(async () => page.locator('.react-flow__node img').count()).toBe(2);

  await page.locator('.react-flow__pane').click({ position: { x: 900, y: 500 } });
  await page.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    document.body.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    }));
  }, [...pngBytes]);
  await expect.poll(async () => page.locator('.react-flow__node').count()).toBe(3);
  await expect.poll(async () => page.locator('.react-flow__node img').count()).toBe(3);
  await expect.poll(() => countStoredAssets(page)).toBe(4);

  await image.dblclick();
  await expect(page.getByAltText(/图片|Image/).last()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
  await page.getByRole('heading', { name: targetName, exact: true }).click();
  const rehydratedImage = page.locator('.react-flow__node img').first();
  await expect(rehydratedImage).toBeVisible();
  await expect.poll(async () => rehydratedImage.getAttribute('src')).toMatch(/^blob:/);
  const secondObjectUrl = await rehydratedImage.getAttribute('src');
  expect(secondObjectUrl).not.toBe(firstObjectUrl);

  const secondAsset = await readStoredImageAsset(page, targetName);
  expect(secondAsset?.assetId).toBe(replacementAsset?.assetId);
  expect(secondAsset?.blobHash).toBe(replacementAsset?.blobHash);
});
