#!/usr/bin/env node
import type http from 'node:http';

import { loadConfig } from './config.js';
import { startHttpServer } from './server/http.js';
import { startMcpServer } from './server/mcp.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'serve';
const configFile = readOption(args, '--config');
const config = loadConfig(true, configFile);

if (command === 'mcp') {
  await startMcpServer(config);
} else if (command === 'config') {
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
} else if (command === 'serve') {
  const server = startHttpServer(config);
  const parentPid = readPositiveIntegerOption(args, '--parent-pid');
  const close = createCloseHandler(server);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  if (parentPid) {
    const timer = setInterval(() => {
      if (!isProcessAlive(parentPid)) {
        clearInterval(timer);
        close();
      }
    }, 2_000);
    timer.unref();
  }
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

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

function readPositiveIntegerOption(values: string[], name: string): number | undefined {
  const rawValue = readOption(values, name);
  if (!rawValue) {
    return undefined;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function createCloseHandler(server: http.Server): () => void {
  let closing = false;
  return () => {
    if (closing) {
      return;
    }
    closing = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
