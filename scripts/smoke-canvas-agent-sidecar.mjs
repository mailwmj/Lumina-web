import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliArgs = process.argv.slice(2);
const target = readTarget(cliArgs) ?? resolveHostTarget();
const extension = target.includes('windows') ? '.exe' : '';
const executable = readOption(cliArgs, '--executable')
  ? path.resolve(readOption(cliArgs, '--executable'))
  : path.join(
    repositoryRoot,
    'src-tauri',
    'binaries',
    `lumina-canvas-agent-${target}${extension}`
  );
const expectedTools = [
  'canvas_get_action_status',
  'canvas_get_capabilities',
  'canvas_get_change_status',
  'canvas_get_node_images',
  'canvas_get_selection',
  'canvas_get_state',
  'canvas_import_images',
  'canvas_propose_changes',
  'canvas_run_nodes',
  'canvas_wait_for_nodes',
];

if (!fs.statSync(executable).isFile()) {
  throw new Error(`Canvas Agent sidecar does not exist: ${executable}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-sidecar-smoke-'));
const configFile = path.join(tempDir, 'canvas-agent.json');
const child = spawn(executable, ['mcp', '--config', configFile], {
  cwd: repositoryRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
let buffer = '';
const responses = new Map();
const waiters = new Map();

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      } else {
        responses.set(message.id, message);
      }
    }
    newlineIndex = buffer.indexOf('\n');
  }
});

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'lumina-native-smoke', version: '1.0.0' },
    },
  });
  const initialized = await waitForResponse(1);
  if (initialized.error) {
    throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}\n${stderr}`);
  }

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await waitForResponse(2);
  if (listed.error) {
    throw new Error(`MCP tools/list failed: ${JSON.stringify(listed.error)}\n${stderr}`);
  }
  const actualTools = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected MCP tools: ${JSON.stringify(actualTools)}`);
  }
  process.stdout.write(`Canvas Agent native MCP smoke passed: ${executable}\n`);
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(id) {
  const existing = responses.get(id);
  if (existing) {
    responses.delete(id);
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`Timed out waiting for MCP response ${id}.\n${stderr}`));
    }, 5_000);
    waiters.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolve(message);
      },
    });
  });
}

function readTarget(args) {
  const equalsArgument = args.find((value) => value.startsWith('--target='));
  if (equalsArgument) {
    return equalsArgument.slice('--target='.length).trim() || undefined;
  }
  const index = args.indexOf('--target');
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined;
}

function readOption(args, name) {
  const equalsArgument = args.find((value) => value.startsWith(`${name}=`));
  if (equalsArgument) {
    return equalsArgument.slice(name.length + 1).trim() || undefined;
  }
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined;
}

function resolveHostTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'aarch64-apple-darwin';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'x86_64-pc-windows-msvc';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'x86_64-unknown-linux-gnu';
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'aarch64-unknown-linux-gnu';
  }
  throw new Error(`Unsupported Canvas Agent smoke target: ${process.platform}/${process.arch}`);
}
