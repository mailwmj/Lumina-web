#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertDevelopmentReady,
  formatDevelopmentPreflight,
  inspectDevelopmentEnvironment,
  repositoryRoot,
} from './development-preflight.mjs';

export async function startDevelopmentRuntime(options = {}) {
  const inspect = options.inspect ?? inspectDevelopmentEnvironment;
  const build = options.build ?? (() => runCommand('npm', ['run', 'canvas:runtime:build']));
  const start = options.start ?? (() => import('../runtime/startProductionRuntime.mjs'));
  let report = await inspect();
  process.stdout.write(`${formatDevelopmentPreflight(report)}\n`);
  assertDevelopmentReady(report, { requireRuntime: true });

  if (report.artifacts.status !== 'ready') {
    process.stdout.write(`Runtime artifacts are ${report.artifacts.status}; building them once before startup.\n`);
    await build();
    report = await inspect();
    assertDevelopmentReady(report, { requireArtifacts: true, requireRuntime: true });
  }

  await start();
}

function runCommand(command, arguments_) {
  const resolvedCommand = process.platform === 'win32' ? `${command}.cmd` : command;
  return new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, arguments_, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`Lumina Runtime build failed (${signal ?? `exit ${exitCode ?? 'unknown'}`}).`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startDevelopmentRuntime();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Lumina Runtime development startup failed.'}\n`);
    process.exitCode = 1;
  }
}
