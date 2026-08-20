import type { ProjectRecord } from '@/features/project/domain/projectRepository';
import {
  decodeLuminaArchiveJson,
  type VerifiedLuminaProjectArchive,
} from './luminaProjectImportArchive';
import {
  assertImport,
  type LuminaArchiveAsset,
  type LuminaArchiveProject,
} from './luminaProjectImportTypes';

const CURRENT_LUMINA_PROJECT_SCHEMA_VERSION = 1;

export interface PreparedLuminaProject {
  sourceId: string;
  record: ProjectRecord;
}

export interface PreparedLuminaAsset {
  sourceId: string;
  asset: LuminaArchiveAsset;
  blob: Blob;
}

export interface PreparedLuminaProjectImport {
  projects: PreparedLuminaProject[];
  assets: PreparedLuminaAsset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown): string {
  assertImport(typeof value === 'string' && value.length > 0, 'invalid_manifest');
  return value;
}

function requireFiniteNumber(value: unknown): number {
  assertImport(typeof value === 'number' && Number.isFinite(value), 'invalid_manifest');
  return value;
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
  manifestProject: LuminaArchiveProject,
): PreparedLuminaProject {
  assertImport(isRecord(document), 'invalid_manifest');
  const schemaVersion = document.schemaVersion ?? CURRENT_LUMINA_PROJECT_SCHEMA_VERSION;
  assertImport(schemaVersion === CURRENT_LUMINA_PROJECT_SCHEMA_VERSION, 'unsupported_schema');
  const sourceId = requireString(document.id);
  assertImport(sourceId === manifestProject.id, 'invalid_manifest');
  const nodes = document.nodes;
  const edges = document.edges;
  const viewport = document.viewport;
  assertImport(
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
  const nodeCount = requireFiniteNumber(document.nodeCount);
  assertImport(Number.isSafeInteger(nodeCount) && nodeCount >= 0, 'invalid_manifest');
  const revision = requireString(document.revision);
  assertImport(revision === manifestProject.revision, 'invalid_manifest');
  return {
    sourceId,
    record: {
      id: sourceId,
      name: requireString(document.name),
      createdAt: requireFiniteNumber(document.createdAt),
      updatedAt: requireFiniteNumber(document.updatedAt),
      nodeCount,
      schemaVersion: CURRENT_LUMINA_PROJECT_SCHEMA_VERSION,
      revision,
      nodesJson: JSON.stringify(nodes),
      edgesJson: JSON.stringify(edges),
      viewportJson: JSON.stringify(viewport),
      historyJson: JSON.stringify(history),
    },
  };
}

function remapReferences(
  value: unknown,
  projectIds: ReadonlyMap<string, string>,
  assetIds: ReadonlyMap<string, string>,
): unknown {
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

export function remapPreparedLuminaProjects(
  projects: readonly PreparedLuminaProject[],
  projectIds: ReadonlyMap<string, string>,
  assetIds: ReadonlyMap<string, string>,
): ProjectRecord[] {
  return projects.map((project) => {
    const targetId = projectIds.get(project.sourceId);
    assertImport(targetId, 'id_conflict');
    const nodes = remapReferences(
      decodeLuminaArchiveJson(new TextEncoder().encode(project.record.nodesJson), 'invalid_manifest'),
      projectIds,
      assetIds,
    );
    const history = remapReferences(
      decodeLuminaArchiveJson(new TextEncoder().encode(project.record.historyJson), 'invalid_manifest'),
      projectIds,
      assetIds,
    );
    return {
      ...project.record,
      id: targetId,
      nodesJson: JSON.stringify(nodes),
      historyJson: JSON.stringify(history),
    };
  });
}

export function prepareLuminaProjectImport(
  archive: VerifiedLuminaProjectArchive,
): PreparedLuminaProjectImport {
  const projects = archive.manifest.projects.map((project) => {
    const projectEntry = archive.entries.get(project.projectPath);
    const historyEntry = archive.entries.get(project.historyPath);
    assertImport(projectEntry && historyEntry, 'entry_mismatch');
    return migrateProjectDocument(
      decodeLuminaArchiveJson(projectEntry.bytes, 'invalid_manifest'),
      decodeLuminaArchiveJson(historyEntry.bytes, 'invalid_manifest'),
      project,
    );
  });
  const declaredAssetIds = new Set(archive.manifest.assets.map((asset) => asset.assetId));
  for (const project of projects) {
    const references = new Set<string>();
    collectAssetReferences(
      decodeLuminaArchiveJson(new TextEncoder().encode(project.record.nodesJson), 'invalid_manifest'),
      references,
    );
    collectAssetReferences(
      decodeLuminaArchiveJson(new TextEncoder().encode(project.record.historyJson), 'invalid_manifest'),
      references,
    );
    for (const assetId of references) {
      assertImport(declaredAssetIds.has(assetId), 'invalid_manifest');
    }
  }
  const assets = archive.manifest.assets.map((asset): PreparedLuminaAsset => {
    const entry = archive.entries.get(asset.path);
    assertImport(entry && entry.bytes.byteLength === asset.byteCount, 'entry_mismatch');
    return {
      sourceId: asset.assetId,
      asset,
      blob: new Blob([entry.bytes], { type: asset.mimeType }),
    };
  });
  return { projects, assets };
}
