import type { AssetKind, AssetLifecycleState, AssetSourceKind } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord } from '@/features/project/domain/projectRepository';
import type { WebDatabase } from '@/runtime/webDatabase';

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CURRENT_LUMINA_PROJECT_SCHEMA_VERSION = 1;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

type ArchiveEntry = {
  path: string;
  bytes: Uint8Array;
};

type ManifestEntry = {
  path: string;
  byteCount: number;
  sha256: string;
};

type ArchiveProject = {
  id: string;
  revision: string;
  projectPath: string;
  historyPath: string;
};

type ArchiveAsset = {
  assetId: string;
  path: string;
  projectId: string;
  kind: AssetKind;
  mimeType: string;
  sourceKind: AssetSourceKind;
  sourceMetadata: Record<string, string | number | boolean | null>;
  byteCount: number;
  sha256: string;
};

type ArchiveManifest = {
  format: 'lumina-project-export';
  version: 1;
  projects: ArchiveProject[];
  assets: ArchiveAsset[];
  entries: ManifestEntry[];
};

type PreparedProject = {
  sourceId: string;
  record: ProjectRecord;
};

type PreparedAsset = {
  sourceId: string;
  asset: ArchiveAsset;
  blob: Blob;
};

interface StoredAssetRecord {
  assetId: string;
  projectId: string;
  kind: AssetKind;
  mimeType: string;
  byteCount: number;
  createdAt: number;
  sourceKind: AssetSourceKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sourceMetadata: Record<string, string | number | boolean | null>;
  lifecycleState: AssetLifecycleState;
  blob: Blob;
  stagingId?: string;
}

interface StoredHistoryRecord {
  projectId: string;
  historyJson: string;
}

export type LuminaProjectImportErrorCode =
  | 'invalid_archive_type'
  | 'invalid_archive'
  | 'invalid_manifest'
  | 'invalid_path'
  | 'entry_mismatch'
  | 'checksum_mismatch'
  | 'unsupported_schema'
  | 'id_conflict';

export class LuminaProjectImportError extends Error {
  constructor(readonly code: LuminaProjectImportErrorCode) {
    super(code);
    this.name = 'LuminaProjectImportError';
  }
}

export interface ImportLuminaProjectArchiveOptions {
  archive: Blob;
  database: WebDatabase;
  now?: () => number;
}

export interface LuminaProjectImportResult {
  projectIds: string[];
  assetIds: string[];
}

function importError(code: LuminaProjectImportErrorCode): never {
  throw new LuminaProjectImportError(code);
}

function assert(condition: unknown, code: LuminaProjectImportErrorCode): asserts condition {
  if (!condition) {
    importError(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, code: LuminaProjectImportErrorCode): string {
  assert(typeof value === 'string' && value.length > 0, code);
  return value;
}

function requireFiniteNumber(value: unknown, code: LuminaProjectImportErrorCode): number {
  assert(typeof value === 'number' && Number.isFinite(value), code);
  return value;
}

function decodeJson(bytes: Uint8Array, code: LuminaProjectImportErrorCode): unknown {
  try {
    return JSON.parse(TEXT_DECODER.decode(bytes)) as unknown;
  } catch {
    return importError(code);
  }
}

function assertRange(bytes: Uint8Array, offset: number, length: number): void {
  assert(Number.isSafeInteger(offset) && Number.isSafeInteger(length), 'invalid_archive');
  assert(offset >= 0 && length >= 0 && offset + length <= bytes.byteLength, 'invalid_archive');
}

function decodePath(bytes: Uint8Array): string {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    return importError('invalid_path');
  }
}

function isArchivePath(path: string): boolean {
  return path === 'manifest.json'
    || /^projects\/\d{4}\/(project|history)\.json$/.test(path)
    || /^assets\/\d{4}\.bin$/.test(path);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const lowerBound = Math.max(0, bytes.byteLength - 0xffff - 22);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return importError('invalid_archive');
}

function readArchiveEntries(bytes: Uint8Array): Map<string, ArchiveEntry> {
  assert(bytes.byteLength >= 22, 'invalid_archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  assertRange(bytes, endOffset, 22);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  assert(diskNumber === 0 && directoryDisk === 0 && entriesOnDisk === entryCount, 'invalid_archive');
  assert(endOffset + 22 + commentLength === bytes.byteLength, 'invalid_archive');
  assertRange(bytes, directoryOffset, directorySize);

  const entries = new Map<string, ArchiveEntry>();
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, offset, 46);
    assert(view.getUint32(offset, true) === ZIP_CENTRAL_DIRECTORY_HEADER, 'invalid_archive');
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const entryDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    assert(flags === 0 && compression === 0 && entryDisk === 0, 'invalid_archive');
    assert(compressedSize === uncompressedSize, 'invalid_archive');
    assertRange(bytes, offset + 46, pathLength + extraLength + entryCommentLength);
    const path = decodePath(bytes.subarray(offset + 46, offset + 46 + pathLength));
    assert(isArchivePath(path) && !entries.has(path), 'invalid_path');

    assertRange(bytes, localOffset, 30);
    assert(view.getUint32(localOffset, true) === ZIP_LOCAL_FILE_HEADER, 'invalid_archive');
    assert(view.getUint16(localOffset + 6, true) === flags, 'invalid_archive');
    assert(view.getUint16(localOffset + 8, true) === compression, 'invalid_archive');
    assert(view.getUint32(localOffset + 14, true) === crc32, 'invalid_archive');
    assert(view.getUint32(localOffset + 18, true) === compressedSize, 'invalid_archive');
    assert(view.getUint32(localOffset + 22, true) === uncompressedSize, 'invalid_archive');
    const localPathLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    assert(localPathLength === pathLength, 'invalid_archive');
    assertRange(bytes, localOffset + 30, localPathLength + localExtraLength + compressedSize);
    assert(
      decodePath(bytes.subarray(localOffset + 30, localOffset + 30 + localPathLength)) === path,
      'invalid_archive',
    );
    const dataOffset = localOffset + 30 + localPathLength + localExtraLength;
    entries.set(path, { path, bytes: bytes.slice(dataOffset, dataOffset + compressedSize) });
    offset += 46 + pathLength + extraLength + entryCommentLength;
  }
  assert(offset === directoryOffset + directorySize, 'invalid_archive');
  assert(entries.has('manifest.json'), 'invalid_manifest');
  return entries;
}

function parseSourceMetadata(value: unknown): Record<string, string | number | boolean | null> {
  assert(isRecord(value), 'invalid_manifest');
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    assert(
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null,
      'invalid_manifest',
    );
    metadata[key] = item;
  }
  return metadata;
}

function parseManifest(value: unknown): ArchiveManifest {
  assert(isRecord(value), 'invalid_manifest');
  assert(value.format === 'lumina-project-export' && value.version === 1, 'unsupported_schema');
  assert(Array.isArray(value.projects) && Array.isArray(value.assets) && Array.isArray(value.entries), 'invalid_manifest');
  assert(value.projects.length > 0, 'invalid_manifest');
  const seenPaths = new Set<string>();
  const entries = value.entries.map((entry): ManifestEntry => {
    assert(isRecord(entry), 'invalid_manifest');
    const path = requireString(entry.path, 'invalid_manifest');
    const byteCount = requireFiniteNumber(entry.byteCount, 'invalid_manifest');
    const sha256 = requireString(entry.sha256, 'invalid_manifest');
    assert(isArchivePath(path) && path !== 'manifest.json' && Number.isSafeInteger(byteCount) && byteCount >= 0, 'invalid_manifest');
    assert(/^[0-9a-f]{64}$/.test(sha256) && !seenPaths.has(path), 'invalid_manifest');
    seenPaths.add(path);
    return { path, byteCount, sha256 };
  });
  const seenProjects = new Set<string>();
  const seenProjectPaths = new Set<string>();
  const projects = value.projects.map((project): ArchiveProject => {
    assert(isRecord(project), 'invalid_manifest');
    const id = requireString(project.id, 'invalid_manifest');
    const revision = requireString(project.revision, 'invalid_manifest');
    const projectPath = requireString(project.projectPath, 'invalid_manifest');
    const historyPath = requireString(project.historyPath, 'invalid_manifest');
    const projectDirectory = projectPath.slice(0, projectPath.lastIndexOf('/') + 1);
    assert(
      !seenProjects.has(id)
        && !seenProjectPaths.has(projectPath)
        && !seenProjectPaths.has(historyPath)
        && /^projects\/\d{4}\/project\.json$/.test(projectPath)
        && /^projects\/\d{4}\/history\.json$/.test(historyPath)
        && /^projects\/\d{4}\/$/.test(projectDirectory)
        && projectDirectory === historyPath.slice(0, historyPath.lastIndexOf('/') + 1)
        && seenPaths.has(projectPath)
        && seenPaths.has(historyPath),
      'invalid_manifest',
    );
    seenProjects.add(id);
    seenProjectPaths.add(projectPath);
    seenProjectPaths.add(historyPath);
    return { id, revision, projectPath, historyPath };
  });
  const seenAssets = new Set<string>();
  const seenAssetPaths = new Set<string>();
  const assets = value.assets.map((asset): ArchiveAsset => {
    assert(isRecord(asset), 'invalid_manifest');
    const assetId = requireString(asset.assetId, 'invalid_manifest');
    const path = requireString(asset.path, 'invalid_manifest');
    const projectId = requireString(asset.projectId, 'invalid_manifest');
    const kind = asset.kind;
    const mimeType = requireString(asset.mimeType, 'invalid_manifest');
    const sourceKind = asset.sourceKind;
    const byteCount = requireFiniteNumber(asset.byteCount, 'invalid_manifest');
    const sha256 = requireString(asset.sha256, 'invalid_manifest');
    assert(kind === 'image' || kind === 'video' || kind === 'audio', 'invalid_manifest');
    assert(sourceKind === 'import' || sourceKind === 'generation' || sourceKind === 'derived', 'invalid_manifest');
    assert(
      !seenAssets.has(assetId)
        && !seenAssetPaths.has(path)
        && seenProjects.has(projectId)
        && /^assets\/\d{4}\.bin$/.test(path)
        && seenPaths.has(path)
        && Number.isSafeInteger(byteCount)
        && byteCount >= 0
        && /^[0-9a-f]{64}$/.test(sha256),
      'invalid_manifest',
    );
    seenAssets.add(assetId);
    seenAssetPaths.add(path);
    return {
      assetId,
      path,
      projectId,
      kind,
      mimeType,
      sourceKind,
      sourceMetadata: parseSourceMetadata(asset.sourceMetadata),
      byteCount,
      sha256,
    };
  });
  return { format: value.format, version: value.version, projects, assets, entries };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return importError('invalid_archive');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function collectAssetReferences(value: unknown, assetIds: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetReferences(item, assetIds));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'assetId' || key === 'previewAssetId') && typeof item === 'string' && item) {
      assetIds.add(item);
    }
    collectAssetReferences(item, assetIds);
  }
}

function migrateProjectDocument(
  document: unknown,
  history: unknown,
  manifestProject: ArchiveProject,
): PreparedProject {
  assert(isRecord(document), 'invalid_manifest');
  const schemaVersion = document.schemaVersion ?? CURRENT_LUMINA_PROJECT_SCHEMA_VERSION;
  assert(schemaVersion === CURRENT_LUMINA_PROJECT_SCHEMA_VERSION, 'unsupported_schema');
  const sourceId = requireString(document.id, 'invalid_manifest');
  assert(sourceId === manifestProject.id, 'invalid_manifest');
  const nodes = document.nodes;
  const edges = document.edges;
  const viewport = document.viewport;
  assert(
    isRecord(nodes)
      && Array.isArray(nodes.nodes)
      && (nodes.imagePool === undefined || Array.isArray(nodes.imagePool))
      && Array.isArray(edges)
      && isRecord(viewport)
      && isRecord(history)
      && Array.isArray(history.past)
      && Array.isArray(history.future),
    'invalid_manifest',
  );
  const nodeCount = requireFiniteNumber(document.nodeCount, 'invalid_manifest');
  assert(Number.isSafeInteger(nodeCount) && nodeCount >= 0, 'invalid_manifest');
  const revision = requireString(document.revision, 'invalid_manifest');
  assert(revision === manifestProject.revision, 'invalid_manifest');
  const record: ProjectRecord = {
    id: sourceId,
    name: requireString(document.name, 'invalid_manifest'),
    createdAt: requireFiniteNumber(document.createdAt, 'invalid_manifest'),
    updatedAt: requireFiniteNumber(document.updatedAt, 'invalid_manifest'),
    nodeCount,
    schemaVersion: CURRENT_LUMINA_PROJECT_SCHEMA_VERSION,
    revision,
    nodesJson: JSON.stringify(nodes),
    edgesJson: JSON.stringify(edges),
    viewportJson: JSON.stringify(viewport),
    historyJson: JSON.stringify(history),
  };
  return { sourceId, record };
}

function remapReferences(value: unknown, projectIds: ReadonlyMap<string, string>, assetIds: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => remapReferences(item, projectIds, assetIds));
  }
  if (!isRecord(value)) {
    return value;
  }
  const remapped: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'assetId' || key === 'previewAssetId') && typeof item === 'string') {
      remapped[key] = assetIds.get(item) ?? item;
    } else if (key === 'projectId' && typeof item === 'string') {
      remapped[key] = projectIds.get(item) ?? item;
    } else {
      remapped[key] = remapReferences(item, projectIds, assetIds);
    }
  }
  return remapped;
}

function remapProject(
  project: PreparedProject,
  projectIds: ReadonlyMap<string, string>,
  assetIds: ReadonlyMap<string, string>,
): ProjectRecord {
  const targetId = projectIds.get(project.sourceId);
  assert(targetId, 'id_conflict');
  const nodes = remapReferences(decodeJson(new TextEncoder().encode(project.record.nodesJson), 'invalid_manifest'), projectIds, assetIds);
  const history = remapReferences(decodeJson(new TextEncoder().encode(project.record.historyJson), 'invalid_manifest'), projectIds, assetIds);
  return {
    ...project.record,
    id: targetId,
    nodesJson: JSON.stringify(nodes),
    historyJson: JSON.stringify(history),
  };
}

function resolveImportedIds(sourceIds: readonly string[], existingIds: ReadonlySet<string>): Map<string, string> {
  const allocated = new Set(existingIds);
  const mapping = new Map<string, string>();
  for (const sourceId of sourceIds) {
    let candidate = sourceId;
    let suffix = 1;
    while (allocated.has(candidate)) {
      candidate = `${sourceId}~import-${suffix}`;
      suffix += 1;
    }
    allocated.add(candidate);
    mapping.set(sourceId, candidate);
  }
  return mapping;
}

function assertArchiveType(archive: Blob): void {
  assert(archive.size > 0, 'invalid_archive_type');
  assert(
    !archive.type
      || archive.type === 'application/zip'
      || archive.type === 'application/x-zip-compressed'
      || archive.type === 'application/octet-stream',
    'invalid_archive_type',
  );
  const name = (archive as Blob & { name?: unknown }).name;
  assert(typeof name !== 'string' || name.toLowerCase().endsWith('.lumina'), 'invalid_archive_type');
}

export async function cleanupLuminaImportStaging(database: WebDatabase): Promise<number> {
  return database.run(['assets'], 'readwrite', async (transaction) => {
    const records = await transaction.getAll<StoredAssetRecord>('assets');
    const staleRecords = records.filter((record) => record.lifecycleState === 'staging');
    await Promise.all(staleRecords.map((record) => transaction.delete('assets', record.assetId)));
    return staleRecords.length;
  });
}

export async function importLuminaProjectArchive({
  archive,
  database,
  now = Date.now,
}: ImportLuminaProjectArchiveOptions): Promise<LuminaProjectImportResult> {
  assertArchiveType(archive);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await archive.arrayBuffer());
  } catch {
    return importError('invalid_archive');
  }
  const entries = readArchiveEntries(bytes);
  const manifest = parseManifest(decodeJson(entries.get('manifest.json')!.bytes, 'invalid_manifest'));
  assert(entries.size === manifest.entries.length + 1, 'entry_mismatch');
  const declarationsByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const declaration of manifest.entries) {
    const entry = entries.get(declaration.path);
    assert(entry && entry.bytes.byteLength === declaration.byteCount, 'entry_mismatch');
    assert(await sha256(entry.bytes) === declaration.sha256, 'checksum_mismatch');
  }
  for (const asset of manifest.assets) {
    const declaration = declarationsByPath.get(asset.path);
    assert(
      declaration?.byteCount === asset.byteCount && declaration.sha256 === asset.sha256,
      'checksum_mismatch',
    );
  }

  const preparedProjects = manifest.projects.map((project) => {
    const projectEntry = entries.get(project.projectPath);
    const historyEntry = entries.get(project.historyPath);
    assert(projectEntry && historyEntry, 'entry_mismatch');
    return migrateProjectDocument(
      decodeJson(projectEntry.bytes, 'invalid_manifest'),
      decodeJson(historyEntry.bytes, 'invalid_manifest'),
      project,
    );
  });
  const declaredAssetIds = new Set(manifest.assets.map((asset) => asset.assetId));
  for (const project of preparedProjects) {
    const references = new Set<string>();
    collectAssetReferences(decodeJson(new TextEncoder().encode(project.record.nodesJson), 'invalid_manifest'), references);
    collectAssetReferences(decodeJson(new TextEncoder().encode(project.record.historyJson), 'invalid_manifest'), references);
    for (const assetId of references) {
      assert(declaredAssetIds.has(assetId), 'invalid_manifest');
    }
  }
  const preparedAssets = manifest.assets.map((asset): PreparedAsset => {
    const entry = entries.get(asset.path);
    assert(entry && entry.bytes.byteLength === asset.byteCount, 'entry_mismatch');
    return {
      sourceId: asset.assetId,
      asset,
      blob: new Blob([entry.bytes], { type: asset.mimeType }),
    };
  });

  const existing = await database.run(['projects', 'assets'], 'readonly', async (transaction) => ({
    projectIds: new Set((await transaction.getAll<{ id: string }>('projects')).map((project) => project.id)),
    assetIds: new Set((await transaction.getAll<{ assetId: string }>('assets')).map((asset) => asset.assetId)),
  }));
  const projectIds = resolveImportedIds(preparedProjects.map((project) => project.sourceId), existing.projectIds);
  const assetIds = resolveImportedIds(preparedAssets.map((asset) => asset.sourceId), existing.assetIds);
  const stagingId = `lumina-import-${now()}-${Math.random().toString(36).slice(2)}`;
  const stagedAssets = preparedAssets.map(({ sourceId, asset, blob }): StoredAssetRecord => ({
    assetId: assetIds.get(sourceId)!,
    projectId: projectIds.get(asset.projectId)!,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteCount: blob.size,
    createdAt: now(),
    sourceKind: asset.sourceKind,
    width: null,
    height: null,
    durationMs: null,
    sourceMetadata: asset.sourceMetadata,
    lifecycleState: 'staging',
    blob,
    stagingId,
  }));

  try {
    for (const asset of stagedAssets) {
      await database.run(['assets'], 'readwrite', (transaction) => transaction.put('assets', asset));
    }
    const projects = preparedProjects.map((project) => remapProject(project, projectIds, assetIds));
    await database.run(['projects', 'history', 'assets'], 'readwrite', async (transaction) => {
      for (const project of projects) {
        assert(!(await transaction.get('projects', project.id)), 'id_conflict');
      }
      for (const asset of stagedAssets) {
        const staged = await transaction.get<StoredAssetRecord>('assets', asset.assetId);
        assert(staged?.stagingId === stagingId, 'id_conflict');
      }
      for (const project of projects) {
        await transaction.put('projects', project);
        await transaction.put<StoredHistoryRecord>('history', {
          projectId: project.id,
          historyJson: project.historyJson,
        });
      }
      for (const asset of stagedAssets) {
        await transaction.put('assets', { ...asset, lifecycleState: 'active', stagingId: undefined });
      }
    });
    return {
      projectIds: preparedProjects.map((project) => projectIds.get(project.sourceId)!),
      assetIds: preparedAssets.map((asset) => assetIds.get(asset.sourceId)!),
    };
  } catch (error) {
    await database.run(['assets'], 'readwrite', async (transaction) => {
      const records = await transaction.getAll<StoredAssetRecord>('assets');
      await Promise.all(records
        .filter((record) => record.stagingId === stagingId)
        .map((record) => transaction.delete('assets', record.assetId)));
    });
    throw error;
  }
}
