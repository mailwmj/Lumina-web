import { emptyCommit } from './admission.mjs';
import { parseLibraryManifest, readCatalog } from './catalog.mjs';
import { ACTIVE_READER_PINS, CorruptLibraryError, DEFAULT_LOCK_TIMEOUT_MS, FileProjectLibraryError, LIBRARY_FORMAT, LIBRARY_VERSION, MAX_READER_PIN_MS, canonicalize, fs, makeLibraryKey, path, randomBytes, randomUUID, sha256 } from './core.mjs';
import { acquireWriteLease, assertDurableFileOps, assertWriteLeaseCurrent, collectFiles, ensureDirectory, ensureNoSymlinkAncestors, ensureNoSymlinkPath, listDirectories, managedPath, pathExists, readCanonicalFile, releaseWriteLease, removeIfUnchanged, runDurableOperation, syncDirectory, writeCanonicalFile, writeCanonicalHeadFile } from './filesystem.mjs';
import { cleanupOrphans } from './maintenance.mjs';
import { deleteAsset, deleteProject, getAssetMetadata, listDeletionCandidates, readAsset, setDeletionCandidates, writeAsset } from './assets.mjs';
import { listProjects, openProject, renameProject, saveProject, updateViewport } from './projects.mjs';
import { recoverUnderLease } from './recovery.mjs';
import { isReaderPinGateClosed, readerPinGate, waitForReaderPinGate } from './readerPins.mjs';
import { selectDurableFileOps } from './durableFileOps.mjs';
import { selectManagedLibraryRoot } from './managedRoot.mjs';

export function createFileProjectLibrary(options = {}) {
  const selectedRoot = selectManagedLibraryRoot(options);
  if (!selectedRoot) {
    throw new FileProjectLibraryError(
      'invalid_root',
      'The runtime could not select a managed library root.',
    );
  }

  const state = {
    root: selectedRoot,
    lockPath: path.join(selectedRoot, '.library-write.lock'),
    opened: false,
    opening: null,
    library: null,
    faultInjector: typeof options.faultInjector === 'function' ? options.faultInjector : null,
    emptyTrashAuthorizer: typeof options.emptyTrashAuthorizer === 'function' ? options.emptyTrashAuthorizer : null,
    durableFileOps: selectDurableFileOps(options),
    recovery: null,
    activeWriteLease: null,
    lockTimeoutMs: Number.isSafeInteger(options.lockTimeoutMs) && options.lockTimeoutMs > 0
      ? options.lockTimeoutMs
      : DEFAULT_LOCK_TIMEOUT_MS,
    clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
  };

  const api = {
    open: () => openLibrary(state),
    recover: (recoveryOptions = {}) => withWriteLease(
      state,
      async (catalog) => {
        if (recoveryOptions?.acknowledge === true) {
          await acknowledgeRecoveredHead(state);
        }
        return catalog.revision;
      },
      { allowRecovery: true },
    ),
    acknowledgeRecovery: () => withWriteLease(
      state,
      () => {
        return acknowledgeRecoveredHead(state).then(() => ({ code: 'recovery_acknowledged' }));
      },
      { allowRecovery: true },
    ),
    getRecoveryState: () => (state.recovery ? structuredClone(state.recovery) : null),
    listProjects: () => withReadAccess(state, (catalog) => listProjects(state, catalog)),
    listSummaries: () => withReadAccess(state, (catalog) => listProjects(state, catalog)),
    openProject: (projectId) => withReadAccess(state, (catalog) => openProject(state, catalog, projectId)),
    get: (projectId) => withReadAccess(state, (catalog) => openProject(state, catalog, projectId)),
    saveProject: (record, writeOptions) => withWriteLease(state, (catalog) => saveProject(state, catalog, record, writeOptions)),
    saveSnapshot: (record, writeOptions) => withWriteLease(state, (catalog) => saveProject(state, catalog, record, writeOptions)),
    updateViewport: (projectId, viewportJson, writeOptions) => withWriteLease(
      state,
      (catalog) => updateViewport(state, catalog, projectId, viewportJson, writeOptions),
    ),
    renameProject: (projectId, name, updatedAt, writeOptions) => withWriteLease(
      state,
      (catalog) => renameProject(state, catalog, projectId, name, updatedAt, writeOptions),
    ),
    rename: (projectId, name, updatedAt, writeOptions) => withWriteLease(
      state,
      (catalog) => renameProject(state, catalog, projectId, name, updatedAt, writeOptions),
    ),
    deleteProject: (projectId, writeOptions) => withWriteLease(
      state,
      (catalog) => deleteProject(state, catalog, projectId, writeOptions),
    ),
    delete: (projectId, writeOptions) => withWriteLease(
      state,
      (catalog) => deleteProject(state, catalog, projectId, writeOptions),
    ),
    writeAsset: (input, writeOptions) => withWriteLease(
      state,
      (catalog) => writeAsset(state, catalog, input, writeOptions),
    ),
    readAsset: (assetId) => withReadAccess(state, (catalog) => readAsset(state, catalog, assetId)),
    getAssetMetadata: (assetId) => withReadAccess(state, (catalog) => getAssetMetadata(state, catalog, assetId)),
    setDeletionCandidates: (projectId, assetIds, writeOptions) => withWriteLease(
      state,
      (catalog) => setDeletionCandidates(state, catalog, projectId, assetIds, writeOptions),
    ),
    listDeletionCandidates: (projectId) => withReadAccess(
      state,
      (catalog) => listDeletionCandidates(state, catalog, projectId),
    ),
    deleteAsset: (assetId, writeOptions) => withWriteLease(
      state,
      (catalog) => deleteAsset(state, catalog, assetId, writeOptions),
    ),
    cleanupOrphans: (cleanupOptions) => withWriteLease(
      state,
      (catalog) => cleanupOrphans(state, catalog, cleanupOptions),
    ),
  };

  return api;
}

export default createFileProjectLibrary;

export async function openLibrary(state) {
  if (state.opened) {
    return state.library;
  }
  if (state.opening) {
    return state.opening;
  }
  state.opening = (async () => {
    assertDurableFileOps(state);
    await ensureManagedRoot(state);
    await ensureLayout(state);
    const lock = await acquireWriteLease(state);
    state.activeWriteLease = lock;
    try {
      await ensureLibraryManifest(state);
      await ensureInitialHead(state);
      await recoverUnderLease(state);
      state.library = await readCatalog(state);
      state.opened = true;
      return state.library;
    } finally {
      state.activeWriteLease = null;
      await releaseWriteLease(state, lock);
    }
  })();
  try {
    return await state.opening;
  } finally {
    state.opening = null;
  }
}

export async function withReadAccess(state, operation) {
  await openLibrary(state);
  while (true) {
    await waitForReaderPinGate(state);
    const catalog = await readCatalog(state);
    if (isReaderPinGateClosed(state)) continue;
    const releaseReaderPin = acquireReaderPin(state, catalog);
    try {
      return await operation(catalog);
    } finally {
      releaseReaderPin();
    }
  }
}

export function acquireReaderPin(state, catalog) {
  const acquiredAt = state.clock();
  const expiresAt = acquiredAt + MAX_READER_PIN_MS;
  if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0 || !Number.isSafeInteger(expiresAt)) {
    throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid reader-pin timestamp.');
  }
  const pinId = makeLibraryKey('r');
  const pins = ACTIVE_READER_PINS.get(state.root) ?? new Map();
  const pin = Object.freeze({
    commitId: catalog.revision.commitId,
    commitSha256: catalog.revision.commitSha256,
    sequence: catalog.revision.sequence,
    expiresAt,
  });
  pins.set(pinId, pin);
  ACTIVE_READER_PINS.set(state.root, pins);
  return () => {
    const activePins = ACTIVE_READER_PINS.get(state.root);
    if (!activePins) return;
    activePins.delete(pinId);
    if (activePins.size === 0) ACTIVE_READER_PINS.delete(state.root);
  };
}

export async function withWriteLease(state, operation, leaseOptions = {}) {
  await openLibrary(state);
  const lock = await acquireWriteLease(state);
  state.activeWriteLease = lock;
  try {
    await recoverUnderLease(state);
    if (state.recovery && leaseOptions.allowRecovery !== true) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The library is in read-only recovery and requires acknowledgement before writes.',
        { recovery: state.recovery },
      );
    }
    const catalog = await readCatalog(state);
    const result = await operation(catalog);
    state.library = await readCatalog(state);
    return result;
  } finally {
    state.activeWriteLease = null;
    await releaseWriteLease(state, lock);
  }
}

export async function ensureManagedRoot(state) {
  await ensureNoSymlinkAncestors(state, state.root);
  await runDurableOperation(
    state,
    'ensureRootDirectory',
    [state.root],
    'The managed filesystem cannot create a contained library root.',
  );
  const rootStat = await fs.lstat(state.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FileProjectLibraryError('path_escape', 'The managed library root is not a real directory.');
  }
  await ensureNoSymlinkPath(state, state.root);
  state.root = await fs.realpath(state.root);
  state.lockPath = path.join(state.root, '.library-write.lock');
}

export async function ensureLayout(state) {
  for (const relative of [
    'control', 'commits', 'attachments', 'migrations', 'maintenance', 'projects',
    'assets', 'staging', 'quarantine', 'trash',
  ]) {
    await ensureDirectory(state, relative);
  }
}

export async function ensureLibraryManifest(state) {
  const manifestPath = managedPath(state, 'library.json');
  try {
    await readCanonicalFile(state, manifestPath, 'library manifest');
    state.library = parseLibraryManifest(await readCanonicalFile(state, manifestPath, 'library manifest'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof CorruptLibraryError) throw error;
      throw new CorruptLibraryError('The library manifest is invalid.', { cause: error });
    }
    const existingCommits = await listDirectories(state, 'commits');
    const existingFiles = await collectFiles(state, state.root);
    const hasExistingData = existingCommits.length > 0 || existingFiles.some((file) => {
      const relative = path.relative(state.root, file).replaceAll('\\', '/');
      return relative !== '.library-write.lock';
    });
    if (hasExistingData) {
      throw new FileProjectLibraryError('recovery_required', 'The library manifest is missing from an existing library.');
    }
    const manifest = {
      format: LIBRARY_FORMAT,
      version: LIBRARY_VERSION,
      libraryId: randomUUID(),
      libraryRootId: randomBytes(16).toString('hex'),
      importOperationNamespace: randomBytes(16).toString('hex'),
    };
    await writeCanonicalFile(state, manifestPath, manifest);
    state.library = manifest;
  }
}

export async function removeRecoveryMarker(state) {
  const markerPath = managedPath(state, 'control/recovery.json');
  let markerBytes;
  try {
    markerBytes = await readCanonicalFile(state, markerPath, 'recovery marker');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!(await removeIfUnchanged(state, markerPath, { sha256: sha256(markerBytes) }))) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'The recovery marker changed before exact acknowledgement cleanup.',
    );
  }
  await syncDirectory(state, path.dirname(markerPath));
}

export async function acknowledgeRecoveredHead(state) {
  if (!state.recovery) return;
  const [headBytes, previousBytes] = await Promise.all([
    readCanonicalFile(state, managedPath(state, 'head.json'), 'head'),
    readCanonicalFile(state, managedPath(state, 'head.previous.json'), 'previous head'),
  ]);
  if (headBytes.length !== previousBytes.length || !headBytes.every((value, index) => value === previousBytes[index])) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'The recovered head journal no longer matches the visible head.',
    );
  }
  const previousPath = managedPath(state, 'head.previous.json');
  if (!(await removeIfUnchanged(state, previousPath, { sha256: sha256(previousBytes) }))) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'The recovered-head journal changed before exact acknowledgement cleanup.',
    );
  }
  await syncDirectory(state, state.root);
  state.recovery = null;
  await removeRecoveryMarker(state);
}

export async function ensureInitialHead(state) {
  const headPath = managedPath(state, 'head.json');
  try {
    await fs.access(headPath);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (await pathExists(state, managedPath(state, 'head.previous.json'))) return;
  const existingCommits = await listDirectories(state, 'commits');
  const existingFiles = await collectFiles(state, state.root);
  const hasUnownedData = existingCommits.length > 0 || existingFiles.some((file) => {
    const relative = path.relative(state.root, file).replaceAll('\\', '/');
    return relative !== 'library.json' && relative !== '.library-write.lock';
  });
  if (hasUnownedData) {
    throw new FileProjectLibraryError('recovery_required', 'The library has data but no validated head.');
  }
  const commitId = makeLibraryKey('c');
  const commit = emptyCommit(commitId, 0, null, null);
  await assertWriteLeaseCurrent(state);
  await writeCanonicalFile(state, managedPath(state, `commits/${commitId}.json`), commit);
  const commitSha256 = sha256(canonicalize(commit));
  const head = {
    format: 'lumina-library-head',
    version: 1,
    commitId,
    commitSha256,
    previousCommitId: null,
  };
  await assertWriteLeaseCurrent(state);
  await writeCanonicalHeadFile(state, headPath, head);
}
