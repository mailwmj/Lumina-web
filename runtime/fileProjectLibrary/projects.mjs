import { assertExpectedRevision, chooseRevision, collectAssetReferences, normalizeProjectRecord, validateRecovery } from './admission.mjs';
import { parseHistoryDocument, parseProjectDocument, parseProjectManifest, readProjectSnapshotDocuments } from './catalog.mjs';
import { CorruptLibraryError, DIGEST_PATTERN, FileProjectLibraryError, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, assertExactFields, canonicalize, compareUtf8, encoder, fs, makeLibraryKey, parseJsonString, parseStrictJson, path, sha256, validateLibraryKey, validateLogicalId } from './core.mjs';
import { ensureNoSymlinkPath, hashFileBytes, managedPath, readCanonicalFile, readFileBytesBounded, writeCanonicalBytes } from './filesystem.mjs';
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
  try {
    return await readProjectSnapshotSource(state, entry);
  } catch (error) {
    if (!(error instanceof CorruptLibraryError)) throw error;
    const recovery = await readProjectRecovery(state, entry);
    if (!recovery) throw error;
    return projectRecordFromRecovery(entry, recovery);
  }
}

export async function readProjectSnapshotSource(state, entry) {
  validateLibraryKey(entry.projectKey, 'p');
  validateLibraryKey(entry.snapshotKey, 's');
  const expectedManifestPath = `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}/manifest.json`;
  if (entry.manifestPath !== expectedManifestPath || !DIGEST_PATTERN.test(entry.manifestSha256)) {
    throw new CorruptLibraryError('Project catalog path is invalid.');
  }
  const base = managedPath(state, `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}`);
  await ensureNoSymlinkPath(state.root, base);
  const manifestBytes = await readCanonicalFile(path.join(base, 'manifest.json'), 'project manifest');
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
  return fromProjectDocument(project, history, manifest.recovery);
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
  for (const entry of catalog.commit.projects) {
    try {
      await readProjectSnapshotSource(state, entry);
    } catch (error) {
      if (!(error instanceof CorruptLibraryError)) throw error;
      if (await readProjectRecovery(state, entry)) continue;
      await preserveProjectRecovery(state, entry, error);
    }
  }
}

export async function preserveProjectRecovery(state, entry, error) {
  const base = managedPath(state, `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}`);
  const projectBytes = await readFileBytesBounded(
    path.join(base, 'project.json'),
    MAX_PROJECT_DOCUMENT_BYTES,
    'project recovery source',
  );
  const historyBytes = await readFileBytesBounded(
    path.join(base, 'history.json'),
    MAX_HISTORY_DOCUMENT_BYTES,
    'history recovery source',
  );
  const recoveredAt = state.clock();
  if (!Number.isSafeInteger(recoveredAt) || recoveredAt < 0) {
    throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid timestamp.');
  }
  const recoveryId = makeLibraryKey('r');
  const recoveryDirectory = `projects/${entry.projectKey}/recovery`;
  const sourceProjectPath = `${recoveryDirectory}/${recoveryId}-source-project.json`;
  const sourceHistoryPath = `${recoveryDirectory}/${recoveryId}-source-history.json`;
  await writeCanonicalBytes(state, managedPath(state, sourceProjectPath), projectBytes);
  await writeCanonicalBytes(state, managedPath(state, sourceHistoryPath), historyBytes);
  const recovery = {
    format: 'lumina-library-project-recovery',
    version: 1,
    recoveryId,
    projectId: entry.projectId,
    projectKey: entry.projectKey,
    snapshotKey: entry.snapshotKey,
    revision: entry.revision,
    reason: recoveryReason(error),
    sourceProjectPath,
    sourceProjectSha256: sha256(projectBytes),
    sourceHistoryPath,
    sourceHistorySha256: sha256(historyBytes),
    recoveredAt,
  };
  await writeCanonicalBytes(
    state,
    managedPath(state, `${recoveryDirectory}/${recoveryId}.json`),
    encoder.encode(canonicalize(recovery)),
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

export async function readProjectRecovery(state, entry) {
  const recoveryDirectory = managedPath(state, `projects/${entry.projectKey}/recovery`);
  let names;
  try {
    names = await fs.readdir(recoveryDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const records = names
    .filter((item) => item.isFile() && /^r_[0-9a-f]{32}\.json$/u.test(item.name))
    .map((item) => item.name)
    .sort(compareUtf8);
  if (records.length === 0) return null;
  if (records.length !== 1 || names.some((item) => item.isSymbolicLink())) {
    throw new CorruptLibraryError('Project recovery records are ambiguous or unsafe.');
  }
  const recoveryPath = path.join(recoveryDirectory, records[0]);
  const recovery = parseProjectRecoveryRecord(
    await readCanonicalFile(recoveryPath, 'project recovery', MAX_PROJECT_DOCUMENT_BYTES),
    entry,
  );
  const projectSource = await hashFileBytes(
    managedPath(state, recovery.sourceProjectPath),
    MAX_PROJECT_DOCUMENT_BYTES,
  );
  const historySource = await hashFileBytes(
    managedPath(state, recovery.sourceHistoryPath),
    MAX_HISTORY_DOCUMENT_BYTES,
  );
  if (projectSource.sha256 !== recovery.sourceProjectSha256 || historySource.sha256 !== recovery.sourceHistorySha256) {
    throw new CorruptLibraryError('Project recovery source bytes failed integrity validation.');
  }
  return recovery;
}

export function parseProjectRecoveryRecord(bytes, entry) {
  const value = parseStrictJson(bytes, 'project recovery');
  assertExactFields(
    value,
    ['format', 'version', 'recoveryId', 'projectId', 'projectKey', 'snapshotKey', 'revision', 'reason', 'sourceProjectPath', 'sourceProjectSha256', 'sourceHistoryPath', 'sourceHistorySha256', 'recoveredAt'],
    [],
    'project recovery',
  );
  if (value.format !== 'lumina-library-project-recovery' || value.version !== 1) {
    throw new CorruptLibraryError('Project recovery schema is unsupported.');
  }
  validateLibraryKey(value.recoveryId, 'r');
  if (value.projectId !== entry.projectId || value.projectKey !== entry.projectKey
    || value.snapshotKey !== entry.snapshotKey || value.revision !== entry.revision
    || !['unsupported_schema', 'migration_failed'].includes(value.reason)
    || !DIGEST_PATTERN.test(value.sourceProjectSha256)
    || !DIGEST_PATTERN.test(value.sourceHistorySha256)
    || !Number.isSafeInteger(value.recoveredAt) || value.recoveredAt < 0) {
    throw new CorruptLibraryError('Project recovery identity is invalid.');
  }
  const directory = `projects/${entry.projectKey}/recovery`;
  if (value.sourceProjectPath !== `${directory}/${value.recoveryId}-source-project.json`
    || value.sourceHistoryPath !== `${directory}/${value.recoveryId}-source-history.json`) {
    throw new CorruptLibraryError('Project recovery source paths are invalid.');
  }
  return value;
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
  }, 'project-mutation', { transactionId });
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
