import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = path.join(root, 'dist');
const target = path.join(root, 'canvas-agent', 'web-dist');

await fs.access(path.join(source, 'index.html'));
await fs.rm(target, { recursive: true, force: true });
await fs.cp(source, target, { recursive: true });
