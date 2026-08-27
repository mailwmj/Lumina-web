import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeAppShellRevision } from './appShellRevision.mjs';

test('changes the app-shell revision when a shell input changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-app-shell-revision-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'public'));
    await fs.mkdir(path.join(root, 'runtime'));
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(root, 'package.json'), '{"version":"0.2.46"}');
    await fs.writeFile(path.join(root, 'src', 'main.tsx'), 'export const version = 1;');
    await fs.writeFile(path.join(root, 'public', 'service-worker.js'), 'const version = 1;');
    await fs.writeFile(path.join(root, 'runtime', 'runtimeProjectRouter.mjs'), 'const apiVersion = 1;');

    const first = await computeAppShellRevision(root);
    const same = await computeAppShellRevision(root);
    assert.equal(first, same);

    await fs.writeFile(path.join(root, 'src', 'main.tsx'), 'export const version = 2;');
    const changed = await computeAppShellRevision(root);
    assert.notEqual(changed, first);

    await fs.writeFile(path.join(root, 'src', 'main.tsx'), 'export const version = 1;');
    await fs.writeFile(path.join(root, 'runtime', 'runtimeProjectRouter.mjs'), 'const apiVersion = 2;');
    const runtimeChanged = await computeAppShellRevision(root);
    assert.notEqual(runtimeChanged, first);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
