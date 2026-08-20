import { expect, test, type Page } from '@playwright/test';

interface StoredAsset {
  assetId: string;
  width: number | null;
  height: number | null;
  sourceMetadata: Record<string, unknown>;
  blobHash: string;
}

interface StoredToolProject {
  nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  assets: StoredAsset[];
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(name);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();
}

async function createTwoTonePng(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 8;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas is unavailable');
    context.fillStyle = '#d92d20';
    context.fillRect(0, 0, 6, 8);
    context.fillStyle = '#155eef';
    context.fillRect(6, 0, 6, 8);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG encoding failed')), 'image/png');
    });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

async function readToolProject(page: Page, name: string): Promise<StoredToolProject | null> {
  return await page.evaluate(async (projectName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<StoredToolProject | null>((resolve, reject) => {
      const transaction = database.transaction(['projects', 'assets'], 'readonly');
      const projects = transaction.objectStore('projects').getAll();
      const assets = transaction.objectStore('assets').getAll();
      transaction.oncomplete = async () => {
        try {
          const project = (projects.result as Array<{ name: string; nodesJson: string }>)
            .find((item) => item.name === projectName);
          if (!project) {
            database.close();
            resolve(null);
            return;
          }
          const parsedNodes = JSON.parse(project.nodesJson) as unknown;
          const nodes = (Array.isArray(parsedNodes)
            ? parsedNodes
            : parsedNodes && typeof parsedNodes === 'object' && Array.isArray(
              (parsedNodes as { nodes?: unknown }).nodes,
            )
              ? (parsedNodes as { nodes: unknown[] }).nodes
              : []) as Array<{
            id: string;
            type: string;
            data: Record<string, unknown>;
          }>;
          const storedAssets = assets.result as Array<{
            assetId: string;
            width: number | null;
            height: number | null;
            sourceMetadata?: Record<string, unknown>;
            blob: Blob;
          }>;
          const resultAssets = await Promise.all(storedAssets.map(async (asset) => {
            const hash = await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer());
            return {
              assetId: asset.assetId,
              width: asset.width,
              height: asset.height,
              sourceMetadata: asset.sourceMetadata ?? {},
              blobHash: Array.from(new Uint8Array(hash))
                .map((value) => value.toString(16).padStart(2, '0'))
                .join(''),
            };
          }));
          database.close();
          resolve({ nodes, assets: resultAssets });
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
  }, name);
}

async function openTool(page: Page, name: RegExp): Promise<void> {
  const button = page.getByRole('button', { name });
  await button.focus();
  await button.press('Enter');
  await expect(page.getByRole('button', { name: /应用|Apply/ })).toBeVisible();
}

test('persists browser crop, split, and storyboard export assets across undo and reload', async ({ page }) => {
  const projectName = `Browser tools ${Date.now()}`;
  await page.goto('/');
  await createProject(page, projectName);

  await page.locator('.react-flow__pane').dblclick({ position: { x: 420, y: 320 } });
  await page.getByRole('button', { name: /^上传$|^Upload$/ }).click();
  const uploadInput = page.locator('input[type="file"]').first();
  await expect(uploadInput).toHaveCount(1);
  await uploadInput.setInputFiles({
    name: 'two-tone.png',
    mimeType: 'image/png',
    buffer: await createTwoTonePng(page),
  });

  const sourceImage = page.locator('.react-flow__node img').first();
  await expect(sourceImage).toBeVisible();
  await sourceImage.click();
  await openTool(page, /^裁剪$|^Crop$/);
  await page.getByRole('button', { name: '1:1' }).click();
  const cropSelection = page.locator('.ReactCrop__crop-selection');
  await expect(cropSelection).toBeVisible();
  await expect.poll(async () => {
    const box = await cropSelection.boundingBox();
    return box ? Math.round((box.width / box.height) * 100) : null;
  }).toBe(100);
  await page.getByRole('button', { name: /应用|Apply/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /应用|Apply/ })).toBeHidden();

  let stored: StoredToolProject | null = null;
  await expect.poll(async () => {
    stored = await readToolProject(page, projectName);
    return stored?.nodes.length;
  }).toBe(2);
  const cropNode = stored?.nodes.find((node) => node.type === 'exportImageNode');
  const sourceNode = stored?.nodes.find((node) => node.type === 'uploadNode');
  expect(sourceNode?.data.assetId).toEqual(expect.any(String));
  expect(cropNode).toMatchObject({ data: { assetId: expect.any(String) } });
  const sourceAsset = stored?.assets.find((asset) => asset.assetId === sourceNode?.data.assetId);
  const cropAsset = stored?.assets.find((asset) => asset.assetId === cropNode?.data.assetId);
  expect(cropAsset).toMatchObject({ width: 7, height: 7 });
  expect(cropAsset?.blobHash).not.toBe(sourceAsset?.blobHash);

  const canvasPane = page.locator('.react-flow__pane');
  await canvasPane.click({ position: { x: 900, y: 500 } });
  await canvasPane.press('Control+z');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await canvasPane.press('Control+y');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);

  await sourceImage.click();
  await openTool(page, /^切割$|^Split$/);
  const rowInput = page.getByText('行数', { exact: true }).locator('..').locator('input');
  await rowInput.fill('2');
  await page.getByRole('button', { name: /应用|Apply/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);

  await expect.poll(async () => {
    stored = await readToolProject(page, projectName);
    return stored?.nodes.length;
  }).toBe(3);
  const storyboardNode = stored?.nodes.find((node) => node.type === 'storyboardNode');
  const frames = storyboardNode?.data.frames as Array<Record<string, unknown>>;
  expect(frames).toHaveLength(6);
  expect(frames.every((frame) => (
    typeof frame.assetId === 'string' && !frame.imageUrl
  ))).toBe(true);

  await page.getByRole('button', { name: '导出设置' }).click();
  await page.getByRole('checkbox', { name: '显示分镜序号' }).check();
  await page.getByRole('checkbox', { name: '显示分镜描述' }).check();
  await page.getByRole('button', { name: '填充满格子' }).click();
  await page.getByRole('option', { name: '完整显示' }).click();
  await page.getByRole('button', { name: '图上遮罩' }).click();
  await page.getByRole('option', { name: '图下文字' }).click();
  await page.getByText('间距', { exact: true }).locator('..').locator('input').fill('11');
  await page.getByText('字号(%)', { exact: true }).locator('..').locator('input').fill('6');
  await page.getByText(/边距|Outer padding/, { exact: true }).locator('..').locator('input').fill('16');
  await page.locator('input[type="color"]').nth(0).fill('#101010');
  await page.locator('input[type="color"]').nth(1).fill('#fefefe');
  await page.getByRole('button', { name: /合并分镜|Merge Storyboard/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect.poll(async () => {
    stored = await readToolProject(page, projectName);
    return stored?.nodes.length;
  }).toBe(4);
  const exportedNode = stored?.nodes.filter((node) => node.type === 'exportImageNode').at(-1);
  const exportedAsset = stored?.assets.find((asset) => asset.assetId === exportedNode?.data.assetId);
  const metadata = JSON.parse(String(exportedAsset?.sourceMetadata.storyboardMetadata ?? '{}'));
  expect(metadata).toMatchObject({
    gridRows: 2,
    gridCols: 3,
    frameNotes: ['', '', '', '', '', ''],
    exportOptions: expect.objectContaining({
      showFrameIndex: true,
      showFrameNote: true,
      notePlacement: 'bottom',
      imageFit: 'contain',
      cellGap: 11,
      outerPadding: 16,
      fontSize: 6,
      backgroundColor: '#101010',
      textColor: '#fefefe',
    }),
  });
  expect(exportedAsset?.blobHash).not.toBe(cropAsset?.blobHash);

  await page.reload();
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await page.locator('.react-flow__node').last().click();
  await openTool(page, /^切割$|^Split$/);
  await expect(page.getByText('行数', { exact: true }).locator('..').locator('input')).toHaveValue('2');
  await page.getByRole('button', { name: /应用|Apply/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect.poll(async () => {
    stored = await readToolProject(page, projectName);
    return stored?.nodes.length;
  }).toBe(5);
  const restoredStoryboard = stored?.nodes.filter((node) => node.type === 'storyboardNode').at(-1);
  expect(restoredStoryboard?.data.exportOptions).toMatchObject({
    showFrameIndex: true,
    showFrameNote: true,
    notePlacement: 'bottom',
    imageFit: 'contain',
    cellGap: 11,
    outerPadding: 16,
    fontSize: 6,
    backgroundColor: '#101010',
    textColor: '#fefefe',
  });
});
