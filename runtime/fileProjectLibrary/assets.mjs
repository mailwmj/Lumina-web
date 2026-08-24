import { assertExpectedRevision, assertInputFields, collectAssetReferences, normalizeAssetInput, validateAssetCatalogEntry, validateAssetMetadata } from './admission.mjs';
import { parseAssetMetadataDocument } from './catalog.mjs';
import { CorruptLibraryError, DIGEST_PATTERN, FileProjectLibraryError, MAX_ASSET_METADATA_BYTES, MAX_DURABLE_ASSET_BYTES, canonicalize, compareUtf8, createHash, encoder, fs, makeLibraryKey, parseJsonString, path, randomUUID, sha256, validateLibraryKey, validateLogicalId } from './core.mjs';
import { ensureDirectory, ensureNoSymlinkPath, ensureParentDirectory, flushFile, managedPath, readCanonicalFile, readFileBytesBounded, syncDirectory } from './filesystem.mjs';
import { publishNextCatalog } from './publication.mjs';
import { readProjectSnapshot } from './projects.mjs';

export async function deleteProject(state, catalog, projectId, writeOptions = {}) {
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

export async function writeAsset(state, catalog, input, writeOptions = {}) {
  if (!writeOptions || typeof writeOptions !== 'object'
    || !Object.hasOwn(writeOptions, 'expectedCatalog')
    || !Object.hasOwn(writeOptions, 'expectedProjectRevision')) {
    throw new FileProjectLibraryError(
      'asset_precondition_required',
      'Asset writes require the catalog and owning project revisions that were observed by the caller.',
    );
  }
  const expectedCatalog = validateCatalogRevisionPrecondition(writeOptions.expectedCatalog);
  if (canonicalize(expectedCatalog) !== canonicalize(catalog.revision)) {
    throw new FileProjectLibraryError(
      'stale_catalog',
      'The library catalog changed since the asset write was prepared.',
      { actualCatalog: catalog.revision },
    );
  }
  const projectId = validateLogicalId(input?.projectId, 'projectId');
  const owner = catalog.commit.projects.find((entry) => entry.projectId === projectId);
  assertExpectedRevision(projectId, writeOptions.expectedProjectRevision, owner?.revision ?? 'absent');
  if (!owner) {
    throw new FileProjectLibraryError(
      'asset_owner_missing',
      'Asset writes require an existing owning project.',
      { projectId },
    );
  }
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

export async function stageBlobBytes(state, target, blob) {
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

export async function getAssetMetadata(state, catalog, assetId) {
  validateLogicalId(assetId, 'assetId');
  const entry = catalog.commit.assets.find((candidate) => candidate.assetId === assetId);
  if (!entry) return null;
  const metadataPath = managedPath(state, entry.metadataPath);
  await ensureNoSymlinkPath(state.root, metadataPath);
  const metadataDocument = parseAssetMetadataDocument(
    await readCanonicalFile(metadataPath, 'asset metadata', MAX_ASSET_METADATA_BYTES),
  );
  validateAssetCatalogEntry(entry, metadataDocument);
  return structuredClone(metadataDocument.metadata);
}

export async function readAsset(state, catalog, assetId) {
  validateLogicalId(assetId, 'assetId');
  const entry = catalog.commit.assets.find((candidate) => candidate.assetId === assetId);
  if (!entry) return null;
  const metadata = await getAssetMetadata(state, catalog, assetId);
  const bytesPath = managedPath(state, entry.bytesPath);
  await ensureNoSymlinkPath(state.root, bytesPath);
  const bytes = await readFileBytesBounded(bytesPath, entry.byteCount, 'asset bytes');
  if (bytes.byteLength !== entry.byteCount || sha256(bytes) !== entry.bytesSha256 || bytes.byteLength !== metadata.byteCount) {
    throw new CorruptLibraryError('Asset bytes failed integrity validation.');
  }
  return new Blob([bytes], { type: metadata.mimeType });
}

export async function listDeletionCandidates(state, catalog, projectId) {
  validateLogicalId(projectId, 'projectId');
  const result = [];
  for (const entry of catalog.commit.assets) {
    if (entry.projectId !== projectId) continue;
    const metadata = await getAssetMetadata(state, catalog, entry.assetId);
    if (metadata?.lifecycleState === 'deletion-candidate') result.push(metadata);
  }
  return result;
}

export async function projectAssetReferences(state, catalog, projectId) {
  const entry = catalog.commit.projects.find((candidate) => candidate.projectId === projectId);
  if (!entry) return new Set();
  const record = await readProjectSnapshot(state, entry);
  return collectAssetReferences({
    nodes: parseJsonString(record.nodesJson, 'nodes'),
    history: parseJsonString(record.historyJson, 'history'),
  });
}

export async function allLiveAssetReferences(state, catalog, excludedProjectId = null) {
  const references = new Set();
  for (const entry of catalog.commit.projects) {
    if (entry.projectId === excludedProjectId) continue;
    const projectReferences = await projectAssetReferences(state, catalog, entry.projectId);
    for (const assetId of projectReferences) references.add(assetId);
  }
  return references;
}

export async function deleteAsset(state, catalog, assetId, writeOptions = {}) {
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

export async function setDeletionCandidates(state, catalog, projectId, assetIds, writeOptions = {}) {
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

export async function getAssetLifecyclePrecondition(state, catalog, projectId) {
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

export function validateAssetLifecyclePrecondition(value, projectId) {
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

export function validateCatalogRevisionPrecondition(value) {
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

export async function stageAssetMetadata(state, metadata, assetKey, transactionId) {
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
