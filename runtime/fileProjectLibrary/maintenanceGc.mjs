import { parseCleanupPlan } from './catalog.mjs';
import { CorruptLibraryError, DEFAULT_SAFETY_WINDOW_MS, FileProjectLibraryError, KEY_PATTERN, compareUtf8, fs, makeLibraryKey, path, sha256 } from './core.mjs';
import { assertWriteLeaseCurrent, collectFiles, ensureNoSymlinkPath, fault, hashFileBytes, listDirectories, managedPath, readCanonicalFile, removeExactManagedTree, removeIfUnchanged, syncDirectory, writeCanonicalFile } from './filesystem.mjs';
import { withReaderPinBarrier } from './readerPins.mjs';
import { cleanupExpiredQuarantines } from './quarantineMaintenance.mjs';
import { collectReachablePaths, rootSetDigest } from './maintenanceReachability.mjs';
import { cleanupExpiredTrashAudits, emptyTrash, moveDeletionCandidatesToTrash, resumeAuthorizedTrashCleanup } from './maintenanceTrash.mjs';

export async function cleanupOrphans(state, catalog, cleanupOptions = {}) {
  const now = state.clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid timestamp.');
  }
  const quarantineResult = await cleanupExpiredQuarantines(state, catalog, now);
  if (quarantineResult) return quarantineResult;
  if (cleanupOptions?.emptyTrash !== undefined) return emptyTrash(state, catalog, now, cleanupOptions.emptyTrash);
  const resumedTrash = await resumeAuthorizedTrashCleanup(state, catalog, now);
  if (resumedTrash) return resumedTrash;
  const trashResult = await moveDeletionCandidatesToTrash(state, catalog, now);
  if (trashResult) return trashResult;
  const safetyWindowMs = DEFAULT_SAFETY_WINDOW_MS;
  const reachable = await collectReachablePaths(state, catalog, now);
  const plans = await listDirectories(state, 'maintenance');
  let pendingPlan = null;
  for (const transactionId of plans.sort(compareUtf8)) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') continue;
    const planPath = managedPath(state, `maintenance/${transactionId}/gc.json`);
    let planBytes;
    try {
      planBytes = await readCanonicalFile(state, planPath, 'garbage-collection plan');
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

  await cleanupExpiredTrashAudits(state, catalog, now);

  const candidates = [];
  for (const absolute of await collectFiles(state, state.root)) {
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
      candidates.push({ path: relative, sha256: (await hashFileBytes(state, absolute)).sha256 });
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
  await ensureNoSymlinkPath(state, directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== 'gc.json' || entry.isSymbolicLink() || entry.isDirectory()) {
      throw new CorruptLibraryError('Garbage-collection plan contains unexpected retained data.');
    }
  }
  const planPath = path.join(directory, 'gc.json');
  const planBytes = await readCanonicalFile(state, planPath, 'garbage-collection plan');
  const plan = parseCleanupPlan(planBytes, transactionId);
  if (!['complete', 'cancelled'].includes(plan.state)
    || !Number.isSafeInteger(plan.retainedUntil)
    || state.clock() < plan.retainedUntil) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'The expired garbage-collection plan changed before exact cleanup.',
      { transactionId },
    );
  }
  if (!(await removeIfUnchanged(state, planPath, { sha256: sha256(planBytes) }))) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'The expired garbage-collection plan changed before exact cleanup.',
      { transactionId },
    );
  }
  await removeExactManagedTree(state, directory, [], 'Expired garbage-collection plan');
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
        await ensureNoSymlinkPath(state, target);
        const hashed = await hashFileBytes(state, target);
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
    await ensureNoSymlinkPath(state, target);
    const hashed = await hashFileBytes(state, target);
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
