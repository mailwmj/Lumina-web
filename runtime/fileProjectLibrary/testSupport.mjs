import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function createSecureTemporaryDirectory(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('A temporary directory prefix must be a non-empty string.');
  }

  const canonicalTempRoot = await fs.realpath(os.tmpdir());
  const temporaryDirectory = await fs.mkdtemp(path.join(canonicalTempRoot, prefix));
  const canonicalDirectory = await fs.realpath(temporaryDirectory);
  if (canonicalDirectory !== path.resolve(temporaryDirectory)) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw new Error('The temporary directory did not resolve to its created path.');
  }
  return canonicalDirectory;
}
