import { validateAssetCatalogEntry } from './admission.mjs';
import { parseAssetMetadataDocument, parseTrashCleanup, parseTrashExpiry, parseTrashManifest, readCatalog } from './catalog.mjs';
import { CorruptLibraryError, DEFAULT_SAFETY_WINDOW_MS, FileProjectLibraryError, MAX_ASSET_METADATA_BYTES, canonicalize, compareUtf8, makeLibraryKey, path, sha256, validateLibraryKey } from './core.mjs';
import { atomicReplace, captureManagedTreeClosure, copyManagedFile, fileDigestIfExists, hashFileBytes, listDirectories, managedPath, readCanonicalFile, removeExactManagedTree, removeIfUnchanged, syncDirectory, writeCanonicalFile } from './filesystem.mjs';
import { collectDeletionProtectedAssetIds, collectReachablePaths, rootSetDigest } from './maintenanceReachability.mjs';
import { publishNextCatalog } from './publication.mjs';
import { resumeProjectTrash } from './projectTrash.mjs';
import { completeRuntimeCommand, consumeRuntimeCommand, markRuntimeCommandPending, readCommandLedger, resetPendingEmptyTrashCommand } from './runtimeCommands.mjs';

export async function moveDeletionCandidatesToTrash(state, catalog, now) {
  const protectedAssetIds = await collectDeletionProtectedAssetIds(state, catalog, now);
  const candidates = [];
  for (const entry of catalog.commit.assets) {
    const document = parseAssetMetadataDocument(await readCanonicalFile(
      state,
      managedPath(state, entry.metadataPath),
      'asset metadata',
      MAX_ASSET_METADATA_BYTES,
    ));
    validateAssetCatalogEntry(entry, document);
    if (document.metadata.lifecycleState === 'deletion-candidate' && !protectedAssetIds.has(entry.assetId)) candidates.push(entry);
  }
  if (candidates.length === 0) return null;

  candidates.sort((left, right) => compareUtf8(left.assetId, right.assetId));
  const deletionId = makeLibraryKey('d');
  const assets = candidates.map((entry) => ({
    assetId: entry.assetId,
    projectId: entry.projectId,
    assetKey: entry.assetKey,
    metadataPath: entry.metadataPath,
    metadataSha256: entry.metadataSha256,
    bytesPath: entry.bytesPath,
    bytesSha256: entry.bytesSha256,
    byteCount: entry.byteCount,
    trashMetadataPath: `trash/${deletionId}/assets/${entry.assetKey}/metadata/${entry.metadataSha256}.json`,
    trashBytesPath: `trash/${deletionId}/assets/${entry.assetKey}/bytes.bin`,
  }));
  const manifest = {
    format: 'lumina-library-trash',
    version: 1,
    deletionId,
    catalog: catalog.revision,
    assets,
    createdAt: now,
  };
  await writeCanonicalFile(state, managedPath(state, `trash/${deletionId}/manifest.json`), manifest);
  await state.faultInjector?.('after-trash-manifest', { deletionId });
  await materializeTrashPayloads(state, manifest);
  await state.faultInjector?.('after-trash-materialize', { deletionId });
  const next = await publishTrashedCandidates(state, catalog, manifest);
  return { code: 'trash_published', deletionId, catalog: next.revision };
}

export async function recoverInterruptedTrash(state, catalog) {
  let recoveredCatalog = catalog;
  for (const deletionId of (await listDirectories(state, 'trash')).sort(compareUtf8)) {
    if (!/^d_[0-9a-f]{32}$/u.test(deletionId) || await readTrashExpiry(state, deletionId)) continue;
    const manifest = await readTrashManifest(state, deletionId);
    const cleanup = await readTrashCleanup(state, deletionId);
    if (cleanup?.state === 'complete' || cleanup?.state === 'authorized') continue;
    if (manifest.project) {
      recoveredCatalog = await resumeProjectTrash(state, recoveredCatalog, manifest);
      continue;
    }
    await materializeTrashPayloads(state, manifest);
    if (sameCatalogRevision(recoveredCatalog.revision, manifest.catalog)) {
      recoveredCatalog = await publishTrashedCandidates(state, recoveredCatalog, manifest);
      continue;
    }
    if (!manifest.assets.every((entry) => !recoveredCatalog.commit.assets.some((asset) => asset.assetId === entry.assetId))) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'An interrupted trash copy no longer matches the visible catalog.',
        { deletionId },
      );
    }
  }
  return recoveredCatalog;
}

export async function emptyTrash(state, catalog, now, selection) {
  const { deletionId, trashManifestSha256, context } = parseEmptyTrashSelection(selection);
  const command = await consumeRuntimeCommand(
    state,
    catalog,
    context,
    'empty-trash',
    { projectId: null, assetId: null, deletionId },
    { deletionId, trashManifestSha256 },
  );
  if (command.replay) return command.replay;
  if (await readTrashExpiry(state, deletionId)) {
    throw new FileProjectLibraryError('trash_manifest_mismatch', 'The selected trash manifest is no longer pending.', { deletionId });
  }
  const manifestBytes = await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/manifest.json`), 'trash manifest');
  if (sha256(manifestBytes) !== trashManifestSha256) {
    throw new FileProjectLibraryError('trash_manifest_mismatch', 'The selected trash manifest does not match its request.', { deletionId });
  }
  const manifest = parseTrashManifest(manifestBytes, deletionId);
  const entries = trashPayloadEntries(manifest);
  let cleanup = await readTrashCleanup(state, deletionId);
  if (cleanup) assertTrashCleanupMatches(cleanup, manifestBytes, entries);
  if (command.pendingEmptyTrashReceipt && !cleanup) {
    throw new FileProjectLibraryError('command_recovery_failed', 'The pending empty-trash command has no durable receipt.', { deletionId });
  }
  if (cleanup?.state === 'complete') return completeRuntimeCommand(state, command.commandId, { code: 'trash_empty_complete', deletionId });
  if (cleanup?.state === 'cancelled') return completeRuntimeCommand(state, command.commandId, { code: 'trash_empty_cancelled', deletionId });
  if (!cleanup) {
    await assertTrashCleanupPreconditions(state, catalog, deletionId, entries, null, now);
    cleanup = {
      format: 'lumina-library-trash-cleanup',
      version: 1,
      deletionId,
      trashManifestSha256,
      expectedCatalog: catalog.revision,
      rootSetSha256: await trashCleanupRootSetSha256(state, catalog, deletionId, now),
      authorizationClass: 'empty-trash',
      entries,
      authorizedAt: now,
      state: 'authorized',
      terminalAt: null,
      retainedUntil: null,
    };
    await markRuntimeCommandPending(state, command.commandId, null, catalog.revision);
    await writeCanonicalFile(state, managedPath(state, `trash/${deletionId}/cleanup.json`), cleanup);
    await state.faultInjector?.('after-trash-cleanup-authorized', { deletionId });
  }
  return completeRuntimeCommand(
    state,
    command.commandId,
    await completeAuthorizedTrashCleanup(state, catalog, now, deletionId, cleanup, entries),
  );
}

export async function resumeAuthorizedTrashCleanup(state, catalog, now) {
  for (const deletionId of (await listDirectories(state, 'trash')).sort(compareUtf8)) {
    if (!/^d_[0-9a-f]{32}$/u.test(deletionId) || await readTrashExpiry(state, deletionId)) continue;
    const cleanup = await readTrashCleanup(state, deletionId);
    if (cleanup?.state !== 'authorized') continue;
    const manifestBytes = await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/manifest.json`), 'trash manifest');
    const manifest = parseTrashManifest(manifestBytes, deletionId);
    const entries = trashPayloadEntries(manifest);
    assertTrashCleanupMatches(cleanup, manifestBytes, entries);
    return completePendingEmptyTrashCommand(
      state,
      cleanup,
      await completeAuthorizedTrashCleanup(state, catalog, now, deletionId, cleanup, entries),
    );
  }
  const ledger = await readCommandLedger(state);
  for (const command of ledger.entries) {
    if (command.state !== 'pending' || command.action !== 'empty-trash') continue;
    if (!(await readTrashCleanup(state, command.subject.deletionId))) {
      await resetPendingEmptyTrashCommand(state, command.commandId);
    }
  }
  return null;
}

async function completeAuthorizedTrashCleanup(state, catalog, now, deletionId, cleanup, entries) {
  for (const entry of entries) {
    try {
      await assertTrashCleanupPreconditions(state, catalog, deletionId, [entry], cleanup, now);
    } catch (error) {
      if (error instanceof FileProjectLibraryError && error.code === 'trash_cleanup_cancelled') {
        await writeCancelledTrashCleanup(state, deletionId, cleanup, now);
        return { code: 'trash_empty_cancelled', deletionId };
      }
      throw error;
    }
    const target = managedPath(state, entry.path);
    if (await fileDigestIfExists(state, entry.path)) {
      if (!(await removeIfUnchanged(state, target, { sha256: entry.sha256 }))) {
        await writeCancelledTrashCleanup(state, deletionId, cleanup, now);
        return { code: 'trash_empty_cancelled', deletionId };
      }
      await syncDirectory(state, path.dirname(target));
    }
  }
  await writeCanonicalFile(state, managedPath(state, `trash/${deletionId}/cleanup.json`), {
    ...cleanup,
    state: 'complete',
    terminalAt: now,
    retainedUntil: now + DEFAULT_SAFETY_WINDOW_MS,
  });
  return { code: 'trash_empty_complete', deletionId };
}

async function completePendingEmptyTrashCommand(state, cleanup, result) {
  const command = (await readCommandLedger(state)).entries.find((entry) => (
    entry.state === 'pending'
      && entry.action === 'empty-trash'
      && entry.subject.deletionId === cleanup.deletionId
      && sameCatalogRevision(entry.intendedCatalog, cleanup.expectedCatalog)
  ));
  if (!command) return result;
  return completeRuntimeCommand(state, command.commandId, result);
}

function parseEmptyTrashSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || Object.keys(selection).length !== 3
    || !Object.hasOwn(selection, 'deletionId')
    || !Object.hasOwn(selection, 'trashManifestSha256')
    || !Object.hasOwn(selection, 'context')
    || typeof selection.deletionId !== 'string'
    || !/^[0-9a-f]{64}$/u.test(selection.trashManifestSha256)
    || !selection.context || typeof selection.context !== 'object' || Array.isArray(selection.context)) {
    throw new FileProjectLibraryError('runtime_command_context_required', 'Empty-trash requires one verified runtime command context.');
  }
  try {
    validateLibraryKey(selection.deletionId, 'd');
  } catch (error) {
    throw new FileProjectLibraryError('trash_manifest_mismatch', 'Empty-trash requires a valid trash deletion ID.', { cause: error });
  }
  return selection;
}

export async function cleanupExpiredTrashAudits(state, catalog, now) {
  for (const deletionId of (await listDirectories(state, 'trash')).sort(compareUtf8)) {
    if (!/^d_[0-9a-f]{32}$/u.test(deletionId)) continue;
    const expiry = await readTrashExpiry(state, deletionId);
    if (expiry) {
      await finishTrashExpiry(state, catalog, now, expiry);
      continue;
    }
    const manifestBytes = await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/manifest.json`), 'trash manifest');
    const manifest = parseTrashManifest(manifestBytes, deletionId);
    const cleanupBytes = await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/cleanup.json`), 'trash cleanup receipt');
    const cleanup = parseTrashCleanup(cleanupBytes, deletionId);
    const entries = trashPayloadEntries(manifest);
    assertTrashCleanupMatches(cleanup, manifestBytes, entries);
    if (cleanup.state !== 'complete' || now < cleanup.retainedUntil) continue;
    for (const entry of entries) {
      if (await fileDigestIfExists(state, entry.path)) {
        throw new FileProjectLibraryError('recovery_required', 'A completed trash audit still retains a payload.', { deletionId, path: entry.path });
      }
    }
    const terminalRoots = await collectReachablePaths(state, catalog, now, { excludeTrashDeletionId: deletionId });
    const expiryRecord = {
      format: 'lumina-library-trash-expiry',
      version: 1,
      deletionId,
      trashManifestSha256: sha256(manifestBytes),
      cleanupSha256: sha256(cleanupBytes),
      terminalRootSetSha256: rootSetDigest(terminalRoots),
      authorizedAt: now,
      state: 'authorized',
      completedAt: null,
      retainedUntil: null,
    };
    await writeCanonicalFile(state, managedPath(state, `trash/${deletionId}/expiry.json`), expiryRecord);
    await finishTrashExpiry(state, catalog, now, expiryRecord);
  }
}

async function publishTrashedCandidates(state, catalog, manifest) {
  if (!sameCatalogRevision(catalog.revision, manifest.catalog)) {
    throw new FileProjectLibraryError('recovery_required', 'Trash publication no longer matches its pinned catalog.', { deletionId: manifest.deletionId });
  }
  for (const entry of manifest.assets) {
    const visible = catalog.commit.assets.find((asset) => asset.assetId === entry.assetId);
    if (!visible || visible.projectId !== entry.projectId || visible.metadataPath !== entry.metadataPath
      || visible.metadataSha256 !== entry.metadataSha256 || visible.bytesPath !== entry.bytesPath
      || visible.bytesSha256 !== entry.bytesSha256 || visible.byteCount !== entry.byteCount) {
      throw new FileProjectLibraryError('recovery_required', 'Trash publication no longer owns its candidate asset.', { deletionId: manifest.deletionId, assetId: entry.assetId });
    }
  }
  const expectedProjectRevisions = [...new Set(manifest.assets.map((entry) => entry.projectId))]
    .sort(compareUtf8)
    .map((projectId) => ({
      projectId,
      expectedRevision: catalog.commit.projects.find((entry) => entry.projectId === projectId)?.revision ?? 'absent',
    }));
  return publishNextCatalog(
    state,
    catalog,
    {
      projects: catalog.commit.projects,
      assets: catalog.commit.assets.filter((entry) => !manifest.assets.some((candidate) => candidate.assetId === entry.assetId)),
    },
    'asset-lifecycle',
    {
      transactionId: makeLibraryKey('t'),
      expectedCatalog: catalog.revision,
      expectedProjectRevisions,
    },
  );
}

async function materializeTrashPayloads(state, manifest) {
  for (const entry of manifest.assets) {
    await materializeTrashPayload(state, manifest.deletionId, entry.metadataPath, entry.trashMetadataPath, entry.metadataSha256, 'trash metadata');
    await materializeTrashPayload(state, manifest.deletionId, entry.bytesPath, entry.trashBytesPath, entry.bytesSha256, 'trash asset bytes');
  }
}

async function materializeTrashPayload(state, deletionId, sourceRelative, targetRelative, expectedSha256, label) {
  const existing = await fileDigestIfExists(state, targetRelative);
  if (existing) {
    if (existing.sha256 !== expectedSha256) {
      throw new FileProjectLibraryError('recovery_required', `${label} changed before trash recovery.`, { deletionId, path: targetRelative });
    }
    return;
  }
  const source = await fileDigestIfExists(state, sourceRelative);
  if (!source || source.sha256 !== expectedSha256) {
    throw new FileProjectLibraryError('recovery_required', `${label} no longer matches its trash manifest.`, { deletionId, path: sourceRelative });
  }
  const temporaryRelative = `${targetRelative}.copying`;
  const temporary = await fileDigestIfExists(state, temporaryRelative);
  if (temporary) {
    if (!(await removeIfUnchanged(state, managedPath(state, temporaryRelative), { sha256: temporary.sha256 }))) {
      throw new FileProjectLibraryError('recovery_required', `${label} temporary changed before recovery.`, { deletionId, path: temporaryRelative });
    }
    await syncDirectory(state, path.dirname(managedPath(state, temporaryRelative)));
  }
  await copyManagedFile(state, managedPath(state, sourceRelative), managedPath(state, temporaryRelative));
  const copied = await hashFileBytes(state, managedPath(state, temporaryRelative));
  if (copied.sha256 !== expectedSha256) {
    throw new CorruptLibraryError(`${label} changed while it was copied to trash.`);
  }
  await atomicReplace(state, managedPath(state, temporaryRelative), managedPath(state, targetRelative));
  await syncDirectory(state, path.dirname(managedPath(state, targetRelative)));
}

async function finishTrashExpiry(state, catalog, now, expiry) {
  const deletionId = expiry.deletionId;
  const root = managedPath(state, `trash/${deletionId}`);
  const expiryPath = managedPath(state, `trash/${deletionId}/expiry.json`);
  const expiryBytes = await readCanonicalFile(state, expiryPath, 'trash expiry receipt');
  const parsed = parseTrashExpiry(expiryBytes, deletionId);
  if (parsed.state === 'complete') {
    if (now >= parsed.retainedUntil) {
      await removeExactManagedTree(state, root, [{ path: 'expiry.json', sha256: sha256(expiryBytes) }], 'Expired trash audit');
    }
    return;
  }
  if (parsed.terminalRootSetSha256 !== rootSetDigest(await collectReachablePaths(state, catalog, now, { excludeTrashDeletionId: deletionId }))) {
    throw new FileProjectLibraryError('recovery_required', 'Trash expiry roots changed before exact audit removal.', { deletionId });
  }
  const manifestPath = managedPath(state, `trash/${deletionId}/manifest.json`);
  const cleanupPath = managedPath(state, `trash/${deletionId}/cleanup.json`);
  const expected = [{ path: 'expiry.json', sha256: sha256(expiryBytes) }];
  for (const [target, expectedSha256, label] of [
    [manifestPath, parsed.trashManifestSha256, 'trash manifest'],
    [cleanupPath, parsed.cleanupSha256, 'trash cleanup receipt'],
  ]) {
    try {
      const bytes = await readCanonicalFile(state, target, label);
      if (sha256(bytes) !== expectedSha256) {
        throw new FileProjectLibraryError('recovery_required', 'Trash expiry evidence changed before exact audit removal.', { deletionId });
      }
      expected.push({ path: path.basename(target), sha256: expectedSha256 });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const actual = await captureManagedTreeClosure(state, root, 'Trash expiry audit');
  const sortedExpected = expected.sort((left, right) => compareUtf8(left.path, right.path));
  if (actual.length !== sortedExpected.length || actual.some((entry, index) => (
    entry.path !== sortedExpected[index].path || entry.sha256 !== sortedExpected[index].sha256
  ))) {
    throw new FileProjectLibraryError('recovery_required', 'Trash expiry audit changed before exact removal.', { deletionId });
  }
  for (const target of [manifestPath, cleanupPath]) {
    try {
      const bytes = await readCanonicalFile(state, target, target === manifestPath ? 'trash manifest' : 'trash cleanup receipt');
      if (!(await removeIfUnchanged(state, target, { sha256: sha256(bytes) }))) {
        throw new FileProjectLibraryError('recovery_required', 'Trash expiry evidence changed before exact audit removal.', { deletionId });
      }
      await syncDirectory(state, path.dirname(target));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await writeCanonicalFile(state, expiryPath, {
    ...parsed,
    state: 'complete',
    completedAt: now,
    retainedUntil: now + DEFAULT_SAFETY_WINDOW_MS,
  });
}

async function assertTrashCleanupPreconditions(state, catalog, deletionId, entries, cleanup, now) {
  const current = await readCatalog(state);
  const expectedCatalog = cleanup?.expectedCatalog ?? catalog.revision;
  const rootSetSha256 = cleanup?.rootSetSha256 ?? await trashCleanupRootSetSha256(state, catalog, deletionId, now);
  if (!sameCatalogRevision(current.revision, expectedCatalog)
    || rootSetSha256 !== await trashCleanupRootSetSha256(state, current, deletionId, now)) {
    throw new FileProjectLibraryError('trash_cleanup_cancelled', 'Trash cleanup roots changed before deletion.', { deletionId });
  }
  for (const entry of entries) {
    const actual = await fileDigestIfExists(state, entry.path);
    if (actual && actual.sha256 !== entry.sha256) {
      throw new FileProjectLibraryError('recovery_required', 'A trash payload changed before exact empty-trash cleanup.', { deletionId, path: entry.path });
    }
  }
}

async function trashCleanupRootSetSha256(state, catalog, deletionId, now) {
  return rootSetDigest(await collectReachablePaths(state, catalog, now, { excludeTrashDeletionId: deletionId }));
}

async function writeCancelledTrashCleanup(state, deletionId, cleanup, now) {
  await writeCanonicalFile(state, managedPath(state, `trash/${deletionId}/cleanup.json`), {
    ...cleanup,
    state: 'cancelled',
    terminalAt: now,
    retainedUntil: now + DEFAULT_SAFETY_WINDOW_MS,
  });
}

async function readTrashManifest(state, deletionId) {
  return parseTrashManifest(
    await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/manifest.json`), 'trash manifest'),
    deletionId,
  );
}

async function readTrashCleanup(state, deletionId) {
  try {
    return parseTrashCleanup(
      await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/cleanup.json`), 'trash cleanup receipt'),
      deletionId,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readTrashExpiry(state, deletionId) {
  try {
    return parseTrashExpiry(
      await readCanonicalFile(state, managedPath(state, `trash/${deletionId}/expiry.json`), 'trash expiry receipt'),
      deletionId,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertTrashCleanupMatches(cleanup, manifestBytes, entries) {
  if (cleanup.trashManifestSha256 !== sha256(manifestBytes)
    || canonicalize(cleanup.entries) !== canonicalize(entries)) {
    throw new CorruptLibraryError('Trash cleanup receipt does not match its manifest.');
  }
}

function trashPayloadEntries(manifest) {
  return manifest.assets
    .flatMap((entry) => [
      { path: entry.trashMetadataPath, sha256: entry.metadataSha256 },
      { path: entry.trashBytesPath, sha256: entry.bytesSha256 },
    ])
    .sort((left, right) => compareUtf8(left.path, right.path));
}

function sameCatalogRevision(left, right) {
  return left.commitId === right.commitId && left.sequence === right.sequence && left.commitSha256 === right.commitSha256;
}
