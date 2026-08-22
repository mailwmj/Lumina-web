/* global AbortSignal, URL, fetch, process */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withInstallationStartupLock } from './installationStartupLock.mjs';
import { closeLocalRuntimeHost, startLocalRuntimeHost } from './localRuntimeHost.mjs';
import { isPackagedRuntime } from './packagedRuntime.mjs';
export const LOCAL_RUNTIME_PORTS = Object.freeze(Array.from({ length: 100 }, (_value, index) => 48100 + index));

const METADATA_FILE_NAME = 'runtime-metadata.json';
const activeRuntimes = new Map();
const startingRuntimes = new Map();

export async function startLocalLuminaRuntime(options) {
  const settings = await resolveSettings(options);
  const activeRuntime = activeRuntimes.get(settings.metadataDirectory);
  if (activeRuntime) {
    return {
      status: 'reused',
      metadata: activeRuntime.metadata,
      runtime: activeRuntime,
    };
  }

  let startup = startingRuntimes.get(settings.metadataDirectory);
  if (!startup) {
    startup = startLockedRuntime(settings).finally(() => {
      startingRuntimes.delete(settings.metadataDirectory);
    });
    startingRuntimes.set(settings.metadataDirectory, startup);
  }
  return startup;
}

async function startLockedRuntime(settings) {
  return withInstallationStartupLock(settings.metadataDirectory, async () => {
    const activeRuntime = activeRuntimes.get(settings.metadataDirectory);
    if (activeRuntime) {
      return {
        status: 'reused',
        metadata: activeRuntime.metadata,
        runtime: activeRuntime,
      };
    }
    const registeredMetadata = await readMetadata(settings.metadataDirectory);
    if (registeredMetadata) {
      const knownRuntime = await readHealthyRuntime(registeredMetadata);
      if (knownRuntime) {
        return {
          status: 'reused',
          metadata: registeredMetadata,
        };
      }

      try {
        return await startRegisteredRuntime(settings, registeredMetadata);
      } catch (error) {
        if (isAddressInUse(error)) {
          return {
            status: 'repair-required',
            reason: 'registered-port-occupied',
            metadata: registeredMetadata,
          };
        }
        throw error;
      }
    }

    return startFirstRuntime(settings);
  });
}

async function resolveSettings(options) {
  if (!options?.webRoot) {
    throw new Error('Lumina local runtime requires a Web root.');
  }
  const webRoot = await fs.realpath(options.webRoot);
  await fs.access(path.join(webRoot, 'index.html'));

  const metadataDirectory = path.resolve(options.metadataDirectory ?? defaultMetadataDirectory());
  await fs.mkdir(metadataDirectory, { recursive: true });
  const candidates = options.portCandidates ?? LOCAL_RUNTIME_PORTS;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.some((port) => !LOCAL_RUNTIME_PORTS.includes(port))) {
    throw new Error('Lumina local runtime ports must use the product-controlled loopback range.');
  }

  return {
    metadataDirectory: await fs.realpath(metadataDirectory),
    runtimeVersion: await resolveRuntimeVersion(options.runtimeVersion),
    webRoot,
    candidates,
    services: resolveRuntimeServices(options.services),
  };
}

function resolveRuntimeServices(value) {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Lumina local runtime services are invalid.');
  }
  const { startBridge, startGateway } = value;
  if (startBridge !== undefined && typeof startBridge !== 'function') {
    throw new Error('Lumina local runtime bridge service is invalid.');
  }
  if (startGateway !== undefined && typeof startGateway !== 'function') {
    throw new Error('Lumina local runtime Gateway service is invalid.');
  }
  return { startBridge, startGateway };
}

async function resolveRuntimeVersion(runtimeVersion) {
  if (typeof runtimeVersion === 'string' && runtimeVersion.trim()) {
    return runtimeVersion;
  }
  if (await isPackagedRuntime()) {
    const installedMetadata = JSON.parse(await fs.readFile(
      path.join(path.dirname(process.execPath), 'runtime-version.json'),
      'utf8',
    ));
    if (typeof installedMetadata.version === 'string' && installedMetadata.version.trim()) {
      return installedMetadata.version;
    }
    throw new Error('Lumina installed runtime requires version metadata.');
  }
  const packageMetadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof packageMetadata.version !== 'string' || !packageMetadata.version.trim()) {
    throw new Error('Lumina local runtime requires a product version.');
  }
  return packageMetadata.version;
}

async function startFirstRuntime(settings) {
  for (const port of settings.candidates) {
    let host;
    try {
      host = await startLocalRuntimeHost(settings.webRoot, port);
    } catch (error) {
      if (isAddressInUse(error)) {
        continue;
      }
      throw error;
    }
    try {
      const metadata = createMetadata(port, settings.runtimeVersion);
      const services = await startRuntimeServices(settings, host, metadata.origin);
      try {
        await writeMetadata(settings.metadataDirectory, metadata);
      } catch (error) {
        await closeRuntimeServices(services);
        throw error;
      }
      host.publishMetadata(metadata);
      return createStartedRuntime(settings.metadataDirectory, host.server, metadata, services);
    } catch (error) {
      await closeLocalRuntimeHost(host.server);
      throw error;
    }
  }
  throw new Error('No product-controlled Lumina loopback port is available.');
}

async function startRegisteredRuntime(settings, registeredMetadata) {
  const host = await startLocalRuntimeHost(settings.webRoot, registeredMetadata.port);
  const metadata = {
    ...registeredMetadata,
    runtimeVersion: settings.runtimeVersion,
  };
  let services;
  try {
    services = await startRuntimeServices(settings, host, metadata.origin);
    await writeMetadata(settings.metadataDirectory, metadata);
  } catch (error) {
    await closeRuntimeServices(services);
    await closeLocalRuntimeHost(host.server);
    throw error;
  }
  host.publishMetadata(metadata);
  return createStartedRuntime(settings.metadataDirectory, host.server, metadata, services);
}

async function startRuntimeServices(settings, host, canonicalOrigin) {
  let gateway;
  let bridge;
  try {
    if (settings.services.startGateway) {
      gateway = await settings.services.startGateway({ canonicalOrigin });
      if (!gateway || typeof gateway.close !== 'function' || typeof gateway.origin !== 'string') {
        throw new Error('Lumina local runtime Gateway service is invalid.');
      }
      host.setGatewayOrigin(gateway.origin);
    }
    if (settings.services.startBridge) {
      bridge = await settings.services.startBridge({ canonicalOrigin });
      if (!bridge || typeof bridge.close !== 'function') {
        throw new Error('Lumina local runtime bridge service is invalid.');
      }
    }
    return { bridge, gateway };
  } catch (error) {
    await closeRuntimeServices({ bridge, gateway });
    throw error;
  }
}

async function closeRuntimeServices(services = {}) {
  try {
    await services.bridge?.close();
  } finally {
    await services.gateway?.close();
  }
}

function createStartedRuntime(metadataDirectory, server, metadata, services) {
  let closePromise;
  const runtime = {
    ...services,
    metadata,
    close: () => {
      closePromise ??= closeLocalRuntimeHost(server)
        .finally(() => closeRuntimeServices(services))
        .finally(() => {
          if (activeRuntimes.get(metadataDirectory) === runtime) {
            activeRuntimes.delete(metadataDirectory);
          }
        });
      return closePromise;
    },
  };
  activeRuntimes.set(metadataDirectory, runtime);
  return {
    status: 'started',
    metadata,
    runtime,
  };
}

function createMetadata(port, runtimeVersion) {
  return {
    installationId: randomUUID(),
    origin: `http://127.0.0.1:${port}`,
    port,
    runtimeVersion,
  };
}

async function readMetadata(metadataDirectory) {
  try {
    const value = JSON.parse(await fs.readFile(metadataPath(metadataDirectory), 'utf8'));
    return parseMetadata(value);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function parseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Lumina runtime metadata is invalid and requires repair.');
  }
  const { installationId, origin, port, runtimeVersion } = value;
  if (
    typeof installationId !== 'string'
    || typeof origin !== 'string'
    || !LOCAL_RUNTIME_PORTS.includes(port)
    || typeof runtimeVersion !== 'string'
    || origin !== `http://127.0.0.1:${port}`
  ) {
    throw new Error('Lumina runtime metadata is invalid and requires repair.');
  }
  return { installationId, origin, port, runtimeVersion };
}

async function writeMetadata(metadataDirectory, metadata) {
  const filePath = metadataPath(metadataDirectory);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(metadata), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

const metadataPath = (metadataDirectory) => path.join(metadataDirectory, METADATA_FILE_NAME);

async function readHealthyRuntime(metadata) {
  try {
    const response = await fetch(`${metadata.origin}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      return false;
    }
    const health = await response.json();
    return health?.status === 'healthy'
      && health.installationId === metadata.installationId
      && health.origin === metadata.origin
      && health.port === metadata.port;
  } catch {
    return false;
  }
}

const isAddressInUse = (error) => error?.code === 'EADDRINUSE';

function defaultMetadataDirectory() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Lumina', 'runtime');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Lumina', 'runtime');
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'lumina', 'runtime');
}
