import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDevelopmentReady,
  formatDevelopmentPreflight,
} from './development-preflight.mjs';
import { startDevelopmentRuntime } from './start-development-runtime.mjs';

function report(overrides = {}) {
  return {
    node: { actual: '22.0.0', minimumMajor: 20, ready: true },
    rootDependencies: { ready: true, missing: [] },
    canvasAgentDependencies: { ready: true, missing: [] },
    artifacts: { status: 'ready', missing: [] },
    runtime: { status: 'not-registered' },
    ...overrides,
  };
}

test('reports exact dependency recovery commands before startup', () => {
  assert.throws(
    () => assertDevelopmentReady(report({
      rootDependencies: { ready: false, missing: ['Vite'] },
      canvasAgentDependencies: { ready: false, missing: ['canvas-agent TypeScript'] },
    })),
    (error) => error.message.includes('Run: npm ci')
      && error.message.includes('Run: npm ci --prefix canvas-agent'),
  );
});

test('marks the Vite command as UI-only before it starts', () => {
  assert.match(
    formatDevelopmentPreflight(report(), { mode: 'ui-only' }),
    /Project API: unavailable.*npm run canvas:runtime/u,
  );
});

test('allows UI-only startup to report missing canvas-agent dependencies without blocking Vite', () => {
  const uiOnly = report({
    canvasAgentDependencies: { ready: false, missing: ['canvas-agent TypeScript'] },
  });
  assert.doesNotThrow(() => assertDevelopmentReady(uiOnly, { requireCanvasAgent: false }));
  assert.match(formatDevelopmentPreflight(uiOnly, { mode: 'ui-only' }), /canvas-agent dependencies: missing/u);
});

test('blocks Runtime startup when the registered process has an incompatible app shell', () => {
  assert.throws(
    () => assertDevelopmentReady(report({
      runtime: { status: 'incompatible', origin: 'http://127.0.0.1:48100' },
    }), { requireRuntime: true }),
    /registered Lumina Runtime is incompatible/u,
  );
});

test('reuses valid Runtime artifacts without running a build', async () => {
  const calls = [];
  await startDevelopmentRuntime({
    inspect: async () => report(),
    build: async () => calls.push('build'),
    start: async () => calls.push('start'),
  });
  assert.deepEqual(calls, ['start']);
});

test('builds missing Runtime artifacts once and validates them before startup', async () => {
  const calls = [];
  let inspections = 0;
  await startDevelopmentRuntime({
    inspect: async () => {
      inspections += 1;
      return report({ artifacts: { status: inspections === 1 ? 'missing' : 'ready', missing: [] } });
    },
    build: async () => calls.push('build'),
    start: async () => calls.push('start'),
  });
  assert.deepEqual(calls, ['build', 'start']);
  assert.equal(inspections, 2);
});
