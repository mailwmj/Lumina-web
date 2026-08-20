import { expect, test, type Page } from '@playwright/test';

interface StoredProjectSnapshot {
  revision: string;
  nodeCount: number;
  historyJson: string;
}

async function readStoredProject(page: Page, projectName: string): Promise<StoredProjectSnapshot | null> {
  return page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumina-web');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<StoredProjectSnapshot | null>((resolve, reject) => {
      const transaction = database.transaction(['projects', 'history'], 'readonly');
      const projects = transaction.objectStore('projects').getAll();
      const histories = transaction.objectStore('history').getAll();
      transaction.oncomplete = () => {
        const project = (projects.result as Array<{
          id: string;
          name: string;
          revision?: string;
          nodeCount: number;
        }>).find((item) => item.name === name);
        const history = (histories.result as Array<{ projectId: string; historyJson: string }>)
          .find((item) => item.projectId === project?.id);
        database.close();
        resolve(project ? {
          revision: project.revision ?? 'r0',
          nodeCount: project.nodeCount,
          historyJson: history?.historyJson ?? '',
        } : null);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }, projectName);
}

async function addTextAnnotation(page: Page): Promise<void> {
  await page.locator('.react-flow__pane').dblclick({ position: { x: 420, y: 320 } });
  await page.getByRole('button', { name: /文本注释|Text Annotation/ }).click();
}

test('opens a project read-only in a second tab and transfers writer ownership explicitly', async ({ page }) => {
  const projectName = `Ownership project ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(projectName);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(projectName, { exact: false })).toBeVisible();

  const second = await page.context().newPage();
  await second.goto('/');
  await second.getByRole('heading', { name: projectName, exact: true }).click();
  await expect(second.getByText(/其他标签页中编辑|being edited in another tab/)).toBeVisible();

  await second.getByRole('button', { name: /接管编辑|Take over editing/ }).click();
  await expect(second.getByText(/其他标签页中编辑|being edited in another tab/)).toBeHidden();
  await expect(page.getByText(/其他标签页中编辑|being edited in another tab/)).toBeVisible();
  await second.close();
});

test('rejects read-only keyboard and paste mutations, then rejects a stale queued writer save', async ({ page }) => {
  const projectName = `Ownership race ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(projectName);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await addTextAnnotation(page);
  await expect.poll(async () => (await readStoredProject(page, projectName))?.nodeCount).toBe(1);

  const second = await page.context().newPage();
  await second.goto('/');
  await second.getByRole('heading', { name: projectName, exact: true }).click();
  await expect(second.getByText(/其他标签页中编辑|being edited in another tab/)).toBeVisible();

  await second.keyboard.press('Control+z');
  await second.evaluate(() => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'blocked.png', { type: 'image/png' });
    const clipboard = new DataTransfer();
    clipboard.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  });
  await expect(second.locator('.react-flow__node')).toHaveCount(1);
  expect((await readStoredProject(second, projectName))?.nodeCount).toBe(1);

  await addTextAnnotation(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await second.getByRole('button', { name: /接管编辑|Take over editing/ }).click();
  await expect(second.getByText(/其他标签页中编辑|being edited in another tab/)).toBeHidden();
  await expect(page.getByText(/其他标签页中编辑|being edited in another tab/)).toBeVisible();

  await page.waitForTimeout(500);
  const persisted = await readStoredProject(second, projectName);
  expect(persisted).toMatchObject({ revision: 'r1', nodeCount: 1 });
  expect(JSON.parse(persisted?.historyJson ?? '{}')).toMatchObject({
    past: expect.any(Array),
    future: expect.any(Array),
  });
  await second.close();
});
