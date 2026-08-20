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

async function readStoredProject(
  page: Page,
  targetName: string
): Promise<StoredProjectRecord | null> {
  return page.evaluate(async (projectName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web', 1);
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
