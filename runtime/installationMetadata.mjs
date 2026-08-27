/* global process */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  areBridgeProtocolsCompatible,
  parseBridgeProtocol,
} from './bridgeProtocol.mjs';
import { isPackagedRuntime } from './packagedRuntime.mjs';

export const LOCAL_RUNTIME_PORTS = Object.freeze(Array.from({ length: 100 }, (_value, index) => 48100 + index));

const METADATA_FILE_NAME = 'runtime-metadata.json';
const METADATA_SCHEMA_VERSION = 2;
const PROTOCOL_ENTRY = 'lumina://open';

export async function resolveRuntimeIdentity({ runtimeVersion, bridgeProtocol, appShellRevision }) {
  if (typeof runtimeVersion === 'string' && runtimeVersion.trim()) {
    return createRuntimeIdentity(
      runtimeVersion,
      bridgeProtocol,
      'Lumina local runtime bridge protocol metadata is invalid.',
      appShellRevision,
    );
  }
  if (await isPackagedRuntime()) {
    const installedIdentity = await readInstalledRuntimeIdentity();
    return withAppShellRevision(installedIdentity, appShellRevision);
  }
  const packageMetadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return createRuntimeIdentity(
    packageMetadata.version,
    bridgeProtocol,
    'Lumina local runtime bridge protocol metadata is invalid.',
    appShellRevision,
  );
}

export function createInstallationMetadata(port, runtimeIdentity) {
  return {
    installationId: randomUUID(),
    origin: `http://127.0.0.1:${port}`,
    port,
    runtimeVersion: runtimeIdentity.runtimeVersion,
    schemaVersion: METADATA_SCHEMA_VERSION,
    protocolEntry: PROTOCOL_ENTRY,
    bridgeProtocol: runtimeIdentity.bridgeProtocol,
    ...(runtimeIdentity.appShellRevision ? { appShellRevision: runtimeIdentity.appShellRevision } : {}),
  };
}

export function migrateInstallationMetadata(metadata, runtimeIdentity) {
  return {
    ...metadata,
    runtimeVersion: runtimeIdentity.runtimeVersion,
    schemaVersion: METADATA_SCHEMA_VERSION,
    protocolEntry: PROTOCOL_ENTRY,
    bridgeProtocol: runtimeIdentity.bridgeProtocol,
    ...(runtimeIdentity.appShellRevision ? { appShellRevision: runtimeIdentity.appShellRevision } : {}),
  };
}

export async function readInstallationMetadata(metadataDirectory) {
  try {
    const value = JSON.parse(await fs.readFile(metadataPath(metadataDirectory), 'utf8'));
    return parseInstallationMetadata(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function parseInstallationMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Lumina runtime metadata is invalid and requires repair.');
  }
  const {
    installationId,
    origin,
    port,
    runtimeVersion,
    schemaVersion,
    protocolEntry,
    bridgeProtocol,
    appShellRevision,
  } = value;
  if (
    typeof installationId !== 'string'
    || typeof origin !== 'string'
    || !LOCAL_RUNTIME_PORTS.includes(port)
    || typeof runtimeVersion !== 'string'
    || origin !== `http://127.0.0.1:${port}`
  ) {
    throw new Error('Lumina runtime metadata is invalid and requires repair.');
  }
  const parsedAppShellRevision = parseAppShellRevision(appShellRevision);
  if (schemaVersion === undefined && protocolEntry === undefined && bridgeProtocol === undefined) {
    return {
      installationId,
      origin,
      port,
      runtimeVersion,
      ...(parsedAppShellRevision ? { appShellRevision: parsedAppShellRevision } : {}),
    };
  }
  if (schemaVersion !== METADATA_SCHEMA_VERSION || protocolEntry !== PROTOCOL_ENTRY) {
    throw new Error('Lumina runtime metadata is invalid and requires repair.');
  }
  return {
    installationId,
    origin,
    port,
    runtimeVersion,
    schemaVersion,
    protocolEntry,
    bridgeProtocol: parseBridgeProtocol(
      bridgeProtocol,
      'Lumina runtime metadata is invalid and requires repair.',
    ),
    ...(parsedAppShellRevision ? { appShellRevision: parsedAppShellRevision } : {}),
  };
}

export async function writeInstallationMetadata(metadataDirectory, metadata) {
  const filePath = metadataPath(metadataDirectory);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(metadata), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export function isRuntimeCompatible(activeMetadata, expectedIdentity) {
  return runtimeCompatibilityLine(activeMetadata.runtimeVersion) === runtimeCompatibilityLine(expectedIdentity.runtimeVersion)
    && activeMetadata.bridgeProtocol !== undefined
    && areBridgeProtocolsCompatible(activeMetadata.bridgeProtocol, expectedIdentity.bridgeProtocol)
    && (expectedIdentity.appShellRevision === undefined
      || activeMetadata.appShellRevision === expectedIdentity.appShellRevision);
}

export function defaultMetadataDirectory() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Lumina', 'runtime');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Lumina', 'runtime');
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'lumina', 'runtime');
}

async function readInstalledRuntimeIdentity() {
  const installedMetadata = JSON.parse(await fs.readFile(
    path.join(path.dirname(process.execPath), 'runtime-version.json'),
    'utf8',
  ));
  return createRuntimeIdentity(
    installedMetadata.version,
    installedMetadata.bridgeProtocol,
    'Lumina installed runtime bridge protocol metadata is invalid.',
  );
}

function createRuntimeIdentity(runtimeVersion, bridgeProtocol, errorMessage, appShellRevision) {
  if (typeof runtimeVersion !== 'string' || !runtimeVersion.trim()) {
    throw new Error('Lumina local runtime requires a product version.');
  }
  const parsedAppShellRevision = parseAppShellRevision(
    appShellRevision,
    'Lumina local runtime app-shell revision metadata is invalid.',
  );
  return {
    runtimeVersion,
    bridgeProtocol: parseBridgeProtocol(bridgeProtocol, errorMessage),
    ...(parsedAppShellRevision ? { appShellRevision: parsedAppShellRevision } : {}),
  };
}

function withAppShellRevision(identity, appShellRevision) {
  const parsedAppShellRevision = parseAppShellRevision(
    appShellRevision,
    'Lumina local runtime app-shell revision metadata is invalid.',
  );
  return parsedAppShellRevision
    ? { ...identity, appShellRevision: parsedAppShellRevision }
    : identity;
}

function parseAppShellRevision(value, errorMessage = 'Lumina runtime metadata is invalid and requires repair.') {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^sha256-[0-9a-f]{16,64}$/u.test(value)) {
    throw new Error(errorMessage);
  }
  return value;
}

function runtimeCompatibilityLine(version) {
  const match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/u);
  return match ? `${match[1]}.${match[2]}` : version;
}

const metadataPath = (metadataDirectory) => path.join(metadataDirectory, METADATA_FILE_NAME);
