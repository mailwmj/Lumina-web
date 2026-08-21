import type { AssetMetadata, AssetRepository } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord, ProjectRepository } from '@/features/project/domain/projectRepository';
import {
  createStoredZip,
  StoredZipError,
  type StoredZipEntry,
} from './storedZip';

const TEXT_ENCODER = new TextEncoder();

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

function createZip(entries: readonly StoredZipEntry[]): Blob {
  try {
    return createStoredZip(entries);
  } catch (error) {
    if (error instanceof StoredZipError) {
      throw new LuminaProjectExportError(error.code);
    }
    throw error;
  }
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
    if ((key === 'assetId' || key === 'previewAssetId' || key === 'lastFrameAssetId')
      && typeof item === 'string' && item) {
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
  const projectEntries: StoredZipEntry[] = [];

  for (const [index, project] of projects.entries()) {
    const nodes = sanitizeExportValue(parseJson(project.nodesJson));
    const history = sanitizeExportValue(parseJson(project.historyJson));
    collectAssetIds(nodes, assetIds);
    collectAssetIds(history, assetIds);
    const directory = `projects/${String(index + 1).padStart(4, '0')}`;
    projectEntries.push({
      path: `${directory}/project.json`,
      bytes: encodeJson({
        schemaVersion: project.schemaVersion ?? 1,
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

  const entries: StoredZipEntry[] = [];
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
