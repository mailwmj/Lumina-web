/* global URL, clearTimeout, process, setTimeout */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLoopbackOrigin } from './loopbackOrigin.mjs';
import { isPackagedRuntime } from './packagedRuntime.mjs';
import { startProductionLuminaRuntime } from './productionRuntime.mjs';

const READY_TIMEOUT_MS = 12_000;
const READY_RETRY_MS = 50;

const launchMessages = Object.freeze({
  'invalid-protocol': 'This is not a valid Lumina link.',
  'registered-port-occupied': 'Lumina cannot open because its saved local address is in use. Repair Lumina to keep your existing projects.',
  'runtime-start-failed': 'Lumina could not start. Run the Lumina installer again and choose Repair.',
});

export async function runInstalledRuntimeCli(argv, dependencies = {}) {
  const arguments_ = Array.isArray(argv) ? argv : [];
  if (arguments_[0] === '--serve') {
    const readyFile = optionValue(arguments_.slice(1), '--ready-file');
    const metadataDirectory = optionValue(arguments_.slice(1), '--metadata-directory');
    if (hasMissingOptionValue(arguments_.slice(1), '--ready-file') || hasMissingOptionValue(arguments_.slice(1), '--metadata-directory')) {
      return reportFailure('runtime-start-failed', dependencies.showError);
    }
    return serveInstalledLumina({
      ...dependencies,
      ...(readyFile ? { readyFile } : {}),
      ...(metadataDirectory ? { metadataDirectory } : {}),
    });
  }

  if (arguments_.length > 1 || (arguments_.length === 1 && !isLuminaOpenUrl(arguments_[0]))) {
    return reportFailure('invalid-protocol', dependencies.showError);
  }
  const open = dependencies.open ?? openInstalledLumina;
  return open(dependencies);
}

export async function openInstalledLumina(options = {}) {
  const makeReadyFile = options.createReadyFile ?? createReadyFile;
  const discardReadyFile = options.removeReadyFile ?? removeReadyFile;
  const spawnRuntime = options.spawnRuntime ?? defaultSpawnRuntime;
  const waitForReady = options.waitForReady ?? waitForRuntimeReady;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const showError = options.showError ?? defaultShowError;
  const runtimeCommand = options.runtimeCommand ?? await defaultRuntimeCommand();
  let readyFile;
  try {
    readyFile = await makeReadyFile();
    const child = await spawnRuntime(runtimeCommand.command, [
      ...runtimeCommand.arguments,
      '--serve',
      '--ready-file',
      readyFile,
      ...(options.metadataDirectory ? ['--metadata-directory', options.metadataDirectory] : []),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child?.unref?.();

    const readiness = await waitForReady(readyFile, child);
    if (readiness.status !== 'ready') {
      return reportFailure(readiness.code, showError);
    }
    await openBrowser(readiness.origin);
    return {
      status: 'opened',
      origin: readiness.origin,
      runtimeStatus: readiness.runtimeStatus,
    };
  } catch (error) {
    return reportFailure(failureCode(error), showError);
  } finally {
    if (readyFile) {
      await discardReadyFile(readyFile);
    }
  }
}

export async function serveInstalledLumina(options = {}) {
  const startRuntime = options.startRuntime ?? startProductionLuminaRuntime;
  const writeReady = options.writeReady ?? writeRuntimeReady;
  const waitForShutdown = options.waitForShutdown ?? waitForRuntimeShutdown;
  const reportDiagnostic = options.reportDiagnostic ?? defaultStartupDiagnostic;
  try {
    const result = await startRuntime({
      ...(options.metadataDirectory ? { metadataDirectory: options.metadataDirectory } : {}),
    });
    if (result.status === 'repair-required') {
      const failure = failureCode({ code: result.reason });
      await writeReady(options.readyFile, failedReadiness(failure));
      return failureResult(failure);
    }
    const origin = parseLoopbackOrigin(
      result.metadata?.origin,
      'Lumina installed runtime returned an invalid local address.',
    );
    const ready = {
      status: 'ready',
      origin,
      runtimeStatus: result.status,
    };
    await writeReady(options.readyFile, ready);
    if (result.status === 'started') {
      await waitForShutdown();
      await result.runtime.close();
    }
    return { status: result.status, origin };
  } catch (error) {
    try {
      reportDiagnostic(error);
    } catch {
      // Diagnostics must not change the user-visible launch result.
    }
    const code = failureCode(error);
    await writeReady(options.readyFile, failedReadiness(code));
    return failureResult(code);
  }
}

function defaultStartupDiagnostic(error) {
  if (process.env.LUMINA_RUNTIME_DIAGNOSTICS !== '1') return;
  const detail = error instanceof Error ? (error.stack ?? error.message) : 'Unknown startup failure.';
  process.stderr.write(`Lumina startup diagnostic: ${detail}\n`);
}

export function isLuminaOpenUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'lumina:'
      && url.hostname === 'open'
      && (url.pathname === '' || url.pathname === '/')
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

async function createReadyFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-runtime-ready-'));
  return path.join(directory, 'ready.json');
}

async function removeReadyFile(filePath) {
  await fs.rm(filePath, { force: true });
  await fs.rmdir(path.dirname(filePath)).catch(() => {});
}

function defaultSpawnRuntime(command, arguments_, options) {
  return spawn(command, arguments_, options);
}

async function waitForRuntimeReady(filePath, child) {
  const childFailure = childStartFailure(child);
  const readiness = pollForReadiness(filePath);
  return childFailure ? Promise.race([readiness, childFailure]) : readiness;
}

async function pollForReadiness(filePath) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return parseReadiness(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
  }
  throw new Error('Lumina runtime did not become ready.');
}

function childStartFailure(child) {
  if (!child || typeof child.once !== 'function') return null;
  return new Promise((_, reject) => {
    child.once('error', () => reject(new Error('Lumina runtime could not start.')));
  });
}

function parseReadiness(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Lumina runtime readiness is invalid.');
  }
  if (value.status === 'ready') {
    if (value.runtimeStatus !== 'started' && value.runtimeStatus !== 'reused') {
      throw new Error('Lumina runtime readiness is invalid.');
    }
    return {
      status: 'ready',
      origin: parseLoopbackOrigin(value.origin, 'Lumina runtime readiness is invalid.'),
      runtimeStatus: value.runtimeStatus,
    };
  }
  if (value.status === 'failed') {
    return { status: 'failed', code: failureCode({ code: value.code }) };
  }
  throw new Error('Lumina runtime readiness is invalid.');
}

async function writeRuntimeReady(filePath, value) {
  if (!filePath) return;
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
  await fs.rename(temporary, filePath);
}

function waitForRuntimeShutdown() {
  return new Promise((resolve) => {
    const finish = () => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

async function defaultRuntimeCommand() {
  if (await isPackagedRuntime()) {
    return { command: process.execPath, arguments: [] };
  }
  return {
    command: process.execPath,
    arguments: [fileURLToPath(new URL('./installedRuntimeEntrypoint.mjs', import.meta.url))],
  };
}

function defaultOpenBrowser(origin) {
  const command = process.platform === 'win32'
    ? { command: 'rundll32.exe', arguments: ['url.dll,FileProtocolHandler', origin] }
    : process.platform === 'darwin'
      ? { command: 'open', arguments: [origin] }
      : { command: 'xdg-open', arguments: [origin] };
  const child = spawn(command.command, command.arguments, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function defaultShowError(message) {
  const safeMessage = message.replaceAll("'", "''");
  const command = process.platform === 'win32'
    ? {
      command: 'powershell.exe',
      arguments: [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${safeMessage}', 'Lumina') | Out-Null`,
      ],
    }
    : process.platform === 'darwin'
      ? { command: 'osascript', arguments: ['-e', `display alert "Lumina" message "${message.replaceAll('"', '\\"')}"`] }
      : null;
  if (!command) {
    process.stderr.write(`${message}\n`);
    return;
  }
  const child = spawn(command.command, command.arguments, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function optionValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function hasMissingOptionValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index !== -1 && (!arguments_[index + 1] || arguments_[index + 1].startsWith('--'));
}

function failedReadiness(code) {
  return { status: 'failed', code, message: launchMessages[code] };
}

function failureCode(error) {
  return error?.code === 'registered-port-occupied'
    ? 'registered-port-occupied'
    : 'runtime-start-failed';
}

function failureResult(code) {
  return { status: 'failed', code, message: launchMessages[code] };
}

async function reportFailure(code, showError = defaultShowError) {
  const failure = failureResult(code);
  await showError(failure.message);
  return failure;
}
