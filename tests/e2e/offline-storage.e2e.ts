import { expect, test, type Page } from '@playwright/test';

test.setTimeout(60_000);
test.describe.configure({ mode: 'serial' });

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /新建项目|New Project/ }).click();
  await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(name);
  await page.getByRole('button', { name: /确认|Confirm/ }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();
}

async function importImage(page: Page, name: string): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: pngBytes,
  });
}

test('reopens the versioned app shell and an existing project while offline', async ({ page, context }) => {
  const projectName = `Offline shell ${Date.now()}`;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persisted: async () => false,
        persist: async () => false,
        estimate: async () => ({ usage: 0, quota: 20 * 1024 * 1024 }),
      },
    });
  });
  await page.goto('/');
  await createProject(page, projectName);

  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller && registration.active);
  })).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open('lumina-app-shell-0.2.32');
    const entry = document.querySelector('script[src]')?.getAttribute('src');
    return Boolean(entry && await cache.match(new URL(entry, window.location.href).toString()));
  })).toBe(true);
  const workerSource = await (await page.request.get('/service-worker.js')).text();
  expect(workerSource).not.toContain('indexedDB');
  expect(workerSource).not.toContain('cache.put');

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /项目管理|Projects/ })).toBeVisible({
    timeout: 40_000,
  });
  await expect(page.getByRole('alert')).toContainText(
    /本地存储未获持久化授权|Persistent browser storage was not granted/,
  );
  await page.getByRole('heading', { name: projectName, exact: true }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出 \.lumina|Export \.lumina/ }).click();
  expect((await backupDownload).suggestedFilename()).toMatch(/^lumina-export-\d+\.lumina$/);
});

test('keeps existing media readable, downloadable, and deletable after a capacity gate blocks a new import', async ({ page }) => {
  const projectName = `Capacity gate ${Date.now()}`;
  await page.addInitScript(() => {
    const storageState = { usage: 0, quota: 20 * 1024 * 1024 };
    Object.defineProperty(globalThis, '__luminaStorageState', {
      configurable: true,
      value: storageState,
      writable: false,
    });
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => storageState,
      },
    });
  });
  await page.goto('/');
  await createProject(page, projectName);
  await importImage(page, 'kept.png');

  const image = page.locator('.react-flow__node img').first();
  await expect(image).toBeVisible();
  await page.evaluate(() => {
    const storageState = (globalThis as unknown as {
      __luminaStorageState: { usage: number; quota: number };
    }).__luminaStorageState;
    storageState.usage = 99;
    storageState.quota = 100;
  });
  await importImage(page, 'blocked.png');

  await expect(page.getByRole('alert')).toContainText(/存储空间不足|Browser storage is low/);
  await expect(page.locator('.react-flow__node img')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: /错误|Error/ })).toBeVisible();
  await page.getByRole('button', { name: /关闭|Close/ }).last().click();

  await image.click();
  const downloadPromise = page.waitForEvent('download');
  const downloadButton = page.getByRole('button', { name: /^下载$|^Download$/ });
  await downloadButton.focus();
  await downloadButton.press('Enter');
  expect((await downloadPromise).suggestedFilename()).toBe('kept.png');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node img')).toHaveCount(0);
});

test('recovers after an IndexedDB quota failure once browser capacity is available again', async ({ page }) => {
  const projectName = `Quota recovery ${Date.now()}`;
  await page.addInitScript(() => {
    const storageState = { usage: 0, quota: 20 * 1024 * 1024 };
    Object.defineProperty(globalThis, '__luminaStorageState', {
      configurable: true,
      value: storageState,
      writable: false,
    });
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => storageState,
      },
    });
  });
  await page.goto('/');
  await createProject(page, projectName);

  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    let shouldFail = true;
    const restore = () => {
      IDBObjectStore.prototype.put = originalPut;
      delete (globalThis as typeof globalThis & { __restoreLuminaAssetPut?: () => void })
        .__restoreLuminaAssetPut;
    };
    IDBObjectStore.prototype.put = function put(value: unknown, key?: IDBValidKey) {
      if (shouldFail && this.name === 'assets') {
        shouldFail = false;
        throw new DOMException('full', 'QuotaExceededError');
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    };
    (globalThis as typeof globalThis & { __restoreLuminaAssetPut?: () => void })
      .__restoreLuminaAssetPut = restore;
  });

  await importImage(page, 'quota-failure.png');
  await expect(page.getByRole('alert')).toContainText(/存储空间不足|Browser storage is low/);
  await expect(page.getByRole('heading', { name: /错误|Error/ })).toBeVisible();
  await page.getByRole('button', { name: /关闭|Close/ }).last().click();
  await expect(page.locator('.react-flow__node img')).toHaveCount(0);

  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __restoreLuminaAssetPut?: () => void })
      .__restoreLuminaAssetPut?.();
    const storageState = (globalThis as unknown as {
      __luminaStorageState: { usage: number; quota: number };
    }).__luminaStorageState;
    storageState.usage = 0;
    storageState.quota = 20 * 1024 * 1024;
  });
  await importImage(page, 'recovered.png');
  await expect(page.locator('.react-flow__node img')).toHaveCount(1);
});
