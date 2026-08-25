import {
  CorruptLibraryError,
  DEFAULT_LOCK_TIMEOUT_MS,
  FileProjectLibraryError,
  MAX_ASSET_METADATA_BYTES,
  MAX_DURABLE_ASSET_BYTES,
  assertExactFields,
  canonicalize,
  compareUtf8,
  createHash,
  encoder,
  fs,
  makeLibraryKey,
  parseStrictJson,
  path,
  randomUUID,
  sha256,
  validateLogicalId,
} from './core.mjs';
import {
  collectAssetReferences,
  isAdmittedMime,
  normalizeAssetInput,
  normalizeProjectRecord,
  validateSourceMetadata,
} from './admission.mjs';
import {
  acquireWriteLease,
  assertDurableFileOps,
  captureManagedTreeClosure,
  copyManagedFile,
  ensureDirectory,
  ensureNoSymlinkAncestors,
  ensureNoSymlinkPath,
  flushFile,
  listDirectories,
  managedPath,
  pathExists,
  readCanonicalFile,
  readFileBytesBounded,
  releaseWriteLease,
  removeExactManagedTree,
  syncDirectory,
  writeCanonicalBytes,
  writeCanonicalFile,
  writeCanonicalHeadFile,
  openNewManagedFile,
} from './filesystem.mjs';
import { selectDurableFileOps } from './durableFileOps.mjs';
import { selectManagedLibraryRoot } from './managedRoot.mjs';

const RUNTIME_LIBRARY_FORMAT = 'lumina-runtime-project-library';
const RUNTIME_LIBRARY_VERSION = 1;
const RUNTIME_HEAD_FORMAT = 'lumina-runtime-project-head';
const RUNTIME_PROJECT_FORMAT = 'lumina-runtime-project-snapshot';
const RUNTIME_ASSET_FORMAT = 'lumina-runtime-asset';

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
    durableFileOps: selectDurableFileOps(options),
    faultInjector: typeof options.faultInjector === 'function' ? options.faultInjector : null,
    lockTimeoutMs: Number.isSafeInteger(options.lockTimeoutMs) && options.lockTimeoutMs > 0
      ? options.lockTimeoutMs
      : DEFAULT_LOCK_TIMEOUT_MS,
    activeWriteLease: null,
    opened: false,
    opening: null,
  };

  return {
    open: () => openLibrary(state),
    close: () => closeLibrary(state),
    listProjects: () => withReadAccess(state, (head) => listProjects(head)),
    listSummaries: () => withReadAccess(state, (head) => listProjects(head)),
    openProject: (projectId) => withReadAccess(state, (head) => readProject(state, head, projectId)),
    get: (projectId) => withReadAccess(state, (head) => readProject(state, head, projectId)),
    saveProject: (record) => withWriteLease(state, (head) => saveProject(state, head, record)),
    saveSnapshot: (record) => withWriteLease(state, (head) => saveProject(state, head, record)),
    updateViewport: (projectId, viewportJson) => withWriteLease(
      state,
      (head) => updateViewport(state, head, projectId, viewportJson),
    ),
    renameProject: (projectId, name, updatedAt) => withWriteLease(
      state,
      (head) => renameProject(state, head, projectId, name, updatedAt),
    ),
    rename: (projectId, name, updatedAt) => withWriteLease(
      state,
      (head) => renameProject(state, head, projectId, name, updatedAt),
    ),
    deleteProject: (projectId) => withWriteLease(state, (head) => deleteProject(state, head, projectId)),
    delete: (projectId) => withWriteLease(state, (head) => deleteProject(state, head, projectId)),
    writeAsset: (input) => withWriteLease(state, (head) => writeAsset(state, head, input)),
    readAsset: (assetId) => withReadAccess(state, (head) => readAsset(state, head, assetId)),
    getAssetMetadata: (assetId) => withReadAccess(state, (head) => getAssetMetadata(state, head, assetId)),
    deleteAsset: (assetId) => withWriteLease(state, (head) => deleteAsset(state, head, assetId)),
  };
}

export default createFileProjectLibrary;

async function openLibrary(state) {
  if (state.opened) return readHead(state);
  if (state.opening) return state.opening;
  state.opening = (async () => {
    assertDurableFileOps(state);
    await ensureManagedRoot(state);
    const lock = await acquireWriteLease(state);
    state.activeWriteLease = lock;
    try {
      await ensureLayout(state);
      const created = await ensureLibraryManifest(state);
      await ensureHead(state, created);
      await cleanupStaging(state);
      state.opened = true;
      return await readHead(state);
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

async function closeLibrary(state) {
  state.opened = false;
}

async function withReadAccess(state, operation) {
  const head = await openLibrary(state);
  return operation(head);
}

async function withWriteLease(state, operation) {
  await openLibrary(state);
  const lock = await acquireWriteLease(state);
  state.activeWriteLease = lock;
  try {
    const head = await readHead(state);
    return await operation(head);
  } finally {
    state.activeWriteLease = null;
    await releaseWriteLease(state, lock);
  }
}

async function ensureManagedRoot(state) {
  await ensureNoSymlinkAncestors(state, state.root);
  await state.durableFileOps.ensureRootDirectory(state.root);
  const rootStat = await fs.lstat(state.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FileProjectLibraryError('path_escape', 'The managed library root is not a real directory.');
  }
  await ensureNoSymlinkPath(state, state.root);
  state.root = await fs.realpath(state.root);
  state.lockPath = path.join(state.root, '.library-write.lock');
}

async function ensureLayout(state) {
  for (const relative of ['projects', 'assets', 'staging']) {
    await ensureDirectory(state, relative);
  }
}

async function ensureLibraryManifest(state) {
  const manifestPath = managedPath(state, 'library.json');
  try {
    const manifest = parseCanonicalDocument(
      await readCanonicalFile(state, manifestPath, 'library manifest'),
      'library manifest',
    );
    assertExactFields(manifest, ['format', 'version', 'libraryId'], [], 'library manifest');
    if (manifest.format !== RUNTIME_LIBRARY_FORMAT
      || manifest.version !== RUNTIME_LIBRARY_VERSION
      || typeof manifest.libraryId !== 'string') {
      throw new CorruptLibraryError('The library manifest is invalid.');
    }
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeCanonicalFile(state, manifestPath, {
    format: RUNTIME_LIBRARY_FORMAT,
    version: RUNTIME_LIBRARY_VERSION,
    libraryId: randomUUID(),
  });
  return true;
}

async function ensureHead(state, createdManifest) {
  const headPath = managedPath(state, 'head.json');
  const recoveryPath = managedPath(state, 'head.previous.json');
  try {
    const head = await readHeadFile(state, headPath, 'runtime project head');
    await writeCanonicalHeadFile(state, recoveryPath, head);
    return;
  } catch (error) {
    if (!isRecoverableHeadError(error)) throw error;
  }

  try {
    const recovered = await readHeadFile(state, recoveryPath, 'runtime project recovery head');
    await writeCanonicalHeadFile(state, headPath, recovered);
    await writeCanonicalHeadFile(state, recoveryPath, recovered);
    return;
  } catch (error) {
    if (!isRecoverableHeadError(error)) throw error;
  }

  if (createdManifest || await isEmptyLibraryPayload(state)) {
    const head = emptyHead();
    await writeCanonicalHeadFile(state, headPath, head);
    await writeCanonicalHeadFile(state, recoveryPath, head);
    return;
  }
  throw new FileProjectLibraryError(
    'recovery_required',
    'The existing runtime project library has no valid complete head.',
  );
}

async function isEmptyLibraryPayload(state) {
  const projectFiles = await captureManagedTreeClosure(
    state,
    managedPath(state, 'projects'),
    'runtime project payload',
  );
  const assetFiles = await captureManagedTreeClosure(
    state,
    managedPath(state, 'assets'),
    'runtime asset payload',
  );
  return projectFiles.length === 0 && assetFiles.length === 0;
}

function isRecoverableHeadError(error) {
  return error?.code === 'ENOENT' || error?.code === 'corrupt_schema';
}

async function cleanupStaging(state) {
  for (const transactionId of await listDirectories(state, 'staging')) {
    const directory = managedPath(state, `staging/${transactionId}`);
    const entries = await captureManagedTreeClosure(state, directory, 'interrupted staging data');
    await removeExactManagedTree(state, directory, entries, 'interrupted staging data');
  }
}

function emptyHead() {
  return {
    format: RUNTIME_HEAD_FORMAT,
    version: RUNTIME_LIBRARY_VERSION,
    projects: [],
    assets: [],
  };
}

async function readHead(state) {
  return readHeadFile(state, managedPath(state, 'head.json'), 'runtime project head');
}

async function readHeadFile(state, target, label) {
  const head = parseCanonicalDocument(
    await readCanonicalFile(state, target, label),
    label,
  );
  validateHead(head);
  return head;
}

function validateHead(value) {
  assertExactFields(value, ['format', 'version', 'projects', 'assets'], [], 'runtime project head');
  if (value.format !== RUNTIME_HEAD_FORMAT
    || value.version !== RUNTIME_LIBRARY_VERSION
    || !Array.isArray(value.projects)
    || !Array.isArray(value.assets)) {
    throw new CorruptLibraryError('The runtime project head is invalid.');
  }
  validateSortedEntries(value.projects, 'project', validateProjectEntry);
  validateSortedEntries(value.assets, 'asset', validateAssetEntry);
  const projectIds = new Set(value.projects.map((entry) => entry.id));
  for (const entry of value.assets) {
    if (!projectIds.has(entry.projectId)) {
      throw new CorruptLibraryError('An asset owner is missing from the runtime project head.');
    }
  }
}

function validateSortedEntries(entries, label, validateEntry) {
  let previous = null;
  for (const entry of entries) {
    validateEntry(entry);
    if (previous !== null && compareUtf8(previous, entry.id ?? entry.assetId) >= 0) {
      throw new CorruptLibraryError(`${label} entries are not sorted and unique.`);
    }
    previous = entry.id ?? entry.assetId;
  }
}

function validateProjectEntry(entry) {
  assertExactFields(
    entry,
    ['id', 'projectKey', 'snapshotPath', 'snapshotSha256', 'name', 'createdAt', 'updatedAt', 'nodeCount'],
    [],
    'runtime project entry',
  );
  validateLogicalId(entry.id, 'projectId');
  if (!isLibraryKey(entry.projectKey, 'p')
    || entry.snapshotPath !== `projects/${entry.projectKey}/snapshots/${entry.snapshotSha256}.json`
    || !isDigest(entry.snapshotSha256)
    || typeof entry.name !== 'string'
    || !validProjectNumber(entry.createdAt)
    || !validProjectNumber(entry.updatedAt)
    || !validProjectNumber(entry.nodeCount)) {
    throw new CorruptLibraryError('A runtime project entry is invalid.');
  }
}

function validateAssetEntry(entry) {
  assertExactFields(
    entry,
    ['assetId', 'projectId', 'assetKey', 'metadataPath', 'metadataSha256', 'bytesPath', 'bytesSha256', 'byteCount'],
    [],
    'runtime asset entry',
  );
  validateLogicalId(entry.assetId, 'assetId');
  validateLogicalId(entry.projectId, 'projectId');
  if (!isLibraryKey(entry.assetKey, 'a')
    || entry.metadataPath !== `assets/${entry.assetKey}/metadata.json`
    || entry.bytesPath !== `assets/${entry.assetKey}/bytes.bin`
    || !isDigest(entry.metadataSha256)
    || !isDigest(entry.bytesSha256)
    || !Number.isSafeInteger(entry.byteCount)
    || entry.byteCount < 0
    || entry.byteCount > MAX_DURABLE_ASSET_BYTES) {
    throw new CorruptLibraryError('A runtime asset entry is invalid.');
  }
}

function isLibraryKey(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{32}$`, 'u').test(value);
}

function isDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validProjectNumber(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function listProjects(head) {
  return head.projects.map(({ id, name, createdAt, updatedAt, nodeCount }) => ({
    id,
    name,
    createdAt,
    updatedAt,
    nodeCount,
  }));
}

async function readProject(state, head, projectId) {
  validateLogicalId(projectId, 'projectId');
  const entry = findProjectEntry(head, projectId);
  if (!entry) return null;
  const document = parseCanonicalDocument(
    await readCanonicalFile(state, managedPath(state, entry.snapshotPath), 'runtime project snapshot'),
    'runtime project snapshot',
  );
  assertExactFields(document, ['format', 'version', 'record'], [], 'runtime project snapshot');
  if (document.format !== RUNTIME_PROJECT_FORMAT
    || document.version !== RUNTIME_LIBRARY_VERSION
    || sha256(canonicalize(document)) !== entry.snapshotSha256) {
    throw new CorruptLibraryError('The runtime project snapshot does not match its head entry.');
  }
  const record = normalizeRuntimeProjectRecord(document.record);
  if (record.id !== entry.id
    || record.name !== entry.name
    || record.createdAt !== entry.createdAt
    || record.updatedAt !== entry.updatedAt
    || record.nodeCount !== entry.nodeCount) {
    throw new CorruptLibraryError('The runtime project snapshot metadata does not match its head entry.');
  }
  return structuredClone(record);
}

async function saveProject(state, head, input) {
  const record = normalizeRuntimeProjectRecord(input);
  await assertProjectReferencesKnown(state, head, record);
  const existing = findProjectEntry(head, record.id);
  const projectKey = existing?.projectKey ?? makeLibraryKey('p');
  const document = {
    format: RUNTIME_PROJECT_FORMAT,
    version: RUNTIME_LIBRARY_VERSION,
    record,
  };
  const snapshotSha256 = sha256(canonicalize(document));
  const transactionId = makeLibraryKey('t');
  const stagedPath = managedPath(state, `staging/${transactionId}/project.json`);
  await writeCanonicalFile(state, stagedPath, document);
  const snapshotPath = `projects/${projectKey}/snapshots/${snapshotSha256}.json`;
  const finalPath = managedPath(state, snapshotPath);
  await ensureDirectory(state, `projects/${projectKey}/snapshots`);
  if (!(await pathExists(state, finalPath))) {
    await copyManagedFile(state, stagedPath, finalPath);
    await flushFile(state, finalPath);
    await syncDirectory(state, path.dirname(finalPath));
  } else {
    const existingBytes = await readCanonicalFile(state, finalPath, 'existing runtime project snapshot');
    if (sha256(existingBytes) !== snapshotSha256) {
      throw new CorruptLibraryError('An immutable runtime project snapshot changed after publication.');
    }
  }

  const nextEntry = {
    id: record.id,
    projectKey,
    snapshotPath,
    snapshotSha256,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
  };
  const nextHead = {
    ...head,
    projects: replaceSorted(head.projects, nextEntry, (entry) => entry.id),
  };
  await publishHead(state, head, nextHead);
  await removeStagingTransaction(state, transactionId);
  return structuredClone(record);
}

async function updateViewport(state, head, projectId, viewportJson) {
  const record = await readProject(state, head, projectId);
  if (!record) return null;
  return saveProject(state, head, {
    ...record,
    updatedAt: Date.now(),
    viewportJson,
  });
}

async function renameProject(state, head, projectId, name, updatedAt) {
  const record = await readProject(state, head, projectId);
  if (!record) return null;
  return saveProject(state, head, {
    ...record,
    name,
    updatedAt,
  });
}

async function deleteProject(state, head, projectId) {
  validateLogicalId(projectId, 'projectId');
  const project = findProjectEntry(head, projectId);
  if (!project) return false;
  const assets = head.assets.filter((entry) => entry.projectId === projectId);
  const nextHead = {
    ...head,
    projects: head.projects.filter((entry) => entry.id !== projectId),
    assets: head.assets.filter((entry) => entry.projectId !== projectId),
  };
  await publishHead(state, head, nextHead);
  await removeContainedTree(state, managedPath(state, `projects/${project.projectKey}`));
  for (const asset of assets) {
    await removeContainedTree(state, managedPath(state, `assets/${asset.assetKey}`));
  }
  return true;
}

async function writeAsset(state, head, input) {
  const projectId = validateLogicalId(input?.projectId, 'projectId');
  if (!findProjectEntry(head, projectId)) {
    throw new FileProjectLibraryError('asset_owner_missing', 'Asset writes require an existing project.');
  }
  const assetId = input?.assetId === undefined ? makeLibraryKey('a') : validateLogicalId(input.assetId, 'assetId');
  if (findAssetEntry(head, assetId)) {
    throw new FileProjectLibraryError('asset_exists', 'The asset already exists.');
  }
  const normalized = await normalizeAssetInput(input);
  const metadata = {
    assetId,
    ...normalized.metadata,
  };
  const assetKey = makeLibraryKey('a');
  const transactionId = makeLibraryKey('t');
  const stagedPath = managedPath(state, `staging/${transactionId}/bytes.bin`);
  const streamed = await stageBlobBytes(state, stagedPath, input.blob);
  if (streamed.byteCount !== metadata.byteCount) {
    throw new FileProjectLibraryError('asset_integrity_failed', 'Asset bytes do not match their metadata.');
  }

  const metadataDocument = {
    format: RUNTIME_ASSET_FORMAT,
    version: RUNTIME_LIBRARY_VERSION,
    metadata,
  };
  const metadataBytes = encoder.encode(canonicalize(metadataDocument));
  if (metadataBytes.byteLength > MAX_ASSET_METADATA_BYTES) {
    throw new FileProjectLibraryError('asset_metadata_too_large', 'Asset metadata exceeds the durable library limit.');
  }
  const metadataPath = `assets/${assetKey}/metadata.json`;
  const bytesPath = `assets/${assetKey}/bytes.bin`;
  const finalBytesPath = managedPath(state, bytesPath);
  await ensureDirectory(state, `assets/${assetKey}`);
  await copyManagedFile(state, stagedPath, finalBytesPath);
  await flushFile(state, finalBytesPath);
  await syncDirectory(state, path.dirname(finalBytesPath));
  await writeCanonicalBytes(state, managedPath(state, metadataPath), metadataBytes);

  const entry = {
    assetId,
    projectId,
    assetKey,
    metadataPath,
    metadataSha256: sha256(metadataBytes),
    bytesPath,
    bytesSha256: streamed.bytesSha256,
    byteCount: streamed.byteCount,
  };
  await publishHead(state, head, {
    ...head,
    assets: replaceSorted(head.assets, entry, (candidate) => candidate.assetId),
  });
  await removeStagingTransaction(state, transactionId);
  return structuredClone(metadata);
}

async function getAssetMetadata(state, head, assetId) {
  validateLogicalId(assetId, 'assetId');
  const entry = findAssetEntry(head, assetId);
  if (!entry) return null;
  const document = parseCanonicalDocument(
    await readCanonicalFile(
      state,
      managedPath(state, entry.metadataPath),
      'runtime asset metadata',
      MAX_ASSET_METADATA_BYTES,
    ),
    'runtime asset metadata',
  );
  assertExactFields(document, ['format', 'version', 'metadata'], [], 'runtime asset metadata');
  if (document.format !== RUNTIME_ASSET_FORMAT
    || document.version !== RUNTIME_LIBRARY_VERSION
    || sha256(canonicalize(document)) !== entry.metadataSha256) {
    throw new CorruptLibraryError('The runtime asset metadata does not match its head entry.');
  }
  const metadata = normalizeRuntimeAssetMetadata(document.metadata);
  if (metadata.assetId !== entry.assetId
    || metadata.projectId !== entry.projectId
    || metadata.byteCount !== entry.byteCount) {
    throw new CorruptLibraryError('The runtime asset metadata has an invalid owner or size.');
  }
  return structuredClone(metadata);
}

async function readAsset(state, head, assetId) {
  const entry = findAssetEntry(head, validateLogicalId(assetId, 'assetId'));
  if (!entry) return null;
  const metadata = await getAssetMetadata(state, head, assetId);
  const bytes = await readFileBytesBounded(
    state,
    managedPath(state, entry.bytesPath),
    entry.byteCount,
    'runtime asset bytes',
  );
  if (bytes.byteLength !== entry.byteCount || sha256(bytes) !== entry.bytesSha256) {
    throw new CorruptLibraryError('Runtime asset bytes failed integrity validation.');
  }
  return new Blob([bytes], { type: metadata.mimeType });
}

async function deleteAsset(state, head, assetId) {
  validateLogicalId(assetId, 'assetId');
  const asset = findAssetEntry(head, assetId);
  if (!asset) return false;
  const project = await readProject(state, head, asset.projectId);
  if (!project) {
    throw new CorruptLibraryError('An asset owner is missing from the runtime project head.');
  }
  if (projectReferencesAsset(project, assetId)) {
    throw new FileProjectLibraryError('asset_still_referenced', 'Referenced assets cannot be deleted.');
  }
  await publishHead(state, head, {
    ...head,
    assets: head.assets.filter((entry) => entry.assetId !== assetId),
  });
  await removeContainedTree(state, managedPath(state, `assets/${asset.assetKey}`));
  return true;
}

async function assertProjectReferencesKnown(state, head, record) {
  const references = projectAssetReferences(record);
  for (const assetId of references) {
    const asset = findAssetEntry(head, assetId);
    if (!asset || asset.projectId !== record.id) {
      throw new FileProjectLibraryError('asset_reference_missing', 'A project references an unavailable asset.');
    }
    await getAssetMetadata(state, head, assetId);
  }
}

function projectReferencesAsset(record, assetId) {
  return projectAssetReferences(record).has(assetId);
}

function projectAssetReferences(record) {
  return collectAssetReferences({
    nodes: JSON.parse(record.nodesJson),
    edges: JSON.parse(record.edgesJson),
    viewport: JSON.parse(record.viewportJson),
    history: JSON.parse(record.historyJson),
  });
}

async function stageBlobBytes(state, target, blob) {
  if (!blob || typeof blob.stream !== 'function') {
    throw new FileProjectLibraryError('invalid_asset', 'Asset input must include a streamable Blob.');
  }
  await ensureNoSymlinkPath(state, target, true);
  await ensureDirectory(state, path.relative(state.root, path.dirname(target)));
  const handle = await openNewManagedFile(state, target, 'asset staging file');
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
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) {
            throw new FileProjectLibraryError('asset_write_failed', 'Asset staging could not make progress.');
          }
          offset += bytesWritten;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await handle.close();
  }
  if (byteCount !== blob.size) {
    throw new FileProjectLibraryError('asset_integrity_failed', 'Asset bytes changed while being staged.');
  }
  await flushFile(state, target);
  await syncDirectory(state, path.dirname(target));
  return { byteCount, bytesSha256: digest.digest('hex') };
}

async function publishHead(state, currentHead, nextHead) {
  validateHead(currentHead);
  validateHead(nextHead);
  const recoveryPath = managedPath(state, 'head.previous.json');
  await writeCanonicalHeadFile(state, recoveryPath, currentHead);
  await writeCanonicalHeadFile(state, managedPath(state, 'head.json'), nextHead);
  await writeCanonicalHeadFile(state, recoveryPath, nextHead);
}

async function removeStagingTransaction(state, transactionId) {
  await removeContainedTree(state, managedPath(state, `staging/${transactionId}`));
}

async function removeContainedTree(state, directory) {
  try {
    const entries = await captureManagedTreeClosure(state, directory, 'runtime library cleanup');
    await removeExactManagedTree(state, directory, entries, 'runtime library cleanup');
  } catch {
    // Cleanup occurs only after a new head is durable. Hidden leftovers cannot alter visible state.
  }
}

function normalizeRuntimeProjectRecord(record) {
  return normalizeProjectRecord(record);
}

function normalizeRuntimeAssetMetadata(metadata) {
  assertExactFields(
    metadata,
    ['assetId', 'projectId', 'kind', 'mimeType', 'byteCount', 'createdAt', 'sourceKind', 'width', 'height', 'durationMs', 'sourceMetadata'],
    [],
    'runtime asset metadata',
  );
  validateLogicalId(metadata.assetId, 'assetId');
  validateLogicalId(metadata.projectId, 'projectId');
  if (!['image', 'video', 'audio'].includes(metadata.kind)
    || !['import', 'generation', 'derived'].includes(metadata.sourceKind)
    || !isAdmittedMime(metadata.kind, metadata.mimeType)
    || !Number.isSafeInteger(metadata.byteCount)
    || metadata.byteCount < 0
    || metadata.byteCount > MAX_DURABLE_ASSET_BYTES
    || !Number.isSafeInteger(metadata.createdAt)
    || metadata.createdAt < 0
    || !optionalNonNegativeSafeInteger(metadata.width)
    || !optionalNonNegativeSafeInteger(metadata.height)
    || !optionalNonNegativeSafeInteger(metadata.durationMs)) {
    throw new CorruptLibraryError('Runtime asset metadata fields are invalid.');
  }
  return {
    ...metadata,
    sourceMetadata: validateSourceMetadata(metadata.sourceMetadata),
  };
}

function optionalNonNegativeSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function parseCanonicalDocument(bytes, label) {
  return parseStrictJson(bytes, label);
}

function findProjectEntry(head, projectId) {
  return head.projects.find((entry) => entry.id === projectId) ?? null;
}

function findAssetEntry(head, assetId) {
  return head.assets.find((entry) => entry.assetId === assetId) ?? null;
}

function replaceSorted(entries, replacement, key) {
  return entries
    .filter((entry) => key(entry) !== key(replacement))
    .concat(replacement)
    .sort((left, right) => compareUtf8(key(left), key(right)));
}
