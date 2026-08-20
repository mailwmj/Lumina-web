import { expect, test } from '@playwright/test';

test('exports selected browser projects as a Lumina ZIP', async ({ page }) => {
  const projectName = `Export project ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(projectName);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await page.getByRole('button', { name: /返回|Back/ }).click();

  const selection = page.getByRole('checkbox', { name: /选择导出项目|Select project for export/ });
  await expect(selection).toHaveCount(1, { timeout: 2_000 });
  await selection.click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出已选项目|Export selected/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^lumina-export-\d+\.lumina$/);
});
