import { admissionFailure, admitCanvasEdges, admitCanvasNodes, admitHistorySnapshots, emptyCommit, stripHistoryDisplayUrls, stripNodeDisplayUrls, toProjectDocument, validateImagePool, validateProjectRevision, validateViewportValue } from './admission.mjs';
import { isManagedPublicationPath, readCatalog, validateCatalogPayloads, validatePublishPayloads } from './catalog.mjs';
import { parseCommit } from './catalogRecords.mjs';
import { CorruptLibraryError, FileProjectLibraryError, MAX_ASSET_METADATA_BYTES, MAX_DURABLE_ASSET_BYTES, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, assertExpectedCatalogRevision, canonicalize, compareUtf8, createHash, encoder, makeLibraryKey, parseJsonString, path, randomUUID, sha256, validateLogicalId } from './core.mjs';
import { assertWriteLeaseCurrent, atomicReplace, collectFiles, ensureDirectory, ensureNoSymlinkPath, ensureParentDirectory, fault, flushFile, hashFileBytes, managedPath, openManagedFileForRead, openNewManagedFile, readCanonicalFile, removeExactManagedTree, syncDirectory, writeCanonicalBytes, writeCanonicalFile, writeCanonicalHeadBytes } from './filesystem.mjs';
import { markRuntimeCommandPending } from './runtimeCommands.mjs';

export async function publishNextCatalog(state, catalog, changes, operation, options = {}) {
  const transactionId = options.transactionId ?? makeLibraryKey('t');
  const preconditions = publicationPreconditions(catalog, options);
  const commitId = makeLibraryKey('c');
  if (!Number.isSafeInteger(catalog.commit.sequence) || catalog.commit.sequence >= Number.MAX_SAFE_INTEGER) {
    throw new FileProjectLibraryError('catalog_sequence_exhausted', 'Library catalog sequence is exhausted.');
  }
  const sequence = catalog.commit.sequence + 1;
  const nextCommit = emptyCommit(commitId, sequence, catalog.commit.commitId, {
    projects: changes.projects.map(({ stagingTransactionId: _stagingTransactionId, ...entry }) => entry),
    assets: changes.assets,
  });
  const commitBytes = encoder.encode(canonicalize(nextCommit));
  const commitSha256 = sha256(commitBytes);
  const stagingRoot = managedPath(state, `staging/${transactionId}`);
  await ensureDirectory(state, `staging/${transactionId}`);
  await writeCanonicalBytes(state, path.join(stagingRoot, `commits/${commitId}.json`), commitBytes);
  const payloads = await collectStagedPayloads(state, stagingRoot);
  const publish = {
    format: 'lumina-library-publish',
    version: 1,
    transactionId,
    operation,
    expectedCatalog: preconditions.expectedCatalog,
    expectedProjectRevisions: preconditions.expectedProjectRevisions,
    priorCommitId: catalog.commit.commitId,
    priorCommitSha256: catalog.head.commitSha256,
    intendedCommitId: commitId,
    intendedSequence: sequence,
    intendedCommitSha256: commitSha256,
    payloads,
    createdAt: state.clock(),
  };
  await writeCanonicalFile(state, path.join(stagingRoot, 'publish.json'), publish);
  await fault(state, 'after-stage', { transactionId, operation });
  await materializeTransactionPayloads(state, stagingRoot, publish.payloads);
  await validateCatalogPayloads(state, nextCommit);
  await fault(state, 'after-materialize', { transactionId, operation });
  if (options.runtimeCommandId !== undefined) {
    await markRuntimeCommandPending(state, options.runtimeCommandId, transactionId, {
      commitId,
      sequence,
      commitSha256,
    });
  }
  await assertWriteLeaseCurrent(state);
  const headBytes = await readCanonicalFile(state, managedPath(state, 'head.json'), 'head');
  await writeCanonicalHeadBytes(state, managedPath(state, 'head.previous.json'), headBytes);
  await fault(state, 'after-head-previous', { transactionId, operation });
  const nextHead = {
    format: 'lumina-library-head',
    version: 1,
    commitId,
    commitSha256,
    previousCommitId: catalog.commit.commitId,
  };
  const nextHeadBytes = encoder.encode(canonicalize(nextHead));
  await fault(state, 'before-head', { transactionId, operation });
  await assertWriteLeaseCurrent(state);
  await writeCanonicalHeadBytes(state, managedPath(state, 'head.json'), nextHeadBytes);
  await fault(state, 'after-head', { transactionId, operation });
  const verified = await readCatalog(state);
  if (verified.head.commitId !== commitId) throw new CorruptLibraryError('Published head verification failed.');
  await fault(state, 'before-staging-cleanup-delete', { transactionId, operation, stagingRoot });
  await removeStagingTransaction(state, stagingRoot, publish);
  await fault(state, 'after-head-verify', { transactionId, operation });
  return verified;
}

export async function resumePendingPublication(state, catalog, publish) {
  if (publish.priorCommitId !== catalog.head.commitId
    || publish.priorCommitSha256 !== catalog.head.commitSha256
    || publish.intendedSequence !== catalog.commit.sequence + 1) {
    throw new FileProjectLibraryError('command_recovery_failed', 'The pending runtime command no longer names the visible publication base.');
  }
  const intendedCommit = parseCommit(await readCanonicalFile(
    state,
    managedPath(state, `commits/${publish.intendedCommitId}.json`),
    'pending runtime command catalog',
  ));
  if (intendedCommit.commitId !== publish.intendedCommitId
    || intendedCommit.sequence !== publish.intendedSequence
    || intendedCommit.previousCommitId !== publish.priorCommitId
    || sha256(canonicalize(intendedCommit)) !== publish.intendedCommitSha256) {
    throw new FileProjectLibraryError('command_recovery_failed', 'The pending runtime command catalog is invalid.');
  }
  await validateCatalogPayloads(state, intendedCommit);
  await assertWriteLeaseCurrent(state);
  const headBytes = await readCanonicalFile(state, managedPath(state, 'head.json'), 'head');
  await writeCanonicalHeadBytes(state, managedPath(state, 'head.previous.json'), headBytes);
  await assertWriteLeaseCurrent(state);
  await writeCanonicalHeadBytes(state, managedPath(state, 'head.json'), encoder.encode(canonicalize({
    format: 'lumina-library-head',
    version: 1,
    commitId: publish.intendedCommitId,
    commitSha256: publish.intendedCommitSha256,
    previousCommitId: publish.priorCommitId,
  })));
  const verified = await readCatalog(state);
  if (verified.head.commitId !== publish.intendedCommitId || verified.head.commitSha256 !== publish.intendedCommitSha256) {
    throw new CorruptLibraryError('Pending runtime command publication verification failed.');
  }
  await removeStagingTransaction(state, managedPath(state, `staging/${publish.transactionId}`), publish);
  return verified;
}

export function publicationPreconditions(catalog, options) {
  const expectedCatalog = assertExpectedCatalogRevision(options?.expectedCatalog, catalog.revision);
  if (!Array.isArray(options?.expectedProjectRevisions)) {
    throw new FileProjectLibraryError(
      'project_precondition_required',
      'A publication requires its affected project revisions.',
    );
  }
  let previousProjectId = null;
  const expectedProjectRevisions = options.expectedProjectRevisions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, 'projectId')
      || !Object.hasOwn(entry, 'expectedRevision')) {
      throw new FileProjectLibraryError('project_precondition_required', 'A publication project precondition is invalid.');
    }
    const projectId = validateLogicalId(entry.projectId, 'publication projectId');
    if (previousProjectId !== null && compareUtf8(previousProjectId, projectId) >= 0) {
      throw new FileProjectLibraryError('project_precondition_required', 'Publication project preconditions must be sorted and unique.');
    }
    previousProjectId = projectId;
    const actualRevision = catalog.commit.projects.find((project) => project.projectId === projectId)?.revision ?? 'absent';
    const expectedRevision = entry.expectedRevision;
    if (expectedRevision !== 'absent') validateProjectRevision(expectedRevision, 'publication expected revision');
    const equivalentEmptyRevision = expectedRevision === 'r0' && actualRevision === 'absent';
    if (expectedRevision !== actualRevision && !equivalentEmptyRevision) {
      throw new FileProjectLibraryError('stale_revision', 'A publication project revision changed before staging.', {
        projectId,
        expectedRevision,
        actualRevision,
      });
    }
    return { projectId, expectedRevision };
  });
  return { expectedCatalog, expectedProjectRevisions };
}

export async function removeStagingTransaction(state, stagingRoot, publish) {
  const expected = [
    ...publish.payloads,
    { path: 'publish.json', sha256: sha256(canonicalize(publish)) },
  ];
  await removeExactManagedTree(state, stagingRoot, expected, 'Published staging transaction');
}

export async function stageProject(state, record, transactionId, ownedAssetIds = new Set(), options = {}) {
  const projectKey = options.projectKey ?? makeLibraryKey('p');
  const snapshotKey = options.snapshotKey ?? makeLibraryKey('s');
  const projectDocument = admitProjectDocumentPayload(toProjectDocument(record), ownedAssetIds);
  const historyDocument = admitHistoryDocumentPayload(parseJsonString(record.historyJson, 'history'));
  const projectBytes = encoder.encode(canonicalize(projectDocument));
  const historyBytes = encoder.encode(canonicalize(historyDocument));
  if (projectBytes.byteLength > MAX_PROJECT_DOCUMENT_BYTES) {
    throw new FileProjectLibraryError('project_too_large', 'Project snapshot exceeds the v1 limit.');
  }
  if (historyBytes.byteLength > MAX_HISTORY_DOCUMENT_BYTES) {
    throw new FileProjectLibraryError('history_too_large', 'History snapshot exceeds the v1 limit.');
  }
  const manifest = {
    format: 'lumina-library-project-snapshot',
    version: 1,
    projectId: record.id,
    projectKey,
    snapshotKey,
    revision: record.revision,
    recovery: options.manifestRecovery ?? record.recovery ?? null,
  };
  const manifestSha256 = sha256(canonicalize(manifest));
  const stagingRoot = managedPath(state, `staging/${transactionId}/projects/${projectKey}/snapshots/${snapshotKey}`);
  await ensureDirectory(state, `staging/${transactionId}/projects/${projectKey}/snapshots/${snapshotKey}`);
  await writeCanonicalFile(state, path.join(stagingRoot, 'manifest.json'), manifest);
  await writeCanonicalBytes(state, path.join(stagingRoot, 'project.json'), projectBytes);
  await writeCanonicalBytes(state, path.join(stagingRoot, 'history.json'), historyBytes);
  if (options.recoverySources) {
    const { recoveryId, projectBytes: sourceProjectBytes, historyBytes: sourceHistoryBytes } = options.recoverySources;
    await writeCanonicalBytes(
      state,
      path.join(stagingRoot, `recovery/${recoveryId}-source-project.json`),
      sourceProjectBytes,
    );
    await writeCanonicalBytes(
      state,
      path.join(stagingRoot, `recovery/${recoveryId}-source-history.json`),
      sourceHistoryBytes,
    );
  }
  return {
    projectId: record.id,
    projectKey,
    snapshotKey,
    revision: record.revision,
    manifestPath: `projects/${projectKey}/snapshots/${snapshotKey}/manifest.json`,
    manifestSha256,
    stagingTransactionId: transactionId,
  };
}

export function admitProjectDocumentPayload(document, ownedAssetIds) {
  const admitted = {
    ...document,
    nodes: admitCanvasNodes(document.nodes, 'project snapshot nodes', { ownedAssetIds }),
    edges: admitCanvasEdges(document.edges, 'project snapshot edges'),
    viewport: validateViewportValue(document.viewport, 'project snapshot viewport'),
  };
  if (Object.hasOwn(document, 'imagePool')) admitted.imagePool = validateImagePool(document.imagePool, 'project snapshot imagePool');
  for (const node of admitted.nodes) stripNodeDisplayUrls(node, ownedAssetIds, false);
  return admitted;
}

export function admitHistoryDocumentPayload(history) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) throw admissionFailure('History snapshot is invalid.');
  const admitted = {
    past: admitHistorySnapshots(history.past, 'history past'),
    future: admitHistorySnapshots(history.future, 'history future'),
  };
  stripHistoryDisplayUrls(admitted);
  return admitted;
}

export async function collectStagedPayloads(state, stagingRoot) {
  const payloads = [];
  for (const sourcePath of await collectFiles(state, stagingRoot)) {
    const relative = path.relative(stagingRoot, sourcePath).replaceAll('\\', '/');
    if (!isManagedPublicationPath(relative)) {
      throw new FileProjectLibraryError('invalid_publish', 'Staging contains an unmanaged publication payload.');
    }
    await ensureNoSymlinkPath(state, sourcePath);
    payloads.push({ path: relative, sha256: (await hashFileBytes(state, sourcePath)).sha256 });
  }
  payloads.sort((left, right) => compareUtf8(left.path, right.path));
  validatePublishPayloads(payloads);
  return payloads;
}

export async function materializeTransactionPayloads(state, stagingRoot, payloads) {
  for (const payload of payloads) {
    const sourcePath = path.join(stagingRoot, ...payload.path.split('/'));
    const targetPath = managedPath(state, payload.path);
    const maxBytes = materializedPayloadLimit(payload.path);
    await ensureNoSymlinkPath(state, sourcePath);
    const sourceDigest = (await hashFileBytes(state, sourcePath, maxBytes)).sha256;
    if (sourceDigest !== payload.sha256) {
      throw new CorruptLibraryError('Staged publication payload digest changed before materialization.');
    }
    try {
      await ensureNoSymlinkPath(state, targetPath);
      const existing = await hashFileBytes(state, targetPath, maxBytes);
      if (existing.sha256 !== payload.sha256) {
        throw new CorruptLibraryError('Immutable publication payload conflicts with an existing file.');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await ensureParentDirectory(state, targetPath);
      await ensureNoSymlinkPath(state, targetPath, true);
      const temporary = path.join(
        stagingRoot,
        '.materialize',
        `${payload.sha256}.${process.pid}.${randomUUID()}.tmp`,
      );
      const copied = await copyPayloadToTemporary(state, sourcePath, temporary, maxBytes);
      if (copied.sha256 !== payload.sha256) {
        throw new CorruptLibraryError('Materialized publication payload digest changed before installation.');
      }
      await flushFile(state, temporary);
      await atomicReplace(state, temporary, targetPath);
    }
    await flushFile(state, targetPath);
    await syncDirectory(state, path.dirname(targetPath));
  }
}

export function materializedPayloadLimit(relative) {
  if (/^projects\/p_[0-9a-f]{32}\/snapshots\/s_[0-9a-f]{32}\/project\.json$/u.test(relative)) {
    return MAX_PROJECT_DOCUMENT_BYTES;
  }
  if (/^projects\/p_[0-9a-f]{32}\/snapshots\/s_[0-9a-f]{32}\/history\.json$/u.test(relative)) {
    return MAX_HISTORY_DOCUMENT_BYTES;
  }
  if (/^projects\/p_[0-9a-f]{32}\/snapshots\/s_[0-9a-f]{32}\/recovery\/r_[0-9a-f]{32}-source-project\.json$/u.test(relative)) {
    return MAX_PROJECT_DOCUMENT_BYTES;
  }
  if (/^projects\/p_[0-9a-f]{32}\/snapshots\/s_[0-9a-f]{32}\/recovery\/r_[0-9a-f]{32}-source-history\.json$/u.test(relative)) {
    return MAX_HISTORY_DOCUMENT_BYTES;
  }
  if (/^assets\/a_[0-9a-f]{32}\/metadata\/[0-9a-f]{64}\.json$/u.test(relative)) {
    return MAX_ASSET_METADATA_BYTES;
  }
  return MAX_DURABLE_ASSET_BYTES;
}

export async function copyPayloadToTemporary(state, sourcePath, temporary, maxBytes) {
  await ensureParentDirectory(state, temporary);
  await ensureNoSymlinkPath(state, temporary, true);
  await fault(state, 'before-materialize-temporary-open', { sourcePath, temporary });
  await ensureNoSymlinkPath(state, temporary, true);
  const { handle: source, stat: sourceStat } = await openManagedFileForRead(
    state,
    sourcePath,
    maxBytes,
    'staged publication payload',
  );
  let target = null;
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes));
  let copiedBytes = 0;
  try {
    if (sourceStat.size > maxBytes) {
      throw new FileProjectLibraryError('payload_too_large', 'A staged publication payload is not a bounded regular file.');
    }
    target = await openNewManagedFile(state, temporary, 'materialization temporary');
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > maxBytes) {
        throw new FileProjectLibraryError('payload_too_large', 'A staged publication payload exceeds its configured limit.');
      }
      let offset = 0;
      while (offset < bytesRead) {
        const written = await target.write(buffer, offset, bytesRead - offset);
        if (!written.bytesWritten) {
          throw new FileProjectLibraryError('payload_write_failed', 'A staged publication payload could not be materialized.');
        }
        offset += written.bytesWritten;
      }
      digest.update(buffer.subarray(0, bytesRead));
      await fault(state, 'during-materialize-copy', { sourcePath, temporary, copiedBytes });
    }
  } finally {
    await source.close();
    await target?.close();
  }
  return { byteCount: copiedBytes, sha256: digest.digest('hex') };
}
