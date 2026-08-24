import { collectAssetReferences, validateAssetCatalogEntry, validateProjectRevision } from './admission.mjs';
import { ADMISSION_REGISTRY, CorruptLibraryError, DIGEST_PATTERN, MAX_ASSET_METADATA_BYTES, MAX_DURABLE_ASSET_BYTES, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, assertExactFields, canonicalize, path, sha256, validateLibraryKey, validateLogicalId } from './core.mjs';
import { ensureNoSymlinkPath, hashFileBytes, managedPath, pathExists, readCanonicalFile } from './filesystem.mjs';
import { parseCommit, parseHead } from './catalogRecords.mjs';
import { parseAssetMetadataDocument, parseHistoryDocument, parseProjectDocument, parseProjectManifest, validateProjectRecoveryEvidence } from './snapshotDocuments.mjs';

export async function readCatalog(state) {
  try {
    const headBytes = await readCanonicalFile(state, managedPath(state, 'head.json'), 'head');
    const head = parseHead(headBytes);
    await validateCatalogForHead(state, head);
    const commit = parseCommit(await readCanonicalFile(
      state,
      managedPath(state, `commits/${head.commitId}.json`),
      'catalog commit',
    ));
    return { head, commit, revision: { commitId: head.commitId, sequence: commit.sequence, commitSha256: head.commitSha256 } };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'path_escape' || error?.code === 'corrupt_schema') throw error;
    throw new CorruptLibraryError('The visible catalog is invalid.', { cause: error });
  }
}

export async function validateCatalogForHead(state, head) {
  validateLibraryKey(head.commitId, 'c');
  if (!DIGEST_PATTERN.test(head.commitSha256)) throw new CorruptLibraryError('Head digest is invalid.');
  if (head.previousCommitId !== null) validateLibraryKey(head.previousCommitId, 'c');
  if (head.previousCommitId === head.commitId) throw new CorruptLibraryError('Head cannot point to itself.');
  const commitBytes = await readCanonicalFile(state, managedPath(state, `commits/${head.commitId}.json`), 'catalog commit');
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
    if (await pathExists(state, previousPath)) {
      const previous = parseCommit(await readCanonicalFile(state, previousPath, 'previous catalog commit'));
      if (previous.commitId !== commit.previousCommitId || previous.sequence !== commit.sequence - 1) {
        throw new CorruptLibraryError('Catalog commit provenance is invalid.');
      }
    }
  }
  await validateCatalogPayloads(state, commit);
  return commit;
}

export async function validateCatalogPayloads(state, commit) {
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
    try {
      await ensureNoSymlinkPath(state, base);
      const manifestBytes = await readCanonicalFile(state, path.join(base, 'manifest.json'), 'project manifest');
      if (sha256(manifestBytes) !== entry.manifestSha256) throw new CorruptLibraryError('Project manifest digest is invalid.');
      const manifest = parseProjectManifest(manifestBytes);
      if (manifest.projectId !== entry.projectId
        || manifest.projectKey !== entry.projectKey
        || manifest.snapshotKey !== entry.snapshotKey
        || manifest.revision !== entry.revision) {
        throw new CorruptLibraryError('Project manifest does not match its catalog entry.');
      }
      const { project, history } = await readProjectSnapshotDocuments(state, base);
      const recoveryState = manifest.recovery ? { reason: manifest.recovery.reason } : null;
      if (
        project.id !== entry.projectId
        || project.revision !== entry.revision
        || (recoveryState !== null && Object.hasOwn(project, 'recovery')
          && canonicalize(recoveryState) !== canonicalize(project.recovery))
        || history.past.length > ADMISSION_REGISTRY.limits.maxPersistedHistorySnapshotsPerDirection
        || history.future.length > ADMISSION_REGISTRY.limits.maxPersistedHistorySnapshotsPerDirection
      ) {
        throw new CorruptLibraryError('Project snapshot does not match its catalog entry.');
      }
      if (manifest.recovery?.recoveryId) {
        await validateProjectRecoveryEvidence(state, manifest.recovery);
      }
      projectReferences.set(entry.projectId, collectAssetReferences({ nodes: project.nodes, history }));
    } catch (error) {
      if (!(error instanceof CorruptLibraryError)) throw error;
      // Startup recovery preserves invalid snapshot bytes as a read-only fact.
    }
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
    await ensureNoSymlinkPath(state, managedPath(state, `assets/${entry.assetKey}`));
    const metadataBytes = await readCanonicalFile(
      state,
      managedPath(state, entry.metadataPath),
      'asset metadata',
      MAX_ASSET_METADATA_BYTES,
    );
    const metadata = parseAssetMetadataDocument(metadataBytes);
    validateAssetCatalogEntry(entry, metadata);
    if (metadata.metadata.lifecycleState === 'staging') {
      throw new CorruptLibraryError('Staging assets cannot be visible in a catalog.');
    }
    assetLifecycle.set(entry.assetId, metadata.metadata.lifecycleState);
    const bytesPath = managedPath(state, entry.bytesPath);
    await ensureNoSymlinkPath(state, bytesPath);
    const hashed = await hashFileBytes(state, bytesPath, entry.byteCount);
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

export async function readProjectSnapshotDocuments(state, base) {
  const project = parseProjectDocument(await readCanonicalFile(
    state,
    path.join(base, 'project.json'),
    'project snapshot',
    MAX_PROJECT_DOCUMENT_BYTES,
  ));
  const history = parseHistoryDocument(await readCanonicalFile(
    state,
    path.join(base, 'history.json'),
    'history snapshot',
    MAX_HISTORY_DOCUMENT_BYTES,
  ));
  return { project, history };
}

export {
  parseCommit,
  parseHead,
} from './catalogRecords.mjs';
export {
  parseLibraryManifest,
  parsePublish,
  parseQuarantineCleanup,
  parseQuarantineManifest,
  validatePublishPayloads,
} from './catalogRecords.mjs';
export {
  parseAssetMetadataDocument,
  parseHistoryDocument,
  parseProjectDocument,
  parseProjectManifest,
  validateProjectManifestRecovery,
  validateProjectRecoveryEvidence,
} from './snapshotDocuments.mjs';
export {
  isManagedCleanupPath,
  isManagedPublicationPath,
  isManagedQuarantineRetainedPath,
  parseCleanupPlan,
} from './cleanupPlans.mjs';
