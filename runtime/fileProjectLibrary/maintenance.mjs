import { parseCleanupPlan, parseCommit, parseHead, parseQuarantineCleanup, parseQuarantineManifest, validateCatalogForHead, validateCatalogPayloads } from './catalog.mjs';
import { ACTIVE_READER_PINS, CorruptLibraryError, DEFAULT_SAFETY_WINDOW_MS, DIGEST_PATTERN, FileProjectLibraryError, KEY_PATTERN, QUARANTINE_RETENTION_MS, canonicalize, compareUtf8, fs, makeLibraryKey, path, sha256, validateLibraryKey } from './core.mjs';
import { assertWriteLeaseCurrent, collectFiles, ensureNoSymlinkPath, fault, fileDigestIfExists, hashFileBytes, listDirectories, managedPath, readCanonicalFile, removeIfUnchanged, syncDirectory, writeCanonicalFile } from './filesystem.mjs';
import { withReaderPinBarrier } from './readerPins.mjs';
import { readProjectRecovery } from './projects.mjs';

export async function cleanupOrphans(state, catalog, cleanupOptions = {}) {
  const now = state.clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid timestamp.');
  }
  const quarantineResult = await cleanupExpiredQuarantines(state, catalog, now);
  if (quarantineResult) return quarantineResult;
  const safetyWindowMs = DEFAULT_SAFETY_WINDOW_MS;
  const reachable = await collectReachablePaths(state, catalog, now);
  const plans = await listDirectories(state, 'maintenance');
  let pendingPlan = null;
  for (const transactionId of plans.sort(compareUtf8)) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') continue;
    const planPath = managedPath(state, `maintenance/${transactionId}/gc.json`);
    let planBytes;
    try {
      planBytes = await readCanonicalFile(planPath, 'garbage-collection plan');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const plan = parseCleanupPlan(planBytes, transactionId);
    if (plan.state === 'complete' || plan.state === 'cancelled') {
      if (now >= (plan.retainedUntil ?? Number.POSITIVE_INFINITY)) {
        await removeExpiredCleanupPlan(state, transactionId);
      }
      continue;
    }
    if (now < plan.notBefore) {
      pendingPlan ??= plan;
      continue;
    }
    const result = await completeCleanupPlan(state, plan, catalog, now);
    if (result) return result;
  }
  if (pendingPlan) {
    return {
      code: 'cleanup_planned',
      transactionId: pendingPlan.transactionId,
      notBefore: pendingPlan.notBefore,
      entries: pendingPlan.entries,
    };
  }

  const candidates = [];
  for (const absolute of await collectFiles(state.root)) {
    const relative = path.relative(state.root, absolute).replaceAll('\\', '/');
    if (
      reachable.has(relative)
      || relative.startsWith('staging/')
      || relative.startsWith('quarantine/')
      || relative.startsWith('trash/')
      || relative.startsWith('maintenance/')
      || relative.startsWith('control/')
      || !/^(?:projects|assets|commits|attachments)\//u.test(relative)
    ) continue;
    const stat = await fs.stat(absolute);
    if (now - stat.mtimeMs >= safetyWindowMs) {
      candidates.push({ path: relative, sha256: (await hashFileBytes(absolute)).sha256 });
    }
  }
  if (candidates.length === 0) return { code: 'cleanup_complete', removed: [] };
  candidates.sort((left, right) => compareUtf8(left.path, right.path));
  const transactionId = makeLibraryKey('t');
  const plan = {
    format: 'lumina-library-gc',
    version: 1,
    transactionId,
    visibleCommitId: catalog.head.commitId,
    rootSetSha256: rootSetDigest(reachable),
    entries: candidates,
    plannedAt: now,
    notBefore: now + safetyWindowMs,
    state: 'planned',
    authorizedAt: null,
    completedAt: null,
    retainedUntil: null,
  };
  await writeCanonicalFile(state, managedPath(state, `maintenance/${transactionId}/gc.json`), plan);
  return { code: 'cleanup_planned', transactionId, notBefore: plan.notBefore, entries: candidates };
}

export async function removeExpiredCleanupPlan(state, transactionId) {
  const directory = managedPath(state, `maintenance/${transactionId}`);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== 'gc.json' || entry.isSymbolicLink() || entry.isDirectory()) {
      throw new CorruptLibraryError('Garbage-collection plan contains unexpected retained data.');
    }
  }
  await fs.rm(path.join(directory, 'gc.json'), { force: true });
  await fs.rmdir(directory).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

export async function completeCleanupPlan(state, plan, catalog, now) {
  return withReaderPinBarrier(state, async () => {
    if (!Array.isArray(plan.entries) || plan.visibleCommitId === undefined) {
      throw new CorruptLibraryError('Garbage-collection plan is invalid.');
    }
    const reachable = await collectReachablePaths(state, catalog, now);
    const currentRootSetSha256 = rootSetDigest(reachable);
    const changed = plan.visibleCommitId !== undefined
      && (!reachable.has(`commits/${plan.visibleCommitId}.json`)
        || plan.rootSetSha256 !== currentRootSetSha256
        || plan.entries.some((entry) => reachable.has(entry.path)));
    if (changed) {
      return cancelCleanupPlan(state, plan, now);
    }
    for (const entry of plan.entries) {
      const target = managedPath(state, entry.path);
      try {
        await ensureNoSymlinkPath(state.root, target);
        const hashed = await hashFileBytes(target);
        if (hashed.sha256 !== entry.sha256) {
          return cancelCleanupPlan(state, plan, now);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const authorized = { ...plan, state: 'authorized', authorizedAt: plan.authorizedAt ?? now };
    await fault(state, 'before-cleanup-authorize', { transactionId: plan.transactionId });
    await writeCanonicalFile(state, managedPath(state, `maintenance/${plan.transactionId}/gc.json`), authorized);
    await fault(state, 'after-cleanup-authorize', { transactionId: plan.transactionId });
    const removed = [];
    for (const entry of plan.entries) {
      const target = managedPath(state, entry.path);
      await fault(state, 'before-cleanup-delete', { transactionId: plan.transactionId, path: entry.path });
      const revalidated = await revalidateCleanupEntry(state, authorized, catalog, entry, now);
      if (!revalidated.valid) return cancelCleanupPlan(state, authorized, now);
      await fault(state, 'after-cleanup-revalidate', { transactionId: plan.transactionId, path: entry.path });
      if (revalidated.exists) {
        await assertWriteLeaseCurrent(state);
        if (!(await removeIfUnchanged(state, target, { sha256: entry.sha256 }))) {
          return cancelCleanupPlan(state, authorized, now);
        }
        removed.push(entry.path);
      }
      await fault(state, 'after-cleanup-delete', { transactionId: plan.transactionId, path: entry.path });
    }
    const completed = {
      ...authorized,
      state: 'complete',
      completedAt: now,
      retainedUntil: now + DEFAULT_SAFETY_WINDOW_MS,
    };
    await fault(state, 'before-cleanup-complete', { transactionId: plan.transactionId });
    await writeCanonicalFile(state, managedPath(state, `maintenance/${plan.transactionId}/gc.json`), completed);
    await fault(state, 'after-cleanup-complete', { transactionId: plan.transactionId });
    return { code: 'cleanup_complete', transactionId: plan.transactionId, removed: removed.sort(compareUtf8) };
  });
}

export async function revalidateCleanupEntry(state, authorized, catalog, entry, now) {
  await assertWriteLeaseCurrent(state);
  const reachable = await collectReachablePaths(state, catalog, now);
  if (
    authorized.visibleCommitId !== catalog.head.commitId
    || authorized.rootSetSha256 !== rootSetDigest(reachable)
    || reachable.has(entry.path)
  ) {
    return { valid: false, exists: false };
  }
  const target = managedPath(state, entry.path);
  try {
    await ensureNoSymlinkPath(state.root, target);
    const hashed = await hashFileBytes(target);
    return { valid: hashed.sha256 === entry.sha256, exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { valid: true, exists: false };
    throw error;
  }
}

export async function cancelCleanupPlan(state, plan, now) {
  const cancelled = {
    ...plan,
    state: 'cancelled',
    completedAt: now,
    retainedUntil: now + DEFAULT_SAFETY_WINDOW_MS,
  };
  await writeCanonicalFile(state, managedPath(state, `maintenance/${plan.transactionId}/gc.json`), cancelled);
  return { code: 'cleanup_cancelled', transactionId: plan.transactionId, removed: [] };
}

export function rootSetDigest(reachable) {
  return sha256(canonicalize([...reachable].sort(compareUtf8)));
}

export async function addCatalogReachablePaths(state, reachable, commit) {
  reachable.add(`commits/${commit.commitId}.json`);
  for (const entry of commit.projects) {
    reachable.add(entry.manifestPath);
    reachable.add(entry.manifestPath.replace(/manifest\.json$/u, 'project.json'));
    reachable.add(entry.manifestPath.replace(/manifest\.json$/u, 'history.json'));
    const recovery = await readProjectRecovery(state, entry);
    if (recovery) {
      reachable.add(`projects/${entry.projectKey}/recovery/${recovery.recoveryId}.json`);
      reachable.add(recovery.sourceProjectPath);
      reachable.add(recovery.sourceHistoryPath);
    }
  }
  for (const entry of commit.assets) {
    reachable.add(entry.metadataPath);
    reachable.add(entry.bytesPath);
  }
}

export async function addActiveReaderPinPaths(state, reachable, now) {
  const pins = ACTIVE_READER_PINS.get(state.root);
  if (!pins) return;
  for (const [pinId, pin] of pins) {
    if (pin.expiresAt <= now) {
      pins.delete(pinId);
      continue;
    }
    try {
      validateLibraryKey(pinId, 'r');
      validateLibraryKey(pin.commitId, 'c');
      if (!DIGEST_PATTERN.test(pin.commitSha256)
        || !Number.isSafeInteger(pin.sequence)
        || pin.sequence < 0
        || !Number.isSafeInteger(pin.expiresAt)) {
        throw new CorruptLibraryError('Reader pin is invalid.');
      }
      const commit = parseCommit(await readCanonicalFile(
        managedPath(state, `commits/${pin.commitId}.json`),
        'reader-pinned catalog',
      ));
      if (commit.commitId !== pin.commitId
        || commit.sequence !== pin.sequence
        || sha256(canonicalize(commit)) !== pin.commitSha256) {
        throw new CorruptLibraryError('Reader pin does not match its catalog.');
      }
      await validateCatalogPayloads(state, commit);
      await addCatalogReachablePaths(state, reachable, commit);
    } catch (error) {
      throw new FileProjectLibraryError(
        'reader_pin_invalid',
        'A live reader pin cannot be validated for garbage collection.',
        { pinId, cause: error },
      );
    }
  }
  if (pins.size === 0) ACTIVE_READER_PINS.delete(state.root);
}

export async function collectReachablePaths(state, catalog, now = state.clock(), options = {}) {
  const reachable = new Set(['library.json', 'head.json', 'head.previous.json', '.library-write.lock']);
  await addCatalogReachablePaths(state, reachable, catalog.commit);
  try {
    const previousHead = parseHead(await readCanonicalFile(managedPath(state, 'head.previous.json'), 'previous head'));
    const journalIsCurrentHead = previousHead.commitId === catalog.head.commitId
      && previousHead.commitSha256 === catalog.head.commitSha256;
    if (!journalIsCurrentHead && previousHead.commitId !== catalog.head.previousCommitId) {
      throw new CorruptLibraryError('Previous head is not the visible catalog predecessor.');
    }
    const previousCommit = await validateCatalogForHead(state, previousHead);
    if (!journalIsCurrentHead) await addCatalogReachablePaths(state, reachable, previousCommit);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await addActiveReaderPinPaths(state, reachable, now);
  await addQuarantineReachablePaths(state, reachable, now, options.excludeQuarantineTransactionId);
  return reachable;
}

export async function addQuarantineReachablePaths(state, reachable, now, excludedTransactionId = null) {
  for (const transactionId of (await listDirectories(state, 'quarantine')).sort(compareUtf8)) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't' || transactionId === excludedTransactionId) {
      continue;
    }
    const manifestPath = `quarantine/${transactionId}/manifest.json`;
    let manifestBytes;
    try {
      manifestBytes = await readCanonicalFile(managedPath(state, manifestPath), 'quarantine manifest');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new FileProjectLibraryError(
          'recovery_required',
          'A quarantine directory is missing its durable manifest.',
          { transactionId },
        );
      }
      throw error;
    }
    const manifest = parseQuarantineManifest(manifestBytes, transactionId);
    const cleanupPath = `quarantine/${transactionId}/cleanup.json`;
    let cleanup = null;
    try {
      cleanup = parseQuarantineCleanup(
        await readCanonicalFile(managedPath(state, cleanupPath), 'quarantine cleanup receipt'),
        transactionId,
      );
      assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (cleanup?.state === 'authorized') {
      reachable.add(manifestPath);
      reachable.add(cleanupPath);
      for (const entry of manifest.retained) reachable.add(entry.path);
    } else if (cleanup?.state === 'complete') {
      if (now < cleanup.retainedUntil) {
        reachable.add(manifestPath);
        reachable.add(cleanupPath);
      }
    } else if (now < manifest.retainedUntil) {
      reachable.add(manifestPath);
      for (const entry of manifest.retained) reachable.add(entry.path);
    }
  }
}

export async function cleanupExpiredQuarantines(state, catalog, now) {
  const transactionIds = (await listDirectories(state, 'quarantine')).sort(compareUtf8);
  for (const transactionId of transactionIds) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') continue;
    const manifestPath = managedPath(state, `quarantine/${transactionId}/manifest.json`);
    let manifestBytes;
    try {
      manifestBytes = await readCanonicalFile(manifestPath, 'quarantine manifest');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new FileProjectLibraryError(
          'recovery_required',
          'A quarantine directory is missing its durable manifest.',
          { transactionId },
        );
      }
      throw error;
    }
    const manifest = parseQuarantineManifest(manifestBytes, transactionId);
    const cleanupPath = managedPath(state, `quarantine/${transactionId}/cleanup.json`);
    let cleanup = null;
    try {
      cleanup = parseQuarantineCleanup(
        await readCanonicalFile(cleanupPath, 'quarantine cleanup receipt'),
        transactionId,
      );
      assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (cleanup?.state === 'complete') {
      if (now >= cleanup.retainedUntil) {
        await expireQuarantine(state, transactionId, manifest, cleanup);
        return { code: 'quarantine_expired', transactionId };
      }
      continue;
    }
    if (cleanup?.state === 'authorized') {
      return completeQuarantineCleanup(state, catalog, manifestBytes, manifest, cleanup, now);
    }
    if (now < manifest.retainedUntil) continue;
    return authorizeQuarantineCleanup(state, catalog, manifestBytes, manifest, now);
  }
  return null;
}

export function assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup) {
  if (cleanup.manifestSha256 !== sha256(manifestBytes)
    || canonicalize(cleanup.entries) !== canonicalize(manifest.retained)) {
    throw new CorruptLibraryError('Quarantine cleanup receipt does not match its manifest.');
  }
}

export async function authorizeQuarantineCleanup(state, catalog, manifestBytes, manifest, now) {
  return withReaderPinBarrier(state, async () => {
    const reachable = await collectReachablePaths(state, catalog, now, {
      excludeQuarantineTransactionId: manifest.transactionId,
    });
    await verifyQuarantineCleanupClosure(state, manifest, reachable, true);
    const cleanup = {
      format: 'lumina-library-quarantine-cleanup',
      version: 1,
      transactionId: manifest.transactionId,
      manifestSha256: sha256(manifestBytes),
      rootSetSha256: rootSetDigest(reachable),
      entries: manifest.retained,
      checkedAt: now,
      state: 'authorized',
      completedAt: null,
      retainedUntil: null,
    };
    await fault(state, 'before-quarantine-cleanup-authorize', { transactionId: manifest.transactionId });
    await writeCanonicalFile(state, managedPath(state, `quarantine/${manifest.transactionId}/cleanup.json`), cleanup);
    await fault(state, 'after-quarantine-cleanup-authorize', { transactionId: manifest.transactionId });
    return completeQuarantineCleanup(state, catalog, manifestBytes, manifest, cleanup, now, true);
  });
}

export async function completeQuarantineCleanup(state, catalog, manifestBytes, manifest, cleanup, now, readerBarrierHeld = false) {
  const complete = async () => {
    assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup);
    const reachable = await collectReachablePaths(state, catalog, now, {
      excludeQuarantineTransactionId: manifest.transactionId,
    });
    if (cleanup.rootSetSha256 !== rootSetDigest(reachable)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The quarantine root set changed after cleanup authorization.',
        { transactionId: manifest.transactionId },
      );
    }
    await verifyQuarantineCleanupClosure(state, manifest, reachable);
    const removed = [];
    for (const entry of cleanup.entries) {
      await fault(state, 'before-quarantine-cleanup-delete', { transactionId: manifest.transactionId, path: entry.path });
      const actual = await fileDigestIfExists(state, entry.path);
      if (actual) {
        if (actual.sha256 !== entry.sha256) {
          throw new FileProjectLibraryError(
            'recovery_required',
            'A retained quarantine payload changed after authorization.',
            { transactionId: manifest.transactionId, path: entry.path },
          );
        }
        const target = managedPath(state, entry.path);
        await fs.rm(target, { force: true });
        await syncDirectory(state, path.dirname(target));
        removed.push(entry.path);
      }
      await fault(state, 'after-quarantine-cleanup-delete', { transactionId: manifest.transactionId, path: entry.path });
    }
    const completed = {
      ...cleanup,
      state: 'complete',
      completedAt: now,
      retainedUntil: now + QUARANTINE_RETENTION_MS,
    };
    await fault(state, 'before-quarantine-cleanup-complete', { transactionId: manifest.transactionId });
    await writeCanonicalFile(state, managedPath(state, `quarantine/${manifest.transactionId}/cleanup.json`), completed);
    await fault(state, 'after-quarantine-cleanup-complete', { transactionId: manifest.transactionId });
    return { code: 'quarantine_cleanup_complete', transactionId: manifest.transactionId, removed: removed.sort(compareUtf8) };
  };
  return readerBarrierHeld ? complete() : withReaderPinBarrier(state, complete);
}

export async function verifyQuarantineCleanupClosure(state, manifest, reachable, requireQuarantineCopies = false) {
  for (const entry of manifest.retained) {
    if (reachable.has(entry.path)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'A retained quarantine payload is reachable from the current root set.',
        { transactionId: manifest.transactionId, path: entry.path },
      );
    }
    const actual = await fileDigestIfExists(state, entry.path);
    if (!actual) {
      if (requireQuarantineCopies && entry.path.startsWith(`quarantine/${manifest.transactionId}/`)) {
        throw new FileProjectLibraryError(
          'recovery_required',
          'A quarantined control payload is missing before cleanup.',
          { transactionId: manifest.transactionId, path: entry.path },
        );
      }
      continue;
    }
    if (actual.sha256 !== entry.sha256) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'A retained quarantine payload digest no longer matches.',
        { transactionId: manifest.transactionId, path: entry.path },
      );
    }
  }
}

export async function expireQuarantine(state, transactionId, manifest, cleanup) {
  for (const entry of cleanup.entries) {
    if (await fileDigestIfExists(state, entry.path)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'A completed quarantine still contains a retained payload.',
        { transactionId, path: entry.path },
      );
    }
  }
  const directory = managedPath(state, `quarantine/${transactionId}`);
  const allowed = new Set([
    path.resolve(directory, 'manifest.json'),
    path.resolve(directory, 'cleanup.json'),
  ]);
  for (const file of await collectFiles(directory)) {
    if (!allowed.has(path.resolve(file))) {
      throw new CorruptLibraryError('Completed quarantine contains unexpected retained data.');
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
  await syncDirectory(state, path.dirname(directory));
}
