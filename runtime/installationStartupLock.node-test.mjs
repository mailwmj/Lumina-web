/* global clearTimeout, setTimeout */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withInstallationStartupLock } from './installationStartupLock.mjs';

test('waits for an existing lock until its owner releases it', async () => {
  const metadataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-runtime-lock-'));
  const lockPath = path.join(metadataDirectory, 'runtime-start.lock');
  await fs.writeFile(lockPath, '', 'utf8');
  let ownerReleased = false;
  const ownerReleases = setTimeout(() => {
    ownerReleased = true;
    void fs.rm(lockPath, { force: true });
  }, 1_150);

  try {
    await withInstallationStartupLock(metadataDirectory, () => {
      assert.equal(ownerReleased, true);
    });
  } finally {
    clearTimeout(ownerReleases);
    await fs.rm(metadataDirectory, { recursive: true, force: true });
  }
});

test('requires repair instead of replacing a lock with an unavailable owner', { timeout: 6_000 }, async () => {
  const metadataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-runtime-lock-'));
  await fs.writeFile(path.join(metadataDirectory, 'runtime-start.lock'), '999999999', 'utf8');
  try {
    await assert.rejects(
      withInstallationStartupLock(metadataDirectory, () => {
        throw new Error('The stale lock must not be replaced.');
      }),
      /requires repair/,
    );
  } finally {
    await fs.rm(metadataDirectory, { recursive: true, force: true });
  }
});
