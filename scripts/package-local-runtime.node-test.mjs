import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createRuntimeBuildPlan } from './package-local-runtime.mjs';

test('describes a Windows compiled runtime without requiring a user Node installation', () => {
  const plan = createRuntimeBuildPlan({
    platform: 'win32',
    arch: 'x64',
    outputDirectory: 'release/runtime',
  });

  assert.equal(plan.executable, path.resolve('release/runtime', 'win32-x64', 'LuminaRuntime.exe'));
  assert.equal(plan.seaConfig.main.endsWith('installedRuntime.bundle.cjs'), true);
  assert.equal(plan.requiresNativeBuildHost, true);
  assert.equal(plan.entrypoint.endsWith(path.join('runtime', 'installedRuntimeEntrypoint.mjs')), true);
});

test('rejects platforms and architectures that do not have a supported installer target', () => {
  assert.throws(
    () => createRuntimeBuildPlan({ platform: 'linux', arch: 'x64', outputDirectory: 'release/runtime' }),
    /Windows and macOS/,
  );
  assert.throws(
    () => createRuntimeBuildPlan({ platform: 'darwin', arch: 'ia32', outputDirectory: 'release/runtime' }),
    /x64 and arm64/,
  );
});
