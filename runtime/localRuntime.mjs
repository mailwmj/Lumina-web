/* global AbortSignal, URL, fetch */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createInstallationMetadata,
  defaultMetadataDirectory,
  isRuntimeCompatible,
  LOCAL_RUNTIME_PORTS,
  migrateInstallationMetadata,
  parseInstallationMetadata,
  readInstallationMetadata,
  resolveRuntimeIdentity,
  writeInstallationMetadata,
} from './installationMetadata.mjs';
import { withInstallationStartupLock } from './installationStartupLock.mjs';
import { closeLocalRuntimeHost, startLocalRuntimeHost } from './localRuntimeHost.mjs';

export { LOCAL_RUNTIME_PORTS };

const activeRuntimes = new Map();
const startingRuntimes = new Map();

export async function startLocalLuminaRuntime(options) {
  const settings = await resolveSettings(options);
  const activeRuntime = activeRuntimes.get(settings.metadataDirectory);
  if (activeRuntime) {
    return reusableRuntimeResult(activeRuntime.metadata, settings.runtimeIdentity, activeRuntime);
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
      return reusableRuntimeResult(activeRuntime.metadata, settings.runtimeIdentity, activeRuntime);
    }
    const registeredMetadata = await readInstallationMetadata(settings.metadataDirectory);
    if (registeredMetadata) {
      const knownRuntime = await readHealthyRuntime(registeredMetadata);
      if (knownRuntime) {
        return reusableRuntimeResult(knownRuntime, settings.runtimeIdentity);
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
    runtimeIdentity: await resolveRuntimeIdentity(options),
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
  const { startBridge, startGateway, startProjectService } = value;
  if (startBridge !== undefined && typeof startBridge !== 'function') {
    throw new Error('Lumina local runtime bridge service is invalid.');
  }
  if (startGateway !== undefined && typeof startGateway !== 'function') {
    throw new Error('Lumina local runtime Gateway service is invalid.');
  }
  if (startProjectService !== undefined && typeof startProjectService !== 'function') {
    throw new Error('Lumina local runtime project service is invalid.');
  }
  return { startBridge, startGateway, startProjectService };
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
      const metadata = createInstallationMetadata(port, settings.runtimeIdentity);
      const services = await startRuntimeServices(settings, host, metadata.origin);
      try {
        await writeInstallationMetadata(settings.metadataDirectory, metadata);
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
  const metadata = migrateInstallationMetadata(registeredMetadata, settings.runtimeIdentity);
  let services;
  try {
    services = await startRuntimeServices(settings, host, metadata.origin);
    await writeInstallationMetadata(settings.metadataDirectory, metadata);
  } catch (error) {
    await closeRuntimeServices(services);
    await closeLocalRuntimeHost(host.server);
    throw error;
  }
  host.publishMetadata(metadata);
  return createStartedRuntime(settings.metadataDirectory, host.server, metadata, services);
}

async function startRuntimeServices(settings, host, canonicalOrigin) {
  let projectService;
  let gateway;
  let bridge;
  try {
    if (settings.services.startProjectService) {
      projectService = await settings.services.startProjectService({ canonicalOrigin });
      if (!projectService || typeof projectService.close !== 'function') {
        throw new Error('Lumina local runtime project service is invalid.');
      }
      host.setProjectService(projectService, canonicalOrigin);
    }
    if (settings.services.startGateway) {
      gateway = await settings.services.startGateway({ canonicalOrigin });
      if (!gateway || typeof gateway.close !== 'function' || typeof gateway.origin !== 'string') {
        throw new Error('Lumina local runtime Gateway service is invalid.');
      }
      host.setGatewayOrigin(gateway.origin);
    }
    if (settings.services.startBridge) {
      bridge = await settings.services.startBridge({ canonicalOrigin, projectService });
      if (!bridge || typeof bridge.close !== 'function') {
        throw new Error('Lumina local runtime bridge service is invalid.');
      }
    }
    return { bridge, gateway, projectService };
  } catch (error) {
    await closeRuntimeServices({ bridge, gateway, projectService });
    throw error;
  }
}

async function closeRuntimeServices(services = {}) {
  try {
    await services.bridge?.close();
  } finally {
    try {
      await services.gateway?.close();
    } finally {
      await services.projectService?.close();
    }
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

async function readHealthyRuntime(metadata) {
  try {
    const response = await fetch(`${metadata.origin}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      return null;
    }
    const health = await response.json();
    const activeMetadata = parseInstallationMetadata(health);
    return health?.status === 'healthy'
      && activeMetadata.installationId === metadata.installationId
      && activeMetadata.origin === metadata.origin
      && activeMetadata.port === metadata.port
      ? activeMetadata
      : null;
  } catch {
    return null;
  }
}

function reusableRuntimeResult(metadata, runtimeIdentity, runtime) {
  if (!isRuntimeCompatible(metadata, runtimeIdentity)) {
    return {
      status: 'repair-required',
      reason: 'runtime-incompatible',
      metadata,
    };
  }
  return {
    status: 'reused',
    metadata,
    ...(runtime ? { runtime } : {}),
  };
}

const isAddressInUse = (error) => error?.code === 'EADDRINUSE';
