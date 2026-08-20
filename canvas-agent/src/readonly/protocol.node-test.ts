import assert from 'node:assert/strict';
import test from 'node:test';

import {
  READONLY_CANVAS_CAPABILITIES,
  READONLY_CANVAS_PROTOCOL,
  negotiateReadonlyCanvasProtocol,
} from './protocol.js';

test('fails closed when the protocol major or build is incompatible', () => {
  const majorMismatch = negotiateReadonlyCanvasProtocol({
    protocol: { ...READONLY_CANVAS_PROTOCOL, major: READONLY_CANVAS_PROTOCOL.major + 1 },
    capabilities: READONLY_CANVAS_CAPABILITIES,
  });
  assert.deepEqual(majorMismatch, {
    ok: false,
    reason: 'protocol_major_mismatch',
    capabilities: [],
  });

  const buildMismatch = negotiateReadonlyCanvasProtocol({
    protocol: { ...READONLY_CANVAS_PROTOCOL, build: 'unknown-build' },
    capabilities: READONLY_CANVAS_CAPABILITIES,
  });
  assert.deepEqual(buildMismatch, {
    ok: false,
    reason: 'protocol_build_mismatch',
    capabilities: [],
  });
});

test('uses only the declared capability intersection for a minor mismatch', () => {
  const result = negotiateReadonlyCanvasProtocol({
    protocol: { ...READONLY_CANVAS_PROTOCOL, minor: READONLY_CANVAS_PROTOCOL.minor + 1 },
    capabilities: ['canvas.read.state', 'unrecognized.capability'],
  });

  assert.deepEqual(result, {
    ok: true,
    capabilities: ['canvas.read.state'],
  });
});

test('rejects undeclared or empty capability negotiation', () => {
  const result = negotiateReadonlyCanvasProtocol({
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: ['unrecognized.capability'],
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'no_supported_capabilities',
    capabilities: [],
  });
});
