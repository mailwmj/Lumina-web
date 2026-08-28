/* global setTimeout */
import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { createNativeJsonSession } from '../nativeProcess.mjs';

const DELAYED_HELPER = String.raw`
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  while (true) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const request = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ ok: true, result: request.value }) + '\n');
    }, request.delayMs);
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
`;

test('ignores a retired native helper exit while its replacement has a pending request', async () => {
  const session = createNativeJsonSession(process.execPath, ['-e', DELAYED_HELPER], {
    idleTimeoutMs: 5,
  });

  assert.equal(await session.request({ value: 'first', delayMs: 0 }), 'first');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await session.request({ value: 'second', delayMs: 100 }), 'second');
});
