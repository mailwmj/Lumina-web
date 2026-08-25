import { expect, test } from '@playwright/test';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('persists a Runtime-owned project and asset across a browser reload', async ({ page }) => {
  const projectName = `Runtime E2E ${Date.now()}`;
  let projectWriteResponses = 0;
  page.on('response', (response) => {
    if (response.url().endsWith('/api/runtime/project')
      && response.request().method() === 'PUT'
      && response.ok()) {
      projectWriteResponses += 1;
    }
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(projectName);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(projectName, { exact: false })).toBeVisible();

  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'runtime-e2e.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.react-flow__node img').count()).toBe(1);
  await expect.poll(() => projectWriteResponses).toBeGreaterThan(1);

  await page.reload();
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await expect.poll(() => page.locator('.react-flow__node img').count()).toBe(1);
  await expect(page.locator('.react-flow__node img').first()).toHaveAttribute('src', /^blob:/u);
});
