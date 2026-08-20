import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const entryFile = path.join(repositoryRoot, 'canvas-agent', 'src', 'index.ts');
const binariesDir = path.join(repositoryRoot, 'src-tauri', 'binaries');
const target = readTarget(process.argv.slice(2)) ?? resolveHostTarget();
const executableExtension = target.includes('windows') ? '.exe' : '';
const outputFile = path.join(
  binariesDir,
  `lumina-canvas-agent-${target}${executableExtension}`
);

fs.mkdirSync(binariesDir, { recursive: true });

if (target === 'universal-apple-darwin') {
  buildUniversalMacBinary(outputFile);
} else {
  buildTargetBinary(target, outputFile);
}

if (process.platform !== 'win32') {
  fs.chmodSync(outputFile, 0o755);
}

process.stdout.write(`${outputFile}\n`);

function readTarget(args) {
  const equalsArgument = args.find((value) => value.startsWith('--target='));
  if (equalsArgument) {
    return equalsArgument.slice('--target='.length).trim() || undefined;
  }
  const index = args.indexOf('--target');
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined;
}

function resolveHostTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'aarch64-apple-darwin';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'x86_64-pc-windows-msvc';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'x86_64-unknown-linux-gnu';
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'aarch64-unknown-linux-gnu';
  }
  throw new Error(`Unsupported Canvas Agent build host: ${process.platform}/${process.arch}`);
}

function buildUniversalMacBinary(destination) {
  if (process.platform !== 'darwin') {
    throw new Error('The macOS Universal Canvas Agent binary must be assembled on macOS.');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-canvas-agent-'));
  const arm64Binary = path.join(tempDir, 'lumina-canvas-agent-arm64');
  const x64Binary = path.join(tempDir, 'lumina-canvas-agent-x64');
  const arm64Sidecar = path.join(binariesDir, 'lumina-canvas-agent-aarch64-apple-darwin');
  const x64Sidecar = path.join(binariesDir, 'lumina-canvas-agent-x86_64-apple-darwin');
  try {
    buildTargetBinary('aarch64-apple-darwin', arm64Binary);
    buildTargetBinary('x86_64-apple-darwin', x64Binary);
    fs.rmSync(destination, { force: true });
    run('lipo', ['-create', arm64Binary, x64Binary, '-output', destination]);
    // Tauri resolves each target-specific path while assembling a Universal app.
    fs.copyFileSync(destination, arm64Sidecar);
    fs.copyFileSync(destination, x64Sidecar);
    fs.chmodSync(arm64Sidecar, 0o755);
    fs.chmodSync(x64Sidecar, 0o755);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildTargetBinary(targetTriple, destination) {
  const bunTarget = resolveBunTarget(targetTriple);
  const args = ['build', entryFile, '--compile', '--outfile', destination];
  if (targetTriple !== resolveHostTarget()) {
    args.push('--target', bunTarget);
  }
  fs.rmSync(destination, { force: true });
  run('bun', args);
}

function resolveBunTarget(targetTriple) {
  const targets = {
    'aarch64-apple-darwin': 'bun-darwin-arm64',
    'x86_64-apple-darwin': 'bun-darwin-x64',
    'x86_64-pc-windows-msvc': 'bun-windows-x64',
    'x86_64-unknown-linux-gnu': 'bun-linux-x64',
    'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  };
  const resolved = targets[targetTriple];
  if (!resolved) {
    throw new Error(`Unsupported Canvas Agent target: ${targetTriple}`);
  }
  return resolved;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}.`);
  }
}
