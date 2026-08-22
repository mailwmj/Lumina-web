import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createInstallerPackagePlan } from './package-installer.mjs';

test('describes a simulated macOS installer without pretending that it was built or signed', () => {
  const plan = createInstallerPackagePlan({
    platform: 'darwin',
    arch: 'arm64',
    version: '1.2.3',
    outputDirectory: 'release',
  });

  assert.equal(plan.runtimeOutputDirectory, path.resolve('release', 'runtime'));
  assert.equal(plan.installerOutputDirectory, path.resolve('release', 'installer'));
  assert.equal(plan.webRoot.endsWith(path.join('canvas-agent', 'web-dist')), true);
  assert.deepEqual(plan.releaseRequirements, ['codesign', 'pkgbuild', 'productbuild', 'xcrun notarytool']);
});

test('does not describe installer packages for unsupported targets', () => {
  assert.throws(
    () => createInstallerPackagePlan({ platform: 'linux', arch: 'x64', version: '1.2.3', outputDirectory: 'release' }),
    /Windows and macOS/,
  );
});
