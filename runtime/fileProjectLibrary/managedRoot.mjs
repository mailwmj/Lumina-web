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

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    return typeof localAppData === 'string' && localAppData.trim() !== ''
      ? path.join(localAppData, 'Lumina', 'library')
      : null;
  }
  if (process.platform === 'darwin') {
    const home = os.homedir();
    return typeof home === 'string' && home.trim() !== ''
      ? path.join(home, 'Library', 'Application Support', 'Lumina', 'library')
      : null;
  }
  return null;
}
