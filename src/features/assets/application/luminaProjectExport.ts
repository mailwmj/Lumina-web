import type { AssetMetadata, AssetRepository } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord, ProjectRepository } from '@/features/project/domain/projectRepository';

const TEXT_ENCODER = new TextEncoder();
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_MAX_UINT32 = 0xffffffff;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? (current >>> 1) ^ 0xedb88320 : current >>> 1;
    }
    table[value] = current >>> 0;
  }
  return table;
})();

interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

interface ExportedAsset {
  assetId: string;
  metadata: AssetMetadata;
}

interface ManifestEntry {
  path: string;
  byteCount: number;
  sha256: string;
}

export interface LuminaProjectExportProgress {
  completedBytes: number;
  totalBytes: number;
  completedEntries: number;
  totalEntries: number;
}

export interface LuminaProjectExportOptions {
  projectIds: readonly string[];
  /** Current in-memory snapshots take precedence over persisted records with the same id. */
  projectRecords?: readonly ProjectRecord[];
  projectRepository: Pick<ProjectRepository, 'get'>;
  assetRepository: Pick<AssetRepository, 'read' | 'getMetadata'>;
  exportedAt?: number;
  onProgress?: (progress: LuminaProjectExportProgress) => void;
}

export type LuminaProjectExportErrorCode =
  | 'archive_limit'
  | 'archive_file_limit'
  | 'archive_file_name_limit'
  | 'invalid_project_data'
  | 'hash_unavailable'
  | 'no_projects'
  | 'project_unavailable'
  | 'asset_unavailable'
  | 'asset_changed';

export class LuminaProjectExportError extends Error {
  constructor(readonly code: LuminaProjectExportErrorCode) {
    super(code);
    this.name = 'LuminaProjectExportError';
  }
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertZipValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP_MAX_UINT32) {
    throw new LuminaProjectExportError('archive_limit');
  }
}

function setUint32(view: DataView, offset: number, value: number): void {
  assertZipValue(value);
  view.setUint32(offset, value, true);
}

function createZip(entries: readonly ZipEntry[]): Blob {
  if (entries.length > 0xffff) {
    throw new LuminaProjectExportError('archive_file_limit');
  }

  const encodedEntries = entries.map((entry) => {
    const pathBytes = TEXT_ENCODER.encode(entry.path);
    if (pathBytes.byteLength > 0xffff) {
      throw new LuminaProjectExportError('archive_file_name_limit');
    }
    assertZipValue(entry.bytes.byteLength);
    return { ...entry, pathBytes, crc32: crc32(entry.bytes) };
  });
  const localSize = encodedEntries.reduce(
    (total, entry) => total + 30 + entry.pathBytes.byteLength + entry.bytes.byteLength,
    0,
  );
  const centralSize = encodedEntries.reduce(
    (total, entry) => total + 46 + entry.pathBytes.byteLength,
    0,
  );
  const totalSize = localSize + centralSize + 22;
  assertZipValue(localSize);
  assertZipValue(centralSize);
  assertZipValue(totalSize);

  // Stored ZIP entries preserve Blob bytes directly and avoid base64 expansion.
  const archive = new Uint8Array(totalSize);
  const view = new DataView(archive.buffer);
  let offset = 0;
  const localOffsets: number[] = [];

  for (const entry of encodedEntries) {
    localOffsets.push(offset);
    setUint32(view, offset, ZIP_LOCAL_FILE_HEADER);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    setUint32(view, offset + 14, entry.crc32);
    setUint32(view, offset + 18, entry.bytes.byteLength);
    setUint32(view, offset + 22, entry.bytes.byteLength);
    view.setUint16(offset + 26, entry.pathBytes.byteLength, true);
    view.setUint16(offset + 28, 0, true);
    archive.set(entry.pathBytes, offset + 30);
    archive.set(entry.bytes, offset + 30 + entry.pathBytes.byteLength);
    offset += 30 + entry.pathBytes.byteLength + entry.bytes.byteLength;
  }

  const centralDirectoryOffset = offset;
  for (const [index, entry] of encodedEntries.entries()) {
    setUint32(view, offset, ZIP_CENTRAL_DIRECTORY_HEADER);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 0, true);
    setUint32(view, offset + 16, entry.crc32);
    setUint32(view, offset + 20, entry.bytes.byteLength);
    setUint32(view, offset + 24, entry.bytes.byteLength);
    view.setUint16(offset + 28, entry.pathBytes.byteLength, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    setUint32(view, offset + 38, 0);
    setUint32(view, offset + 42, localOffsets[index]);
    archive.set(entry.pathBytes, offset + 46);
    offset += 46 + entry.pathBytes.byteLength;
  }

  setUint32(view, offset, ZIP_END_OF_CENTRAL_DIRECTORY);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  setUint32(view, offset + 12, centralSize);
  setUint32(view, offset + 16, centralDirectoryOffset);
  view.setUint16(offset + 20, 0, true);

  return new Blob([archive], { type: 'application/zip' });
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized.includes('apikey')
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('authorization')
    || normalized.includes('gatewayurl')
  );
}

function isTemporaryGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /gateway|bridge|token|signature|apikey|secret/i.test(
      `${url.hostname}${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    return false;
  }
}

function sanitizeExportValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return isTemporaryGatewayUrl(value) ? undefined : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = sanitizeExportValue(item);
      return sanitized === undefined ? [] : [sanitized];
    });
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    const sanitized = sanitizeExportValue(item);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new LuminaProjectExportError('invalid_project_data');
  }
}

function encodeJson(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(sanitizeExportValue(value)));
}

function collectAssetIds(value: unknown, assetIds: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetIds(item, assetIds));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'assetId' || key === 'previewAssetId') && typeof item === 'string' && item) {
      assetIds.add(item);
    }
    collectAssetIds(item, assetIds);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new LuminaProjectExportError('hash_unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function uniqueProjectIds(projectIds: readonly string[]): string[] {
  return [...new Set(projectIds.map((projectId) => projectId.trim()).filter(Boolean))];
}

async function readProjects(
  projectIds: readonly string[],
  projectRepository: Pick<ProjectRepository, 'get'>,
  projectRecords: readonly ProjectRecord[] = [],
): Promise<ProjectRecord[]> {
  const providedRecords = new Map(projectRecords.map((project) => [project.id, project]));
  const projects: ProjectRecord[] = [];
  for (const projectId of projectIds) {
    const project = providedRecords.get(projectId) ?? await projectRepository.get(projectId);
    if (!project) {
      throw new LuminaProjectExportError('project_unavailable');
    }
    projects.push(project);
  }
  return projects;
}

async function readExportedAssetMetadata(
  assetIds: readonly string[],
  projectIds: ReadonlySet<string>,
  assetRepository: Pick<AssetRepository, 'getMetadata'>,
): Promise<ExportedAsset[]> {
  const assets: ExportedAsset[] = [];
  for (const assetId of assetIds) {
    const metadata = await assetRepository.getMetadata(assetId);
    if (!metadata || !projectIds.has(metadata.projectId)) {
      throw new LuminaProjectExportError('asset_unavailable');
    }
    assets.push({ assetId, metadata });
  }
  return assets;
}

export async function createLuminaProjectExport({
  projectIds: requestedProjectIds,
  projectRecords,
  projectRepository,
  assetRepository,
  exportedAt = Date.now(),
  onProgress,
}: LuminaProjectExportOptions): Promise<Blob> {
  const projectIds = uniqueProjectIds(requestedProjectIds);
  if (projectIds.length === 0) {
    throw new LuminaProjectExportError('no_projects');
  }

  const projects = await readProjects(projectIds, projectRepository, projectRecords);
  const assetIds = new Set<string>();
  const projectEntries: ZipEntry[] = [];

  for (const [index, project] of projects.entries()) {
    const nodes = sanitizeExportValue(parseJson(project.nodesJson));
    const history = sanitizeExportValue(parseJson(project.historyJson));
    collectAssetIds(nodes, assetIds);
    collectAssetIds(history, assetIds);
    const directory = `projects/${String(index + 1).padStart(4, '0')}`;
    projectEntries.push({
      path: `${directory}/project.json`,
      bytes: encodeJson({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodeCount: project.nodeCount,
        revision: project.revision,
        nodes,
        edges: parseJson(project.edgesJson),
        viewport: parseJson(project.viewportJson),
      }),
    });
    projectEntries.push({ path: `${directory}/history.json`, bytes: encodeJson(history) });
  }

  const assets = await readExportedAssetMetadata(
    [...assetIds].sort(),
    new Set(projectIds),
    assetRepository,
  );
  const totalEntries = projectEntries.length + assets.length + 1;
  let completedEntries = 0;
  let completedBytes = 0;
  let totalBytes = projectEntries.reduce((total, entry) => total + entry.bytes.byteLength, 0)
    + assets.reduce((total, asset) => total + asset.metadata.byteCount, 0);
  onProgress?.({ completedBytes, totalBytes, completedEntries, totalEntries });

  const entries: ZipEntry[] = [];
  for (const entry of projectEntries) {
    entries.push(entry);
    completedEntries += 1;
    completedBytes += entry.bytes.byteLength;
    onProgress?.({ completedBytes, totalBytes, completedEntries, totalEntries });
  }

  const manifestAssets: Array<Record<string, unknown>> = [];
  for (const [index, asset] of assets.entries()) {
    const blob = await assetRepository.read(asset.assetId);
    if (!blob) {
      throw new LuminaProjectExportError('asset_unavailable');
    }
    if (blob.size !== asset.metadata.byteCount) {
      throw new LuminaProjectExportError('asset_changed');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = `assets/${String(index + 1).padStart(4, '0')}.bin`;
    entries.push({ path, bytes });
    manifestAssets.push(sanitizeExportValue({
      assetId: asset.assetId,
      path,
      projectId: asset.metadata.projectId,
      kind: asset.metadata.kind,
      mimeType: asset.metadata.mimeType,
      sourceKind: asset.metadata.sourceKind,
      sourceMetadata: asset.metadata.sourceMetadata,
    }) as Record<string, unknown>);
    completedEntries += 1;
    completedBytes += bytes.byteLength;
    onProgress?.({ completedBytes, totalBytes, completedEntries, totalEntries });
  }

  const manifestEntries: ManifestEntry[] = [];
  for (const entry of entries) {
    manifestEntries.push({
      path: entry.path,
      byteCount: entry.bytes.byteLength,
      sha256: await sha256(entry.bytes),
    });
  }
  const manifestEntryByPath = new Map(manifestEntries.map((entry) => [entry.path, entry]));
  const manifest = encodeJson({
    format: 'lumina-project-export',
    version: 1,
    exportedAt,
    projects: projects.map((project, index) => ({
      id: project.id,
      revision: project.revision ?? 'r0',
      projectPath: `projects/${String(index + 1).padStart(4, '0')}/project.json`,
      historyPath: `projects/${String(index + 1).padStart(4, '0')}/history.json`,
    })),
    assets: manifestAssets.map((asset) => {
      const path = typeof asset.path === 'string' ? asset.path : '';
      const entry = manifestEntryByPath.get(path);
      return {
        ...asset,
        byteCount: entry?.byteCount ?? 0,
        sha256: entry?.sha256 ?? '',
      };
    }),
    entries: manifestEntries,
  });
  totalBytes += manifest.byteLength;
  entries.push({ path: 'manifest.json', bytes: manifest });
  completedEntries += 1;
  completedBytes += manifest.byteLength;
  onProgress?.({ completedBytes, totalBytes, completedEntries, totalEntries });

  return createZip(entries);
}
