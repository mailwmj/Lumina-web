import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');
const args = process.argv.slice(2);
const command = args[0];

if (command === 'dev' || command === 'build') {
  const targetArgs = readTargetArgs(args);
  run(process.execPath, [
    path.join(repositoryRoot, 'scripts', 'build-canvas-agent-sidecar.mjs'),
    ...targetArgs,
  ]);
  if (command === 'build') {
    run(process.execPath, [
      path.join(repositoryRoot, 'scripts', 'smoke-canvas-agent-sidecar.mjs'),
      ...targetArgs,
    ]);
  }
}

if (command === 'build' && !args.some((value) => value === '--config' || value.startsWith('--config='))) {
  args.push('--config', 'src-tauri/tauri.bundle.conf.json');
}

const result = spawnSync(process.execPath, [tauriCli, ...args], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;

function readTargetArgs(values) {
  const equalsArgument = values.find((value) => value.startsWith('--target='));
  if (equalsArgument) {
    return [equalsArgument];
  }
  const index = values.indexOf('--target');
  return index >= 0 && values[index + 1]
    ? ['--target', values[index + 1]]
    : [];
}

function run(program, programArgs) {
  const child = spawnSync(program, programArgs, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(`Canvas Agent sidecar build exited with status ${child.status ?? 'unknown'}.`);
  }
}
