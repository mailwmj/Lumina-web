import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const registryPath = path.join(
  repositoryRoot,
  'docs',
  'adr',
  '0006-runtime-file-project-library',
  'admission-registry-v1.json',
);
const schemaPath = path.join(
  repositoryRoot,
  'docs',
  'adr',
  '0006-runtime-file-project-library',
  'library-schema.md',
);
const publicationPath = path.join(
  repositoryRoot,
  'docs',
  'adr',
  '0006-runtime-file-project-library',
  'publication-and-import.md',
);
const canvasNodesPath = path.join(repositoryRoot, 'src', 'features', 'canvas', 'domain', 'canvasNodes.ts');
const currentAssetRepositoryPath = path.join(repositoryRoot, 'src', 'features', 'assets', 'infrastructure', 'indexedDbAssetRepository.ts');
const currentArchiveVerifierPath = path.join(repositoryRoot, 'src', 'features', 'assets', 'infrastructure', 'luminaProjectImportArchive.ts');
const currentZipPath = path.join(repositoryRoot, 'src', 'features', 'assets', 'application', 'storedZip.ts');
const currentBrowserMediaImportPath = path.join(repositoryRoot, 'src', 'features', 'assets', 'application', 'browserMediaImport.ts');
const currentGatewayPath = path.join(repositoryRoot, 'src', 'features', 'media', 'infrastructure', 'browserMediaGateway.ts');
const currentGatewayServerPath = path.join(repositoryRoot, 'gateway', 'server.mjs');
const currentVideoGenerationPath = path.join(repositoryRoot, 'src', 'features', 'canvas', 'application', 'videoGenerationResult.ts');
const currentCanvasPath = path.join(repositoryRoot, 'src', 'features', 'canvas', 'Canvas.tsx');

test('ADR-0006 admission registry keeps durable, archive, transfer, and Gateway media limits distinct', () => {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const publication = fs.readFileSync(publicationPath, 'utf8');

  assert.equal(registry.format, 'lumina-project-admission-registry');
  assert.equal(registry.version, 1);
  assert.equal(registry.canonicalization, 'RFC8785-JCS-SHA256-v1');
  assert.deepEqual(registry.unknownFieldPolicy, {
    objects: 'reject',
    nodeTypes: 'reject',
    sourceMetadataKeys: 'reject',
    providerParameterKeys: 'reject',
    error: 'project_secret_admission_failed',
  });

  assert.equal(registry.limits.maxDurableLibraryAssetBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(registry.limits.maxProjectRecordsPerImport, 64);
  assert.equal(registry.limits.maxAssetsPerImport, 256);
  assert.equal(registry.limits.maxAggregateAssetBytesPerImport, 6 * 1024 * 1024 * 1024);
  assert.equal(registry.limits.maxRuntimeStreamedArchiveEnvelopeBytes, 8 * 1024 * 1024 * 1024);
  assert.equal(registry.limits.maxBrowserBufferedArchiveEnvelopeBytes, 512 * 1024 * 1024);
  assert.equal(registry.limits.maxBrowserMigrationTransferAggregateBytes, 8 * 1024 * 1024 * 1024);
  assert.equal(registry.limits.maxAssetMetadataDocumentBytes, 64 * 1024);
  assert.equal(registry.limits.maxArchiveManifestBytes, 4 * 1024 * 1024);
  assert.equal(registry.limits.maxProjectDocumentBytes, 4 * 1024 * 1024);
  assert.equal(registry.limits.maxHistoryDocumentBytes, 16 * 1024 * 1024);
  assert.equal(registry.limits.maxTransferJsonPayloadBytes, 1024 * 1024);
  assert.equal(registry.limits.maxTransferChunkPayloadBytes, 4 * 1024 * 1024);
  assert.equal(registry.limits.maxTransferHeaderBytes, 64 * 1024);
  assert.equal(
    registry.limits.maxTransferFrameBytes,
    registry.limits.maxTransferChunkPayloadBytes + registry.limits.maxTransferHeaderBytes,
  );
  assert.equal(registry.limits.maxGatewayTemporaryMediaBytes, 64 * 1024 * 1024);
  assert.equal(
    registry.limits.maxAggregateAssetBytesPerImport / registry.limits.maxDurableLibraryAssetBytes,
    3,
  );
  assert.ok(
    registry.limits.maxAggregateAssetBytesPerImport
      + registry.limits.maxProjectRecordsPerImport
        * (registry.limits.maxProjectDocumentBytes + registry.limits.maxHistoryDocumentBytes)
      + registry.limits.maxAssetsPerImport * registry.limits.maxAssetMetadataDocumentBytes
      + registry.limits.maxArchiveManifestBytes
      < registry.limits.maxRuntimeStreamedArchiveEnvelopeBytes,
  );
  assert.equal(registry.limitSemantics.maxGatewayTemporaryMediaBytes.isDurableLibraryLimit, false);
  assert.deepEqual(registry.archiveContainerSemantics, {
    legacyBrowserVerifier: {
      acceptedContainer: 'zip32',
      reader: 'whole-blob-array-buffer',
      maxEnvelopeLimit: 'maxBrowserBufferedArchiveEnvelopeBytes',
    },
    targetRuntime: {
      acceptedContainers: ['zip32', 'zip64'],
      reader: 'stream-every-entry',
      maxEnvelopeLimit: 'maxRuntimeStreamedArchiveEnvelopeBytes',
      zip64RequiredAboveBytes: 0xffffffff,
    },
  });
  assert.equal(registry.limitErrorCodes.durableAsset, 'asset_too_large');
  assert.equal(registry.limitErrorCodes.mediaType, 'unsupported_media_type');

  assert.deepEqual(registry.media, {
    mimeGrammar: '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$',
    parameters: 'reject',
    normalization: 'ascii-lowercase-exact',
    fallback: {
      empty: 'reject-unsupported_media_type',
      'application/octet-stream': 'reject-unsupported_media_type',
      kindMismatch: 'reject-unsupported_media_type',
      notAllowlisted: 'reject-unsupported_media_type',
      gatewayTranscode: 'not-a-durable-library-admission-fallback',
    },
    allowlist: {
      image: ['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'],
      audio: ['audio/aac', 'audio/flac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/x-wav'],
      video: ['video/avi', 'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm', 'video/x-matroska'],
    },
  });

  assert.match(schema, /\[`admission-registry-v1\.json`\]\(\.\/admission-registry-v1\.json\)/u);
  assert.match(schema, /not to an IndexedDB Blob, a durable file-library asset, a `\.lumina` archive, or a browser-to-runtime migration frame/u);
  assert.match(schema, /ZIP32 or ZIP64 container/u);
  assert.match(schema, /ZIP64 and must stream every entry/u);
  assert.match(schema, /<runtime li_<namespace>_<sequence> ID>/u);
  assert.doesNotMatch(schema, /client-generated lowercase UUID v4/u);
  assert.match(publication, /runtime-allocated `operationId`/u);
  assert.doesNotMatch(publication, /client `operationId`/u);
  assert.match(publication, /videoGenerationResult\.deleteCreatedAssets\(\)/u);
  assert.match(publication, /failed canvas-media-import `deleteAsset` callback/u);

  const currentAssetRepository = fs.readFileSync(currentAssetRepositoryPath, 'utf8');
  const currentArchiveVerifier = fs.readFileSync(currentArchiveVerifierPath, 'utf8');
  const currentZip = fs.readFileSync(currentZipPath, 'utf8');
  const currentBrowserMediaImport = fs.readFileSync(currentBrowserMediaImportPath, 'utf8');
  const currentGateway = fs.readFileSync(currentGatewayPath, 'utf8');
  const currentGatewayServer = fs.readFileSync(currentGatewayServerPath, 'utf8');
  const currentVideoGeneration = fs.readFileSync(currentVideoGenerationPath, 'utf8');
  const currentCanvas = fs.readFileSync(currentCanvasPath, 'utf8');
  assert.match(currentAssetRepository, /byteCount: input\.blob\.size/u);
  assert.match(currentArchiveVerifier, /new Uint8Array\(await archive\.arrayBuffer\(\)\)/u);
  assert.match(currentZip, /const ZIP_MAX_UINT32 = 0xffffffff;/u);
  assert.match(currentBrowserMediaImport, /const requiresTranscode = !RELIABLE_MEDIA_MIME_TYPES\.has\(file\.type\.toLowerCase\(\)\);/u);
  assert.match(currentGateway, /const MAX_MEDIA_BYTES = 64 \* 1024 \* 1024;/u);
  assert.match(currentGatewayServer, /LUMINA_GATEWAY_MAX_MEDIA_BYTES', 64 \* 1024 \* 1024/u);
  assert.match(currentVideoGeneration, /repository\.delete\(asset\.assetId\)/u);
  assert.match(currentCanvas, /await repository\.delete\(assetId\)/u);

  const canvasNodes = fs.readFileSync(canvasNodesPath, 'utf8');
  const canvasNodeBlock = canvasNodes.split('export const CANVAS_NODE_TYPES = {', 2)[1].split('} as const;', 2)[0];
  const currentNodeTypes = [...canvasNodeBlock.matchAll(/^\s+\w+:\s+'([^']+)'/gmu)].map((match) => match[1]);
  assert.deepEqual(registry.schemas.CanvasNode.fields.type.enum, currentNodeTypes);
  currentNodeTypes.forEach((nodeType) => assert.ok(registry.nodeData[nodeType], `${nodeType} must have a field registry`));
  assert.deepEqual(Object.keys(registry.schemas.AssetMetadata.fields), [
    'assetId', 'projectId', 'kind', 'mimeType', 'byteCount', 'createdAt', 'sourceKind', 'width', 'height', 'durationMs', 'sourceMetadata', 'lifecycleState',
  ]);
  assert.deepEqual(Object.keys(registry.schemas.AssetSourceMetadata.fields), [
    'fileName', 'sourceMimeType', 'providerId', 'model', 'storyboardMetadata',
  ]);
  assert.equal(registry.schemas.AssetSourceMetadata.fields.storyboardMetadata.type, 'json-string<StoryboardMetadataJson>');
});
