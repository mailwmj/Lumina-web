import { admitCanvasEdges, admitCanvasNodes, admitHistorySnapshots, collectAssetReferences, rejectProjectSecrets, validateAssetCatalogEntry, validateAssetMetadata, validateImagePool, validateProjectRevision, validateRecovery, validateViewportValue } from './admission.mjs';
import { ADMISSION_REGISTRY, CorruptLibraryError, DIGEST_PATTERN, LIBRARY_FORMAT, LIBRARY_VERSION, MAX_ASSET_METADATA_BYTES, MAX_DURABLE_ASSET_BYTES, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, QUARANTINE_RETENTION_MS, assertExactFields, assertSortedUnique, canonicalize, compareUtf8, encoder, parseStrictJson, path, sha256, validateLibraryKey, validateLogicalId } from './core.mjs';
import { ensureNoSymlinkPath, hashFileBytes, managedPath, pathExists, readCanonicalFile } from './filesystem.mjs';

export async function readCatalog(state) {
  try {
    const headBytes = await readCanonicalFile(managedPath(state, 'head.json'), 'head');
    const head = parseHead(headBytes);
    await validateCatalogForHead(state, head);
    const commit = parseCommit(await readCanonicalFile(
      managedPath(state, `commits/${head.commitId}.json`),
      'catalog commit',
    ));
    return { head, commit, revision: { commitId: head.commitId, sequence: commit.sequence, commitSha256: head.commitSha256 } };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'path_escape' || error?.code === 'corrupt_schema') throw error;
    throw new CorruptLibraryError('The visible catalog is invalid.', { cause: error });
  }
}

export async function validateCatalogForHead(state, head) {
  validateLibraryKey(head.commitId, 'c');
  if (!DIGEST_PATTERN.test(head.commitSha256)) throw new CorruptLibraryError('Head digest is invalid.');
  if (head.previousCommitId !== null) validateLibraryKey(head.previousCommitId, 'c');
  if (head.previousCommitId === head.commitId) throw new CorruptLibraryError('Head cannot point to itself.');
  const commitBytes = await readCanonicalFile(managedPath(state, `commits/${head.commitId}.json`), 'catalog commit');
  const commit = parseCommit(commitBytes);
  if (
    commit.commitId !== head.commitId
    || commit.previousCommitId !== head.previousCommitId
    || (head.previousCommitId === null && commit.sequence !== 0)
    || (head.previousCommitId !== null && commit.sequence <= 0)
    || sha256(canonicalize(commit)) !== head.commitSha256
  ) {
    throw new CorruptLibraryError('Head and catalog commit do not agree.');
  }
  // The predecessor is provenance, not a recursive retention edge. Validate
  // the one immediately named predecessor when it is still retained, while
  // allowing older commits to be bounded-cleaned independently.
  if (commit.previousCommitId !== null) {
    const previousPath = managedPath(state, `commits/${commit.previousCommitId}.json`);
    if (await pathExists(previousPath)) {
      const previous = parseCommit(await readCanonicalFile(previousPath, 'previous catalog commit'));
      if (previous.commitId !== commit.previousCommitId || previous.sequence !== commit.sequence - 1) {
        throw new CorruptLibraryError('Catalog commit provenance is invalid.');
      }
    }
  }
  await validateCatalogPayloads(state, commit);
  return commit;
}

export async function validateCatalogPayloads(state, commit) {
  const projectReferences = new Map();
  const assetLifecycle = new Map();
  for (const entry of commit.projects) {
    assertExactFields(
      entry,
      ['projectId', 'projectKey', 'snapshotKey', 'revision', 'manifestPath', 'manifestSha256'],
      [],
      'project catalog entry',
    );
    validateLogicalId(entry.projectId, 'project catalog projectId');
    validateProjectRevision(entry.revision, 'project catalog revision');
    validateLibraryKey(entry.projectKey, 'p');
    validateLibraryKey(entry.snapshotKey, 's');
    const expectedPath = `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}/manifest.json`;
    if (entry.manifestPath !== expectedPath || !DIGEST_PATTERN.test(entry.manifestSha256)) {
      throw new CorruptLibraryError('Project catalog entry is invalid.');
    }
    const base = managedPath(state, `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}`);
    try {
      await ensureNoSymlinkPath(state.root, base);
      const manifestBytes = await readCanonicalFile(path.join(base, 'manifest.json'), 'project manifest');
      if (sha256(manifestBytes) !== entry.manifestSha256) throw new CorruptLibraryError('Project manifest digest is invalid.');
      const manifest = parseProjectManifest(manifestBytes);
      if (manifest.projectId !== entry.projectId
        || manifest.projectKey !== entry.projectKey
        || manifest.snapshotKey !== entry.snapshotKey
        || manifest.revision !== entry.revision) {
        throw new CorruptLibraryError('Project manifest does not match its catalog entry.');
      }
      const { project, history } = await readProjectSnapshotDocuments(state, base);
      if (
        project.id !== entry.projectId
        || project.revision !== entry.revision
        || (Object.hasOwn(project, 'recovery')
          && canonicalize(manifest.recovery) !== canonicalize(project.recovery))
        || history.past.length > ADMISSION_REGISTRY.limits.maxPersistedHistorySnapshotsPerDirection
        || history.future.length > ADMISSION_REGISTRY.limits.maxPersistedHistorySnapshotsPerDirection
      ) {
        throw new CorruptLibraryError('Project snapshot does not match its catalog entry.');
      }
      projectReferences.set(entry.projectId, collectAssetReferences({ nodes: project.nodes, history }));
    } catch (error) {
      if (!(error instanceof CorruptLibraryError)) throw error;
      // Startup recovery preserves invalid snapshot bytes as a read-only fact.
    }
  }
  for (const entry of commit.assets) {
    assertExactFields(
      entry,
      ['assetId', 'projectId', 'assetKey', 'metadataFormat', 'metadataVersion', 'metadataPath', 'metadataSha256', 'bytesPath', 'byteCount', 'bytesSha256'],
      [],
      'asset catalog entry',
    );
    validateLogicalId(entry.assetId, 'asset catalog assetId');
    validateLibraryKey(entry.assetKey, 'a');
    validateLogicalId(entry.projectId, 'asset projectId');
    if (
      entry.metadataPath !== `assets/${entry.assetKey}/metadata/${entry.metadataSha256}.json`
      || entry.bytesPath !== `assets/${entry.assetKey}/bytes.bin`
      || !DIGEST_PATTERN.test(entry.metadataSha256)
      || !DIGEST_PATTERN.test(entry.bytesSha256)
      || !Number.isSafeInteger(entry.byteCount)
      || entry.byteCount < 0
      || entry.byteCount > MAX_DURABLE_ASSET_BYTES
    ) {
      throw new CorruptLibraryError('Asset catalog entry is invalid.');
    }
    await ensureNoSymlinkPath(state.root, managedPath(state, `assets/${entry.assetKey}`));
    const metadataBytes = await readCanonicalFile(
      managedPath(state, entry.metadataPath),
      'asset metadata',
      MAX_ASSET_METADATA_BYTES,
    );
    const metadata = parseAssetMetadataDocument(metadataBytes);
    validateAssetCatalogEntry(entry, metadata);
    if (metadata.metadata.lifecycleState === 'staging') {
      throw new CorruptLibraryError('Staging assets cannot be visible in a catalog.');
    }
    assetLifecycle.set(entry.assetId, metadata.metadata.lifecycleState);
    const bytesPath = managedPath(state, entry.bytesPath);
    await ensureNoSymlinkPath(state.root, bytesPath);
    const hashed = await hashFileBytes(bytesPath, entry.byteCount);
    if (hashed.byteCount !== entry.byteCount || hashed.sha256 !== entry.bytesSha256) {
      throw new CorruptLibraryError('Asset bytes failed integrity validation.');
    }
  }
  const assetsById = new Map(commit.assets.map((entry) => [entry.assetId, entry]));
  for (const [projectId, references] of projectReferences) {
    for (const assetId of references) {
      const asset = assetsById.get(assetId);
      if (!asset || asset.projectId !== projectId) {
        throw new CorruptLibraryError('Project asset reference closure is invalid.');
      }
      if (assetLifecycle.get(assetId) === 'deletion-candidate') {
        throw new CorruptLibraryError('A deletion-candidate asset remains referenced.');
      }
    }
  }
}

export async function readProjectSnapshotDocuments(state, base) {
  const project = parseProjectDocument(await readCanonicalFile(
    path.join(base, 'project.json'),
    'project snapshot',
    MAX_PROJECT_DOCUMENT_BYTES,
  ));
  const history = parseHistoryDocument(await readCanonicalFile(
    path.join(base, 'history.json'),
    'history snapshot',
    MAX_HISTORY_DOCUMENT_BYTES,
  ));
  return { project, history };
}

export function parseLibraryManifest(bytes) {
  const value = parseStrictJson(bytes, 'library manifest');
  assertExactFields(
    value,
    ['format', 'version', 'libraryId', 'libraryRootId', 'importOperationNamespace'],
    [],
    'library manifest',
  );
  if (
    value.format !== LIBRARY_FORMAT
    || value.version !== LIBRARY_VERSION
    || typeof value.libraryId !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(value.libraryId)
    || !/^[0-9a-f]{32}$/u.test(value.libraryRootId)
    || !/^[0-9a-f]{32}$/u.test(value.importOperationNamespace)
  ) {
    throw new CorruptLibraryError('Library manifest schema is unsupported.');
  }
  return value;
}

export function parseHead(bytes) {
  const value = parseStrictJson(bytes, 'head');
  assertExactFields(value, ['format', 'version', 'commitId', 'commitSha256', 'previousCommitId'], [], 'head');
  if (value.format !== 'lumina-library-head' || value.version !== 1) {
    throw new CorruptLibraryError('Head schema is unsupported.');
  }
  return value;
}

export function parseCommit(bytes) {
  const value = parseStrictJson(bytes, 'catalog commit');
  assertExactFields(
    value,
    ['format', 'version', 'commitId', 'previousCommitId', 'sequence', 'runtimeAttachment', 'projects', 'assets', 'completedImports'],
    [],
    'catalog commit',
  );
  if (
    value.format !== 'lumina-library-commit'
    || value.version !== 1
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || !Array.isArray(value.projects)
    || !Array.isArray(value.assets)
  ) {
    throw new CorruptLibraryError('Catalog commit schema is unsupported.');
  }
  validateLibraryKey(value.commitId, 'c');
  if (value.previousCommitId !== null) validateLibraryKey(value.previousCommitId, 'c');
  if (value.previousCommitId === value.commitId) throw new CorruptLibraryError('Catalog commit cannot point to itself.');
  if (value.runtimeAttachment !== null || !Array.isArray(value.completedImports) || value.completedImports.length !== 0) {
    throw new CorruptLibraryError('Catalog commit optional state is unsupported.');
  }
  value.projects.forEach((entry) => {
    assertExactFields(
      entry,
      ['projectId', 'projectKey', 'snapshotKey', 'revision', 'manifestPath', 'manifestSha256'],
      [],
      'project catalog entry',
    );
    validateProjectRevision(entry.revision, 'project catalog revision');
  });
  value.assets.forEach((entry) => {
    assertExactFields(
      entry,
      ['assetId', 'projectId', 'assetKey', 'metadataFormat', 'metadataVersion', 'metadataPath', 'metadataSha256', 'bytesPath', 'byteCount', 'bytesSha256'],
      [],
      'asset catalog entry',
    );
  });
  assertSortedUnique(value.projects, (entry) => entry.projectId, 'project catalog');
  assertSortedUnique(value.assets, (entry) => entry.assetId, 'asset catalog');
  return value;
}

export function parsePublish(bytes) {
  const value = parseStrictJson(bytes, 'publish record');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'operation', 'priorCommitId', 'priorCommitSha256', 'intendedCommitId', 'intendedSequence', 'intendedCommitSha256', 'payloads', 'createdAt'],
    [],
    'publish record',
  );
  if (
    value.format !== 'lumina-library-publish'
    || value.version !== 1
    || typeof value.transactionId !== 'string'
    || typeof value.intendedCommitId !== 'string'
    || typeof value.intendedCommitSha256 !== 'string'
  ) {
    throw new CorruptLibraryError('Publish record schema is unsupported.');
  }
  validateLibraryKey(value.transactionId, 't');
  validateLibraryKey(value.priorCommitId, 'c');
  validateLibraryKey(value.intendedCommitId, 'c');
  if (!DIGEST_PATTERN.test(value.priorCommitSha256)
    || !Number.isSafeInteger(value.intendedSequence)
    || value.intendedSequence < 0
    || !DIGEST_PATTERN.test(value.intendedCommitSha256)
    || !Number.isSafeInteger(value.createdAt)) {
    throw new CorruptLibraryError('Publish record fields are invalid.');
  }
  validatePublishPayloads(value.payloads);
  if (!value.payloads.some((entry) => (
    entry.path === `commits/${value.intendedCommitId}.json`
    && entry.sha256 === value.intendedCommitSha256
  ))) {
    throw new CorruptLibraryError('Publish record does not retain its intended catalog payload.');
  }
  return value;
}

export function parseQuarantineManifest(bytes, transactionId) {
  const value = parseStrictJson(bytes, 'quarantine manifest');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'reason', 'publish', 'retained', 'failedAt', 'retainedUntil'],
    [],
    'quarantine manifest',
  );
  if (value.format !== 'lumina-library-quarantine'
    || value.version !== 1
    || value.transactionId !== transactionId
    || typeof value.reason !== 'string'
    || value.reason.length === 0
    || !Number.isSafeInteger(value.failedAt)
    || value.failedAt < 0
    || !Number.isSafeInteger(value.retainedUntil)
    || value.retainedUntil !== value.failedAt + QUARANTINE_RETENTION_MS) {
    throw new CorruptLibraryError('Quarantine manifest identity is invalid.');
  }
  validateLibraryKey(transactionId, 't');
  let publish = null;
  try {
    if (value.publish !== null) publish = parsePublish(encoder.encode(canonicalize(value.publish)));
  } catch (error) {
    throw new CorruptLibraryError('Quarantine publish record is invalid.', { cause: error });
  }
  if (!Array.isArray(value.retained) || value.retained.length > 100_000) {
    throw new CorruptLibraryError('Quarantine retained payloads are invalid.');
  }
  const retained = new Map();
  let previousPath = null;
  for (const entry of value.retained) {
    assertExactFields(entry, ['path', 'sha256'], [], 'quarantine retained payload');
    if (typeof entry.path !== 'string'
      || !isManagedQuarantineRetainedPath(entry.path, transactionId)
      || !DIGEST_PATTERN.test(entry.sha256)
      || retained.has(entry.path)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Quarantine retained payload is invalid.');
    }
    retained.set(entry.path, entry.sha256);
    previousPath = entry.path;
  }
  if (publish) {
    for (const payload of publish.payloads) {
      if (retained.get(payload.path) !== payload.sha256) {
        throw new CorruptLibraryError('Quarantine does not retain every final publication payload.');
      }
    }
  }
  return value;
}

export function parseQuarantineCleanup(bytes, transactionId) {
  const value = parseStrictJson(bytes, 'quarantine cleanup receipt');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'manifestSha256', 'rootSetSha256', 'entries', 'checkedAt', 'state', 'completedAt', 'retainedUntil'],
    [],
    'quarantine cleanup receipt',
  );
  if (value.format !== 'lumina-library-quarantine-cleanup'
    || value.version !== 1
    || value.transactionId !== transactionId
    || !DIGEST_PATTERN.test(value.manifestSha256)
    || !DIGEST_PATTERN.test(value.rootSetSha256)
    || !Number.isSafeInteger(value.checkedAt)
    || !['authorized', 'complete'].includes(value.state)
    || !Array.isArray(value.entries)
    || value.entries.length > 100_000) {
    throw new CorruptLibraryError('Quarantine cleanup receipt is invalid.');
  }
  validateLibraryKey(transactionId, 't');
  if (value.state === 'authorized') {
    if (value.completedAt !== null || value.retainedUntil !== null) {
      throw new CorruptLibraryError('Authorized quarantine cleanup receipt has terminal timestamps.');
    }
  } else if (!Number.isSafeInteger(value.completedAt)
    || !Number.isSafeInteger(value.retainedUntil)
    || value.retainedUntil !== value.completedAt + QUARANTINE_RETENTION_MS) {
    throw new CorruptLibraryError('Completed quarantine cleanup receipt has invalid retention.');
  }
  let previousPath = null;
  for (const entry of value.entries) {
    assertExactFields(entry, ['path', 'sha256'], [], 'quarantine cleanup entry');
    if (typeof entry.path !== 'string'
      || !isManagedQuarantineRetainedPath(entry.path, transactionId)
      || !DIGEST_PATTERN.test(entry.sha256)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Quarantine cleanup entry is invalid.');
    }
    previousPath = entry.path;
  }
  return value;
}

export function validatePublishPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 100_000) {
    throw new CorruptLibraryError('Publish record payloads are invalid.');
  }
  let previousPath = null;
  for (const entry of payloads) {
    assertExactFields(entry, ['path', 'sha256'], [], 'publish payload');
    if (typeof entry.path !== 'string'
      || !isManagedPublicationPath(entry.path)
      || !DIGEST_PATTERN.test(entry.sha256)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Publish record payload is invalid.');
    }
    previousPath = entry.path;
  }
}

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
    if (value.recovery !== null) validateRecovery(value.recovery);
  } catch (error) {
    if (error instanceof CorruptLibraryError) throw error;
    throw new CorruptLibraryError('Project manifest schema is invalid.', { cause: error });
  }
  return value;
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

export function parseCleanupPlan(bytes, transactionId) {
  const value = parseStrictJson(bytes, 'garbage-collection plan');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'visibleCommitId', 'rootSetSha256', 'entries', 'plannedAt', 'notBefore', 'state', 'authorizedAt', 'completedAt', 'retainedUntil'],
    [],
    'garbage-collection plan',
  );
  if (value.format !== 'lumina-library-gc' || value.version !== 1 || value.transactionId !== transactionId) {
    throw new CorruptLibraryError('Garbage-collection plan identity is invalid.');
  }
  validateLibraryKey(value.transactionId, 't');
  validateLibraryKey(value.visibleCommitId, 'c');
  if (!DIGEST_PATTERN.test(value.rootSetSha256)
    || !Array.isArray(value.entries)
    || value.entries.length > 100_000
    || !Number.isSafeInteger(value.plannedAt)
    || !Number.isSafeInteger(value.notBefore)
    || !['planned', 'authorized', 'complete', 'cancelled'].includes(value.state)) {
    throw new CorruptLibraryError('Garbage-collection plan fields are invalid.');
  }
  if (value.authorizedAt !== null && !Number.isSafeInteger(value.authorizedAt)) {
    throw new CorruptLibraryError('Garbage-collection authorization timestamp is invalid.');
  }
  if (value.completedAt !== null && !Number.isSafeInteger(value.completedAt)) {
    throw new CorruptLibraryError('Garbage-collection completion timestamp is invalid.');
  }
  if (value.retainedUntil !== null && !Number.isSafeInteger(value.retainedUntil)) {
    throw new CorruptLibraryError('Garbage-collection retention timestamp is invalid.');
  }
  let previousPath = null;
  for (const entry of value.entries) {
    assertExactFields(entry, ['path', 'sha256'], [], 'garbage-collection entry');
    const normalizedPath = typeof entry.path === 'string' ? path.posix.normalize(entry.path) : null;
    if (typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.includes('\\')
      || entry.path.startsWith('/') || normalizedPath !== entry.path
      || !isManagedCleanupPath(entry.path)
      || !DIGEST_PATTERN.test(entry.sha256)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Garbage-collection entry is invalid.');
    }
    previousPath = entry.path;
  }
  return value;
}

export function isManagedCleanupPath(relative) {
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
    return false;
  }
  if (segments[0] === 'commits') {
    return segments.length === 2 && /^c_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'attachments') {
    return segments.length === 2 && /^b_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'assets') {
    return segments.length >= 3 && /^a_[0-9a-f]{32}$/u.test(segments[1]);
  }
  if (segments[0] === 'projects') {
    return segments.length >= 5
      && /^p_[0-9a-f]{32}$/u.test(segments[1])
      && segments[2] === 'snapshots'
      && /^s_[0-9a-f]{32}$/u.test(segments[3]);
  }
  return false;
}

export function isManagedPublicationPath(relative) {
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
    return false;
  }
  if (segments[0] === 'commits') {
    return segments.length === 2 && /^c_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'attachments') {
    return segments.length === 2 && /^b_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'assets') {
    if (!/^a_[0-9a-f]{32}$/u.test(segments[1])) return false;
    return (segments.length === 3 && segments[2] === 'bytes.bin')
      || (segments.length === 4 && segments[2] === 'metadata' && /^[0-9a-f]{64}\.json$/u.test(segments[3]));
  }
  if (segments[0] === 'projects') {
    return segments.length === 5
      && /^p_[0-9a-f]{32}$/u.test(segments[1])
      && segments[2] === 'snapshots'
      && /^s_[0-9a-f]{32}$/u.test(segments[3])
      && ['manifest.json', 'project.json', 'history.json'].includes(segments[4]);
  }
  return false;
}

export function isManagedQuarantineRetainedPath(relative, transactionId) {
  if (isManagedPublicationPath(relative)) return true;
  const segments = relative.split('/');
  return segments.length >= 3
    && segments[0] === 'quarantine'
    && segments[1] === transactionId
    && segments.slice(2).every((segment) => /^[A-Za-z0-9_.-]+$/u.test(segment))
    && !(segments.length === 3 && ['manifest.json', 'cleanup.json'].includes(segments[2]));
}
