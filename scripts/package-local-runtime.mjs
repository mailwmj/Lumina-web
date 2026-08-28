/* global URL */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import postject from 'postject';

import { assertSupportedPackagingTarget } from '../installer/packagingTarget.mjs';
import { generateWindowsIcon } from '../installer/iconAssets.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const defaultIconSource = path.join(repositoryRoot, 'public', 'app-icon-selected-1024.png');

export function createRuntimeBuildPlan(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Lumina runtime packaging requires options.');
  }
  const { platform, arch, outputDirectory } = options;
  assertSupportedPackagingTarget(platform, arch, 'runtime packaging');
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) {
    throw new Error('Lumina runtime packaging requires an output directory.');
  }
  const targetDirectory = path.resolve(outputDirectory, `${platform}-${arch}`);
  const buildDirectory = path.join(targetDirectory, '.sea-build');
  return {
    arch,
    buildDirectory,
    bundle: path.join(buildDirectory, 'installedRuntime.bundle.cjs'),
    entrypoint: path.join(repositoryRoot, 'runtime', 'installedRuntimeEntrypoint.mjs'),
    executable: path.join(targetDirectory, platform === 'win32' ? 'LuminaRuntime.exe' : 'LuminaRuntime'),
    platform,
    requiresNativeBuildHost: true,
    seaBlob: path.join(buildDirectory, 'installedRuntime.blob'),
    seaConfig: {
      main: path.join(buildDirectory, 'installedRuntime.bundle.cjs'),
      output: path.join(buildDirectory, 'installedRuntime.blob'),
      disableExperimentalSEAWarning: true,
    },
    seaConfigPath: path.join(buildDirectory, 'sea-config.json'),
  };
}

export async function buildInstalledRuntime(options) {
  const plan = createRuntimeBuildPlan(options);
  if (process.platform !== plan.platform || process.arch !== plan.arch) {
    throw new Error(`Lumina ${plan.platform}-${plan.arch} runtime packaging requires a matching native build host.`);
  }
  await fs.rm(plan.buildDirectory, { recursive: true, force: true });
  await fs.mkdir(plan.buildDirectory, { recursive: true });
  await fs.mkdir(path.dirname(plan.executable), { recursive: true });
  try {
    await bundleInstalledRuntime(plan, { environment: options.environment ?? process.env });
    await fs.writeFile(plan.seaConfigPath, JSON.stringify(plan.seaConfig), 'utf8');
    await run(process.execPath, [`--experimental-sea-config=${plan.seaConfigPath}`]);
    await fs.copyFile(process.execPath, plan.executable);
    if (plan.platform === 'win32') {
      const iconSource = options.iconSource ?? defaultIconSource;
      const iconPath = path.join(plan.buildDirectory, 'Lumina.ico');
      await generateWindowsIcon(iconSource, iconPath);
      const { rcedit } = await import('rcedit');
      await rcedit(plan.executable, { icon: iconPath });
    }
    if (plan.platform === 'darwin') {
      await run('codesign', ['--remove-signature', plan.executable]);
    }
    await postject.inject(plan.executable, 'NODE_SEA_BLOB', await fs.readFile(plan.seaBlob), {
      ...(plan.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
      sentinelFuse: seaFuse,
    });
    if (plan.platform === 'darwin') {
      await run('codesign', ['--force', '--sign', '-', plan.executable]);
    }
  } finally {
    await fs.rm(plan.buildDirectory, { recursive: true, force: true });
  }
  return plan;
}

export async function bundleInstalledRuntime(plan, { environment = process.env } = {}) {
  await esbuild.build({
    bundle: true,
    entryPoints: [plan.entrypoint],
    format: 'cjs',
    legalComments: 'none',
    outfile: plan.bundle,
    platform: 'node',
    target: 'node20',
    define: {
      __LUMINA_EMBEDDED_TOS_ACCESS_KEY__: JSON.stringify(
        String(environment.LUMINA_EMBEDDED_TOS_ACCESS_KEY ?? '').trim(),
      ),
      __LUMINA_EMBEDDED_TOS_SECRET_KEY__: JSON.stringify(
        String(environment.LUMINA_EMBEDDED_TOS_SECRET_KEY ?? '').trim(),
      ),
    },
  });
}

async function run(command, arguments_) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Lumina runtime packaging command failed with exit code ${code}.`)));
  });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') {
      values.set(argument, true);
      continue;
    }
    if (!['--platform', '--arch', '--out'].includes(argument) || !argv[index + 1]) {
      throw new Error('Usage: package-local-runtime --platform <win32|darwin> --arch <x64|arm64> [--out <directory>] [--plan]');
    }
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  return {
    arch: values.get('--arch') ?? process.arch,
    outputDirectory: values.get('--out') ?? path.join(repositoryRoot, 'release', 'runtime'),
    platform: values.get('--platform') ?? process.platform,
    planOnly: values.get('--plan') === true,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const plan = options.planOnly
    ? createRuntimeBuildPlan(options)
    : await buildInstalledRuntime(options);
  process.stdout.write(`${JSON.stringify({
    arch: plan.arch,
    executable: plan.executable,
    platform: plan.platform,
    requiresNativeBuildHost: plan.requiresNativeBuildHost,
  })}\n`);
}
