import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEB_CANVAS_CAPABILITIES,
  WEB_CANVAS_PROTOCOL,
  negotiateWebCanvasProtocol,
} from './protocol.js';

test('fails closed when the Web protocol major or build is incompatible', () => {
  const majorMismatch = negotiateWebCanvasProtocol({
    protocol: { ...WEB_CANVAS_PROTOCOL, major: WEB_CANVAS_PROTOCOL.major + 1 },
    capabilities: WEB_CANVAS_CAPABILITIES,
  });
  assert.deepEqual(majorMismatch, {
    ok: false,
    reason: 'protocol_major_mismatch',
    capabilities: [],
  });

  const buildMismatch = negotiateWebCanvasProtocol({
    protocol: { ...WEB_CANVAS_PROTOCOL, build: 'unknown-build' },
    capabilities: WEB_CANVAS_CAPABILITIES,
  });
  assert.deepEqual(buildMismatch, {
    ok: false,
    reason: 'protocol_build_mismatch',
    capabilities: [],
  });
});

test('uses only the declared Web capability intersection for a minor mismatch', () => {
  const result = negotiateWebCanvasProtocol({
    protocol: { ...WEB_CANVAS_PROTOCOL, minor: WEB_CANVAS_PROTOCOL.minor + 1 },
    capabilities: ['canvas.read.state', 'unrecognized.capability'],
  });

  assert.deepEqual(result, {
    ok: true,
    capabilities: ['canvas.read.state'],
  });
});

test('rejects undeclared or empty Web capability negotiation', () => {
  const result = negotiateWebCanvasProtocol({
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: ['unrecognized.capability'],
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'no_supported_capabilities',
    capabilities: [],
  });
});
