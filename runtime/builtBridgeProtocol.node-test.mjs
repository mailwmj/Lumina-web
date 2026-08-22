import assert from 'node:assert/strict';
import test from 'node:test';

import { WEB_CANVAS_PROTOCOL } from '../canvas-agent/dist/web/protocol.js';
import { readBuiltCanvasBridgeProtocol } from './builtBridgeProtocol.mjs';

test('reads the bridge protocol from the built canvas artifact', async () => {
  assert.deepEqual(
    await readBuiltCanvasBridgeProtocol(),
    WEB_CANVAS_PROTOCOL,
  );
});
