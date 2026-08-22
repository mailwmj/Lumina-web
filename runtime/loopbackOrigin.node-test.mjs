import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLoopbackOrigin } from './loopbackOrigin.mjs';

const errorMessage = 'Lumina local runtime requires a loopback service origin.';

test('accepts only explicit loopback Origins for local runtime services', () => {
  assert.equal(
    parseLoopbackOrigin('http://127.0.0.1:48100', errorMessage),
    'http://127.0.0.1:48100',
  );

  for (const value of [
    'https://127.0.0.1:48100',
    'http://localhost:48100',
    'http://127.0.0.1',
    'http://user@127.0.0.1:48100',
    'http://127.0.0.1:48100/path',
    'http://127.0.0.1:48100?query=value',
    'http://127.0.0.1:48100#fragment',
  ]) {
    assert.throws(
      () => parseLoopbackOrigin(value, errorMessage),
      new Error(errorMessage),
    );
  }
});
