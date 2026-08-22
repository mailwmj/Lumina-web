/* global setTimeout */

import fs from 'node:fs/promises';
import path from 'node:path';

const LOCK_FILE_NAME = 'runtime-start.lock';
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

export async function withInstallationStartupLock(metadataDirectory, run) {
  const lock = await acquireLock(metadataDirectory);
  try {
    return await run();
  } finally {
    await lock.handle.close();
    await fs.rm(lock.path, { force: true });
  }
}

async function acquireLock(metadataDirectory) {
  const lockPath = path.join(metadataDirectory, LOCK_FILE_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      return { handle, path: lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error('Lumina local runtime startup is already in progress and requires repair.');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}
