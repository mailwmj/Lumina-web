import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('development Codex launcher assigns a loopback port before canvas_open exposes it', { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'start-codex-canvas.mjs')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
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
        clientInfo: { name: 'lumina-local-launcher-test', version: '1.0.0' },
      },
    });
    assert.equal((await responses.waitFor(1)).error, undefined, stderr);
    send(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send(child.stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'canvas_open', arguments: {} },
    });
    const opened = await responses.waitFor(2);
    const text = opened.result?.content?.[0]?.text;
    assert.ok(text, stderr);
    const payload = JSON.parse(text);
    const origin = new URL(payload.canonicalOrigin);
    assert.equal(origin.protocol, 'http:');
    assert.equal(origin.hostname, '127.0.0.1');
    assert.notEqual(origin.port, '');
    assert.notEqual(origin.port, '0');
    assert.notEqual(origin.port, '1420');
    assert.equal((await globalThis.fetch(`${origin.origin}/`)).status, 200);
    const bootstrap = JSON.parse(decodeURIComponent(
      new URL(payload.url).hash.slice('#lumina-canvas='.length),
    ));
    assert.equal(bootstrap.bridge, 'web');
    assert.equal(new URL(bootstrap.endpoint).hostname, '127.0.0.1');
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
});

function send(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function createResponseReader(stream) {
  let buffer = '';
  const responses = new Map();
  const waiters = new Map();
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line);
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
    waitFor(id) {
      const existing = responses.get(id);
      if (existing) {
        responses.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}
