import { expect, test } from '@playwright/test';

test('keeps Firefox usable while exposing browser downloads and safe diagnostics', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 Firefox/128.0',
    });
  });
  await page.goto('/');

  const compatibilityNotice = page.getByRole('alert').filter({ hasText: /Firefox/ });
  await expect(compatibilityNotice).toContainText(/Firefox/);
  await expect(compatibilityNotice).toContainText(/兼容|compatibility/i);
  await compatibilityNotice.getByRole('button', { name: /关闭|Close/ }).click();
  await expect(compatibilityNotice).toHaveCount(0);

  await page.getByRole('button', { name: /设置|Settings/ }).click();
  await expect(page.getByText(/浏览器下载|Browser downloads/)).toBeVisible();
  await expect(page.getByRole('button', { name: /选择文件夹|Choose Folder/ })).toHaveCount(0);

  const diagnosticDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /下载诊断信息|Download diagnostics/ }).click();
  expect((await diagnosticDownload).suggestedFilename()).toBe('lumina-browser-diagnostics.json');
});
