import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SHELL_INPUTS = Object.freeze([
  'src',
  'public',
  'runtime',
  'gateway',
  'canvas-agent/src',
  'scripts/appShellRevision.mjs',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'canvas-agent/tsconfig.json',
  'package.json',
  'package-lock.json',
  'canvas-agent/package.json',
  'canvas-agent/package-lock.json',
]);

export async function computeAppShellRevision(root) {
  const files = [];
  for (const relativePath of SHELL_INPUTS) {
    await collectFiles(root, relativePath, files);
  }
  files.sort();

  const hash = crypto.createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(root, relativePath)));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex').slice(0, 16)}`;
}

async function collectFiles(root, relativePath, files) {
  const target = path.join(root, relativePath);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isFile()) {
    files.push(relativePath);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    await collectFiles(root, path.join(relativePath, entry.name), files);
  }
}
