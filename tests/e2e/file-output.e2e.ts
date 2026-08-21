import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const videoBytes = Buffer.from('Lumina output video E2E bytes');

interface CapturedDirectoryOutput {
  attempts: string[];
  files: Array<{ fileName: string; sha256: string }>;
  queryCount: number;
  requestCount: number;
}

interface StoredZipEntry {
  path: string;
  bytes: Buffer;
}

function readStoredZipEntries(archive: Buffer): StoredZipEntry[] {
  const entries: StoredZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const byteCount = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      path: archive.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      bytes: archive.subarray(dataStart, dataStart + byteCount),
    });
    offset = dataStart + byteCount;
  }
  return entries;
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(name);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();
}

async function addImage(page: Page, name = 'photo.png'): Promise<void> {
  await page.locator('.react-flow__pane').dblclick({ position: { x: 420, y: 320 } });
  await page.getByRole('button', { name: /^上传$|^Upload$/ }).click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect(page.locator('.react-flow__node img').first()).toBeVisible();
}

async function seedVideoResult(page: Page, projectName: string): Promise<void> {
  await page.evaluate(async ({ name, bytes }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['projects', 'assets'], 'readwrite');
        const projects = transaction.objectStore('projects');
        const assets = transaction.objectStore('assets');
        const request = projects.getAll();
        request.onsuccess = () => {
          const project = (request.result as Array<{
            id: string;
            name: string;
            nodeCount: number;
            nodesJson: string;
          }>).find((candidate) => candidate.name === name);
          if (!project) {
            reject(new Error(`Project not found: ${name}`));
            return;
          }
          const payload = JSON.parse(project.nodesJson) as unknown;
          const nodes = Array.isArray(payload)
            ? payload
            : (payload as { nodes?: unknown[] }).nodes ?? [];
          const outputNode = {
            id: 'output-video',
            type: 'exportVideoNode',
            position: { x: 720, y: 320 },
            width: 320,
            height: 240,
            data: {
              displayName: 'Finished video',
              assetId: 'output-video-asset',
              videoUrl: null,
              previewImageUrl: null,
              aspectRatio: '16:9',
              model: 'E2E video',
              resolution: '720p',
              duration: 5,
              hasAudio: false,
              isGenerating: false,
            },
          };
          projects.put({
            ...project,
            nodeCount: nodes.length + 1,
            nodesJson: JSON.stringify(Array.isArray(payload)
              ? [...nodes, outputNode]
              : { ...(payload as Record<string, unknown>), nodes: [...nodes, outputNode] }),
          });
          assets.put({
            assetId: 'output-video-asset',
            projectId: project.id,
            kind: 'video',
            mimeType: 'video/mp4',
            byteCount: bytes.length,
            createdAt: Date.now(),
            sourceKind: 'generation',
            width: null,
            height: null,
            durationMs: 5_000,
            sourceMetadata: { fileName: 'finished-video.mp4' },
            lifecycleState: 'active',
            blob: new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }),
          });
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { name: projectName, bytes: [...videoBytes] });
}

async function seedStoryboard(page: Page, projectName: string): Promise<void> {
  const imageUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;
  await page.evaluate(async ({ name, source }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['projects'], 'readwrite');
        const projects = transaction.objectStore('projects');
        const request = projects.getAll();
        request.onsuccess = () => {
          const project = (request.result as Array<{
            id: string;
            name: string;
            nodeCount: number;
            nodesJson: string;
          }>).find((candidate) => candidate.name === name);
          if (!project) {
            reject(new Error(`Project not found: ${name}`));
            return;
          }
          const payload = JSON.parse(project.nodesJson) as unknown;
          const nodes = Array.isArray(payload)
            ? payload
            : (payload as { nodes?: unknown[] }).nodes ?? [];
          const storyboardNode = {
            id: 'output-storyboard',
            type: 'storyboardNode',
            position: { x: 720, y: 320 },
            width: 318,
            height: 320,
            data: {
              displayName: 'Finished storyboard',
              aspectRatio: '1:1',
              frameAspectRatio: '1:1',
              gridRows: 1,
              gridCols: 1,
              frames: [{
                id: 'storyboard-frame-1',
                imageUrl: source,
                previewImageUrl: source,
                aspectRatio: '1:1',
                note: 'single',
                order: 0,
              }],
              exportOptions: {
                showFrameIndex: false,
                showFrameNote: false,
                notePlacement: 'overlay',
                imageFit: 'cover',
                frameIndexPrefix: 'S',
                cellGap: 8,
                outerPadding: 0,
                fontSize: 4,
                backgroundColor: '#0f1115',
                textColor: '#f8fafc',
              },
            },
          };
          projects.put({
            ...project,
            nodeCount: nodes.length + 1,
            nodesJson: JSON.stringify(Array.isArray(payload)
              ? [...nodes, storyboardNode]
              : { ...(payload as Record<string, unknown>), nodes: [...nodes, storyboardNode] }),
          });
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { name: projectName, source: imageUrl });
}

async function openProjectWithImageAndVideo(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await createProject(page, name);
  await addImage(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
  await seedVideoResult(page, name);
  await page.reload();
  await page.getByRole('heading', { name, exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="output-video"] video')).toBeVisible();
}

async function openProjectWithStoryboard(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await createProject(page, name);
  await page.reload();
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
  await seedStoryboard(page, name);
  await page.reload();
  await page.getByRole('heading', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: '打包下载' })).toBeVisible();
}

async function selectImageAndVideo(page: Page): Promise<void> {
  const imageNode = page.locator('.react-flow__node').filter({ has: page.locator('img') }).first();
  const videoNode = page.locator('.react-flow__node[data-id="output-video"]');
  await imageNode.click();
  await page.keyboard.down('Shift');
  await videoNode.click();
  await page.keyboard.up('Shift');
  await expect(page.getByRole('button', { name: /下载所选内容|Download selected/ })).toBeVisible();
}

async function installDirectoryHandle(page: Page, failFileName: string | null = null): Promise<void> {
  await page.addInitScript((failureName) => {
    const existingNames = new Set<string>();
    const state: CapturedDirectoryOutput = {
      attempts: [],
      files: [],
      queryCount: 0,
      requestCount: 0,
    };
    const directory = {
      queryPermission: async () => {
        state.queryCount += 1;
        return 'prompt';
      },
      requestPermission: async () => {
        state.requestCount += 1;
        return 'granted';
      },
      getFileHandle: async (fileName: string, options?: { create?: boolean }) => {
        if (!options?.create) {
          if (existingNames.has(fileName)) {
            return {};
          }
          throw new DOMException('File not found', 'NotFoundError');
        }
        existingNames.add(fileName);
        return {
          createWritable: async () => ({
            write: async (blob: Blob) => {
              state.attempts.push(fileName);
              if (fileName === failureName) {
                throw new DOMException('Write denied', 'NotAllowedError');
              }
              const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
              state.files.push({
                fileName,
                sha256: Array.from(new Uint8Array(digest))
                  .map((value) => value.toString(16).padStart(2, '0'))
                  .join(''),
              });
            },
            close: async () => undefined,
            abort: async () => undefined,
          }),
        };
      },
    };
    Object.defineProperty(globalThis, 'showDirectoryPicker', {
      configurable: true,
      value: async () => directory,
    });
    (globalThis as typeof globalThis & { __fileOutputDirectoryState?: CapturedDirectoryOutput })
      .__fileOutputDirectoryState = state;
  }, failFileName);
}

async function readDirectoryOutput(page: Page): Promise<CapturedDirectoryOutput> {
  return await page.evaluate(() => (
    (globalThis as typeof globalThis & { __fileOutputDirectoryState: CapturedDirectoryOutput })
      .__fileOutputDirectoryState
  ));
}

test('writes image output with a recovered directory permission, stable collision name, and hash', async ({ page }) => {
  const projectName = `Output image ${Date.now()}`;
  const expectedHash = createHash('sha256').update(pngBytes).digest('hex');
  await installDirectoryHandle(page);
  await page.goto('/');
  await createProject(page, projectName);
  await addImage(page);

  await page.locator('.react-flow__node img').first().click();
  const saveToFolder = page.getByRole('button', { name: /保存到文件夹|Save to folder/ });
  await saveToFolder.click();
  await expect.poll(() => readDirectoryOutput(page)).toMatchObject({
    files: [{ fileName: 'photo.png', sha256: expectedHash }],
    queryCount: 1,
    requestCount: 1,
  });

  await saveToFolder.click();
  await expect.poll(() => readDirectoryOutput(page)).toMatchObject({
    files: [
      { fileName: 'photo.png', sha256: expectedHash },
      { fileName: 'photo (2).png', sha256: expectedHash },
    ],
    queryCount: 2,
    requestCount: 2,
  });

  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'showDirectoryPicker', { configurable: true, value: undefined });
  });
  const downloadPromise = page.waitForEvent('download');
  await saveToFolder.click();
  expect((await downloadPromise).suggestedFilename()).toBe('photo.png');
});

test('downloads a video and keeps mixed selected media in stable ZIP order', async ({ page }) => {
  const projectName = `Output media ${Date.now()}`;
  await openProjectWithImageAndVideo(page, projectName);

  const videoNode = page.locator('.react-flow__node[data-id="output-video"]');
  await videoNode.click();
  const videoDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^下载$|^Download$/ }).click();
  const videoDownload = await videoDownloadPromise;
  expect(videoDownload.suggestedFilename()).toBe('node-output-video.mp4');
  expect(await readFile((await videoDownload.path())!)).toEqual(videoBytes);

  await selectImageAndVideo(page);
  const zipDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /下载所选内容|Download selected/ }).click();
  const zipDownload = await zipDownloadPromise;
  expect(zipDownload.suggestedFilename()).toMatch(/^lumina-media-\d+\.zip$/);
  const entries = readStoredZipEntries(await readFile((await zipDownload.path())!));
  expect(entries.map((entry) => entry.path)).toEqual(['photo.png', 'node-output-video.mp4']);
  expect(entries.map((entry) => entry.bytes)).toEqual([pngBytes, videoBytes]);
});

test('keeps a single storyboard frame in its requested ZIP archive', async ({ page }) => {
  const projectName = `Storyboard output ${Date.now()}`;
  await openProjectWithStoryboard(page, projectName);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '打包下载' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${projectName}-storyboard.zip`);
  const entries = readStoredZipEntries(await readFile((await download.path())!));
  expect(entries.map((entry) => entry.path)).toEqual([`${projectName}_01_single.png`]);
  expect(entries[0]?.bytes).toEqual(pngBytes);
});

test('reports one failed selected-media write while keeping the other file', async ({ page }) => {
  const projectName = `Output partial ${Date.now()}`;
  await installDirectoryHandle(page, 'node-output-video.mp4');
  await openProjectWithImageAndVideo(page, projectName);
  await selectImageAndVideo(page);

  await page.getByRole('button', { name: /保存到文件夹|Save to folder/ }).click();
  await expect(page.getByText(/已保存 1\/2 个文件|Saved 1\/2 files/)).toBeVisible();
  await expect.poll(() => readDirectoryOutput(page)).toMatchObject({
    attempts: ['photo.png', 'node-output-video.mp4'],
    files: [{ fileName: 'photo.png' }],
  });
});

test('writes a selected project archive through the same directory flow', async ({ page }) => {
  const projectName = `Output project ${Date.now()}`;
  await installDirectoryHandle(page);
  await page.goto('/');
  await createProject(page, projectName);
  await page.getByRole('button', { name: /返回|Back/ }).click();
  const selection = page.getByRole('checkbox', { name: /选择导出项目|Select project for export/ });
  await selection.click();
  await page.getByRole('button', { name: /保存导出到文件夹|Save export to folder/ }).first().click();
  await expect.poll(() => readDirectoryOutput(page)).toMatchObject({
    files: [expect.objectContaining({ fileName: expect.stringMatching(/^lumina-export-\d+\.lumina$/) })],
    queryCount: 1,
    requestCount: 1,
  });
});
