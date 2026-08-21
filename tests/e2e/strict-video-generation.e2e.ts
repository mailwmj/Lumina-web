import { expect, test, type Page } from '@playwright/test';

const SETTINGS_SCHEMA_VERSION = 31;

interface StoredVideoState {
  edges: Array<{ source: string; target: string; targetHandle?: string | null }>;
  output: {
    data: {
      assetId?: string | null;
      videoUrl?: string | null;
      isGenerating?: boolean;
      generationJobId?: string | null;
      generationTaskHandle?: unknown;
    };
  } | null;
  asset: {
    kind: string;
    mimeType: string;
    byteCount: number;
    sourceMetadata: { providerId?: string; model?: string };
  } | null;
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(name);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();
}

async function seedStrictVideoProject(page: Page, projectName: string): Promise<void> {
  await page.evaluate(async ({ name, settingsVersion }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const imageBytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
      0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240,
      31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69,
      78, 68, 174, 66, 96, 130,
    ]);
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['projects', 'settings', 'assets'], 'readwrite');
        const projects = transaction.objectStore('projects');
        const settings = transaction.objectStore('settings');
        const assets = transaction.objectStore('assets');
        const request = projects.getAll();
        request.onsuccess = () => {
          const project = (request.result as Array<{
            id: string;
            name: string;
            nodesJson: string;
            edgesJson: string;
            nodeCount: number;
          }>).find((candidate) => candidate.name === name);
          if (!project) {
            reject(new Error(`Project not found: ${name}`));
            return;
          }
          const parsedNodes = JSON.parse(project.nodesJson) as unknown;
          const parsedEdges = JSON.parse(project.edgesJson) as unknown;
          const nodes = Array.isArray(parsedNodes)
            ? parsedNodes
            : (parsedNodes as { nodes?: unknown[] }).nodes ?? [];
          const edges = Array.isArray(parsedEdges) ? parsedEdges : [];
          const firstNode = {
            id: 'strict-first',
            type: 'uploadNode',
            position: { x: 80, y: 80 },
            data: {
              displayName: 'First frame', imageUrl: null, previewImageUrl: null,
              assetId: 'strict-first-asset', aspectRatio: '1:1', sourceFileName: 'first.png',
            },
          };
          const lastNode = {
            id: 'strict-last',
            type: 'uploadNode',
            position: { x: 80, y: 360 },
            data: {
              displayName: 'Last frame', imageUrl: null, previewImageUrl: null,
              assetId: 'strict-last-asset', aspectRatio: '1:1', sourceFileName: 'last.png',
            },
          };
          const videoNode = {
            id: 'strict-video',
            type: 'videoFrameNode',
            position: { x: 480, y: 180 },
            data: {
              displayName: 'Strict video', prompt: 'A lantern drifts across a lake',
              model: 'doubao-seedance-2-0-260128', videoApiId: 'e2e-video-api',
              aspectRatio: '16:9', resolution: '720p', duration: 5,
              hasAudio: true, watermark: false,
            },
          };
          projects.put({
            ...project,
            nodeCount: nodes.length + 3,
            nodesJson: JSON.stringify(Array.isArray(parsedNodes)
              ? [...nodes, firstNode, lastNode, videoNode]
              : { ...(parsedNodes as Record<string, unknown>), nodes: [...nodes, firstNode, lastNode, videoNode] }),
            // Deliberately order the tail edge first. Request roles must still be first then last.
            edgesJson: JSON.stringify([
              ...edges,
              { id: 'strict-last-edge', source: 'strict-last', target: 'strict-video', targetHandle: 'target-last', data: { valueType: 'image', inputOrder: 0 } },
              { id: 'strict-first-edge', source: 'strict-first', target: 'strict-video', targetHandle: 'target-first', data: { valueType: 'image', inputOrder: 1 } },
            ]),
          });
          settings.put({
            key: 'settings-storage',
            value: JSON.stringify({
              version: settingsVersion,
              state: {
                videoApis: [{
                  id: 'e2e-video-api', name: 'E2E Seedance', apiKey: 'e2e-video-key',
                  baseUrl: 'https://video.example.test/api/v3',
                  modelId: 'doubao-seedance-2-0-260128', enabled: true,
                  protocol: 'volcengine-seedance',
                }],
                activeVideoApiId: 'e2e-video-api',
              },
            }),
          });
          for (const [assetId, fileName] of [
            ['strict-first-asset', 'first.png'],
            ['strict-last-asset', 'last.png'],
          ]) {
            assets.put({
              assetId,
              projectId: project.id,
              kind: 'image',
              mimeType: 'image/png',
              byteCount: imageBytes.byteLength,
              createdAt: Date.now(),
              sourceKind: 'import',
              width: 1,
              height: 1,
              durationMs: null,
              sourceMetadata: { fileName },
              lifecycleState: 'active',
              blob: new Blob([imageBytes], { type: 'image/png' }),
            });
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { name: projectName, settingsVersion: SETTINGS_SCHEMA_VERSION });
}

async function readStoredVideoState(page: Page, projectName: string): Promise<StoredVideoState | null> {
  return await page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<StoredVideoState | null>((resolve, reject) => {
      const transaction = database.transaction(['projects', 'assets'], 'readonly');
      const projectRequest = transaction.objectStore('projects').getAll();
      const assetRequest = transaction.objectStore('assets').getAll();
      transaction.oncomplete = () => {
        const project = (projectRequest.result as Array<{
          id: string;
          name: string;
          nodesJson: string;
          edgesJson: string;
        }>).find((candidate) => candidate.name === name);
        if (!project) {
          database.close();
          resolve(null);
          return;
        }
        const parsedNodes = JSON.parse(project.nodesJson) as unknown;
        const nodes = (Array.isArray(parsedNodes)
          ? parsedNodes
          : (parsedNodes as { nodes?: unknown[] }).nodes ?? []) as Array<{
            type: string;
            data: StoredVideoState['output']['data'];
          }>;
        const output = nodes.find((node) => node.type === 'exportVideoNode') ?? null;
        const assetId = output?.data.assetId;
        const asset = typeof assetId === 'string'
          ? (assetRequest.result as Array<StoredVideoState['asset'] & { assetId: string; projectId: string }>)
            .find((candidate) => candidate?.assetId === assetId && candidate.projectId === project.id) ?? null
          : null;
        database.close();
        resolve({
          edges: JSON.parse(project.edgesJson) as StoredVideoState['edges'],
          output,
          asset,
        });
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }, projectName);
}

test('submits strict frame blobs by semantic handle and resumes its provider task after refresh', async ({ page }) => {
  const projectName = `Strict video ${Date.now()}`;
  let publishCount = 0;
  let releaseCount = 0;
  let submissionCount = 0;
  let pollCount = 0;
  let submittedContent: unknown[] = [];

  await page.route('**/api/generation/media**', async (route) => {
    if (route.request().method() === 'POST') {
      publishCount += 1;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          key: `strict-frame-${publishCount}`,
          url: `https://gateway.example.test/media/strict-frame-${publishCount}`,
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: 67,
        }),
      });
      return;
    }
    if (route.request().method() === 'DELETE') {
      releaseCount += 1;
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
  await page.route('https://video.example.test/api/v3/contents/generations/tasks**', async (route) => {
    if (route.request().method() === 'POST') {
      submissionCount += 1;
      submittedContent = (route.request().postDataJSON() as { content?: unknown[] }).content ?? [];
      await route.fulfill({ status: 200, json: { id: 'strict-task-42', status: 'queued' } });
      return;
    }
    pollCount += 1;
    await route.fulfill({
      status: 200,
      json: pollCount === 1
        ? { id: 'strict-task-42', status: 'queued' }
        : { id: 'strict-task-42', status: 'succeeded', output_url: 'https://cdn.example.test/strict.webm' },
    });
  });
  await page.route('https://cdn.example.test/strict.webm', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'video/webm',
      body: 'strict-video-bytes',
      headers: { 'access-control-allow-origin': '*' },
    });
  });

  await page.goto('/');
  await createProject(page, projectName);
  // Let the creation snapshot settle before seeding the refresh scenario.
  await page.reload();
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
  await expect.poll(async () => readStoredVideoState(page, projectName)).not.toBeNull();
  await seedStrictVideoProject(page, projectName);

  await page.reload();
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  const strictNode = page.locator('.react-flow__node[data-id="strict-video"]');
  await expect(strictNode.getByRole('button', { name: /生成视频|Generate Video/ })).toBeEnabled();
  await strictNode.getByRole('button', { name: /生成视频|Generate Video/ }).click();

  await expect.poll(async () => (await readStoredVideoState(page, projectName))?.output?.data.generationJobId)
    .toMatch(/^web-video-/);
  expect(submissionCount).toBe(1);
  expect(publishCount).toBe(2);
  expect(submittedContent).toEqual([
    { type: 'image_url', role: 'first_frame', image_url: { url: 'https://gateway.example.test/media/strict-frame-1' } },
    { type: 'image_url', role: 'last_frame', image_url: { url: 'https://gateway.example.test/media/strict-frame-2' } },
    { type: 'text', text: 'A lantern drifts across a lake' },
  ]);

  await page.reload();
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  await expect.poll(async () => {
    const state = await readStoredVideoState(page, projectName);
    return state?.output?.data.assetId && state.output.data.isGenerating === false ? state : null;
  }).not.toBeNull();
  const stored = await readStoredVideoState(page, projectName);
  expect(stored?.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'strict-first', target: 'strict-video', targetHandle: 'target-first' }),
    expect.objectContaining({ source: 'strict-last', target: 'strict-video', targetHandle: 'target-last' }),
  ]));
  expect(stored?.output?.data).toEqual(expect.objectContaining({
    assetId: expect.any(String),
    isGenerating: false,
    generationJobId: null,
    generationTaskHandle: null,
  }));
  expect(stored?.output?.data.videoUrl).toBeFalsy();
  expect(stored?.asset).toEqual(expect.objectContaining({
    kind: 'video',
    mimeType: 'video/webm',
    byteCount: 18,
    sourceMetadata: {
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
    },
  }));
  expect(submissionCount).toBe(1);
  expect(pollCount).toBeGreaterThanOrEqual(2);
  expect(releaseCount).toBe(2);

  await page.reload();
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  await expect.poll(async () => page.locator('.react-flow__node video').last().getAttribute('src')).toMatch(/^blob:/);
});
