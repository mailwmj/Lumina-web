import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CANONICAL_LUMINA_ORIGIN } from './http.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('web MCP discovers only read tools and returns a canonical fragment bootstrap URL', { timeout: 8_000 }, async () => {
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'dist', 'index.js'), 'web-mcp'], {
    cwd: PACKAGE_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const responses = createResponseReader(child.stdout);
  try {
    send(child.stdin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'lumina-readonly-test', version: '1.0.0' },
      },
    });
    assert.equal((await responses.waitFor(1)).error, undefined, stderr);
    send(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send(child.stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await responses.waitFor(2);
    assert.deepEqual(
      ((listed.result as { tools?: Array<{ name?: string }> }).tools ?? []).map((tool) => tool.name).sort(),
      ['canvas_get_capabilities', 'canvas_get_selection', 'canvas_get_state', 'canvas_open'],
    );

    send(child.stdin, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'canvas_open', arguments: {} },
    });
    const opened = await responses.waitFor(3);
    const text = ((opened.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text;
    assert.ok(text, stderr);
    const payload = JSON.parse(text) as { canonicalOrigin?: string; url?: string };
    assert.equal(payload.canonicalOrigin, CANONICAL_LUMINA_ORIGIN);
    assert.match(payload.url ?? '', new RegExp(`^${escapeRegExp(CANONICAL_LUMINA_ORIGIN)}\\/#lumina-canvas=`));
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
});

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

function send(stream: NodeJS.WritableStream, message: unknown): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function createResponseReader(stream: NodeJS.ReadableStream) {
  let buffer = '';
  const responses = new Map<number, JsonRpcResponse>();
  const waiters = new Map<number, (value: JsonRpcResponse) => void>();
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id === 'number') {
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message);
          } else {
            responses.set(message.id, message);
          }
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  return {
    waitFor(id: number): Promise<JsonRpcResponse> {
      const existing = responses.get(id);
      if (existing) {
        responses.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
