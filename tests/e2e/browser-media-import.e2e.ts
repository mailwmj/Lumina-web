import { expect, test, type Page } from '@playwright/test';

const webmBytes = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIWEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggIA7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiEBeAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYioUXAHbgRGOJyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDgkLCBELqBEJqBAlWwhFW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMXNz2mPAi2PFiKhRcAduBEY4Z8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDEgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMTIwMDAwMDAwAB9DtnXQ54EAo6GBAACAgkmDQgAA8AD2ADgkHBhCAAAwYAAAEL///YsqAACjk4EAKACGAECSnABJQAADIAAAQkCjk4EAUACGAECSnABKwAADIAAAQkAcU7trkbuPs4EAt4r3gQHxggGr8IED',
  'base64',
);

function wavBytes(): Buffer {
  const sampleRate = 8_000;
  const sampleCount = 80;
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(sampleCount * 2, 40);
  return bytes;
}

interface StoredMediaState {
  nodes: Array<{ type: string; data: Record<string, unknown> }>;
  assets: Array<{
    assetId: string;
    kind: string;
    mimeType: string;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    sourceMetadata: { fileName?: string; sourceMimeType?: string };
  }>;
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(name);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();
}

async function readStoredMedia(page: Page, projectName: string): Promise<StoredMediaState | null> {
  return await page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<StoredMediaState | null>((resolve, reject) => {
      const transaction = database.transaction(['projects', 'assets'], 'readonly');
      const projectRequest = transaction.objectStore('projects').getAll();
      const assetRequest = transaction.objectStore('assets').getAll();
      transaction.oncomplete = () => {
        const project = (projectRequest.result as Array<{ name: string; id: string; nodesJson: string }>)
          .find((candidate) => candidate.name === name);
        if (!project) {
          database.close();
          resolve(null);
          return;
        }
        const payload = JSON.parse(project.nodesJson) as { nodes?: unknown[] } | unknown[];
        const nodes = Array.isArray(payload) ? payload : payload.nodes ?? [];
        const assetIds = new Set(nodes.map((node) => (
          node && typeof node === 'object'
            ? (node as { data?: { assetId?: unknown } }).data?.assetId
            : null
        )).filter((assetId): assetId is string => typeof assetId === 'string'));
        const assets = (assetRequest.result as StoredMediaState['assets'] & Array<{ projectId: string }>)
          .filter((asset) => asset.projectId === project.id && assetIds.has(asset.assetId));
        database.close();
        resolve({
          nodes: nodes as StoredMediaState['nodes'],
          assets,
        });
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }, projectName);
}

test('imports, reloads, and drag-drops asset-backed browser audio and video', async ({ page }) => {
  const projectName = `Browser media ${Date.now()}`;
  const audio = wavBytes();
  await page.goto('/');
  await createProject(page, projectName);

  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'voice.wav', mimeType: 'audio/wav', buffer: audio },
    { name: 'clip.webm', mimeType: 'video/webm', buffer: webmBytes },
  ]);

  await expect.poll(async () => (await readStoredMedia(page, projectName))?.assets.length).toBe(2);
  const firstState = await readStoredMedia(page, projectName);
  expect(firstState?.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'audioUploadNode',
      data: expect.objectContaining({
        assetId: expect.any(String), sourceFileName: 'voice.wav',
        sourceMimeType: 'audio/wav', mimeType: 'audio/wav', durationMs: expect.any(Number),
      }),
    }),
    expect.objectContaining({
      type: 'videoUploadNode',
      data: expect.objectContaining({
        assetId: expect.any(String), sourceFileName: 'clip.webm',
        sourceMimeType: 'video/webm', mimeType: 'video/webm', durationMs: expect.any(Number),
        mediaWidth: 16, mediaHeight: 16,
      }),
    }),
  ]));
  expect(firstState?.nodes.find((node) => node.type === 'audioUploadNode')?.data)
    .not.toHaveProperty('audioUrl');
  expect(firstState?.nodes.find((node) => node.type === 'videoUploadNode')?.data)
    .not.toHaveProperty('videoUrl');
  expect(firstState?.assets).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'audio', mimeType: 'audio/wav', sourceMetadata: expect.objectContaining({ fileName: 'voice.wav' }) }),
    expect.objectContaining({ kind: 'video', mimeType: 'video/webm', width: 16, height: 16, sourceMetadata: expect.objectContaining({ fileName: 'clip.webm' }) }),
  ]));
  expect(JSON.stringify(firstState)).not.toContain('/api/generation/media/');

  await page.reload();
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  await expect.poll(async () => page.locator('.react-flow__node').count()).toBe(2);
  await expect.poll(async () => page.locator('.react-flow__node audio').first().getAttribute('src')).toMatch(/^blob:/);
  await expect.poll(async () => page.locator('.react-flow__node video').first().getAttribute('src')).toMatch(/^blob:/);
  const reloaded = await readStoredMedia(page, projectName);
  expect(reloaded?.assets.map((asset) => asset.assetId).sort())
    .toEqual(firstState?.assets.map((asset) => asset.assetId).sort());

  await page.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'dropped.wav', { type: 'audio/wav' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    document.querySelector('.react-flow__pane')?.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: 400,
      clientY: 240,
    }));
  }, [...audio]);
  await expect.poll(async () => (await readStoredMedia(page, projectName))?.assets.length).toBe(3);
  const dropped = await readStoredMedia(page, projectName);
  expect(dropped?.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'audioUploadNode',
      data: expect.objectContaining({ assetId: expect.any(String), sourceFileName: 'dropped.wav' }),
    }),
  ]));
});
