import { assertExpectedRevision } from './admission.mjs';
import { getAssetMetadata, stageAssetMetadata } from './assets.mjs';
import { parseHistoryDocument, parseProjectDocument, parseProjectManifest, parseTrashExpiry, parseTrashManifest } from './catalog.mjs';
import { parseCommit } from './catalogRecords.mjs';
import { CorruptLibraryError, FileProjectLibraryError, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, assertExpectedCatalogRevision, canonicalize, compareUtf8, makeLibraryKey, sha256, validateLogicalId } from './core.mjs';
import { fault, hashFileBytes, managedPath, readCanonicalFile, writeCanonicalFile } from './filesystem.mjs';
import { publishNextCatalog, stageProject } from './publication.mjs';
import { fromProjectDocument } from './projects.mjs';
import { completeRuntimeCommand, consumeRuntimeCommand, readCommandLedger } from './runtimeCommands.mjs';

export async function deleteProject(state, catalog, projectId, writeOptions = {}) {
  validateLogicalId(projectId, 'projectId');
  if (!writeOptions?.context) {
    throw new FileProjectLibraryError(
      'target_delete_authorization_required',
      'Project deletion requires a catalog-pinned runtime command context.',
    );
  }
  const command = await consumeRuntimeCommand(
    state,
    catalog,
    writeOptions.context,
    'project-delete',
    { projectId, assetId: null, deletionId: null },
    { kind: 'delete', projectId, expectedRevision: writeOptions.expectedRevision },
  );
  if (command.replay) return command.replay;
  assertExpectedCatalogRevision(writeOptions?.expectedCatalog, catalog.revision);
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === projectId);
  const actualRevision = entry?.revision ?? 'absent';
  assertExpectedRevision(projectId, writeOptions?.expectedRevision, actualRevision);
  if (!entry) return completeRuntimeCommand(state, command.commandId, { code: 'not_found', projectId });

  const deletionId = makeLibraryKey('d');
  const manifest = await createProjectTrashManifest(state, catalog, entry, deletionId, command.commandId);
  await fault(state, 'before-project-trash-manifest', { deletionId, projectId });
  await writeCanonicalFile(state, managedPath(state, `trash/${deletionId}/manifest.json`), manifest);
  await fault(state, 'after-project-trash-manifest', { deletionId, projectId });
  const next = await publishProjectTrashDeletion(state, catalog, manifest, writeOptions);
  await fault(state, 'after-project-trash-head', { deletionId, projectId });
  return completeRuntimeCommand(state, command.commandId, deletedProjectResult(manifest, next.revision));
}

export async function resumeProjectTrash(state, catalog, manifest) {
  if (!manifest.project) return catalog;
  const command = (await readCommandLedger(state)).entries.find(
    (entry) => entry.commandId === manifest.project.commandId,
  );
  if (!command || command.state === 'completed') return catalog;
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === manifest.project.projectId);
  if (!entry) {
    if (isDirectCatalogSuccessor(catalog, manifest.catalog)) {
      await completeRuntimeCommand(state, manifest.project.commandId, deletedProjectResult(manifest, catalog.revision));
    }
    return catalog;
  }
  if (entry.projectKey !== manifest.project.projectKey
    || entry.snapshotKey !== manifest.project.snapshotKey
    || entry.revision !== manifest.project.revision
    || entry.manifestPath !== manifest.project.manifestPath
    || entry.manifestSha256 !== manifest.project.manifestSha256) return catalog;
  if (!sameCatalogRevision(catalog.revision, manifest.catalog)) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'An interrupted project deletion no longer matches its pinned project snapshot.',
      { deletionId: manifest.deletionId, projectId: manifest.project.projectId },
    );
  }
  const next = await publishProjectTrashDeletion(state, catalog, manifest, {
    expectedCatalog: manifest.catalog,
    expectedRevision: manifest.project.revision,
  });
  await completeRuntimeCommand(state, manifest.project.commandId, deletedProjectResult(manifest, next.revision));
  return next;
}

export async function restoreProject(state, catalog, projectId, deletionId, trashManifestSha256, writeOptions = {}) {
  validateLogicalId(projectId, 'projectId');
  if (!writeOptions?.context) {
    throw new FileProjectLibraryError(
      'target_delete_authorization_required',
      'Project restore requires a catalog-pinned runtime command context.',
    );
  }
  if (typeof trashManifestSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(trashManifestSha256)) {
    throw new FileProjectLibraryError('trash_manifest_mismatch', 'Project restore requires an exact trash manifest digest.');
  }
  const command = await consumeRuntimeCommand(
    state,
    catalog,
    writeOptions.context,
    'project-restore',
    { projectId, assetId: null, deletionId },
    {
      kind: 'restoreProject',
      projectId,
      expectedRevision: writeOptions.expectedRevision,
      deletionId,
      trashManifestSha256,
    },
  );
  if (command.replay) return command.replay;
  assertExpectedCatalogRevision(writeOptions?.expectedCatalog, catalog.revision);
  try {
    parseTrashExpiry(
      await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/expiry.json`), 'trash expiry receipt'),
      deletionId,
    );
    throw new FileProjectLibraryError('trash_manifest_mismatch', 'The selected project trash record has expired.', { deletionId });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const manifestBytes = await readCanonicalFile(
    state,
    managedPath(state, `trash/${deletionId}/manifest.json`),
    'trash manifest',
  );
  if (sha256(manifestBytes) !== trashManifestSha256) {
    throw new FileProjectLibraryError('trash_manifest_mismatch', 'The selected trash manifest does not match its request.', { deletionId });
  }
  const manifest = parseTrashManifest(manifestBytes, deletionId);
  if (!manifest.project || manifest.project.projectId !== projectId) {
    throw new FileProjectLibraryError('trash_manifest_mismatch', 'The selected trash manifest does not own the requested project.', { deletionId, projectId });
  }
  const targetProjectId = allocateRestoredProjectId(catalog, projectId);
  assertExpectedRevision(
    targetProjectId,
    writeOptions?.expectedRevision,
    catalog.commit.projects.find((entry) => entry.projectId === targetProjectId)?.revision ?? 'absent',
  );
  const source = await readProjectTrashSource(state, manifest);
  const transactionId = makeLibraryKey('t');
  const restoredAssets = await restoreProjectAssets(state, catalog, manifest, targetProjectId, transactionId);
  const projectKey = makeLibraryKey('p');
  const snapshotKey = makeLibraryKey('s');
  const record = {
    ...fromProjectDocument(source.project, source.history, source.manifest.recovery ? { reason: source.manifest.recovery.reason } : null),
    id: targetProjectId,
  };
  const stageOptions = { projectKey, snapshotKey };
  if (source.manifest.recovery?.recoveryId) {
    const recovery = source.manifest.recovery;
    stageOptions.manifestRecovery = {
      ...recovery,
      sourceProjectPath: `projects/${projectKey}/snapshots/${snapshotKey}/recovery/${recovery.recoveryId}-source-project.json`,
      sourceHistoryPath: `projects/${projectKey}/snapshots/${snapshotKey}/recovery/${recovery.recoveryId}-source-history.json`,
    };
    stageOptions.recoverySources = {
      recoveryId: recovery.recoveryId,
      projectBytes: source.recoveryProjectBytes,
      historyBytes: source.recoveryHistoryBytes,
    };
  }
  const stagedProject = await stageProject(
    state,
    record,
    transactionId,
    new Set(manifest.project.assets.map((asset) => asset.assetId)),
    stageOptions,
  );
  const projects = catalog.commit.projects.concat(stagedProject).sort((left, right) => compareUtf8(left.projectId, right.projectId));
  const next = await publishNextCatalog(
    state,
    catalog,
    { projects, assets: restoredAssets },
    'project-restore',
    {
      transactionId,
      runtimeCommandId: command.commandId,
      expectedCatalog: writeOptions.expectedCatalog,
      expectedProjectRevisions: [{ projectId: targetProjectId, expectedRevision: writeOptions.expectedRevision }],
    },
  );
  return completeRuntimeCommand(
    state,
    command.commandId,
    { code: 'restored', projectId: targetProjectId, revision: record.revision, catalog: next.revision },
  );
}

export async function completeRecoveredProjectRestores(state, catalog) {
  const ledger = await readCommandLedger(state);
  for (const command of ledger.entries) {
    if (command.state !== 'pending' || command.action !== 'project-restore'
      || !sameCatalogRevision(command.intendedCatalog, catalog.revision)) continue;
    if (catalog.commit.previousCommitId !== command.expectedCatalog.commitId) {
      throw new FileProjectLibraryError('command_recovery_failed', 'The pending project restore no longer names the direct catalog predecessor.');
    }
    const previous = parseCommit(await readCanonicalFile(
      state,
      managedPath(state, `commits/${command.expectedCatalog.commitId}.json`),
      'pending project restore predecessor',
    ));
    const priorProjectIds = new Set(previous.projects.map((entry) => entry.projectId));
    const restored = catalog.commit.projects.filter((entry) => !priorProjectIds.has(entry.projectId));
    if (restored.length !== 1) {
      throw new FileProjectLibraryError('command_recovery_failed', 'The pending project restore does not name one restored project.');
    }
    await completeRuntimeCommand(state, command.commandId, {
      code: 'restored',
      projectId: restored[0].projectId,
      revision: restored[0].revision,
      catalog: catalog.revision,
    });
  }
}

async function createProjectTrashManifest(state, catalog, entry, deletionId, commandId) {
  const base = `projects/${entry.projectKey}/snapshots/${entry.snapshotKey}`;
  const manifestBytes = await readCanonicalFile(state, managedPath(state, entry.manifestPath), 'project manifest');
  if (sha256(manifestBytes) !== entry.manifestSha256) throw new CorruptLibraryError('Project trash source manifest digest is invalid.');
  const snapshotManifest = parseProjectManifest(manifestBytes);
  if (snapshotManifest.projectId !== entry.projectId
    || snapshotManifest.projectKey !== entry.projectKey
    || snapshotManifest.snapshotKey !== entry.snapshotKey
    || snapshotManifest.revision !== entry.revision) {
    throw new CorruptLibraryError('Project trash source manifest does not match its catalog entry.');
  }
  const payloads = [
    { path: entry.manifestPath, sha256: entry.manifestSha256 },
    await projectTrashPayload(state, `${base}/project.json`, MAX_PROJECT_DOCUMENT_BYTES),
    await projectTrashPayload(state, `${base}/history.json`, MAX_HISTORY_DOCUMENT_BYTES),
  ];
  if (snapshotManifest.recovery?.recoveryId) {
    payloads.push(
      await projectTrashPayload(state, snapshotManifest.recovery.sourceProjectPath, MAX_PROJECT_DOCUMENT_BYTES),
      await projectTrashPayload(state, snapshotManifest.recovery.sourceHistoryPath, MAX_HISTORY_DOCUMENT_BYTES),
    );
  }
  payloads.sort((left, right) => compareUtf8(left.path, right.path));
  const assets = [];
  for (const asset of catalog.commit.assets) {
    if (asset.projectId !== entry.projectId) continue;
    await getAssetMetadata(state, catalog, asset.assetId);
    assets.push({
      assetId: asset.assetId,
      assetKey: asset.assetKey,
      metadataPath: asset.metadataPath,
      metadataSha256: asset.metadataSha256,
      bytesPath: asset.bytesPath,
      bytesSha256: asset.bytesSha256,
      byteCount: asset.byteCount,
    });
  }
  assets.sort((left, right) => compareUtf8(left.assetId, right.assetId));
  return {
    format: 'lumina-library-trash',
    version: 1,
    deletionId,
    catalog: catalog.revision,
    assets: [],
    project: {
      projectId: entry.projectId,
      projectKey: entry.projectKey,
      snapshotKey: entry.snapshotKey,
      revision: entry.revision,
      manifestPath: entry.manifestPath,
      manifestSha256: entry.manifestSha256,
      commandId,
      authorizationClass: 'project-delete',
      payloads,
      assets,
    },
    createdAt: state.clock(),
  };
}

async function projectTrashPayload(state, relative, maxBytes) {
  const hashed = await hashFileBytes(state, managedPath(state, relative), maxBytes);
  return { path: relative, sha256: hashed.sha256 };
}

async function publishProjectTrashDeletion(state, catalog, manifest, writeOptions) {
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === manifest.project.projectId);
  if (!entry) return catalog;
  const expectedAssets = new Map(manifest.project.assets.map((asset) => [asset.assetId, asset]));
  const transactionId = makeLibraryKey('t');
  const assets = [];
  for (const asset of catalog.commit.assets) {
    if (asset.projectId !== manifest.project.projectId) {
      assets.push(asset);
      continue;
    }
    const expected = expectedAssets.get(asset.assetId);
    if (!expected || !sameAssetEntry(asset, expected)) {
      throw new FileProjectLibraryError('recovery_required', 'Project trash asset ownership changed before deletion.', {
        deletionId: manifest.deletionId,
        assetId: asset.assetId,
      });
    }
    const metadata = await getAssetMetadata(state, catalog, asset.assetId);
    if (metadata.lifecycleState === 'deletion-candidate') {
      assets.push(asset);
      continue;
    }
    assets.push({
      ...asset,
      ...(await stageAssetMetadata(
        state,
        { ...metadata, lifecycleState: 'deletion-candidate' },
        asset.assetKey,
        transactionId,
      )),
    });
  }
  if (expectedAssets.size !== manifest.project.assets.length
    || manifest.project.assets.some((asset) => !catalog.commit.assets.some((entry_) => entry_.assetId === asset.assetId))) {
    throw new FileProjectLibraryError('recovery_required', 'Project trash assets are incomplete before deletion.', { deletionId: manifest.deletionId });
  }
  const projects = catalog.commit.projects.filter((candidate) => candidate.projectId !== manifest.project.projectId);
  return publishNextCatalog(state, catalog, { projects, assets }, 'project-delete', {
    transactionId,
    expectedCatalog: writeOptions.expectedCatalog,
    expectedProjectRevisions: [{ projectId: manifest.project.projectId, expectedRevision: writeOptions.expectedRevision }],
  });
}

async function readProjectTrashSource(state, manifest) {
  const payloads = new Map(manifest.project.payloads.map((entry) => [entry.path, entry.sha256]));
  for (const entry of manifest.project.payloads) {
    const limit = entry.path.endsWith('/history.json') || entry.path.endsWith('-source-history.json')
      ? MAX_HISTORY_DOCUMENT_BYTES
      : MAX_PROJECT_DOCUMENT_BYTES;
    if ((await hashFileBytes(state, managedPath(state, entry.path), limit)).sha256 !== entry.sha256) {
      throw new FileProjectLibraryError('recovery_required', 'A project trash payload changed before restore.', { deletionId: manifest.deletionId, path: entry.path });
    }
  }
  const base = `projects/${manifest.project.projectKey}/snapshots/${manifest.project.snapshotKey}`;
  const manifestBytes = await readCanonicalFile(state, managedPath(state, manifest.project.manifestPath), 'project trash source manifest');
  const snapshotManifest = parseProjectManifest(manifestBytes);
  const projectBytes = await readCanonicalFile(state, managedPath(state, `${base}/project.json`), 'project trash source', MAX_PROJECT_DOCUMENT_BYTES);
  const historyBytes = await readCanonicalFile(state, managedPath(state, `${base}/history.json`), 'project trash history', MAX_HISTORY_DOCUMENT_BYTES);
  if (payloads.get(manifest.project.manifestPath) !== sha256(manifestBytes)
    || payloads.get(`${base}/project.json`) !== sha256(projectBytes)
    || payloads.get(`${base}/history.json`) !== sha256(historyBytes)) {
    throw new FileProjectLibraryError('recovery_required', 'Project trash payloads no longer match their manifest.', { deletionId: manifest.deletionId });
  }
  const result = {
    manifest: snapshotManifest,
    project: parseProjectDocument(projectBytes),
    history: parseHistoryDocument(historyBytes),
    recoveryProjectBytes: null,
    recoveryHistoryBytes: null,
  };
  if (snapshotManifest.recovery?.recoveryId) {
    result.recoveryProjectBytes = await readCanonicalFile(state, managedPath(state, snapshotManifest.recovery.sourceProjectPath), 'project recovery source', MAX_PROJECT_DOCUMENT_BYTES);
    result.recoveryHistoryBytes = await readCanonicalFile(state, managedPath(state, snapshotManifest.recovery.sourceHistoryPath), 'history recovery source', MAX_HISTORY_DOCUMENT_BYTES);
  }
  return result;
}

async function restoreProjectAssets(state, catalog, manifest, targetProjectId, transactionId) {
  const expectedAssets = new Map(manifest.project.assets.map((entry) => [entry.assetId, entry]));
  const restored = [];
  for (const asset of catalog.commit.assets) {
    const expected = expectedAssets.get(asset.assetId);
    if (!expected) {
      restored.push(asset);
      continue;
    }
    if (asset.projectId !== manifest.project.projectId || !sameAssetPayload(asset, expected)) {
      throw new FileProjectLibraryError('recovery_required', 'Project trash asset changed before restore.', {
        deletionId: manifest.deletionId,
        assetId: asset.assetId,
      });
    }
    const metadata = await getAssetMetadata(state, catalog, asset.assetId);
    restored.push({
      ...asset,
      ...(await stageAssetMetadata(
        state,
        { ...metadata, projectId: targetProjectId, lifecycleState: 'active' },
        asset.assetKey,
        transactionId,
      )),
      projectId: targetProjectId,
    });
  }
  if (manifest.project.assets.some((asset) => !catalog.commit.assets.some((entry) => entry.assetId === asset.assetId))) {
    throw new FileProjectLibraryError('recovery_required', 'Project trash assets are no longer available for restore.', { deletionId: manifest.deletionId });
  }
  return restored.sort((left, right) => compareUtf8(left.assetId, right.assetId));
}

function allocateRestoredProjectId(catalog, projectId) {
  if (!catalog.commit.projects.some((entry) => entry.projectId === projectId)) return projectId;
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = `${projectId}-restored-${suffix}`;
    validateLogicalId(candidate, 'restored projectId');
    if (!catalog.commit.projects.some((entry) => entry.projectId === candidate)) return candidate;
  }
  throw new FileProjectLibraryError('restore_id_exhausted', 'A deterministic project restore ID could not be allocated.', { projectId });
}

function sameAssetEntry(asset, expected) {
  return asset.assetKey === expected.assetKey
    && asset.metadataPath === expected.metadataPath
    && asset.metadataSha256 === expected.metadataSha256
    && asset.bytesPath === expected.bytesPath
    && asset.bytesSha256 === expected.bytesSha256
    && asset.byteCount === expected.byteCount;
}

function sameAssetPayload(asset, expected) {
  return asset.assetKey === expected.assetKey
    && asset.bytesPath === expected.bytesPath
    && asset.bytesSha256 === expected.bytesSha256
    && asset.byteCount === expected.byteCount;
}

function sameCatalogRevision(left, right) {
  return left.commitId === right.commitId
    && left.sequence === right.sequence
    && left.commitSha256 === right.commitSha256;
}

function isDirectCatalogSuccessor(catalog, expected) {
  return catalog.commit.sequence === expected.sequence + 1
    && catalog.commit.previousCommitId === expected.commitId;
}

function deletedProjectResult(manifest, catalog) {
  return {
    code: 'deleted',
    projectId: manifest.project.projectId,
    deletionId: manifest.deletionId,
    trashManifestSha256: sha256(canonicalize(manifest)),
    catalog,
  };
}
