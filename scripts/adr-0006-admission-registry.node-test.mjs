/* global URL */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
const acceptancePath = path.join(
  repositoryRoot,
  'docs',
  'adr',
  '0006-runtime-file-project-library',
  'acceptance.md',
);
const canvasNodesPath = path.join(repositoryRoot, 'src', 'features', 'canvas', 'domain', 'canvasNodes.ts');
const nanoBanana2Path = path.join(repositoryRoot, 'src', 'features', 'canvas', 'models', 'image', 'fal', 'nanoBanana2.ts');
const currentProjectFixturePath = path.join(
  repositoryRoot,
  'src',
  'features',
  'project',
  'infrastructure',
  'fixtures',
  'web-project-schema-v1.json',
);
const assetBackedFixturePath = path.join(
  repositoryRoot,
  'src',
  'features',
  'project',
  'infrastructure',
  'fixtures',
  'web-project-schema-v1-asset-backed.json',
);
const currentAssetRepositoryPath = path.join(repositoryRoot, 'runtime', 'fileProjectLibrary', 'library.mjs');
const currentZipPath = path.join(repositoryRoot, 'src', 'features', 'assets', 'application', 'storedZip.ts');
const currentBrowserMediaImportPath = path.join(repositoryRoot, 'src', 'features', 'assets', 'application', 'browserMediaImport.ts');
const currentGatewayPath = path.join(repositoryRoot, 'src', 'features', 'media', 'infrastructure', 'browserMediaGateway.ts');
const currentGatewayServerPath = path.join(repositoryRoot, 'gateway', 'server.mjs');
const currentVideoGenerationPath = path.join(repositoryRoot, 'src', 'features', 'canvas', 'application', 'videoGenerationResult.ts');
const currentCanvasPath = path.join(repositoryRoot, 'src', 'features', 'canvas', 'Canvas.tsx');

function propertyNameText(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function objectProperty(object, key) {
  const property = object.properties.find((member) => (
    ts.isPropertyAssignment(member) && propertyNameText(member.name) === key
  ));
  assert.ok(property, `missing ${key}`);
  return property.initializer;
}

function asObject(expression, label) {
  assert.ok(ts.isObjectLiteralExpression(expression), `${label} must be an object literal`);
  return expression;
}

function asArray(expression, label) {
  assert.ok(ts.isArrayLiteralExpression(expression), `${label} must be an array literal`);
  return expression;
}

function asString(expression, label) {
  assert.ok(ts.isStringLiteral(expression), `${label} must be a string literal`);
  return expression.text;
}

function variableObjectInitializer(sourceFile, variableName) {
  let initializer;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === variableName
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(initializer, `missing ${variableName} object initializer`);
  return initializer;
}

function parseJsonFixture(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertNoPersistedDisplayUrls(data, label) {
  for (const field of [
    'imageUrl',
    'videoUrl',
    'audioUrl',
    'previewImageUrl',
    'previewVideoUrl',
    'lastFrameImageUrl',
  ]) {
    assert.equal(Object.hasOwn(data, field), false, `${label} must omit ${field}`);
  }
}

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
    sourceMetadataKeys: 'allow-grammar-bound-scalars-only',
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
  const currentZip = fs.readFileSync(currentZipPath, 'utf8');
  const currentBrowserMediaImport = fs.readFileSync(currentBrowserMediaImportPath, 'utf8');
  const currentGateway = fs.readFileSync(currentGatewayPath, 'utf8');
  const currentGatewayServer = fs.readFileSync(currentGatewayServerPath, 'utf8');
  const currentVideoGeneration = fs.readFileSync(currentVideoGenerationPath, 'utf8');
  const currentCanvas = fs.readFileSync(currentCanvasPath, 'utf8');
  assert.match(currentAssetRepository, /if \(streamed\.byteCount !== metadata\.byteCount\)/u);
  assert.match(currentAssetRepository, /if \(byteCount > MAX_DURABLE_ASSET_BYTES\)/u);
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
  assert.deepEqual(registry.schemas.AssetSourceMetadata, {
    type: 'bounded-scalar-map',
    maxEntries: 'limits.maxSourceMetadataEntries',
    maxCanonicalUtf8Bytes: 'limits.maxAssetMetadataDocumentBytes',
    key: {
      pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$',
      normalization: 'preserve-exact',
      sensitiveNameNormalization: 'ascii-alnum-lowercase',
      sensitiveNameAction: 'reject',
    },
    value: {
      types: ['string', 'finite-number', 'boolean', 'null'],
      string: {
        maxUtf8Bytes: 'limits.maxSourceMetadataStringBytes',
        normalization: 'preserve-exact-after-secret-url-scan',
        credentialAction: 'reject',
      },
      'finite-number': {
        normalization: 'rfc8785-jcs-number--negative-zero-to-zero',
      },
      boolean: { normalization: 'preserve-exact' },
      null: { normalization: 'preserve-exact' },
    },
    nestedArrayOrObject: 'reject',
    unknownKeyOrValue: 'reject',
  });
});

test('ADR-0006 registry parses current model and persisted asset-backed fixtures', () => {
  const registry = parseJsonFixture(registryPath);
  const sourceFile = ts.createSourceFile(
    nanoBanana2Path,
    fs.readFileSync(nanoBanana2Path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.equal(sourceFile.parseDiagnostics.length, 0);

  const imageModel = variableObjectInitializer(sourceFile, 'imageModel');
  const extraParamsSchema = asArray(objectProperty(imageModel, 'extraParamsSchema'), 'extraParamsSchema');
  const thinkingLevel = extraParamsSchema.elements.find((element) => (
    ts.isObjectLiteralExpression(element)
    && asString(objectProperty(element, 'key'), 'extra parameter key') === 'thinking_level'
  ));
  const thinkingLevelObject = asObject(thinkingLevel, 'thinking_level schema');
  const thinkingOptions = asArray(objectProperty(thinkingLevelObject, 'options'), 'thinking_level options')
    .elements
    .map((option) => asString(objectProperty(asObject(option, 'thinking_level option'), 'value'), 'thinking_level option value'));
  const defaultExtraParams = asObject(objectProperty(imageModel, 'defaultExtraParams'), 'defaultExtraParams');

  assert.deepEqual(thinkingOptions, ['off', 'minimal', 'high']);
  assert.equal(asString(objectProperty(thinkingLevelObject, 'defaultValue'), 'thinking_level default'), 'off');
  assert.equal(asString(objectProperty(defaultExtraParams, 'thinking_level'), 'default thinking_level'), 'off');
  assert.deepEqual(registry.schemas.ProviderParams.fields.thinking_level.enum, thinkingOptions);

  const currentFixture = parseJsonFixture(currentProjectFixturePath);
  assert.equal(currentFixture.schemaVersion, 1);
  assert.doesNotThrow(() => JSON.parse(currentFixture.nodesJson));
  assert.doesNotThrow(() => JSON.parse(currentFixture.historyJson));

  const fixture = parseJsonFixture(assetBackedFixturePath);
  const nodes = JSON.parse(fixture.project.nodesJson);
  const history = JSON.parse(fixture.project.historyJson);
  const currentNode = nodes.nodes[0];
  const historyNode = history.past[0].nodes[0];
  const imageNodeFields = registry.nodeData.imageNode.fields;

  assert.equal(fixture.project.schemaVersion, 1);
  assert.equal(currentNode.type, 'imageNode');
  assert.equal(historyNode.type, 'imageNode');
  Object.keys(currentNode.data).forEach((field) => assert.ok(imageNodeFields[field], `current image node field ${field} must be registered`));
  Object.keys(historyNode.data).forEach((field) => assert.ok(imageNodeFields[field], `history image node field ${field} must be registered`));
  assert.equal(currentNode.data.assetId, fixture.asset.assetId);
  assert.equal(historyNode.data.assetId, fixture.asset.assetId);
  assert.equal(currentNode.data.extraParams.thinking_level, 'off');
  assert.equal(historyNode.data.extraParams.thinking_level, 'off');
  assertNoPersistedDisplayUrls(currentNode.data, 'current asset-backed node');
  assertNoPersistedDisplayUrls(historyNode.data, 'history asset-backed node');

  const sourceMetadata = fixture.asset.sourceMetadata;
  assert.equal(Object.keys(sourceMetadata).length, 4);
  for (const [key, value] of Object.entries(sourceMetadata)) {
    assert.match(key, /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u);
    assert.ok(
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null,
      `sourceMetadata.${key} must remain a scalar`,
    );
  }
  assert.deepEqual(sourceMetadata, {
    fileName: 'fixture.png',
    'workflow.version': 3,
    isReference: true,
    retained: null,
  });
});

test('ADR-0006 binds import allocation, command bodies, and reconciliation authorization', () => {
  const publication = fs.readFileSync(publicationPath, 'utf8');
  const acceptance = fs.readFileSync(acceptancePath, 'utf8');

  assert.match(publication, /Allocation and publication are distinct commands with distinct runtime-issued command IDs/u);
  assert.match(publication, /an import publication carries that allocation ID, operation ID/u);
  assert.match(publication, /The query duplicates `allocationId`, `operationId`, and `expectedCatalog`/u);
  assert.match(publication, /command_body_mismatch/u);
  assert.match(publication, /command_outcome_expired/u);
  assert.match(publication, /command_recovery_failed/u);
  assert.match(publication, /expectedRevision: 'absent'` against the resolved target project ID/u);
  assert.match(publication, /A retry\/restart never recomputes a suffix/u);
  assert.match(publication, /allocationId`, `operationId`, exact `requestSha256`, and original `expectedCatalog`/u);
  assert.match(publication, /An invalid\/expired proof, wrong session, or missing import\/reconcile authorization returns `authorization_denied`/u);
  assert.match(acceptance, /changed body for non-retryable `command_body_mismatch`/u);
  assert.match(acceptance, /wrong-allocation, or wrong-catalog attempts must return denial\/mismatch without exposing a receipt, state, or mapping/u);
});
