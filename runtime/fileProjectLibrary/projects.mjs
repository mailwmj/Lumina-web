import { assertExpectedRevision, chooseRevision, collectAssetReferences, normalizeProjectRecord, validateRecovery } from './admission.mjs';
import { parseAssetMetadataDocument, parseHistoryDocument, parseProjectDocument, parseProjectManifest, readProjectSnapshotDocuments, validateProjectRecoveryEvidence } from './catalog.mjs';
import { CorruptLibraryError, DIGEST_PATTERN, FileProjectLibraryError, MAX_ASSET_METADATA_BYTES, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, assertExpectedCatalogRevision, canonicalize, compareUtf8, encoder, makeLibraryKey, parseJsonString, parseStrictJson, path, sha256, validateLibraryKey, validateLogicalId } from './core.mjs';
import { ensureNoSymlinkPath, managedPath, readCanonicalFile, readFileBytesBounded } from './filesystem.mjs';
import { publishNextCatalog, stageProject } from './publication.mjs';

export async function listProjects(state, catalog) {
  const summaries = [];
  for (const entry of catalog.commit.projects) {
    const record = await readProjectSnapshot(state, entry);
    summaries.push({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nodeCount: record.nodeCount,
    });
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}

export async function openProject(state, catalog, projectId) {
  validateLogicalId(projectId, 'projectId');
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === projectId);
  return entry ? readProjectSnapshot(state, entry) : null;
}

export async function readProjectSnapshot(state, entry) {
  return readProjectSnapshotSource(state, entry);
}

export async function readProjectSnapshotSource(state, entry) {
  validateLibraryKey(entry.projectKey, 'p');
  validateLibraryKey(entry.snapshotKey, 's');
  const expectedManifestPath = `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}/manifest.json`;
  if (entry.manifestPath !== expectedManifestPath || !DIGEST_PATTERN.test(entry.manifestSha256)) {
    throw new CorruptLibraryError('Project catalog path is invalid.');
  }
  const base = managedPath(state, `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}`);
  await ensureNoSymlinkPath(state, base);
  const manifestBytes = await readCanonicalFile(state, path.join(base, 'manifest.json'), 'project manifest');
  if (sha256(manifestBytes) !== entry.manifestSha256) throw new CorruptLibraryError('Project manifest digest is invalid.');
  const manifest = parseProjectManifest(manifestBytes);
  if (manifest.projectId !== entry.projectId || manifest.projectKey !== entry.projectKey
    || manifest.snapshotKey !== entry.snapshotKey || manifest.revision !== entry.revision) {
    throw new CorruptLibraryError('Project manifest does not match its catalog entry.');
  }
  const { project, history } = await readProjectSnapshotDocuments(state, base);
  if (
    project.id !== entry.projectId
    || project.revision !== entry.revision
    || (Object.hasOwn(project, 'recovery')
      && canonicalize(manifest.recovery) !== canonicalize(project.recovery))
  ) {
    throw new CorruptLibraryError('Project snapshot does not match its catalog entry.');
  }
  if (manifest.recovery?.recoveryId) {
    await validateProjectRecoveryEvidence(state, manifest.recovery);
  }
  return fromProjectDocument(
    project,
    history,
    manifest.recovery ? { reason: manifest.recovery.reason } : null,
  );
}

export function fromProjectDocument(project, history, recovery = null) {
  const validatedProject = parseProjectDocument(encoder.encode(canonicalize(project)));
  const validatedHistory = parseHistoryDocument(encoder.encode(canonicalize(history)));
  const effectiveRecovery = recovery
    ? validateRecovery(recovery)
    : validatedProject.recovery
      ? validateRecovery(validatedProject.recovery)
      : null;
  const nodesValue = Object.hasOwn(validatedProject, 'imagePool')
    ? { nodes: validatedProject.nodes, imagePool: validatedProject.imagePool }
    : validatedProject.nodes;
  return {
    id: validatedProject.id,
    name: validatedProject.name,
    createdAt: validatedProject.createdAt,
    updatedAt: validatedProject.updatedAt,
    nodeCount: validatedProject.nodeCount,
    schemaVersion: validatedProject.schemaVersion,
    revision: validatedProject.revision,
    ...(effectiveRecovery ? { recovery: effectiveRecovery } : {}),
    nodesJson: canonicalize(nodesValue),
    edgesJson: canonicalize(validatedProject.edges),
    viewportJson: canonicalize(validatedProject.viewport),
    historyJson: canonicalize(validatedHistory),
  };
}

export async function recoverCorruptProjectSnapshots(state, catalog) {
  let recoveredCatalog = catalog;
  for (const entry of catalog.commit.projects) {
    try {
      await readProjectSnapshotSource(state, entry);
    } catch (error) {
      if (!(error instanceof CorruptLibraryError)) throw error;
      recoveredCatalog = await preserveProjectRecovery(state, recoveredCatalog, entry, error);
    }
  }
  return recoveredCatalog;
}

export async function preserveProjectRecovery(state, catalog, entry, error) {
  const base = managedPath(state, `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}`);
  const projectBytes = await readFileBytesBounded(
    state,
    path.join(base, 'project.json'),
    MAX_PROJECT_DOCUMENT_BYTES,
    'project recovery source',
  );
  const historyBytes = await readFileBytesBounded(
    state,
    path.join(base, 'history.json'),
    MAX_HISTORY_DOCUMENT_BYTES,
    'history recovery source',
  );
  const recoveredAt = state.clock();
  if (!Number.isSafeInteger(recoveredAt) || recoveredAt < 0) {
    throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid timestamp.');
  }
  const recoveryId = makeLibraryKey('r');
  const snapshotKey = makeLibraryKey('s');
  const recoveryDirectory = `projects/${entry.projectKey}/snapshots/${snapshotKey}/recovery`;
  const sourceProjectPath = `${recoveryDirectory}/${recoveryId}-source-project.json`;
  const sourceHistoryPath = `${recoveryDirectory}/${recoveryId}-source-history.json`;
  const recovery = {
    reason: recoveryReason(error),
    recoveryId,
    sourceProjectPath,
    sourceProjectSha256: sha256(projectBytes),
    sourceHistoryPath,
    sourceHistorySha256: sha256(historyBytes),
    observedSchemaVersion: observedSchemaVersion(projectBytes),
    recoveredAt,
  };
  const record = projectRecordFromRecovery(entry, recovery);
  const ownedAssetIds = new Set(
    catalog.commit.assets
      .filter((asset) => asset.projectId === entry.projectId)
      .map((asset) => asset.assetId),
  );
  const transactionId = makeLibraryKey('t');
  const staged = await stageProject(
    state,
    record,
    transactionId,
    ownedAssetIds,
    {
      projectKey: entry.projectKey,
      snapshotKey,
      manifestRecovery: recovery,
      recoverySources: { recoveryId, projectBytes, historyBytes },
    },
  );
  const projects = catalog.commit.projects
    .filter((candidate) => candidate.projectId !== entry.projectId)
    .concat(staged)
    .sort((left, right) => compareUtf8(left.projectId, right.projectId));
  return publishNextCatalog(
    state,
    catalog,
    { projects, assets: catalog.commit.assets },
    'project-recovery',
    {
      transactionId,
      expectedCatalog: catalog.revision,
      expectedProjectRevisions: [{ projectId: entry.projectId, expectedRevision: entry.revision }],
    },
  );
}

export function recoveryReason(error) {
  const messages = [];
  for (let current = error; current && messages.length < 8; current = current.cause) {
    messages.push(current.message ?? '');
  }
  return /schema|unknown|unsupported|duplicate/u.test(messages.join('\n'))
    ? 'unsupported_schema'
    : 'migration_failed';
}

export function observedSchemaVersion(bytes) {
  try {
    const value = parseStrictJson(bytes, 'project recovery source');
    return Number.isSafeInteger(value?.schemaVersion) && value.schemaVersion >= 0
      ? value.schemaVersion
      : null;
  } catch {
    return null;
  }
}

export async function readProjectRecovery(state, entry) {
  const base = managedPath(state, `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}`);
  const manifest = parseProjectManifest(
    await readCanonicalFile(state, path.join(base, 'manifest.json'), 'project manifest'),
  );
  if (manifest.projectId !== entry.projectId
    || manifest.projectKey !== entry.projectKey
    || manifest.snapshotKey !== entry.snapshotKey
    || manifest.revision !== entry.revision
    || !manifest.recovery?.recoveryId) {
    return null;
  }
  await validateProjectRecoveryEvidence(state, manifest.recovery);
  return manifest.recovery;
}

export function projectRecordFromRecovery(entry, recovery) {
  return {
    id: entry.projectId,
    name: `Recovery required: ${entry.projectId}`,
    createdAt: recovery.recoveredAt,
    updatedAt: recovery.recoveredAt,
    nodeCount: 0,
    schemaVersion: 1,
    revision: entry.revision,
    recovery: { reason: recovery.reason },
    nodesJson: '{"imagePool":[],"nodes":[]}',
    edgesJson: '[]',
    viewportJson: '{"x":0,"y":0,"zoom":1}',
    historyJson: '{"future":[],"past":[]}',
  };
}

export async function saveProject(state, catalog, input, writeOptions = {}) {
  const record = normalizeProjectRecord(input);
  assertExpectedCatalogRevision(writeOptions?.expectedCatalog, catalog.revision);
  const currentEntry = catalog.commit.projects.find((entry) => entry.projectId === record.id);
  if (currentEntry) {
    const currentRecord = await readProjectSnapshot(state, currentEntry);
    if (currentRecord.recovery) {
      throw new FileProjectLibraryError(
        'project_read_only_recovery',
        'A project in recovery is read-only until it is explicitly repaired.',
        { projectId: record.id, recovery: currentRecord.recovery },
      );
    }
  }
  const actualRevision = currentEntry?.revision ?? 'absent';
  assertExpectedRevision(record.id, writeOptions?.expectedRevision, actualRevision);
  const revision = chooseRevision(record.revision, currentEntry?.revision);
  const nextRecord = { ...record, revision };
  const references = collectAssetReferences({
    nodes: parseJsonString(nextRecord.nodesJson, 'nodes'),
    history: parseJsonString(nextRecord.historyJson, 'history'),
  });
  for (const assetId of references) {
    const asset = catalog.commit.assets.find((candidate) => candidate.assetId === assetId);
    if (!asset || asset.projectId !== record.id) {
      throw new FileProjectLibraryError(
        'asset_reference_missing',
        'Project references an asset that is not an owned durable fact.',
        { assetId, projectId: record.id },
      );
    }
    const metadata = parseAssetMetadataDocument(await readCanonicalFile(
      state,
      managedPath(state, asset.metadataPath),
      'referenced asset metadata',
      MAX_ASSET_METADATA_BYTES,
    ));
    if (metadata.metadata.lifecycleState === 'deletion-candidate') {
      throw new FileProjectLibraryError(
        'asset_still_reachable',
        'A deletion-candidate asset cannot be reintroduced into a project snapshot.',
        { assetId, projectId: record.id },
      );
    }
  }
  const transactionId = makeLibraryKey('t');
  const ownedAssetIds = new Set(
    catalog.commit.assets
      .filter((entry) => entry.projectId === record.id)
      .map((entry) => entry.assetId),
  );
  const nextProjects = catalog.commit.projects
    .filter((entry) => entry.projectId !== record.id)
    .concat(await stageProject(state, nextRecord, transactionId, ownedAssetIds));
  nextProjects.sort((left, right) => compareUtf8(left.projectId, right.projectId));
  const nextCommit = await publishNextCatalog(state, catalog, {
    projects: nextProjects,
    assets: catalog.commit.assets,
  }, 'project-mutation', {
    transactionId,
    expectedCatalog: writeOptions.expectedCatalog,
    expectedProjectRevisions: [{ projectId: record.id, expectedRevision: writeOptions.expectedRevision }],
  });
  return { code: 'applied', record: nextRecord, revision, catalog: nextCommit.revision };
}

export async function updateViewport(state, catalog, projectId, viewportJson, writeOptions = {}) {
  const current = await openProject(state, catalog, projectId);
  if (!current) return { code: 'not_found', projectId };
  const viewport = parseJsonString(viewportJson, 'viewport');
  const next = {
    ...current,
    viewportJson: canonicalize(viewport),
    revision: undefined,
  };
  return saveProject(state, catalog, next, writeOptions);
}

export async function renameProject(state, catalog, projectId, name, updatedAt, writeOptions = {}) {
  const current = await openProject(state, catalog, projectId);
  if (!current) return { code: 'not_found', projectId };
  if (typeof name !== 'string' || name.length === 0) {
    throw new FileProjectLibraryError('invalid_project', 'Project name is invalid.');
  }
  return saveProject(state, catalog, { ...current, name, updatedAt, revision: undefined }, writeOptions);
}
