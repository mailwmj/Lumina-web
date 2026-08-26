import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const TEST_MANAGED_ROOTS = new WeakMap();

export function createTestManagedLibraryRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('A test managed library root must be a non-empty string.');
  }
  const capability = Object.freeze({});
  TEST_MANAGED_ROOTS.set(capability, path.resolve(root));
  return capability;
}

export function selectManagedLibraryRoot(options = {}) {
  if (Object.hasOwn(options, 'root') || Object.hasOwn(options, 'dataRoot')) return null;
  if (options.testManagedRoot !== undefined) return TEST_MANAGED_ROOTS.get(options.testManagedRoot) ?? null;

  return resolveManagedLibraryRoot({
    platform: process.platform,
    environment: process.env,
    homeDirectory: os.homedir(),
  });
}

export function resolveManagedLibraryRoot({
  platform,
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    return typeof localAppData === 'string' && localAppData.trim() !== ''
      ? pathApi.join(localAppData, 'Lumina', 'library')
      : null;
  }
  if (platform === 'darwin') {
    return typeof homeDirectory === 'string' && homeDirectory.trim() !== ''
      ? pathApi.join(homeDirectory, 'Library', 'Application Support', 'Lumina', 'library')
      : null;
  }
  if (platform === 'linux') {
    const dataHome = environment.XDG_DATA_HOME;
    if (typeof dataHome === 'string' && dataHome.trim() !== '') {
      return pathApi.join(dataHome, 'Lumina', 'library');
    }
    return typeof homeDirectory === 'string' && homeDirectory.trim() !== ''
      ? pathApi.join(homeDirectory, '.local', 'share', 'Lumina', 'library')
      : null;
  }
  return null;
}
