/* global URL */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { prepareInstaller } from '../installer/packageInstaller.mjs';
import { releaseRequirementsFor } from '../installer/packagingTarget.mjs';
import { readBuiltCanvasBridgeProtocol } from '../runtime/builtBridgeProtocol.mjs';
import { buildInstalledRuntime, createRuntimeBuildPlan } from './package-local-runtime.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function createInstallerPackagePlan(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Lumina installer packaging requires options.');
  }
  const { platform, arch, version, outputDirectory } = options;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Lumina installer packaging requires a version.');
  }
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) {
    throw new Error('Lumina installer packaging requires an output directory.');
  }
  const output = path.resolve(outputDirectory);
  const runtimeOutputDirectory = path.join(output, 'runtime');
  createRuntimeBuildPlan({ platform, arch, outputDirectory: runtimeOutputDirectory });
  return {
    arch,
    installerOutputDirectory: path.join(output, 'installer'),
    platform,
    releaseRequirements: releaseRequirementsFor(platform),
    runtimeOutputDirectory,
    version,
    pluginRoot: path.join(repositoryRoot, 'plugins', 'lumina-canvas'),
    webRoot: path.join(repositoryRoot, 'canvas-agent', 'web-dist'),
  };
}

export async function preparePlatformInstaller(options) {
  const plan = createInstallerPackagePlan(options);
  await assertBuiltRuntimeInputs(plan);
  const bridgeProtocol = await readBuiltBridgeProtocol();
  const runtime = await buildInstalledRuntime({
    platform: plan.platform,
    arch: plan.arch,
    outputDirectory: plan.runtimeOutputDirectory,
  });
  const prepared = await prepareInstaller({
    ...plan,
    bridgeProtocol,
    outputDirectory: plan.installerOutputDirectory,
    runtimeExecutable: runtime.executable,
  });
  return { ...plan, ...prepared, runtimeExecutable: runtime.executable };
}

export async function releasePlatformInstaller(options) {
  const prepared = await preparePlatformInstaller(options);
  return prepared.platform === 'win32'
    ? releaseWindowsInstaller(prepared, options)
    : releaseMacInstaller(prepared, options);
}

async function assertBuiltRuntimeInputs(plan) {
  await Promise.all([
    fs.access(path.join(plan.webRoot, 'index.html')),
    fs.access(path.join(repositoryRoot, 'canvas-agent', 'dist', 'web', 'http.js')),
    fs.access(path.join(repositoryRoot, 'canvas-agent', 'dist', 'web', 'mcp.js')),
    fs.access(path.join(repositoryRoot, 'canvas-agent', 'dist', 'web', 'protocol.js')),
  ]).catch(() => {
    throw new Error('Lumina installer packaging requires npm run build and npm run canvas-agent:build first.');
  });
}

async function readBuiltBridgeProtocol() {
  return readBuiltCanvasBridgeProtocol(
    'Lumina installer packaging requires a valid built canvas bridge protocol.',
  );
}

export async function releaseWindowsInstaller(prepared, dependencies = {}) {
  const unsigned = dependencies.unsigned === true;
  const certificate = dependencies.certificate?.trim() ?? process.env.LUMINA_WINDOWS_CERT_SHA1?.trim();
  if (!unsigned && !certificate) {
    throw new Error('Lumina Windows release packaging requires LUMINA_WINDOWS_CERT_SHA1.');
  }
  const timestamp = dependencies.timestamp?.trim() ?? process.env.LUMINA_WINDOWS_TIMESTAMP_URL?.trim() ?? 'http://timestamp.digicert.com';
  const runCommand = dependencies.runCommand ?? run;
  const runtimeExecutable = path.join(prepared.stageDirectory, 'app', 'LuminaRuntime.exe');
  if (!unsigned) await signWindowsFile(runtimeExecutable, certificate, timestamp, runCommand);
  await runCommand('ISCC.exe', [path.join(prepared.stageDirectory, 'Lumina.iss')]);
  const installer = path.join(prepared.stageDirectory, 'release', 'Lumina-Setup.exe');
  await fs.access(installer);
  if (!unsigned) await signWindowsFile(installer, certificate, timestamp, runCommand);
  return { ...prepared, installer, runtimeExecutable, signed: !unsigned, notarized: false };
}

async function signWindowsFile(filePath, certificate, timestamp, runCommand = run) {
  await runCommand('signtool.exe', [
    'sign',
    '/sha1', certificate,
    '/fd', 'SHA256',
    '/tr', timestamp,
    '/td', 'SHA256',
    filePath,
  ]);
}

async function releaseMacInstaller(prepared, options = {}) {
  const unsigned = options.unsigned === true;
  const applicationIdentity = process.env.LUMINA_MACOS_APP_SIGN_IDENTITY?.trim();
  const installerIdentity = process.env.LUMINA_MACOS_INSTALLER_SIGN_IDENTITY?.trim();
  const notaryProfile = process.env.LUMINA_MACOS_NOTARY_PROFILE?.trim();
  if (!unsigned && (!applicationIdentity || !installerIdentity || !notaryProfile)) {
    throw new Error('Lumina macOS release packaging requires LUMINA_MACOS_APP_SIGN_IDENTITY, LUMINA_MACOS_INSTALLER_SIGN_IDENTITY, and LUMINA_MACOS_NOTARY_PROFILE.');
  }
  const application = path.join(prepared.stageDirectory, 'payload', 'Applications', 'Lumina.app');
  const runtime = path.join(application, 'Contents', 'MacOS', 'LuminaRuntime');
  const packages = path.join(prepared.stageDirectory, 'packages');
  const installer = path.join(prepared.stageDirectory, 'release', 'Lumina-Installer.pkg');
  await fs.mkdir(packages, { recursive: true });
  await fs.mkdir(path.dirname(installer), { recursive: true });
  if (!unsigned) {
    await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', applicationIdentity, runtime]);
    await run('codesign', ['--force', '--timestamp', '--sign', applicationIdentity, application]);
  }
  await run('pkgbuild', [
    '--root', path.join(prepared.stageDirectory, 'payload'),
    '--identifier', 'com.lumina.runtime',
    '--version', prepared.version,
    '--scripts', path.join(prepared.stageDirectory, 'scripts'),
    path.join(packages, 'Lumina.pkg'),
  ]);
  const productbuildArguments = [
    '--distribution', path.join(prepared.stageDirectory, 'Distribution.xml'),
    '--package-path', packages,
  ];
  if (!unsigned) productbuildArguments.push('--sign', installerIdentity);
  productbuildArguments.push(installer);
  await run('productbuild', productbuildArguments);
  if (!unsigned) {
    await run('xcrun', ['notarytool', 'submit', installer, '--keychain-profile', notaryProfile, '--wait']);
    await run('xcrun', ['stapler', 'staple', installer]);
  }
  return { ...prepared, installer, signed: !unsigned, notarized: false };
}

async function run(command, arguments_) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error(`Lumina installer release requires ${command}.`)));
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Lumina installer command ${command} failed with exit code ${code}.`)));
  });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--plan', '--prepare', '--release', '--unsigned'].includes(argument)) {
      values.set(argument, true);
      continue;
    }
    if (!['--platform', '--arch', '--out'].includes(argument) || !argv[index + 1]) {
      throw new Error('Usage: package-installer --platform <win32|darwin> --arch <x64|arm64> [--out <directory>] (--plan|--prepare|--release) [--unsigned]');
    }
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  const modes = ['--plan', '--prepare', '--release'].filter((argument) => values.get(argument) === true);
  if (modes.length !== 1) {
    throw new Error('Lumina installer packaging requires exactly one of --plan, --prepare, or --release.');
  }
  return {
    arch: values.get('--arch') ?? process.arch,
    mode: modes[0],
    outputDirectory: values.get('--out') ?? path.join(repositoryRoot, 'release'),
    platform: values.get('--platform') ?? process.platform,
    unsigned: values.get('--unsigned') === true,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const packageMetadata = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const packageOptions = { ...options, version: packageMetadata.version };
  const plan = createInstallerPackagePlan(packageOptions);
  const result = options.mode === '--plan'
    ? { ...plan, simulated: true }
    : options.mode === '--prepare'
      ? await preparePlatformInstaller(packageOptions)
      : await releasePlatformInstaller(packageOptions);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
