import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';

const require = createRequire(import.meta.url);
const ADMISSION_REGISTRY = require('../docs/adr/0006-runtime-file-project-library/admission-registry-v1.json');

if (
  ADMISSION_REGISTRY?.format !== 'lumina-project-admission-registry'
  || ADMISSION_REGISTRY?.version !== 1
  || ADMISSION_REGISTRY?.canonicalization !== 'RFC8785-JCS-SHA256-v1'
) {
  throw new Error('Unsupported Lumina project admission registry.');
}

const LIBRARY_FORMAT = 'lumina-library';
const LIBRARY_VERSION = 1;
const KEY_PATTERN = /^[pabsctrd]_[0-9a-f]{32}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_ID_BYTES = 256;
const MAX_JSON_DEPTH = 256;
const MAX_ASSET_METADATA_BYTES = ADMISSION_REGISTRY.limits.maxAssetMetadataDocumentBytes;
const MAX_PROJECT_DOCUMENT_BYTES = ADMISSION_REGISTRY.limits.maxProjectDocumentBytes;
const MAX_HISTORY_DOCUMENT_BYTES = ADMISSION_REGISTRY.limits.maxHistoryDocumentBytes;
const MAX_DURABLE_ASSET_BYTES = ADMISSION_REGISTRY.limits.maxDurableLibraryAssetBytes;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_SAFETY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const QUARANTINE_RETENTION_MS = DEFAULT_SAFETY_WINDOW_MS;
const MAX_READER_PIN_MS = 5 * 60 * 1000;
const MAX_WRITE_LEASE_MS = 5 * 60 * 1000;
const ADMITTED_NODE_TYPES = new Set(ADMISSION_REGISTRY.schemas.CanvasNode.fields.type.enum);
const DERIVED_DISPLAY_URL_FIELDS = new Set(
  Object.entries(ADMISSION_REGISTRY.fieldProfiles)
    .filter(([, profile]) => profile.classification === 'derived-display-url')
    .map(([name]) => name),
);
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const ACTIVE_READER_PINS = new Map();
const READER_PIN_GATES = new Map();

export class FileProjectLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FileProjectLibraryError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class StaleProjectRevisionError extends FileProjectLibraryError {
  constructor(projectId, expectedRevision, actualRevision) {
    super(
      'stale_revision',
      `Project ${projectId} changed from revision ${expectedRevision} to ${actualRevision ?? 'missing'}.`,
      { projectId, expectedRevision, actualRevision },
    );
    this.name = 'StaleProjectRevisionError';
  }
}

export class CorruptLibraryError extends FileProjectLibraryError {
  constructor(message, details = {}) {
    super('corrupt_schema', message, details);
    this.name = 'CorruptLibraryError';
  }
}

export function validateLibraryKey(value, expectedPrefix = undefined) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new FileProjectLibraryError('invalid_library_key', 'Library key is invalid.', { value });
  }
  if (expectedPrefix && value[0] !== expectedPrefix) {
    throw new FileProjectLibraryError('invalid_library_key', 'Library key has the wrong prefix.', { value });
  }
  return value;
}

export function validateLogicalId(value, label = 'id') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FileProjectLibraryError('invalid_id', `${label} must be a non-empty string.`);
  }
  const bytes = encoder.encode(value);
  if (bytes.length > MAX_ID_BYTES || value.includes('\u0000') || hasUnpairedSurrogate(value)) {
    throw new FileProjectLibraryError('invalid_id', `${label} is invalid or too large.`);
  }
  return value;
}

export function canonicalize(value) {
  assertJsonValue(value);
  return canonicalizeValue(value);
}

export function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  return createHash('sha256').update(bytes).digest('hex');
}

export function createFileProjectLibrary(options = {}) {
  const configuredRoot = options.root ?? options.dataRoot;
  if (typeof configuredRoot !== 'string' || configuredRoot.trim() === '') {
    throw new FileProjectLibraryError('invalid_root', 'A managed library root is required.');
  }

  const state = {
    root: path.resolve(configuredRoot),
    lockPath: path.resolve(configuredRoot, '.library-write.lock'),
    opened: false,
    opening: null,
    library: null,
    faultInjector: typeof options.faultInjector === 'function' ? options.faultInjector : null,
    durableFileOps: options.durableFileOps,
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
    writeAsset: (input) => withWriteLease(state, (catalog) => writeAsset(state, catalog, input)),
    readAsset: (assetId) => withReadAccess(state, (catalog) => readAsset(state, catalog, assetId)),
    getAssetMetadata: (assetId) => withReadAccess(state, (catalog) => getAssetMetadata(state, catalog, assetId)),
    setDeletionCandidates: async (projectId, assetIds, writeOptions = {}) => {
      const optionsWithPrecondition = writeOptions ?? {};
      const precondition = await withReadAccess(
        state,
        async (catalog) => ({
          expectedCatalog: optionsWithPrecondition.expectedCatalog ?? catalog.revision,
          expectedAssets: optionsWithPrecondition.expectedAssets
            ?? await getAssetLifecyclePrecondition(state, catalog, projectId),
        }),
      );
      return withWriteLease(
        state,
        (catalog) => setDeletionCandidates(
          state,
          catalog,
          projectId,
          assetIds,
          { ...optionsWithPrecondition, ...precondition },
        ),
      );
    },
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

async function openLibrary(state) {
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

async function withReadAccess(state, operation) {
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

function readerPinGate(state) {
  const existing = READER_PIN_GATES.get(state.root);
  if (existing) return existing;
  const created = { closed: false, waiters: [] };
  READER_PIN_GATES.set(state.root, created);
  return created;
}

function isReaderPinGateClosed(state) {
  return readerPinGate(state).closed;
}

async function waitForReaderPinGate(state) {
  const gate = readerPinGate(state);
  if (!gate.closed) return;
  await new Promise((resolve) => gate.waiters.push(resolve));
}

function closeReaderPinGate(state) {
  const gate = readerPinGate(state);
  if (gate.closed) throw new FileProjectLibraryError('library_busy', 'Reader pin authorization is already in progress.');
  gate.closed = true;
  return () => {
    gate.closed = false;
    for (const resolve of gate.waiters.splice(0)) resolve();
  };
}

async function withReaderPinBarrier(state, operation) {
  const release = closeReaderPinGate(state);
  try {
    return await operation();
  } finally {
    release();
  }
}

function acquireReaderPin(state, catalog) {
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

async function withWriteLease(state, operation, leaseOptions = {}) {
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

async function ensureManagedRoot(state) {
  await ensureNoSymlinkAncestors(state.root);
  await fs.mkdir(state.root, { recursive: true });
  const rootStat = await fs.lstat(state.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FileProjectLibraryError('path_escape', 'The managed library root is not a real directory.');
  }
  state.root = await fs.realpath(state.root);
  state.lockPath = path.join(state.root, '.library-write.lock');
}

async function ensureNoSymlinkAncestors(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'The managed root cannot contain symlinks.');
      if (!stat.isDirectory()) throw new FileProjectLibraryError('invalid_root', 'The managed root contains a non-directory ancestor.');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

async function ensureLayout(state) {
  for (const relative of [
    'control', 'commits', 'attachments', 'migrations', 'maintenance', 'projects',
    'assets', 'staging', 'quarantine', 'trash',
  ]) {
    await ensureDirectory(state, relative);
  }
}

async function ensureLibraryManifest(state) {
  const manifestPath = managedPath(state, 'library.json');
  try {
    await readCanonicalFile(manifestPath, 'library manifest');
    state.library = parseLibraryManifest(await readCanonicalFile(manifestPath, 'library manifest'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof CorruptLibraryError) throw error;
      throw new CorruptLibraryError('The library manifest is invalid.', { cause: error });
    }
    const existingCommits = await listDirectories(state, 'commits');
    const existingFiles = await collectFiles(state.root);
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

async function loadRecoveryState(state) {
  const markerPath = managedPath(state, 'control/recovery.json');
  try {
    const value = parseStrictJson(await readCanonicalFile(markerPath, 'recovery marker'), 'recovery marker');
    assertExactFields(
      value,
      ['format', 'version', 'reason', 'priorCommitId', 'recoveredAt'],
      [],
      'recovery marker',
    );
    if (
      value.format !== 'lumina-library-recovery'
      || value.version !== 1
      || value.reason !== 'head_recovered'
      || !Number.isSafeInteger(value.recoveredAt)
    ) {
      throw new CorruptLibraryError('Recovery marker schema is unsupported.');
    }
    validateLibraryKey(value.priorCommitId, 'c');
    state.recovery = Object.freeze({
      reason: value.reason,
      priorCommitId: value.priorCommitId,
      recoveredAt: value.recoveredAt,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof CorruptLibraryError || error?.code === 'path_escape') throw error;
    throw new FileProjectLibraryError('recovery_required', 'The durable recovery marker is invalid.', { cause: error });
  }
}

async function writeRecoveryMarker(state, recovery) {
  await writeCanonicalFile(state, managedPath(state, 'control/recovery.json'), {
    format: 'lumina-library-recovery',
    version: 1,
    reason: recovery.reason,
    priorCommitId: recovery.priorCommitId,
    recoveredAt: recovery.recoveredAt,
  });
}

async function removeRecoveryMarker(state) {
  const markerPath = managedPath(state, 'control/recovery.json');
  await ensureNoSymlinkPath(state.root, markerPath, true);
  await fs.rm(markerPath, { force: true });
  await syncDirectory(state, path.dirname(markerPath));
}

async function acknowledgeRecoveredHead(state) {
  if (!state.recovery) return;
  const [headBytes, previousBytes] = await Promise.all([
    readCanonicalFile(managedPath(state, 'head.json'), 'head'),
    readCanonicalFile(managedPath(state, 'head.previous.json'), 'previous head'),
  ]);
  if (headBytes.length !== previousBytes.length || !headBytes.every((value, index) => value === previousBytes[index])) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'The recovered head journal no longer matches the visible head.',
    );
  }
  await fs.rm(managedPath(state, 'head.previous.json'), { force: true });
  await syncDirectory(state, state.root);
  state.recovery = null;
  await removeRecoveryMarker(state);
}

async function ensureInitialHead(state) {
  const headPath = managedPath(state, 'head.json');
  try {
    await fs.access(headPath);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (await pathExists(managedPath(state, 'head.previous.json'))) return;
  const existingCommits = await listDirectories(state, 'commits');
  const existingFiles = await collectFiles(state.root);
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

async function recoverUnderLease(state) {
  await loadRecoveryState(state);
  await cleanupTransientTemps(state);
  let catalog;
  try {
    catalog = await readCatalog(state);
  } catch (error) {
    if (!(error instanceof CorruptLibraryError) && error?.code !== 'ENOENT') throw error;
    const previousPath = managedPath(state, 'head.previous.json');
    try {
      const previousBytes = await readCanonicalFile(previousPath, 'previous head');
      const previousHead = parseHead(previousBytes);
      await validateCatalogForHead(state, previousHead);
      const recovery = Object.freeze({
        reason: 'head_recovered',
        priorCommitId: previousHead.commitId,
        recoveredAt: Date.now(),
      });
      await writeRecoveryMarker(state, recovery);
      await assertWriteLeaseCurrent(state);
      await writeCanonicalHeadBytes(state, managedPath(state, 'head.json'), previousBytes);
      catalog = await readCatalog(state);
      state.recovery = recovery;
    } catch (fallbackError) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The library has no valid current or journaled head.',
        { cause: fallbackError },
      );
    }
  }

  const stagingEntries = await listDirectories(state, 'staging');
  for (const transactionId of stagingEntries) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') {
      continue;
    }
    const publishPath = managedPath(state, `staging/${transactionId}/publish.json`);
    let publish;
    try {
      publish = parsePublish(await readCanonicalFile(publishPath, 'publish record'));
    } catch {
      await quarantineTransaction(state, transactionId, null, 'invalid_publish_record');
      continue;
    }
    if (publish.transactionId !== transactionId) {
      await quarantineTransaction(state, transactionId, null, 'transaction_id_mismatch');
      continue;
    }
    const visibleIntendedCommit = publish.intendedCommitId === catalog.head.commitId
      && publish.intendedCommitSha256 === catalog.head.commitSha256
      && publish.intendedSequence === catalog.commit.sequence;
    const visiblePriorCommit = publish.priorCommitId === catalog.head.commitId
      && publish.priorCommitSha256 === catalog.head.commitSha256;
    if (visibleIntendedCommit) {
      await fs.rm(managedPath(state, `staging/${transactionId}`), { recursive: true, force: true });
    } else if (!visiblePriorCommit) {
      await quarantineTransaction(state, transactionId, publish, 'not_visible');
    } else {
      await quarantineTransaction(state, transactionId, publish, 'not_published');
    }
  }
  return catalog;
}

async function cleanupTransientTemps(state) {
  const ownedTransactions = new Map();
  for (const transactionId of await listDirectories(state, 'staging')) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') continue;
    try {
      const publish = parsePublish(
        await readCanonicalFile(
          managedPath(state, `staging/${transactionId}/publish.json`),
          'publish record',
        ),
      );
      if (publish.transactionId === transactionId) ownedTransactions.set(transactionId, publish);
    } catch {
      // An ownerless or malformed transaction is quarantined below; retain its
      // temporary files until that transaction can be moved as one unit.
    }
  }
  const ownedRootTargets = new Map();
  const addOwnedRootDigest = (target, digest) => {
    if (!ownedRootTargets.has(target)) ownedRootTargets.set(target, new Set());
    ownedRootTargets.get(target).add(digest);
  };
  let currentHeadBytes = null;
  try {
    currentHeadBytes = await readCanonicalFile(managedPath(state, 'head.json'), 'head');
  } catch {
    // A damaged head is handled by the journal recovery path; do not claim
    // ownership of root-level temporary pointers without its exact bytes.
  }
  for (const publish of ownedTransactions.values()) {
    for (const payload of publish.payloads) addOwnedRootDigest(payload.path, payload.sha256);
    if (currentHeadBytes) {
      try {
        const currentHead = parseHead(currentHeadBytes);
        if (currentHead.commitId === publish.priorCommitId
          && currentHead.commitSha256 === publish.priorCommitSha256) {
          addOwnedRootDigest('head.previous.json', sha256(currentHeadBytes));
          addOwnedRootDigest('head.json', sha256(canonicalize({
            format: 'lumina-library-head',
            version: 1,
            commitId: publish.intendedCommitId,
            commitSha256: publish.intendedCommitSha256,
            previousCommitId: publish.priorCommitId,
          })));
        }
      } catch {
        // Invalid current-head bytes cannot establish a publication owner.
      }
    }
  }
  for (const absolute of await collectFiles(state.root)) {
    const name = path.basename(absolute);
    if (!/\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(name)) continue;
    const relative = path.relative(state.root, absolute).replaceAll('\\', '/');
    const transactionMatch = /^staging\/(t_[0-9a-f]{32})\//u.exec(relative);
    const ownedByTransaction = transactionMatch && ownedTransactions.has(transactionMatch[1]);
    const targetRelative = relative.replace(/\.\d+\.[0-9a-f-]{36}\.tmp$/u, '');
    if (ownedByTransaction) {
      await ensureNoSymlinkPath(state.root, absolute);
      await fs.rm(absolute, { force: true });
      continue;
    }
    const expectedDigests = ownedRootTargets.get(targetRelative);
    if (!expectedDigests) continue;
    await ensureNoSymlinkPath(state.root, absolute);
    const actualDigest = (await hashFileBytes(absolute)).sha256;
    if (!expectedDigests.has(actualDigest)) continue;
    await fs.rm(absolute, { force: true });
  }
}

async function quarantineTransaction(state, transactionId, publish, reason) {
  const source = managedPath(state, `staging/${transactionId}`);
  const target = managedPath(state, `quarantine/${transactionId}`);
  validateLibraryKey(transactionId, 't');
  if (await pathExists(target)) {
    const manifestPath = path.join(target, 'manifest.json');
    try {
      const existing = parseQuarantineManifest(
        await readCanonicalFile(manifestPath, 'quarantine manifest'),
        transactionId,
      );
      await finishExistingQuarantine(state, source, existing);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof FileProjectLibraryError && error.code === 'recovery_required') throw error;
        throw new FileProjectLibraryError(
          'recovery_required',
          'The existing quarantine manifest is invalid.',
          { transactionId, cause: error },
        );
      }
    }
    if (!(await pathExists(source))) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'An incomplete quarantine has no staging payload to resume.',
        { transactionId },
      );
    }
    // A partial copy has no durable manifest yet, while its staging source is
    // still intact. Discard only that exact partial destination and rebuild it.
    await ensureNoSymlinkPath(state.root, target);
    await fs.rm(target, { recursive: true, force: true });
    await syncDirectory(state, path.dirname(target));
  }
  await ensureDirectory(state, `quarantine/${transactionId}`);
  let entries;
  try {
    entries = await collectFiles(source);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    entries = [];
  }
  const retained = new Map();
  if (publish) {
    for (const payload of publish.payloads) {
      const actual = await fileDigestIfExists(state, payload.path);
      if (actual && actual.sha256 !== payload.sha256) {
        throw new FileProjectLibraryError(
          'recovery_required',
          'A materialized publication payload conflicts with its journal digest.',
          { transactionId, path: payload.path },
        );
      }
      retained.set(payload.path, payload.sha256);
    }
  }
  for (const sourcePath of entries) {
    const relative = path.relative(source, sourcePath);
    const targetPath = path.join(target, relative);
    await ensureNoSymlinkPath(state.root, sourcePath);
    await ensureParentDirectory(state, targetPath);
    await ensureNoSymlinkPath(state.root, targetPath, true);
    await fs.copyFile(sourcePath, targetPath);
    await flushFile(state, targetPath);
    await syncDirectory(state, path.dirname(targetPath));
    const retainedPath = `quarantine/${transactionId}/${relative.replaceAll('\\', '/')}`;
    retained.set(retainedPath, (await hashFileBytes(targetPath)).sha256);
  }
  const failedAt = state.clock();
  if (!Number.isSafeInteger(failedAt) || failedAt < 0) {
    throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid timestamp.');
  }
  const manifest = {
    format: 'lumina-library-quarantine',
    version: 1,
    transactionId,
    reason,
    publish: publish ?? null,
    retained: [...retained.entries()]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
    failedAt,
    retainedUntil: failedAt + QUARANTINE_RETENTION_MS,
  };
  await writeCanonicalFile(state, path.join(target, 'manifest.json'), manifest);
  await fs.rm(source, { recursive: true, force: true });
  await syncDirectory(state, path.dirname(source));
}

async function finishExistingQuarantine(state, source, manifest) {
  for (const entry of manifest.retained) {
    const actual = await fileDigestIfExists(state, entry.path);
    if ((!actual && entry.path.startsWith(`quarantine/${manifest.transactionId}/`))
      || (actual && actual.sha256 !== entry.sha256)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The existing quarantine does not retain its exact payload closure.',
        { transactionId: manifest.transactionId, path: entry.path },
      );
    }
  }
  if (!(await pathExists(source))) return;
  const retained = new Map(manifest.retained.map((entry) => [entry.path, entry.sha256]));
  for (const sourcePath of await collectFiles(source)) {
    const relative = path.relative(source, sourcePath).replaceAll('\\', '/');
    const retainedPath = `quarantine/${manifest.transactionId}/${relative}`;
    const sourceDigest = (await hashFileBytes(sourcePath)).sha256;
    const targetDigest = await fileDigestIfExists(state, retainedPath);
    if (retained.get(retainedPath) !== sourceDigest || targetDigest?.sha256 !== sourceDigest) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The existing quarantine does not retain the exact staging payloads.',
        { transactionId: manifest.transactionId },
      );
    }
  }
  await fs.rm(source, { recursive: true, force: true });
  await syncDirectory(state, path.dirname(source));
}

async function fileDigestIfExists(state, relative) {
  const target = managedPath(state, relative);
  try {
    await ensureNoSymlinkPath(state.root, target);
    return await hashFileBytes(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function cleanupExpiredQuarantines(state, catalog, now) {
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

function assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup) {
  if (cleanup.manifestSha256 !== sha256(manifestBytes)
    || canonicalize(cleanup.entries) !== canonicalize(manifest.retained)) {
    throw new CorruptLibraryError('Quarantine cleanup receipt does not match its manifest.');
  }
}

async function authorizeQuarantineCleanup(state, catalog, manifestBytes, manifest, now) {
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

async function completeQuarantineCleanup(state, catalog, manifestBytes, manifest, cleanup, now, readerBarrierHeld = false) {
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

async function verifyQuarantineCleanupClosure(state, manifest, reachable, requireQuarantineCopies = false) {
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

async function expireQuarantine(state, transactionId, manifest, cleanup) {
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

async function readCatalog(state) {
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

async function validateCatalogForHead(state, head) {
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

async function validateCatalogPayloads(state, commit) {
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
    const project = parseProjectDocument(await readCanonicalFile(path.join(base, 'project.json'), 'project snapshot'));
    const history = parseHistoryDocument(await readCanonicalFile(path.join(base, 'history.json'), 'history snapshot'));
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
    const metadataBytes = await readCanonicalFile(managedPath(state, entry.metadataPath), 'asset metadata');
    const metadata = parseAssetMetadataDocument(metadataBytes);
    validateAssetCatalogEntry(entry, metadata);
    if (metadata.metadata.lifecycleState === 'staging') {
      throw new CorruptLibraryError('Staging assets cannot be visible in a catalog.');
    }
    assetLifecycle.set(entry.assetId, metadata.metadata.lifecycleState);
    const bytesPath = managedPath(state, entry.bytesPath);
    await ensureNoSymlinkPath(state.root, bytesPath);
    const hashed = await hashFileBytes(bytesPath);
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

function parseLibraryManifest(bytes) {
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

function parseHead(bytes) {
  const value = parseStrictJson(bytes, 'head');
  assertExactFields(value, ['format', 'version', 'commitId', 'commitSha256', 'previousCommitId'], [], 'head');
  if (value.format !== 'lumina-library-head' || value.version !== 1) {
    throw new CorruptLibraryError('Head schema is unsupported.');
  }
  return value;
}

function parseCommit(bytes) {
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

function parsePublish(bytes) {
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

function parseQuarantineManifest(bytes, transactionId) {
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

function parseQuarantineCleanup(bytes, transactionId) {
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

function validatePublishPayloads(payloads) {
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

function parseProjectManifest(bytes) {
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

function parseProjectDocument(bytes) {
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

function parseHistoryDocument(bytes) {
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

function parseAssetMetadataDocument(bytes) {
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

function parseCleanupPlan(bytes, transactionId) {
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

function isManagedCleanupPath(relative) {
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

function isManagedPublicationPath(relative) {
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

function isManagedQuarantineRetainedPath(relative, transactionId) {
  if (isManagedPublicationPath(relative)) return true;
  const segments = relative.split('/');
  return segments.length >= 3
    && segments[0] === 'quarantine'
    && segments[1] === transactionId
    && segments.slice(2).every((segment) => /^[A-Za-z0-9_.-]+$/u.test(segment))
    && !(segments.length === 3 && ['manifest.json', 'cleanup.json'].includes(segments[2]));
}

async function listProjects(state, catalog) {
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

async function openProject(state, catalog, projectId) {
  validateLogicalId(projectId, 'projectId');
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === projectId);
  return entry ? readProjectSnapshot(state, entry) : null;
}

async function readProjectSnapshot(state, entry) {
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
  const project = parseProjectDocument(await readCanonicalFile(path.join(base, 'project.json'), 'project snapshot'));
  const history = parseHistoryDocument(await readCanonicalFile(path.join(base, 'history.json'), 'history snapshot'));
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

async function saveProject(state, catalog, input, writeOptions = {}) {
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

async function updateViewport(state, catalog, projectId, viewportJson, writeOptions = {}) {
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

async function renameProject(state, catalog, projectId, name, updatedAt, writeOptions = {}) {
  const current = await openProject(state, catalog, projectId);
  if (!current) return { code: 'not_found', projectId };
  if (typeof name !== 'string' || name.length === 0) {
    throw new FileProjectLibraryError('invalid_project', 'Project name is invalid.');
  }
  return saveProject(state, catalog, { ...current, name, updatedAt, revision: undefined }, writeOptions);
}

async function deleteProject(state, catalog, projectId, writeOptions = {}) {
  validateLogicalId(projectId, 'projectId');
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === projectId);
  const actualRevision = entry?.revision ?? 'absent';
  assertExpectedRevision(projectId, writeOptions?.expectedRevision, actualRevision);
  if (!entry) return { code: 'not_found', projectId };
  const transactionId = makeLibraryKey('t');
  const liveReferences = await allLiveAssetReferences(state, catalog, projectId);
  const assets = [];
  for (const asset of catalog.commit.assets) {
    if (asset.projectId !== projectId) {
      assets.push(asset);
      continue;
    }
    const metadata = await getAssetMetadata(state, catalog, asset.assetId);
    if (metadata.lifecycleState === 'deletion-candidate' || liveReferences.has(asset.assetId)) {
      assets.push(asset);
    } else {
      assets.push({
        ...asset,
        ...(await stageAssetMetadata(state, { ...metadata, lifecycleState: 'deletion-candidate' }, asset.assetKey, transactionId)),
      });
    }
  }
  const projects = catalog.commit.projects.filter((project) => project.projectId !== projectId);
  const nextCommit = await publishNextCatalog(state, catalog, { projects, assets }, 'project-delete', { transactionId });
  return { code: 'deleted', projectId, catalog: nextCommit.revision };
}

async function writeAsset(state, catalog, input) {
  const normalized = await normalizeAssetInput(input);
  const assetId = validateLogicalId(input.assetId ?? randomUUID(), 'assetId');
  if (catalog.commit.assets.some((entry) => entry.assetId === assetId)) {
    throw new FileProjectLibraryError('asset_exists', 'Asset already exists.', { assetId });
  }
  const assetKey = makeLibraryKey('a');
  const transactionId = makeLibraryKey('t');
  const metadata = { ...normalized.metadata, assetId, lifecycleState: 'active' };
  const metadataDocument = {
    format: 'lumina-library-asset-metadata',
    version: 1,
    metadata,
  };
  const metadataBytes = encoder.encode(canonicalize(metadataDocument));
  if (metadataBytes.byteLength > MAX_ASSET_METADATA_BYTES) {
    throw new FileProjectLibraryError('asset_metadata_too_large', 'Asset metadata exceeds the v1 limit.');
  }
  const metadataSha256 = sha256(metadataBytes);
  const stagingRoot = managedPath(state, `staging/${transactionId}`);
  await ensureDirectory(state, `staging/${transactionId}/assets/${assetKey}/metadata`);
  const stagedMetadataPath = path.join(stagingRoot, `assets/${assetKey}/metadata/${metadataSha256}.json`);
  const stagedBytesPath = path.join(stagingRoot, `assets/${assetKey}/bytes.bin`);
  await ensureNoSymlinkPath(state.root, stagedMetadataPath, true);
  await fs.writeFile(stagedMetadataPath, metadataBytes);
  await flushFile(state, stagedMetadataPath);
  const streamed = await stageBlobBytes(state, stagedBytesPath, input.blob);
  await syncDirectory(state, path.dirname(stagedBytesPath));
  const entry = {
    assetId,
    projectId: metadata.projectId,
    assetKey,
    metadataFormat: metadataDocument.format,
    metadataVersion: metadataDocument.version,
    metadataPath: `assets/${assetKey}/metadata/${metadataSha256}.json`,
    metadataSha256,
    bytesPath: `assets/${assetKey}/bytes.bin`,
    byteCount: streamed.byteCount,
    bytesSha256: streamed.bytesSha256,
  };
  const nextAssets = catalog.commit.assets.concat(entry).sort((left, right) => compareUtf8(left.assetId, right.assetId));
  const result = await publishNextCatalog(state, catalog, {
    projects: catalog.commit.projects,
    assets: nextAssets,
  }, 'asset-write', { transactionId });
  return { code: 'applied', metadata, catalog: result.revision };
}

async function stageBlobBytes(state, target, blob) {
  if (typeof blob.stream !== 'function') {
    throw new FileProjectLibraryError('invalid_asset', 'Asset Blob streaming is unavailable.');
  }
  await ensureParentDirectory(state, target);
  await ensureNoSymlinkPath(state.root, target, true);
  const handle = await fs.open(target, 'w');
  const digest = createHash('sha256');
  let byteCount = 0;
  try {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        byteCount += chunk.byteLength;
        if (byteCount > MAX_DURABLE_ASSET_BYTES) {
          throw new FileProjectLibraryError('asset_too_large', 'Asset bytes exceed the durable library limit.');
        }
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (!written.bytesWritten) throw new FileProjectLibraryError('asset_write_failed', 'Asset bytes could not be staged.');
          offset += written.bytesWritten;
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (byteCount !== blob.size) {
      throw new FileProjectLibraryError('asset_integrity_failed', 'Asset Blob size changed while staging.');
    }
  } finally {
    await handle.close();
  }
  await flushFile(state, target);
  return { byteCount, bytesSha256: digest.digest('hex') };
}

async function hashFileBytes(target) {
  const handle = await fs.open(target, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteCount = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      byteCount += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { byteCount, sha256: digest.digest('hex') };
}

async function getAssetMetadata(state, catalog, assetId) {
  validateLogicalId(assetId, 'assetId');
  const entry = catalog.commit.assets.find((candidate) => candidate.assetId === assetId);
  if (!entry) return null;
  const metadataPath = managedPath(state, entry.metadataPath);
  await ensureNoSymlinkPath(state.root, metadataPath);
  const metadataDocument = parseAssetMetadataDocument(
    await readCanonicalFile(metadataPath, 'asset metadata'),
  );
  validateAssetCatalogEntry(entry, metadataDocument);
  return structuredClone(metadataDocument.metadata);
}

async function readAsset(state, catalog, assetId) {
  validateLogicalId(assetId, 'assetId');
  const entry = catalog.commit.assets.find((candidate) => candidate.assetId === assetId);
  if (!entry) return null;
  const metadata = await getAssetMetadata(state, catalog, assetId);
  const bytesPath = managedPath(state, entry.bytesPath);
  await ensureNoSymlinkPath(state.root, bytesPath);
  const bytes = await fs.readFile(bytesPath);
  if (bytes.byteLength !== entry.byteCount || sha256(bytes) !== entry.bytesSha256 || bytes.byteLength !== metadata.byteCount) {
    throw new CorruptLibraryError('Asset bytes failed integrity validation.');
  }
  return new Blob([bytes], { type: metadata.mimeType });
}

async function listDeletionCandidates(state, catalog, projectId) {
  validateLogicalId(projectId, 'projectId');
  const result = [];
  for (const entry of catalog.commit.assets) {
    if (entry.projectId !== projectId) continue;
    const metadata = await getAssetMetadata(state, catalog, entry.assetId);
    if (metadata?.lifecycleState === 'deletion-candidate') result.push(metadata);
  }
  return result;
}

function collectAssetReferences(value) {
  const references = new Set();
  const referenceFields = new Set([
    'assetId', 'previewAssetId', 'lastFrameAssetId',
    'referenceImageIds', 'referenceAudioIds', 'referenceVideoIds',
  ]);
  walk(value, (key, item) => {
    if (!referenceFields.has(key)) return;
    if (typeof item === 'string') references.add(item);
    if (Array.isArray(item)) {
      for (const reference of item) if (typeof reference === 'string') references.add(reference);
    }
  });
  return references;
}

async function projectAssetReferences(state, catalog, projectId) {
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === projectId);
  if (!entry) return new Set();
  const record = await readProjectSnapshot(state, entry);
  return collectAssetReferences({
    nodes: parseJsonString(record.nodesJson, 'nodes'),
    history: parseJsonString(record.historyJson, 'history'),
  });
}

async function allLiveAssetReferences(state, catalog, excludedProjectId = null) {
  const references = new Set();
  for (const entry of catalog.commit.projects) {
    if (entry.projectId === excludedProjectId) continue;
    const projectReferences = await projectAssetReferences(state, catalog, entry.projectId);
    for (const assetId of projectReferences) references.add(assetId);
  }
  return references;
}

async function deleteAsset(state, catalog, assetId, writeOptions = {}) {
  const metadata = await getAssetMetadata(state, catalog, assetId);
  if (!metadata) return { code: 'not_found', assetId };
  const existing = await listDeletionCandidates(state, catalog, metadata.projectId);
  const ids = new Set(existing.map((item) => item.assetId));
  ids.add(assetId);
  return setDeletionCandidates(
    state,
    catalog,
    metadata.projectId,
    [...ids],
    {
      ...(writeOptions ?? {}),
      expectedCatalog: writeOptions?.expectedCatalog ?? catalog.revision,
      expectedAssets: writeOptions?.expectedAssets
        ?? await getAssetLifecyclePrecondition(state, catalog, metadata.projectId),
    },
  );
}

async function setDeletionCandidates(state, catalog, projectId, assetIds, writeOptions = {}) {
  validateLogicalId(projectId, 'projectId');
  if (!Array.isArray(assetIds)) throw new FileProjectLibraryError('invalid_asset', 'Deletion candidates must be an array.');
  const requested = new Set(assetIds.map((assetId) => validateLogicalId(assetId, 'assetId')));
  const projectEntry = catalog.commit.projects.find((entry) => entry.projectId === projectId);
  assertExpectedRevision(projectId, writeOptions?.expectedRevision, projectEntry?.revision ?? 'absent');
  const expectedCatalog = validateCatalogRevisionPrecondition(writeOptions?.expectedCatalog);
  if (canonicalize(expectedCatalog) !== canonicalize(catalog.revision)) {
    throw new FileProjectLibraryError(
      'stale_catalog',
      'The library catalog changed since the asset lifecycle state was read.',
      { actualCatalog: catalog.revision },
    );
  }
  const expectedAssets = validateAssetLifecyclePrecondition(writeOptions?.expectedAssets, projectId);
  const owned = catalog.commit.assets.filter((entry) => entry.projectId === projectId);
  const actualAssets = [];
  for (const entry of owned) {
    const metadata = await getAssetMetadata(state, catalog, entry.assetId);
    actualAssets.push({
      assetId: entry.assetId,
      lifecycleState: metadata.lifecycleState,
      metadataSha256: entry.metadataSha256,
    });
  }
  actualAssets.sort((left, right) => compareUtf8(left.assetId, right.assetId));
  if (canonicalize(expectedAssets) !== canonicalize(actualAssets)) {
    throw new FileProjectLibraryError(
      'stale_asset_lifecycle',
      'Owned asset lifecycle state changed since it was read.',
      { projectId },
    );
  }
  for (const assetId of requested) {
    if (!owned.some((entry) => entry.assetId === assetId)) {
      throw new FileProjectLibraryError('asset_not_owned', 'Asset does not belong to the project.', { assetId, projectId });
    }
  }
  const references = await projectAssetReferences(state, catalog, projectId);
  for (const assetId of requested) {
    if (references.has(assetId)) {
      throw new FileProjectLibraryError(
        'asset_still_reachable',
        'An asset referenced by the project or retained history cannot become a deletion candidate.',
        { assetId, projectId },
      );
    }
  }
  const transactionId = makeLibraryKey('t');
  const nextAssets = [];
  for (const entry of catalog.commit.assets) {
    if (entry.projectId !== projectId) {
      nextAssets.push(entry);
      continue;
    }
    const metadata = await getAssetMetadata(state, catalog, entry.assetId);
    const lifecycleState = requested.has(entry.assetId) ? 'deletion-candidate' : 'active';
    if (metadata.lifecycleState === lifecycleState) {
      nextAssets.push(entry);
      continue;
    }
    const nextMetadata = { ...metadata, lifecycleState };
    const staged = await stageAssetMetadata(state, nextMetadata, entry.assetKey, transactionId);
    nextAssets.push({ ...entry, ...staged });
  }
  const result = await publishNextCatalog(state, catalog, {
    projects: catalog.commit.projects,
    assets: nextAssets.sort((left, right) => compareUtf8(left.assetId, right.assetId)),
  }, 'asset-lifecycle', { transactionId });
  return { code: 'applied', catalog: result.revision };
}

async function getAssetLifecyclePrecondition(state, catalog, projectId) {
  validateLogicalId(projectId, 'projectId');
  const entries = catalog.commit.assets
    .filter((entry) => entry.projectId === projectId)
    .map((entry) => ({
      assetId: entry.assetId,
      lifecycleState: null,
      metadataSha256: entry.metadataSha256,
    }));
  for (const entry of entries) {
    const metadata = await getAssetMetadata(state, catalog, entry.assetId);
    entry.lifecycleState = metadata.lifecycleState;
  }
  entries.sort((left, right) => compareUtf8(left.assetId, right.assetId));
  return entries;
}

function validateAssetLifecyclePrecondition(value, projectId) {
  if (!Array.isArray(value)) {
    throw new FileProjectLibraryError(
      'asset_precondition_required',
      'Asset lifecycle mutations require the complete observed asset set.',
      { projectId },
    );
  }
  let previousAssetId = null;
  const result = value.map((entry) => {
    assertInputFields(entry, ['assetId', 'lifecycleState', 'metadataSha256'], 'asset lifecycle precondition');
    validateLogicalId(entry.assetId, 'asset lifecycle assetId');
    if (previousAssetId !== null && compareUtf8(previousAssetId, entry.assetId) >= 0) {
      throw new FileProjectLibraryError('invalid_asset', 'Asset lifecycle precondition must be sorted and unique.');
    }
    previousAssetId = entry.assetId;
    if (!['active', 'deletion-candidate'].includes(entry.lifecycleState) || !DIGEST_PATTERN.test(entry.metadataSha256)) {
      throw new FileProjectLibraryError('invalid_asset', 'Asset lifecycle precondition is invalid.');
    }
    return {
      assetId: entry.assetId,
      lifecycleState: entry.lifecycleState,
      metadataSha256: entry.metadataSha256,
    };
  });
  return result;
}

function validateCatalogRevisionPrecondition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset lifecycle catalog precondition is invalid.');
  }
  assertInputFields(value, ['commitId', 'sequence', 'commitSha256'], 'asset lifecycle catalog precondition');
  validateLibraryKey(value.commitId, 'c');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || !DIGEST_PATTERN.test(value.commitSha256)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset lifecycle catalog precondition is invalid.');
  }
  return {
    commitId: value.commitId,
    sequence: value.sequence,
    commitSha256: value.commitSha256,
  };
}

async function stageAssetMetadata(state, metadata, assetKey, transactionId) {
  validateAssetMetadata(metadata, 'asset metadata');
  const document = { format: 'lumina-library-asset-metadata', version: 1, metadata };
  const bytes = encoder.encode(canonicalize(document));
  if (bytes.byteLength > MAX_ASSET_METADATA_BYTES) {
    throw new FileProjectLibraryError('asset_metadata_too_large', 'Asset metadata exceeds the v1 limit.');
  }
  const metadataSha256 = sha256(bytes);
  const target = managedPath(state, `staging/${transactionId}/assets/${assetKey}/metadata/${metadataSha256}.json`);
  await ensureParentDirectory(state, target);
  await ensureNoSymlinkPath(state.root, target, true);
  await fs.writeFile(target, bytes);
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
  await flushFile(state, target);
  return {
    metadataFormat: document.format,
    metadataVersion: document.version,
    metadataPath: `assets/${assetKey}/metadata/${metadataSha256}.json`,
    metadataSha256,
  };
}

async function cleanupOrphans(state, catalog, cleanupOptions = {}) {
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

async function removeExpiredCleanupPlan(state, transactionId) {
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

async function completeCleanupPlan(state, plan, catalog, now) {
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
      const cancelled = {
        ...plan,
        state: 'cancelled',
        completedAt: now,
        retainedUntil: now + DEFAULT_SAFETY_WINDOW_MS,
      };
      await writeCanonicalFile(state, managedPath(state, `maintenance/${plan.transactionId}/gc.json`), cancelled);
      return { code: 'cleanup_cancelled', transactionId: plan.transactionId, removed: [] };
    }
    for (const entry of plan.entries) {
      const target = managedPath(state, entry.path);
      try {
        await ensureNoSymlinkPath(state.root, target);
        const hashed = await hashFileBytes(target);
        if (hashed.sha256 !== entry.sha256) {
          const cancelled = {
            ...plan,
            state: 'cancelled',
            completedAt: now,
            retainedUntil: now + DEFAULT_SAFETY_WINDOW_MS,
          };
          await writeCanonicalFile(state, managedPath(state, `maintenance/${plan.transactionId}/gc.json`), cancelled);
          return { code: 'cleanup_cancelled', transactionId: plan.transactionId, removed: [] };
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
      await fs.rm(target, { force: true });
      removed.push(entry.path);
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

function rootSetDigest(reachable) {
  return sha256(canonicalize([...reachable].sort(compareUtf8)));
}

function addCatalogReachablePaths(reachable, commit) {
  reachable.add(`commits/${commit.commitId}.json`);
  for (const entry of commit.projects) {
    reachable.add(entry.manifestPath);
    reachable.add(entry.manifestPath.replace(/manifest\.json$/u, 'project.json'));
    reachable.add(entry.manifestPath.replace(/manifest\.json$/u, 'history.json'));
  }
  for (const entry of commit.assets) {
    reachable.add(entry.metadataPath);
    reachable.add(entry.bytesPath);
  }
}

async function addActiveReaderPinPaths(state, reachable, now) {
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
      addCatalogReachablePaths(reachable, commit);
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

async function collectReachablePaths(state, catalog, now = state.clock(), options = {}) {
  const reachable = new Set(['library.json', 'head.json', 'head.previous.json', '.library-write.lock']);
  addCatalogReachablePaths(reachable, catalog.commit);
  try {
    const previousHead = parseHead(await readCanonicalFile(managedPath(state, 'head.previous.json'), 'previous head'));
    const journalIsCurrentHead = previousHead.commitId === catalog.head.commitId
      && previousHead.commitSha256 === catalog.head.commitSha256;
    if (!journalIsCurrentHead && previousHead.commitId !== catalog.head.previousCommitId) {
      throw new CorruptLibraryError('Previous head is not the visible catalog predecessor.');
    }
    const previousCommit = await validateCatalogForHead(state, previousHead);
    if (!journalIsCurrentHead) addCatalogReachablePaths(reachable, previousCommit);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await addActiveReaderPinPaths(state, reachable, now);
  await addQuarantineReachablePaths(state, reachable, now, options.excludeQuarantineTransactionId);
  return reachable;
}

async function addQuarantineReachablePaths(state, reachable, now, excludedTransactionId = null) {
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

async function publishNextCatalog(state, catalog, changes, operation, options = {}) {
  const transactionId = options.transactionId ?? makeLibraryKey('t');
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
  await assertWriteLeaseCurrent(state);
  const headBytes = await readCanonicalFile(managedPath(state, 'head.json'), 'head');
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
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fault(state, 'after-head-verify', { transactionId, operation });
  return verified;
}

async function stageProject(state, record, transactionId, ownedAssetIds = new Set()) {
  const projectKey = makeLibraryKey('p');
  const snapshotKey = makeLibraryKey('s');
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
    recovery: record.recovery ?? null,
  };
  const manifestSha256 = sha256(canonicalize(manifest));
  const stagingRoot = managedPath(state, `staging/${transactionId}/projects/${projectKey}/snapshots/${snapshotKey}`);
  await ensureDirectory(state, `staging/${transactionId}/projects/${projectKey}/snapshots/${snapshotKey}`);
  await writeCanonicalFile(state, path.join(stagingRoot, 'manifest.json'), manifest);
  await writeCanonicalBytes(state, path.join(stagingRoot, 'project.json'), projectBytes);
  await writeCanonicalBytes(state, path.join(stagingRoot, 'history.json'), historyBytes);
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

function admitProjectDocumentPayload(document, ownedAssetIds) {
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

function admitHistoryDocumentPayload(history) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) throw admissionFailure('History snapshot is invalid.');
  const admitted = {
    past: admitHistorySnapshots(history.past, 'history past'),
    future: admitHistorySnapshots(history.future, 'history future'),
  };
  stripHistoryDisplayUrls(admitted);
  return admitted;
}

async function collectStagedPayloads(state, stagingRoot) {
  const payloads = [];
  for (const sourcePath of await collectFiles(stagingRoot)) {
    const relative = path.relative(stagingRoot, sourcePath).replaceAll('\\', '/');
    if (!isManagedPublicationPath(relative)) {
      throw new FileProjectLibraryError('invalid_publish', 'Staging contains an unmanaged publication payload.');
    }
    await ensureNoSymlinkPath(state.root, sourcePath);
    payloads.push({ path: relative, sha256: (await hashFileBytes(sourcePath)).sha256 });
  }
  payloads.sort((left, right) => compareUtf8(left.path, right.path));
  validatePublishPayloads(payloads);
  return payloads;
}

async function materializeTransactionPayloads(state, stagingRoot, payloads) {
  for (const payload of payloads) {
    const sourcePath = path.join(stagingRoot, ...payload.path.split('/'));
    const targetPath = managedPath(state, payload.path);
    await ensureNoSymlinkPath(state.root, sourcePath);
    const sourceDigest = (await hashFileBytes(sourcePath)).sha256;
    if (sourceDigest !== payload.sha256) {
      throw new CorruptLibraryError('Staged publication payload digest changed before materialization.');
    }
    try {
      const existing = await hashFileBytes(targetPath);
      if (existing.sha256 !== payload.sha256) {
        throw new CorruptLibraryError('Immutable publication payload conflicts with an existing file.');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await ensureParentDirectory(state, targetPath);
      await ensureNoSymlinkPath(state.root, targetPath, true);
      await fs.copyFile(sourcePath, targetPath);
    }
    await flushFile(state, targetPath);
    await syncDirectory(state, path.dirname(targetPath));
  }
}

async function normalizeAssetInput(input) {
  if (!input || typeof input !== 'object' || !(input.blob instanceof Blob)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset input must include a Blob.');
  }
  validateLogicalId(input.projectId, 'projectId');
  if (!['image', 'video', 'audio'].includes(input.kind) || !['import', 'generation', 'derived'].includes(input.sourceKind)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset kind or source kind is invalid.');
  }
  if (!Number.isSafeInteger(input.blob.size) || input.blob.size > MAX_DURABLE_ASSET_BYTES) {
    throw new FileProjectLibraryError('asset_too_large', 'Asset bytes exceed the durable library limit.');
  }
  const mimeType = String(input.blob.type ?? '').toLowerCase();
  if (!isAdmittedMime(input.kind, mimeType)) {
    throw new FileProjectLibraryError('unsupported_media_type', 'Asset MIME type is not admitted.');
  }
  const sourceMetadata = validateSourceMetadata(input.sourceMetadata ?? {});
  const metadata = {
    projectId: input.projectId,
    kind: input.kind,
    mimeType,
    byteCount: input.blob.size,
    createdAt: input.createdAt === undefined ? Date.now() : input.createdAt,
    sourceKind: input.sourceKind,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    sourceMetadata,
  };
  if (!optionalNonNegativeSafeInteger(metadata.width)
    || !optionalNonNegativeSafeInteger(metadata.height)
    || !optionalNonNegativeSafeInteger(metadata.durationMs)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset dimensions or duration are invalid.');
  }
  if (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset createdAt is invalid.');
  }
  return { metadata };
}

function validateSourceMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata must be a scalar map.');
  }
  const entries = Object.entries(value);
  if (entries.length > ADMISSION_REGISTRY.limits.maxSourceMetadataEntries) {
    throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata has too many entries.');
  }
  const result = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || isSensitiveName(key)) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata contains a forbidden key.');
    }
    if (!(item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata values must be scalar.');
    }
    if (typeof item === 'string'
      && encoder.encode(item).byteLength > ADMISSION_REGISTRY.limits.maxSourceMetadataStringBytes) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata string is too large.');
    }
    if (typeof item === 'string' && (containsCredentialLikeString(item) || containsUnsafeUrl(item))) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata contains credential-like text.');
    }
    result[key] = item;
  }
  return result;
}

function validateAssetCatalogEntry(entry, metadataDocument) {
  assertExactFields(metadataDocument, ['format', 'version', 'metadata'], [], 'asset metadata');
  validateAssetMetadata(metadataDocument.metadata, 'asset metadata');
  if (
    metadataDocument?.format !== 'lumina-library-asset-metadata'
    || metadataDocument.version !== 1
    || metadataDocument.metadata?.assetId !== entry.assetId
    || metadataDocument.metadata?.projectId !== entry.projectId
    || entry.metadataFormat !== metadataDocument.format
    || entry.metadataVersion !== metadataDocument.version
    || entry.metadataPath !== `assets/${entry.assetKey}/metadata/${entry.metadataSha256}.json`
    || entry.bytesPath !== `assets/${entry.assetKey}/bytes.bin`
    || entry.metadataSha256 !== sha256(canonicalize(metadataDocument))
    || entry.byteCount !== metadataDocument.metadata.byteCount
    || !DIGEST_PATTERN.test(entry.bytesSha256)
  ) {
    throw new CorruptLibraryError('Asset metadata and catalog do not agree.');
  }
}

function validateAssetMetadata(metadata, label, options = {}) {
  assertExactFields(
    metadata,
    ['assetId', 'projectId', 'kind', 'mimeType', 'byteCount', 'createdAt', 'sourceKind', 'width', 'height', 'durationMs', 'sourceMetadata', 'lifecycleState'],
    [],
    label,
  );
  validateLogicalId(metadata.assetId, `${label} assetId`);
  validateLogicalId(metadata.projectId, `${label} projectId`);
  if (!['image', 'video', 'audio'].includes(metadata.kind)
    || !['import', 'generation', 'derived'].includes(metadata.sourceKind)
    || !['active', 'deletion-candidate', ...(options.allowStaging ? ['staging'] : [])].includes(metadata.lifecycleState)) {
    throw new CorruptLibraryError(`${label} kind or lifecycle is invalid.`);
  }
  if (!isAdmittedMime(metadata.kind, metadata.mimeType)
    || !Number.isSafeInteger(metadata.byteCount)
    || metadata.byteCount < 0
    || metadata.byteCount > MAX_DURABLE_ASSET_BYTES
    || !Number.isSafeInteger(metadata.createdAt)
    || metadata.createdAt < 0
    || !optionalNonNegativeSafeInteger(metadata.width)
    || !optionalNonNegativeSafeInteger(metadata.height)
    || !optionalNonNegativeSafeInteger(metadata.durationMs)) {
    throw new CorruptLibraryError(`${label} scalar fields are invalid.`);
  }
  validateSourceMetadata(metadata.sourceMetadata);
}

function optionalNonNegativeSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function isAdmittedMime(kind, mimeType) {
  const allowlist = ADMISSION_REGISTRY.media.allowlist;
  return typeof mimeType === 'string'
    && mimeType === mimeType.toLowerCase()
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)
    && allowlist[kind].includes(mimeType);
}

function isAdmittedMimeAny(mimeType) {
  return Object.keys(ADMISSION_REGISTRY.media.allowlist)
    .some((kind) => isAdmittedMime(kind, mimeType));
}

function normalizeProjectRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new FileProjectLibraryError('invalid_project', 'Project record is invalid.');
  }
  assertInputFields(record, [
    'id', 'name', 'createdAt', 'updatedAt', 'nodeCount', 'schemaVersion', 'revision', 'recovery',
    'nodesJson', 'edgesJson', 'viewportJson', 'historyJson',
  ], 'project record');
  validateLogicalId(record.id, 'projectId');
  if (typeof record.name !== 'string' || encoder.encode(record.name).byteLength > 1024) {
    throw new FileProjectLibraryError('invalid_project', 'Project name is invalid.');
  }
  if (containsCredentialLikeString(record.name) || containsUnsafeUrl(record.name)) {
    throw admissionFailure('Project name contains unsafe text.');
  }
  for (const field of ['createdAt', 'updatedAt', 'nodeCount']) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
      throw new FileProjectLibraryError('invalid_project', `Project ${field} is invalid.`);
    }
  }
  for (const field of ['nodesJson', 'edgesJson', 'viewportJson']) {
    if (typeof record[field] !== 'string') {
      throw new FileProjectLibraryError('invalid_project', `${field} must be JSON text.`);
    }
    if (encoder.encode(record[field]).byteLength > MAX_PROJECT_DOCUMENT_BYTES) {
      throw new FileProjectLibraryError('project_too_large', `${field} exceeds the v1 limit.`);
    }
  }
  if (typeof record.historyJson !== 'string') {
    throw new FileProjectLibraryError('invalid_project', 'historyJson must be JSON text.');
  }
  if (encoder.encode(record.historyJson).byteLength > MAX_HISTORY_DOCUMENT_BYTES) {
    throw new FileProjectLibraryError('history_too_large', 'historyJson exceeds the v1 limit.');
  }
  const nodes = parseJsonString(record.nodesJson, 'nodes');
  const edges = parseJsonString(record.edgesJson, 'edges');
  const viewport = parseJsonString(record.viewportJson, 'viewport');
  const history = parseJsonString(record.historyJson, 'history');
  const admittedEdges = admitCanvasEdges(edges, 'project edges');
  const nodeList = Array.isArray(nodes) ? nodes : nodes?.nodes;
  const admittedNodeList = admitCanvasNodes(nodeList, 'project nodes');
  let admittedNodes = admittedNodeList;
  if (!Array.isArray(nodes)) {
    assertExactInputFields(nodes, ['nodes', 'imagePool'], 'project nodes payload');
    admittedNodes = {
      nodes: admittedNodeList,
      imagePool: validateImagePool(nodes.imagePool, 'project imagePool'),
    };
  }
  const admittedViewport = admitObject(viewport, 'Viewport', 'viewport');
  assertExactInputFields(history, ['past', 'future'], 'history');
  if (!Array.isArray(history.past) || !Array.isArray(history.future)) throw admissionFailure('Project history is invalid.');
  const admittedHistory = {
    past: admitHistorySnapshots(history.past, 'history past'),
    future: admitHistorySnapshots(history.future, 'history future'),
  };
  rejectProjectSecrets({ nodes: admittedNodes, edges: admittedEdges, viewport: admittedViewport, history: admittedHistory });
  if (record.revision !== undefined && record.revision !== null) validateProjectRevision(record.revision, 'revision');
  if (record.recovery !== undefined && record.recovery !== null) validateRecovery(record.recovery);
  if (record.schemaVersion !== undefined && record.schemaVersion !== null
    && (!Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 0 || record.schemaVersion > 1)) {
    throw new FileProjectLibraryError('invalid_project', 'Project schemaVersion is invalid.');
  }
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    schemaVersion: record.schemaVersion === undefined || record.schemaVersion === null || record.schemaVersion === 0
      ? 1
      : record.schemaVersion,
    ...(record.revision !== undefined && record.revision !== null ? { revision: record.revision } : {}),
    ...(record.recovery ? { recovery: validateRecovery(record.recovery) } : {}),
    nodesJson: canonicalize(admittedNodes),
    edgesJson: canonicalize(admittedEdges),
    viewportJson: canonicalize(admittedViewport),
    historyJson: canonicalize(admittedHistory),
  };
}

function toProjectDocument(record) {
  const nodes = JSON.parse(record.nodesJson);
  const nodeList = Array.isArray(nodes) ? nodes : nodes.nodes;
  return {
    schemaVersion: record.schemaVersion ?? 1,
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    revision: record.revision ?? 'r0',
    nodes: nodeList,
    ...(Array.isArray(nodes) ? {} : { imagePool: nodes.imagePool ?? [] }),
    edges: JSON.parse(record.edgesJson),
    viewport: JSON.parse(record.viewportJson),
  };
}

function fromProjectDocument(project, history, recovery = null) {
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

const OMIT_MEMBER = Symbol('omit-member');

function admissionFailure(message, details = {}) {
  return new FileProjectLibraryError('project_secret_admission_failed', message, details);
}

function schemaDefinition(name) {
  return ADMISSION_REGISTRY.schemas[name] ?? ADMISSION_REGISTRY.nodeData[name] ?? null;
}

function schemaFields(name) {
  const schema = schemaDefinition(name);
  if (!schema) throw admissionFailure(`Admission schema ${name} is not implemented.`);
  const inherited = schema.inherits ? schemaFields(schema.inherits) : {};
  return { ...inherited, ...(schema.fields ?? {}) };
}

function admitObject(value, schemaName, label, context = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw admissionFailure(`${label} must be an object.`);
  const fields = schemaFields(schemaName);
  const localContext = schemaName === 'CanvasNode' ? { ...context, nodeType: value.type } : context;
  const output = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw admissionFailure(`${label} contains unknown member ${key}.`);
  }
  for (const [key, descriptor] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      const profile = descriptor.profile
        ? ADMISSION_REGISTRY.fieldProfiles[descriptor.profile]
        : null;
      if (descriptor.required === true || profile?.required === true) {
        throw admissionFailure(`${label} is missing member ${key}.`);
      }
      continue;
    }
    const fieldContext = schemaName === 'StoryboardFrameItem'
      ? {
        ...localContext,
        assetIdForUrl: value.assetId,
        previewAssetIdForUrl: value.previewAssetId,
        urlField: key,
      }
      : localContext;
    const admitted = admitDescriptor(value[key], descriptor, `${label}.${key}`, fieldContext);
    if (admitted !== OMIT_MEMBER) output[key] = admitted;
  }
  return output;
}

function admitDescriptor(value, descriptor, label, context) {
  if (descriptor.profile) return admitProfile(value, descriptor, label, context);
  if (descriptor.type === 'enum' || descriptor.type === 'enum|null') {
    const allowed = descriptor.enum ?? [];
    if (!allowed.includes(value) && !(descriptor.type.endsWith('|null') && value === null)) {
      throw admissionFailure(`${label} is not an admitted enum value.`);
    }
    return value;
  }
  if (descriptor.type === 'allowlisted-media-mime|null') {
    if (value !== null && !isAdmittedMimeAny(value)) throw admissionFailure(`${label} has an unsupported media type.`);
    return value;
  }
  if (descriptor.type?.startsWith('array<') && descriptor.type.endsWith('>')) {
    const itemType = descriptor.type.slice(6, -1);
    if (!Array.isArray(value) || value.length > (descriptor.maxItems ?? Number.MAX_SAFE_INTEGER)) {
      throw admissionFailure(`${label} is invalid.`);
    }
    if (itemType === 'HttpUrl') {
      return value.map((item, index) => admitHttpUrl(item, `${label}[${index}]`, descriptor.itemProfile));
    }
    if (itemType === 'string') {
      const result = [];
      const seen = new Set();
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'string'
          || item.length === 0
          || item.length > (descriptor.itemMaxUtf8Bytes ?? 256)
          || (descriptor.itemPattern && !new RegExp(descriptor.itemPattern, 'u').test(item))) {
          throw admissionFailure(`${label}[${index}] is invalid.`);
        }
        if (descriptor.normalization === 'deduplicate-preserve-order') {
          if (seen.has(item)) continue;
          seen.add(item);
        }
        result.push(item);
      }
      return result;
    }
    return value.map((item, index) => admitObject(item, itemType, `${label}[${index}]`, context));
  }
  if (descriptor.type === 'node-type-discriminated-object') {
    return admitNodeData(context.nodeType, value, label, context);
  }
  if (descriptor.type === 'AssetSourceMetadata') return validateSourceMetadata(value);
  if (descriptor.type === 'object' && descriptor.required === false) {
    if (value === null || (value && typeof value === 'object' && !Array.isArray(value))) return value;
    throw admissionFailure(`${label} is invalid.`);
  }
  if (descriptor.type && schemaDefinition(descriptor.type)) return admitObject(value, descriptor.type, label, context);
  throw admissionFailure(`${label} has an unsupported admission type.`);
}

function admitProfile(value, profileName, label, context) {
  const profileKey = profileName.profile ?? profileName;
  const profile = ADMISSION_REGISTRY.fieldProfiles[profileKey];
  if (!profile) throw admissionFailure(`${label} uses an unsupported admission profile.`);
  const nullable = profile.type.endsWith('|null');
  if (value === null) {
    if (!nullable) throw admissionFailure(`${label} cannot be null.`);
    return profile.normalization === 'drop' ? OMIT_MEMBER : (profile.classification === 'optional-sensitive' ? OMIT_MEMBER : null);
  }
  if (profile.type.startsWith('string')) {
    if (typeof value !== 'string') throw admissionFailure(`${label} must be text.`);
    const maxBytes = profileName.maxUtf8Bytes ?? profile.maxUtf8Bytes;
    if (maxBytes !== undefined && encoder.encode(value).byteLength > maxBytes) throw admissionFailure(`${label} is too large.`);
  }
  switch (profileKey) {
    case 'requiredId':
    case 'optionalId':
      validateLogicalId(value, label);
      return value;
    case 'requiredSafeInteger':
    case 'optionalSafeInteger':
      if (!Number.isSafeInteger(value)) throw admissionFailure(`${label} must be a safe integer.`);
      break;
    case 'requiredFiniteNumber':
    case 'optionalFiniteNumber':
      if (!Number.isFinite(value)) throw admissionFailure(`${label} must be finite.`);
      break;
    case 'requiredBoolean':
    case 'optionalBoolean':
      if (typeof value !== 'boolean') throw admissionFailure(`${label} must be boolean.`);
      break;
    case 'requiredUserText':
    case 'optionalUserText':
      if (typeof value !== 'string') throw admissionFailure(`${label} must be text.`);
      if (containsCredentialLikeString(value) || containsUnsafeUrl(value)) throw admissionFailure(`${label} contains unsafe text.`);
      break;
    case 'optionalSensitiveText':
      if (typeof value !== 'string') throw admissionFailure(`${label} must be text.`);
      return OMIT_MEMBER;
    case 'requiredHttpUrlOrNull':
    case 'optionalHttpUrlOrNull':
    case 'optionalSensitiveHttpUrl':
    case 'optionalDerivedDisplayUrl':
      {
        const parsed = parseHttpUrl(value, label);
        if (profileKey === 'optionalSensitiveHttpUrl' && parsed.unsafe) return OMIT_MEMBER;
        if (parsed.unsafe) throw admissionFailure(`${label} is not an admitted URL.`);
      }
      if (profileKey === 'optionalDerivedDisplayUrl') {
        const backed = context.history
          || (context.ownedAssetIds && (
            context.ownedAssetIds.has(context.assetIdForUrl)
            || (context.urlField === 'previewImageUrl'
              && context.ownedAssetIds.has(context.previewAssetIdForUrl))
            || (context.urlField === 'previewVideoUrl'
              && context.ownedAssetIds.has(context.previewAssetIdForUrl))
            || (context.urlField === 'lastFrameImageUrl'
              && context.ownedAssetIds.has(context.lastFrameAssetIdForUrl))
          ));
        if (backed) return OMIT_MEMBER;
      }
      return value;
    case 'runtimeOnlyBoolean':
      if (typeof value !== 'boolean') throw admissionFailure(`${label} must be boolean.`);
      return OMIT_MEMBER;
    case 'runtimeOnlyObject':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw admissionFailure(`${label} must be an object.`);
      return OMIT_MEMBER;
    case 'assetReference':
      validateLogicalId(value, label);
      return value;
    case 'assetReferenceArray':
      if (!Array.isArray(value) || value.length > 256) throw admissionFailure(`${label} is invalid.`);
      value.forEach((item, index) => validateLogicalId(item, `${label}[${index}]`));
      return [...value];
    case 'providerParams':
      return admitObject(value, 'ProviderParams', label, context);
    case 'generationHandle':
      return admitObject(value, 'BrowserGenerationJobHandle', label, context);
    default:
      throw admissionFailure(`${label} uses an unsupported admission profile.`);
  }
  const minimum = profileName.minimum;
  const maximum = profileName.maximum;
  if (minimum !== undefined && value < minimum) throw admissionFailure(`${label} is below its minimum.`);
  if (maximum !== undefined && value > maximum) throw admissionFailure(`${label} exceeds its maximum.`);
  if (profileName.minimumExclusive !== undefined && !(value > profileName.minimumExclusive)) {
    throw admissionFailure(`${label} must be greater than its minimum.`);
  }
  if (profileName.maximumExclusive !== undefined && !(value < profileName.maximumExclusive)) {
    throw admissionFailure(`${label} must be less than its maximum.`);
  }
  return value;
}

function admitHttpUrl(value, label, profile = 'requiredHttpUrlOrNull') {
  if (value === null && profile !== 'requiredHttpUrlOrNull') return null;
  const parsed = parseHttpUrl(value, label);
  if (parsed.unsafe) throw admissionFailure(`${label} is not an admitted URL.`);
  return value;
}

function parseHttpUrl(value, label) {
  const maxUtf8Bytes = ADMISSION_REGISTRY.fieldProfiles.requiredHttpUrlOrNull.maxUtf8Bytes;
  if (typeof value !== 'string' || encoder.encode(value).byteLength > maxUtf8Bytes) {
    throw admissionFailure(`${label} is not an admitted URL.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw admissionFailure(`${label} is not an admitted URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw admissionFailure(`${label} is not an admitted URL.`);
  }
  return {
    parsed,
    unsafe: Boolean(parsed.username || parsed.password || parsed.search || parsed.hash),
  };
}

function admitNodeData(nodeType, value, label, context = {}) {
  if (!ADMITTED_NODE_TYPES.has(nodeType)) throw admissionFailure(`${label} has an unknown node type.`);
  return admitObject(value, nodeType, label, { ...context, nodeType });
}

function admitCanvasNodes(nodes, label, context = {}) {
  if (!Array.isArray(nodes)
    || nodes.length > ADMISSION_REGISTRY.schemas.projectDocument.fields.nodes.maxItems) {
    throw admissionFailure(`${label} is invalid.`);
  }
  return nodes.map((node, index) => {
    const admitted = admitObject(node, 'CanvasNode', `${label}[${index}]`, context);
    return admitted;
  });
}

function admitCanvasEdges(edges, label, context = {}) {
  if (!Array.isArray(edges)
    || edges.length > ADMISSION_REGISTRY.schemas.projectDocument.fields.edges.maxItems) {
    throw admissionFailure(`${label} is invalid.`);
  }
  return edges.map((edge, index) => admitObject(edge, 'CanvasEdge', `${label}[${index}]`, context));
}

function validateCanvasNodes(nodes, label, context = {}) {
  admitCanvasNodes(nodes, label, context);
}

function validateCanvasEdges(edges, label, context = {}) {
  admitCanvasEdges(edges, label, context);
}

function validateHistorySnapshots(snapshots, label, context = {}) {
  admitHistorySnapshots(snapshots, label, context);
}

function admitHistorySnapshots(snapshots, label, context = {}, options = {}) {
  if (!Array.isArray(snapshots)) throw admissionFailure(`${label} is invalid.`);
  const maximum = ADMISSION_REGISTRY.limits.maxPersistedHistorySnapshotsPerDirection;
  if (options.truncate === false && snapshots.length > maximum) {
    throw admissionFailure(`${label} exceeds the persisted history limit.`);
  }
  const retained = options.truncate === false ? snapshots : snapshots.slice(-maximum);
  return retained.map((snapshot, index) => admitObject(
    snapshot,
    'CanvasHistorySnapshot',
    `${label}[${index}]`,
    { ...context, history: true },
  ));
}

function validatePosition(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new FileProjectLibraryError('project_secret_admission_failed', `${label} is invalid.`);
  }
  assertInputFields(value, ['x', 'y'], label);
}

function validateImagePool(value, label) {
  if (!Array.isArray(value) || value.length > ADMISSION_REGISTRY.schemas.nodesJson.imagePool.maxItems) {
    throw admissionFailure(`${label} is invalid.`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !isSafeHttpUrl(item)) {
      throw admissionFailure(`${label} contains an invalid URL.`);
    }
  }
  return [...value];
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function stripDerivedDisplayUrls(project, ownedAssetIds) {
  const next = structuredClone(project);
  const nodes = Array.isArray(next.nodes) ? next.nodes : [];
  for (const node of nodes) stripNodeDisplayUrls(node, ownedAssetIds, false);
  return next;
}

function stripHistoryDisplayUrls(history) {
  for (const snapshot of [...(history.past ?? []), ...(history.future ?? [])]) {
    for (const node of snapshot.nodes ?? []) stripNodeDisplayUrls(node, new Set(), true);
  }
}

function stripNodeDisplayUrls(node, ownedAssetIds, history) {
  if (!node?.data || typeof node.data !== 'object' || Array.isArray(node.data)) return;
  if (history) {
    for (const field of DERIVED_DISPLAY_URL_FIELDS) delete node.data[field];
    return;
  }
  const mainAsset = typeof node.data.assetId === 'string' && ownedAssetIds.has(node.data.assetId);
  const previewAsset = typeof node.data.previewAssetId === 'string' && ownedAssetIds.has(node.data.previewAssetId);
  const lastFrameAsset = typeof node.data.lastFrameAssetId === 'string' && ownedAssetIds.has(node.data.lastFrameAssetId);
  if (mainAsset) {
    for (const field of ['imageUrl', 'videoUrl', 'audioUrl']) delete node.data[field];
  }
  if (mainAsset || previewAsset) {
    for (const field of ['previewImageUrl', 'previewVideoUrl']) delete node.data[field];
  }
  if (lastFrameAsset) delete node.data.lastFrameImageUrl;
}

function validateRecovery(value) {
  if (!value || typeof value !== 'object' || !['unsupported_schema', 'migration_failed'].includes(value.reason)) {
    throw new FileProjectLibraryError('invalid_project', 'Project recovery state is invalid.');
  }
  assertInputFields(value, ['reason'], 'project recovery');
  return { reason: value.reason };
}

function validateProjectRevision(value, label = 'revision') {
  validateLogicalId(value, label);
  if (/^r[0-9]+$/u.test(value)) {
    const sequence = Number(value.slice(1));
    if (!Number.isSafeInteger(sequence)) {
      throw new CorruptLibraryError(`${label} is not a safe integer revision.`);
    }
  }
  return value;
}

function validateViewportValue(value, label) {
  return admitObject(value, 'Viewport', label);
}

function assertInputFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileProjectLibraryError('invalid_project', `${label} must be an object.`);
  }
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) throw new FileProjectLibraryError('invalid_project', `${label} contains unknown member ${key}.`);
  }
}

function assertExactInputFields(value, required, label) {
  assertInputFields(value, required, label);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new FileProjectLibraryError('invalid_project', `${label} is missing member ${key}.`);
  }
}

function rejectProjectSecrets(value) {
  walk(value, (key, item) => {
    if (key && isSensitiveName(key)) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Project data contains a forbidden secret field.');
    }
    if (typeof item === 'string' && (
      item.startsWith('blob:')
      || item.startsWith('data:')
      || containsCredentialLikeString(item)
      || containsUnsafeUrl(item)
    )) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Project data contains temporary or credential-like text.');
    }
  });
}

function assertExpectedRevision(projectId, expected, actual) {
  const equivalentEmptyRevision = expected === 'r0' && actual === 'absent';
  if (expected !== undefined && expected !== actual && !equivalentEmptyRevision) {
    throw new StaleProjectRevisionError(projectId, expected, actual === 'absent' ? null : actual);
  }
}

function chooseRevision(requested, current) {
  if (!current || current === 'absent') {
    if (requested === undefined || requested === 'r0' || requested === 'r1') return 'r1';
    throw new FileProjectLibraryError('non_monotonic_revision', 'A new project must start at revision r1.');
  }
  const next = nextRevision(current);
  if (requested === undefined || requested === current) return next;
  if (requested !== next) {
    throw new FileProjectLibraryError(
      'non_monotonic_revision',
      `Project revision must advance from ${current} to ${next}.`,
      { currentRevision: current, requestedRevision: requested },
    );
  }
  return requested;
}

function nextRevision(current) {
  const match = /^r(\d+)$/u.exec(current);
  if (!match) return `r${sha256(current).slice(0, 8)}`;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new FileProjectLibraryError('revision_exhausted', 'Project revision sequence is exhausted.');
  }
  return `r${sequence + 1}`;
}

function emptyCommit(commitId, sequence, previousCommitId, changes = null) {
  return {
    format: 'lumina-library-commit',
    version: 1,
    commitId,
    previousCommitId,
    sequence,
    runtimeAttachment: null,
    projects: changes?.projects ?? [],
    assets: changes?.assets ?? [],
    completedImports: [],
  };
}

function makeLibraryKey(prefix) {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

function compareUtf8(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function assertSortedUnique(entries, selector, label) {
  let previous = null;
  for (const entry of entries) {
    const key = selector(entry);
    validateLogicalId(key, `${label} id`);
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      throw new CorruptLibraryError(`${label} is not sorted or contains duplicates.`);
    }
    previous = key;
  }
}

function parseJsonString(value, label) {
  if (typeof value !== 'string') throw new FileProjectLibraryError('invalid_project', `${label} must be JSON text.`);
  try {
    const parsed = parseJsonText(value);
    assertJsonValue(parsed);
    return parsed;
  } catch (error) {
    throw new FileProjectLibraryError('invalid_project', `${label} is not valid JSON.`, { cause: error });
  }
}

function parseStrictJson(bytes, label) {
  try {
    const text = decoder.decode(bytes instanceof Uint8Array ? bytes : encoder.encode(bytes));
    if (text.charCodeAt(0) === 0xfeff) throw new Error('BOM');
    const value = parseJsonText(text);
    assertJsonValue(value);
    if (canonicalize(value) !== text) throw new Error('non-canonical JSON');
    return value;
  } catch (error) {
    if (error instanceof CorruptLibraryError) throw error;
    throw new CorruptLibraryError(`${label} is not a valid canonical JSON document.`, { cause: error });
  }
}

function parseJsonText(text) {
  let index = 0;
  let depth = 0;

  const fail = (message) => {
    throw new SyntaxError(`${message} at byte ${index}.`);
  };
  const skipWhitespace = () => {
    while (index < text.length && /[\u0020\u0009\u000a\u000d]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail('Expected a JSON string');
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        index += 2;
        if (index > text.length) fail('Unterminated JSON escape');
        continue;
      }
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch (error) {
          throw new SyntaxError(`Invalid JSON string: ${error.message}`);
        }
      }
      if (character < ' ') fail('Control character in JSON string');
      index += 1;
    }
    fail('Unterminated JSON string');
  };
  const parseNumber = () => {
    const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) fail('Invalid JSON number');
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail('Non-finite JSON number');
    return number;
  };
  const parseValue = () => {
    skipWhitespace();
    if (depth > MAX_JSON_DEPTH) fail('JSON nesting is too deep');
    const character = text[index];
    if (character === '"') return parseString();
    if (character === '-' || (character >= '0' && character <= '9')) return parseNumber();
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    if (character === '[') {
      index += 1;
      depth += 1;
      const result = [];
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        depth -= 1;
        return result;
      }
      while (true) {
        result.push(parseValue());
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          depth -= 1;
          return result;
        }
        if (text[index] !== ',') fail('Expected a comma in JSON array');
        index += 1;
      }
    }
    if (character === '{') {
      index += 1;
      depth += 1;
      const result = Object.create(null);
      const keys = new Set();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        depth -= 1;
        return result;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail(`Duplicate JSON member ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('Expected a colon in JSON object');
        index += 1;
        Object.defineProperty(result, key, {
          value: parseValue(),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          depth -= 1;
          return result;
        }
        if (text[index] !== ',') fail('Expected a comma in JSON object');
        index += 1;
      }
    }
    fail('Unexpected JSON token');
  };

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) fail('Trailing JSON data');
  return value;
}

function assertExactFields(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CorruptLibraryError(`${label} must be an object.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CorruptLibraryError(`${label} contains unknown member ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new CorruptLibraryError(`${label} is missing member ${key}.`);
  }
}

function assertJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && hasUnpairedSurrogate(value)) throw new FileProjectLibraryError('invalid_json', 'JSON contains an unpaired surrogate.');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FileProjectLibraryError('invalid_json', 'JSON contains a non-finite number.');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertJsonValue);
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (hasUnpairedSurrogate(key)) throw new FileProjectLibraryError('invalid_json', 'JSON contains an unpaired key.');
      assertJsonValue(item);
    });
    return;
  }
  throw new FileProjectLibraryError('invalid_json', 'JSON contains an unsupported value.');
}

function canonicalizeValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(',')}]`;
  const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`).join(',')}}`;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isSensitiveName(value) {
  const normalized = value.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
  return ['apikey', 'token', 'secret', 'password', 'authorization', 'credential', 'cookie', 'privatekey', 'clientsecret', 'accesskey', 'gatewayurl', 'signature', 'signedurl'].some((part) => normalized.includes(part));
}

function containsCredentialLikeString(value) {
  const trimmed = value.trim();
  return /^(?:bearer|basic|token)\s+\S+/iu.test(trimmed)
    || /^(?:sk-|rk-|pk-|akia|ghp_|github_pat_|xox)[A-Za-z0-9_-]{8,}/iu.test(trimmed)
    || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(trimmed)
    || /^blob:|^data:/iu.test(trimmed);
}

function containsUnsafeUrl(value) {
  const trimmed = value.trim();
  if (/^(?:data:|blob:)/iu.test(trimmed)) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return !['http:', 'https:'].includes(parsed.protocol)
      || Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch {
    return true;
  }
}

function walk(value, visitor) {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      visitor('', item);
      walk(item, visitor);
    });
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      visitor(key, item);
      walk(item, visitor);
    });
  }
}

function managedPath(state, relative) {
  if (typeof relative !== 'string' || relative.includes('\u0000')) {
    throw new FileProjectLibraryError('path_escape', 'Managed path is invalid.');
  }
  const target = path.resolve(state.root, relative);
  const relation = path.relative(state.root, target);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new FileProjectLibraryError('path_escape', 'Managed path escapes the library root.');
  }
  return target;
}

async function ensureDirectory(state, relative) {
  const target = managedPath(state, relative);
  await ensureNoSymlinkPath(state.root, target, true);
  await fs.mkdir(target, { recursive: true });
  await ensureNoSymlinkPath(state.root, target);
}

async function ensureParentDirectory(state, target) {
  const parent = path.dirname(target);
  const relative = path.relative(state.root, parent);
  await ensureDirectory(state, relative);
}

async function ensureNoSymlinkPath(root, target, allowMissing = true) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relation = path.relative(absoluteRoot, absoluteTarget);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new FileProjectLibraryError('path_escape', 'Path escapes the managed root.');
  }
  const segments = relation ? relation.split(path.sep) : [];
  let current = absoluteRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'Managed paths cannot contain symlinks.');
      if (stat.isDirectory() === false && current !== absoluteTarget) {
        throw new FileProjectLibraryError('path_escape', 'Managed path contains a non-directory segment.');
      }
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) break;
      throw error;
    }
  }
}

async function acquireWriteLease(state) {
  const deadline = Date.now() + state.lockTimeoutMs;
  while (true) {
    try {
      const acquiredAt = Date.now();
      const token = randomUUID();
      const contents = `${process.pid}\n${acquiredAt}\n${token}\n`;
      const handle = await fs.open(state.lockPath, 'wx');
      try {
        await handle.writeFile(contents, 'utf8');
      } finally {
        await handle.close();
      }
      await flushFile(state, state.lockPath);
      await syncDirectory(state, path.dirname(state.lockPath));
      return { path: state.lockPath, acquiredAt, token, contents };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await removeStaleLease(state);
      if (Date.now() >= deadline) throw new FileProjectLibraryError('library_busy', 'The project library write lease is busy.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function removeStaleLease(state) {
  let stat;
  let contents;
  try {
    [stat, contents] = await Promise.all([
      fs.stat(state.lockPath),
      fs.readFile(state.lockPath, 'utf8'),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const fields = contents.split(/\s+/u);
  const createdAt = Number.parseInt(fields[1], 10);
  const now = Date.now();
  let leaseExpired = false;
  if (Number.isSafeInteger(createdAt)) {
    const age = now - createdAt;
    if (age < state.lockTimeoutMs) return;
    leaseExpired = age >= MAX_WRITE_LEASE_MS;
  } else if (now - stat.mtimeMs < state.lockTimeoutMs) {
    return;
  }
  if (!leaseExpired) {
    const pid = Number.parseInt(fields[0], 10);
    if (Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if (error?.code === 'EPERM') return;
      }
    }
  }
  if (await removeIfUnchanged(state, state.lockPath, contents)) {
    await syncDirectory(state, path.dirname(state.lockPath));
  }
}

async function releaseWriteLease(state, lock) {
  try {
    const contents = await fs.readFile(lock.path, 'utf8');
    if (contents.split(/\s+/u)[2] !== lock.token) return;
    if (await removeIfUnchanged(state, lock.path, contents)) {
      await syncDirectory(state, path.dirname(lock.path));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertWriteLeaseCurrent(state) {
  const lease = state.activeWriteLease;
  if (!lease || Date.now() - lease.acquiredAt >= MAX_WRITE_LEASE_MS) {
    throw new FileProjectLibraryError(
      'lease_expired',
      'The final library publication lease exceeded its five-minute bound.',
    );
  }
  let contents;
  try {
    contents = await fs.readFile(lease.path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
    }
    throw error;
  }
  if (contents.split(/\s+/u)[2] !== lease.token) {
    throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
  }
}

async function writeCanonicalFile(state, target, value) {
  return writeCanonicalBytes(state, target, encoder.encode(canonicalize(value)));
}

async function writeCanonicalHeadFile(state, target, value) {
  return writeCanonicalHeadBytes(state, target, encoder.encode(canonicalize(value)));
}

async function writeCanonicalBytes(state, target, bytes) {
  await ensureNoSymlinkPath(state.root, target, true);
  await ensureParentDirectory(state, target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes);
  await flushFile(state, temporary);
  await atomicReplace(state, temporary, target);
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
}

async function writeCanonicalHeadBytes(state, target, bytes) {
  await ensureNoSymlinkPath(state.root, target, true);
  await ensureParentDirectory(state, target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await fs.writeFile(temporary, bytes);
    await flushFile(state, temporary);
    await atomicReplaceIfLeaseCurrent(state, temporary, target);
    published = true;
  } finally {
    if (!published) await fs.rm(temporary, { force: true }).catch(() => {});
  }
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
}

async function readCanonicalFile(target, label) {
  await ensureNoSymlinkAncestors(path.dirname(target));
  try {
    const targetStat = await fs.lstat(target);
    if (targetStat.isSymbolicLink()) {
      throw new FileProjectLibraryError('path_escape', 'Managed files cannot be symbolic links.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const bytes = await fs.readFile(target);
  const value = parseStrictJson(bytes, label);
  if (canonicalize(value) !== decoder.decode(bytes)) throw new CorruptLibraryError(`${label} is not canonical.`);
  return bytes;
}

async function flushFile(state, target) {
  await runDurableOperation(state, 'flushFile', [target], 'The managed filesystem cannot flush files.');
}

async function atomicReplace(state, temporary, target) {
  await runDurableOperation(
    state,
    'atomicReplace',
    [temporary, target],
    'The managed filesystem cannot atomically replace files.',
  );
}

async function atomicReplaceIfLeaseCurrent(state, temporary, target) {
  const lease = state.activeWriteLease;
  if (!lease) {
    throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
  }
  const result = await runDurableOperation(
    state,
    'atomicReplaceIfLeaseCurrent',
    [temporary, target, lease.path, lease.contents, lease.acquiredAt + MAX_WRITE_LEASE_MS],
    'The managed filesystem cannot atomically publish the head while its write lease is current.',
    true,
  );
  if (typeof result !== 'boolean') {
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem must report whether it atomically published the head under the write lease.',
    );
  }
  if (!result) {
    throw new FileProjectLibraryError('lease_lost', 'The library write lease was replaced before publication.');
  }
}

async function removeIfUnchanged(state, target, expectedContents) {
  const result = await runDurableOperation(
    state,
    'removeIfUnchanged',
    [target, expectedContents],
    'The managed filesystem cannot atomically reclaim a matching write lease.',
    true,
  );
  if (typeof result !== 'boolean') {
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem must report whether it atomically reclaimed the matching write lease.',
    );
  }
  return result;
}

async function syncDirectory(state, directory) {
  const root = path.resolve(state.root);
  let current = path.resolve(directory);
  while (true) {
    await ensureNoSymlinkPath(state.root, current);
    await runDurableOperation(state, 'syncDirectory', [current], 'The managed filesystem cannot sync directories.');
    if (current === root) return;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new FileProjectLibraryError('path_escape', 'A directory sync escaped the managed root.');
    }
    current = parent;
  }
}

function assertDurableFileOps(state) {
  if (!state.durableFileOps
    || ['flushFile', 'atomicReplace', 'atomicReplaceIfLeaseCurrent', 'removeIfUnchanged', 'syncDirectory'].some(
      (operation) => typeof state.durableFileOps[operation] !== 'function',
    )) {
    throw new FileProjectLibraryError(
      'durability_unavailable',
      'The managed filesystem requires a complete DurableFileOps implementation.',
    );
  }
}

async function runDurableOperation(state, operation, arguments_, message, allowFalse = false) {
  assertDurableFileOps(state);
  try {
    const result = await state.durableFileOps[operation](...arguments_);
    if (result === false && !allowFalse) throw new FileProjectLibraryError('durability_unavailable', message);
    return result;
  } catch (error) {
    if (error instanceof FileProjectLibraryError) throw error;
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR'].includes(error?.code)) {
      throw new FileProjectLibraryError('durability_unavailable', message, { cause: error });
    }
    throw error;
  }
}

async function fault(state, phase, details) {
  if (state.faultInjector) await state.faultInjector(phase, details);
}

async function collectFiles(directory) {
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'Symlinks are not allowed in the library.');
    if (entry.isDirectory()) result.push(...(await collectFiles(entryPath)));
    else result.push(entry.name);
  }
  return result.map((entry) => path.isAbsolute(entry) ? entry : path.join(directory, entry));
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function listDirectories(state, relative) {
  const directory = managedPath(state, relative);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new FileProjectLibraryError('path_escape', 'Symlinks are not allowed in the library.');
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export const FILE_PROJECT_LIBRARY_CONSTANTS = Object.freeze({
  libraryFormat: LIBRARY_FORMAT,
  libraryVersion: LIBRARY_VERSION,
  libraryKeyPattern: KEY_PATTERN.source,
  safetyWindowMs: DEFAULT_SAFETY_WINDOW_MS,
});
