import { admitCanvasEdges, admitCanvasNodes, admitHistorySnapshots, rejectProjectSecrets, validateAssetMetadata, validateImagePool, validateProjectRevision, validateRecovery, validateViewportValue } from './admission.mjs';
import { CorruptLibraryError, DIGEST_PATTERN, MAX_ASSET_METADATA_BYTES, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, assertExactFields, canonicalize, encoder, parseStrictJson, validateLibraryKey, validateLogicalId } from './core.mjs';
import { hashFileBytes, managedPath } from './filesystem.mjs';

export function parseProjectManifest(bytes) {
  const value = parseStrictJson(bytes, 'project manifest');
  assertExactFields(
    value,
    ['format', 'version', 'projectId', 'projectKey', 'snapshotKey', 'revision', 'recovery'],
    [],
    'project manifest',
  );
  try {
    if (value.format !== 'lumina-library-project-snapshot' || value.version !== 1) {
      throw new CorruptLibraryError('Project manifest schema is unsupported.');
    }
    validateLogicalId(value.projectId, 'project manifest projectId');
    validateLibraryKey(value.projectKey, 'p');
    validateLibraryKey(value.snapshotKey, 's');
    validateProjectRevision(value.revision, 'project manifest revision');
    if (value.recovery !== null) value.recovery = validateProjectManifestRecovery(value);
  } catch (error) {
    if (error instanceof CorruptLibraryError) throw error;
    throw new CorruptLibraryError('Project manifest schema is invalid.', { cause: error });
  }
  return value;
}

export function validateProjectManifestRecovery(manifest) {
  const recovery = manifest.recovery;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    throw new CorruptLibraryError('Project manifest recovery is invalid.');
  }
  if (Object.keys(recovery).length === 1 && Object.hasOwn(recovery, 'reason')) {
    return validateRecovery(recovery);
  }
  assertExactFields(
    recovery,
    [
      'reason', 'recoveryId', 'sourceProjectPath', 'sourceProjectSha256',
      'sourceHistoryPath', 'sourceHistorySha256', 'observedSchemaVersion', 'recoveredAt',
    ],
    [],
    'project manifest recovery',
  );
  validateRecovery({ reason: recovery.reason });
  validateLibraryKey(recovery.recoveryId, 'r');
  if (!DIGEST_PATTERN.test(recovery.sourceProjectSha256)
    || !DIGEST_PATTERN.test(recovery.sourceHistorySha256)
    || (recovery.observedSchemaVersion !== null
      && (!Number.isSafeInteger(recovery.observedSchemaVersion) || recovery.observedSchemaVersion < 0))
    || !Number.isSafeInteger(recovery.recoveredAt)
    || recovery.recoveredAt < 0) {
    throw new CorruptLibraryError('Project manifest recovery evidence is invalid.');
  }
  const directory = `projects/${manifest.projectKey}/snapshots/${manifest.snapshotKey}/recovery`;
  if (recovery.sourceProjectPath !== `${directory}/${recovery.recoveryId}-source-project.json`
    || recovery.sourceHistoryPath !== `${directory}/${recovery.recoveryId}-source-history.json`) {
    throw new CorruptLibraryError('Project manifest recovery paths are invalid.');
  }
  return {
    reason: recovery.reason,
    recoveryId: recovery.recoveryId,
    sourceProjectPath: recovery.sourceProjectPath,
    sourceProjectSha256: recovery.sourceProjectSha256,
    sourceHistoryPath: recovery.sourceHistoryPath,
    sourceHistorySha256: recovery.sourceHistorySha256,
    observedSchemaVersion: recovery.observedSchemaVersion,
    recoveredAt: recovery.recoveredAt,
  };
}

export async function validateProjectRecoveryEvidence(state, recovery) {
  const [projectSource, historySource] = await Promise.all([
    hashFileBytes(state, managedPath(state, recovery.sourceProjectPath), MAX_PROJECT_DOCUMENT_BYTES),
    hashFileBytes(state, managedPath(state, recovery.sourceHistoryPath), MAX_HISTORY_DOCUMENT_BYTES),
  ]);
  if (projectSource.sha256 !== recovery.sourceProjectSha256
    || historySource.sha256 !== recovery.sourceHistorySha256) {
    throw new CorruptLibraryError('Project recovery source bytes failed integrity validation.');
  }
}

export function parseProjectDocument(bytes) {
  if ((bytes instanceof Uint8Array ? bytes.byteLength : encoder.encode(bytes).byteLength) > MAX_PROJECT_DOCUMENT_BYTES) {
    throw new CorruptLibraryError('Project snapshot exceeds the v1 limit.');
  }
  const value = parseStrictJson(bytes, 'project snapshot');
  assertExactFields(
    value,
    ['schemaVersion', 'id', 'name', 'createdAt', 'updatedAt', 'nodeCount', 'revision', 'nodes', 'edges', 'viewport'],
    ['imagePool', 'format', 'version', 'recovery'],
    'project snapshot',
  );
  try {
    if ((Object.hasOwn(value, 'format') || Object.hasOwn(value, 'version'))
      && (value.format !== 'lumina-library-project' || value.version !== 1)) {
      throw new CorruptLibraryError('Project document schema is unsupported.');
    }
    validateLogicalId(value.id, 'project snapshot id');
    if (typeof value.name !== 'string' || encoder.encode(value.name).byteLength > 1024) {
      throw new CorruptLibraryError('Project snapshot name is invalid.');
    }
    for (const field of ['createdAt', 'updatedAt', 'nodeCount', 'schemaVersion']) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
        throw new CorruptLibraryError(`Project snapshot ${field} is invalid.`);
      }
    }
    if (value.schemaVersion !== 1) {
      throw new CorruptLibraryError('Project snapshot schema version is unsupported.');
    }
    validateProjectRevision(value.revision, 'project snapshot revision');
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
      throw new CorruptLibraryError('Project snapshot canvas data is invalid.');
    }
    value.nodes = admitCanvasNodes(value.nodes, 'project snapshot nodes');
    value.edges = admitCanvasEdges(value.edges, 'project snapshot edges');
    value.viewport = validateViewportValue(value.viewport, 'project snapshot viewport');
    if (Object.hasOwn(value, 'imagePool')) value.imagePool = validateImagePool(value.imagePool, 'project snapshot imagePool');
    if (Object.hasOwn(value, 'recovery') && value.recovery !== null) validateRecovery(value.recovery);
    rejectProjectSecrets(value);
  } catch (error) {
    if (error instanceof CorruptLibraryError) throw error;
    throw new CorruptLibraryError('Project snapshot failed secret admission.', { cause: error });
  }
  return value;
}

export function parseHistoryDocument(bytes) {
  if ((bytes instanceof Uint8Array ? bytes.byteLength : encoder.encode(bytes).byteLength) > MAX_HISTORY_DOCUMENT_BYTES) {
    throw new CorruptLibraryError('History snapshot exceeds the v1 limit.');
  }
  const value = parseStrictJson(bytes, 'history snapshot');
  assertExactFields(value, ['past', 'future'], [], 'history snapshot');
  try {
    if (!Array.isArray(value.past) || !Array.isArray(value.future)) {
      throw new CorruptLibraryError('History snapshot schema is invalid.');
    }
    value.past = admitHistorySnapshots(value.past, 'history past', {}, { truncate: false });
    value.future = admitHistorySnapshots(value.future, 'history future', {}, { truncate: false });
    rejectProjectSecrets(value);
  } catch (error) {
    if (error instanceof CorruptLibraryError) throw error;
    throw new CorruptLibraryError('History snapshot failed secret admission.', { cause: error });
  }
  return value;
}

export function parseAssetMetadataDocument(bytes) {
  const value = parseStrictJson(bytes, 'asset metadata');
  assertExactFields(value, ['format', 'version', 'metadata'], [], 'asset metadata');
  if (value.format !== 'lumina-library-asset-metadata' || value.version !== 1) {
    throw new CorruptLibraryError('Asset metadata schema is unsupported.');
  }
  try {
    validateAssetMetadata(value.metadata, 'asset metadata');
  } catch (error) {
    if (error instanceof CorruptLibraryError) throw error;
    throw new CorruptLibraryError('Asset metadata failed schema admission.', { cause: error });
  }
  const encoded = encoder.encode(canonicalize(value));
  if (encoded.byteLength > MAX_ASSET_METADATA_BYTES) {
    throw new CorruptLibraryError('Asset metadata exceeds the v1 limit.');
  }
  return value;
}
