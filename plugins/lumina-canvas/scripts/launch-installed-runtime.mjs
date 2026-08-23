import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url));

export async function resolveInstalledRuntime(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const configuredRuntimePath = options.runtimePath ?? environment.LUMINA_RUNTIME_PATH;
  const registeredRuntimePath = configuredRuntimePath
    ? null
    : await readRegisteredRuntimePath(
      platform,
      environment,
      homeDirectory,
      pathApi,
      options.readLocatorFile ?? fs.readFile,
      options.locatorPath,
    );
  const runtimePath = configuredRuntimePath
    ?? registeredRuntimePath
    ?? await defaultRuntimePath(
      platform,
      environment,
      homeDirectory,
      pathApi,
      options.access ?? fs.access,
    );
  const access = options.access ?? fs.access;
  const readFile = options.readFile ?? fs.readFile;
  const compatibilityLine = options.compatibilityLine ?? await pluginCompatibilityLine(readFile);

  try {
    await access(runtimePath);
    const metadata = JSON.parse(await readFile(pathApi.join(pathApi.dirname(runtimePath), 'runtime-version.json'), 'utf8'));
    if (runtimeCompatibilityLine(metadata?.version) !== compatibilityLine) {
      throw repairRequired('Lumina and the Lumina Canvas plugin are incompatible. Repair Lumina, then update the Lumina Canvas plugin.');
    }
    return runtimePath;
  } catch (error) {
    if (error instanceof InstalledRuntimeError) {
      throw error;
    }
    throw repairRequired('Lumina is not installed or is incomplete. Repair Lumina, then retry the Lumina Canvas plugin.');
  }
}

export async function launchInstalledCanvasMcp(options = {}) {
  const runtimePath = await resolveInstalledRuntime(options);
  const spawn = options.spawn ?? defaultSpawn;
  const child = spawn(runtimePath, ['--canvas-mcp'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(repairRequired('Lumina could not start. Repair Lumina, then retry the Lumina Canvas plugin.')));
    child.once('exit', (exitCode) => resolve({
      status: 'closed',
      exitCode: typeof exitCode === 'number' ? exitCode : 1,
    }));
  });
}

export class InstalledRuntimeError extends Error {}

async function readRegisteredRuntimePath(
  platform,
  environment,
  homeDirectory,
  pathApi,
  readLocatorFile,
  configuredLocatorPath,
) {
  const locatorPath = configuredLocatorPath
    ?? defaultRuntimeLocatorPath(platform, environment, homeDirectory, pathApi);
  try {
    const runtimePath = (await readLocatorFile(locatorPath, 'utf8')).trim();
    const expectedName = platform === 'win32' ? 'LuminaRuntime.exe' : 'LuminaRuntime';
    if (!pathApi.isAbsolute(runtimePath) || pathApi.basename(runtimePath) !== expectedName) {
      throw repairRequired('Lumina installation location is invalid. Repair Lumina, then retry the Lumina Canvas plugin.');
    }
    return runtimePath;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    if (error instanceof InstalledRuntimeError) {
      throw error;
    }
    throw repairRequired('Lumina installation location could not be read. Repair Lumina, then retry the Lumina Canvas plugin.');
  }
}

function defaultRuntimeLocatorPath(platform, environment, homeDirectory, pathApi) {
  if (platform === 'win32') {
    const appData = environment.APPDATA || pathApi.join(homeDirectory, 'AppData', 'Roaming');
    return pathApi.join(appData, 'Lumina', 'runtime', 'runtime-location.txt');
  }
  if (platform === 'darwin') {
    return '/Library/Application Support/Lumina/runtime/runtime-location.txt';
  }
  throw repairRequired('Lumina is available on Windows and macOS. Repair Lumina, then retry the Lumina Canvas plugin.');
}

async function defaultRuntimePath(platform, environment, homeDirectory, pathApi, access) {
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA || pathApi.join(homeDirectory, 'AppData', 'Local');
    const canonicalPath = pathApi.join(localAppData, 'Lumina', 'LuminaRuntime.exe');
    const legacyPath = pathApi.join(localAppData, 'Lumina-web', 'LuminaRuntime.exe');
    try {
      await access(canonicalPath);
      return canonicalPath;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return canonicalPath;
      }
    }
    try {
      await access(legacyPath);
      return legacyPath;
    } catch {
      return canonicalPath;
    }
  }
  if (platform === 'darwin') {
    return '/Applications/Lumina.app/Contents/MacOS/LuminaRuntime';
  }
  throw repairRequired('Lumina is available on Windows and macOS. Repair Lumina, then retry the Lumina Canvas plugin.');
}

async function pluginCompatibilityLine(readFile) {
  try {
    const manifest = JSON.parse(await readFile(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
    const line = runtimeCompatibilityLine(manifest?.version);
    if (!line) {
      throw new Error('invalid plugin version');
    }
    return line;
  } catch {
    throw repairRequired('The Lumina Canvas plugin is incomplete. Repair Lumina, then update the Lumina Canvas plugin.');
  }
}

function runtimeCompatibilityLine(version) {
  const match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/u);
  return match ? `${match[1]}.${match[2]}` : null;
}

function repairRequired(message) {
  return new InstalledRuntimeError(message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await launchInstalledCanvasMcp();
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Lumina could not start.'}\n`);
    process.exitCode = 1;
  }
}
