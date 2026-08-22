import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInstallerPackagePlan, releaseWindowsInstaller } from './package-installer.mjs';

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

test('signs the Windows runtime copied into the installer payload before compiling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-windows-release-'));
  const stageDirectory = path.join(root, 'installer');
  const stagedRuntime = path.join(stageDirectory, 'app', 'LuminaRuntime.exe');
  const rawRuntime = path.join(root, 'runtime', 'LuminaRuntime.exe');
  const installer = path.join(stageDirectory, 'release', 'Lumina-Setup.exe');
  const calls = [];
  try {
    await fs.mkdir(path.dirname(stagedRuntime), { recursive: true });
    await fs.writeFile(stagedRuntime, 'staged runtime');
    await fs.mkdir(path.dirname(rawRuntime), { recursive: true });
    await fs.writeFile(rawRuntime, 'raw runtime');

    const result = await releaseWindowsInstaller({
      stageDirectory,
      runtimeExecutable: rawRuntime,
    }, {
      certificate: 'certificate-sha1',
      timestamp: 'https://timestamp.example.test',
      runCommand: async (command, arguments_) => {
        calls.push({ command, arguments_ });
        if (command === 'ISCC.exe') {
          await fs.mkdir(path.dirname(installer), { recursive: true });
          await fs.writeFile(installer, 'installer');
        }
      },
    });

    assert.deepEqual(calls, [
      {
        command: 'signtool.exe',
        arguments_: ['sign', '/sha1', 'certificate-sha1', '/fd', 'SHA256', '/tr', 'https://timestamp.example.test', '/td', 'SHA256', stagedRuntime],
      },
      { command: 'ISCC.exe', arguments_: [path.join(stageDirectory, 'Lumina.iss')] },
      {
        command: 'signtool.exe',
        arguments_: ['sign', '/sha1', 'certificate-sha1', '/fd', 'SHA256', '/tr', 'https://timestamp.example.test', '/td', 'SHA256', installer],
      },
    ]);
    assert.equal(result.runtimeExecutable, stagedRuntime);
    assert.equal(result.signed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
