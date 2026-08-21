#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { startWebMcpServer } from './web/mcp.js';
import { startWebCanvasRuntime } from './web/runtime.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'web-mcp';

if (command !== 'web-mcp') {
  throw new Error('Lumina Canvas Agent only supports the web-mcp command.');
}

await startWebMcpServer(await startWebRuntime(args));

function readOption(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = values[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function startWebRuntime(values: string[]) {
  const webRoot = readOption(values, '--web-root');
  if (readOption(values, '--canonical-origin')) {
    throw new Error('web-mcp always creates its own session-local canonical Origin.');
  }
  return startWebCanvasRuntime(webRoot ?? defaultCanvasWebRoot());
}

function defaultCanvasWebRoot(): string {
  return fileURLToPath(new URL('../web-dist', import.meta.url));
}
