import {
  assertImport,
  importError,
  type LuminaArchiveAsset,
  type LuminaArchiveEntry,
  type LuminaArchiveManifest,
  type LuminaArchiveProject,
  type LuminaManifestEntry,
} from './luminaProjectImportTypes';

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, code: 'invalid_manifest' | 'invalid_path'): string {
  assertImport(typeof value === 'string' && value.length > 0, code);
  return value;
}

function requireFiniteNumber(value: unknown): number {
  assertImport(typeof value === 'number' && Number.isFinite(value), 'invalid_manifest');
  return value;
}

export function decodeLuminaArchiveJson(bytes: Uint8Array, code: 'invalid_manifest' | 'invalid_archive'): unknown {
  try {
    return JSON.parse(TEXT_DECODER.decode(bytes)) as unknown;
  } catch {
    return importError(code);
  }
}

function assertRange(bytes: Uint8Array, offset: number, length: number): void {
  assertImport(Number.isSafeInteger(offset) && Number.isSafeInteger(length), 'invalid_archive');
  assertImport(offset >= 0 && length >= 0 && offset + length <= bytes.byteLength, 'invalid_archive');
}

function decodePath(bytes: Uint8Array): string {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    return importError('invalid_path');
  }
}

function isArchivePath(path: string): boolean {
  return path === 'manifest.json'
    || /^projects\/\d{4}\/(project|history)\.json$/.test(path)
    || /^assets\/\d{4}\.bin$/.test(path);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const lowerBound = Math.max(0, bytes.byteLength - 0xffff - 22);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return importError('invalid_archive');
}

function readArchiveEntries(bytes: Uint8Array): Map<string, LuminaArchiveEntry> {
  assertImport(bytes.byteLength >= 22, 'invalid_archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  assertRange(bytes, endOffset, 22);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  assertImport(diskNumber === 0 && directoryDisk === 0 && entriesOnDisk === entryCount, 'invalid_archive');
  assertImport(endOffset + 22 + commentLength === bytes.byteLength, 'invalid_archive');
  assertRange(bytes, directoryOffset, directorySize);

  const entries = new Map<string, LuminaArchiveEntry>();
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, offset, 46);
    assertImport(view.getUint32(offset, true) === ZIP_CENTRAL_DIRECTORY_HEADER, 'invalid_archive');
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const pathLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const entryDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    assertImport(flags === 0 && compression === 0 && entryDisk === 0, 'invalid_archive');
    assertImport(compressedSize === uncompressedSize, 'invalid_archive');
    assertRange(bytes, offset + 46, pathLength + extraLength + entryCommentLength);
    const path = decodePath(bytes.subarray(offset + 46, offset + 46 + pathLength));
    assertImport(isArchivePath(path) && !entries.has(path), 'invalid_path');

    assertRange(bytes, localOffset, 30);
    assertImport(view.getUint32(localOffset, true) === ZIP_LOCAL_FILE_HEADER, 'invalid_archive');
    assertImport(view.getUint16(localOffset + 6, true) === flags, 'invalid_archive');
    assertImport(view.getUint16(localOffset + 8, true) === compression, 'invalid_archive');
    assertImport(view.getUint32(localOffset + 14, true) === crc32, 'invalid_archive');
    assertImport(view.getUint32(localOffset + 18, true) === compressedSize, 'invalid_archive');
    assertImport(view.getUint32(localOffset + 22, true) === uncompressedSize, 'invalid_archive');
    const localPathLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    assertImport(localPathLength === pathLength, 'invalid_archive');
    assertRange(bytes, localOffset + 30, localPathLength + localExtraLength + compressedSize);
    assertImport(
      decodePath(bytes.subarray(localOffset + 30, localOffset + 30 + localPathLength)) === path,
      'invalid_archive',
    );
    const dataOffset = localOffset + 30 + localPathLength + localExtraLength;
    entries.set(path, { path, bytes: bytes.slice(dataOffset, dataOffset + compressedSize) });
    offset += 46 + pathLength + extraLength + entryCommentLength;
  }
  assertImport(offset === directoryOffset + directorySize, 'invalid_archive');
  assertImport(entries.has('manifest.json'), 'invalid_manifest');
  return entries;
}

function parseSourceMetadata(value: unknown): Record<string, string | number | boolean | null> {
  assertImport(isRecord(value), 'invalid_manifest');
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    assertImport(
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null,
      'invalid_manifest',
    );
    metadata[key] = item;
  }
  return metadata;
}

function parseManifest(value: unknown): LuminaArchiveManifest {
  assertImport(isRecord(value), 'invalid_manifest');
  assertImport(value.format === 'lumina-project-export' && value.version === 1, 'unsupported_schema');
  assertImport(Array.isArray(value.projects) && Array.isArray(value.assets) && Array.isArray(value.entries), 'invalid_manifest');
  assertImport(value.projects.length > 0, 'invalid_manifest');
  const seenPaths = new Set<string>();
  const entries = value.entries.map((entry): LuminaManifestEntry => {
    assertImport(isRecord(entry), 'invalid_manifest');
    const path = requireString(entry.path, 'invalid_manifest');
    const byteCount = requireFiniteNumber(entry.byteCount);
    const sha256 = requireString(entry.sha256, 'invalid_manifest');
    assertImport(isArchivePath(path) && path !== 'manifest.json' && Number.isSafeInteger(byteCount) && byteCount >= 0, 'invalid_manifest');
    assertImport(/^[0-9a-f]{64}$/.test(sha256) && !seenPaths.has(path), 'invalid_manifest');
    seenPaths.add(path);
    return { path, byteCount, sha256 };
  });
  const seenProjects = new Set<string>();
  const seenProjectPaths = new Set<string>();
  const projects = value.projects.map((project): LuminaArchiveProject => {
    assertImport(isRecord(project), 'invalid_manifest');
    const id = requireString(project.id, 'invalid_manifest');
    const revision = requireString(project.revision, 'invalid_manifest');
    const projectPath = requireString(project.projectPath, 'invalid_manifest');
    const historyPath = requireString(project.historyPath, 'invalid_manifest');
    const projectDirectory = projectPath.slice(0, projectPath.lastIndexOf('/') + 1);
    assertImport(
      !seenProjects.has(id)
        && !seenProjectPaths.has(projectPath)
        && !seenProjectPaths.has(historyPath)
        && /^projects\/\d{4}\/project\.json$/.test(projectPath)
        && /^projects\/\d{4}\/history\.json$/.test(historyPath)
        && /^projects\/\d{4}\/$/.test(projectDirectory)
        && projectDirectory === historyPath.slice(0, historyPath.lastIndexOf('/') + 1)
        && seenPaths.has(projectPath)
        && seenPaths.has(historyPath),
      'invalid_manifest',
    );
    seenProjects.add(id);
    seenProjectPaths.add(projectPath);
    seenProjectPaths.add(historyPath);
    return { id, revision, projectPath, historyPath };
  });
  const seenAssets = new Set<string>();
  const seenAssetPaths = new Set<string>();
  const assets = value.assets.map((asset): LuminaArchiveAsset => {
    assertImport(isRecord(asset), 'invalid_manifest');
    const assetId = requireString(asset.assetId, 'invalid_manifest');
    const path = requireString(asset.path, 'invalid_manifest');
    const projectId = requireString(asset.projectId, 'invalid_manifest');
    const kind = asset.kind;
    const mimeType = requireString(asset.mimeType, 'invalid_manifest');
    const sourceKind = asset.sourceKind;
    const byteCount = requireFiniteNumber(asset.byteCount);
    const sha256 = requireString(asset.sha256, 'invalid_manifest');
    assertImport(kind === 'image' || kind === 'video' || kind === 'audio', 'invalid_manifest');
    assertImport(sourceKind === 'import' || sourceKind === 'generation' || sourceKind === 'derived', 'invalid_manifest');
    assertImport(
      !seenAssets.has(assetId)
        && !seenAssetPaths.has(path)
        && seenProjects.has(projectId)
        && /^assets\/\d{4}\.bin$/.test(path)
        && seenPaths.has(path)
        && Number.isSafeInteger(byteCount)
        && byteCount >= 0
        && /^[0-9a-f]{64}$/.test(sha256),
      'invalid_manifest',
    );
    seenAssets.add(assetId);
    seenAssetPaths.add(path);
    return {
      assetId,
      path,
      projectId,
      kind,
      mimeType,
      sourceKind,
      sourceMetadata: parseSourceMetadata(asset.sourceMetadata),
      byteCount,
      sha256,
    };
  });
  return { format: value.format, version: value.version, projects, assets, entries };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return importError('invalid_archive');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function assertArchiveType(archive: Blob): void {
  assertImport(archive.size > 0, 'invalid_archive_type');
  assertImport(
    !archive.type
      || archive.type === 'application/zip'
      || archive.type === 'application/x-zip-compressed'
      || archive.type === 'application/octet-stream',
    'invalid_archive_type',
  );
  const name = (archive as Blob & { name?: unknown }).name;
  assertImport(typeof name !== 'string' || name.toLowerCase().endsWith('.lumina'), 'invalid_archive_type');
}

export interface VerifiedLuminaProjectArchive {
  manifest: LuminaArchiveManifest;
  entries: ReadonlyMap<string, LuminaArchiveEntry>;
}

export async function verifyLuminaProjectArchive(archive: Blob): Promise<VerifiedLuminaProjectArchive> {
  assertArchiveType(archive);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await archive.arrayBuffer());
  } catch {
    return importError('invalid_archive');
  }
  const entries = readArchiveEntries(bytes);
  const manifest = parseManifest(decodeLuminaArchiveJson(entries.get('manifest.json')!.bytes, 'invalid_manifest'));
  assertImport(entries.size === manifest.entries.length + 1, 'entry_mismatch');
  const declarationsByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const declaration of manifest.entries) {
    const entry = entries.get(declaration.path);
    assertImport(entry && entry.bytes.byteLength === declaration.byteCount, 'entry_mismatch');
    assertImport(await sha256(entry.bytes) === declaration.sha256, 'checksum_mismatch');
  }
  for (const asset of manifest.assets) {
    const declaration = declarationsByPath.get(asset.path);
    assertImport(
      declaration?.byteCount === asset.byteCount && declaration.sha256 === asset.sha256,
      'checksum_mismatch',
    );
  }
  return { manifest, entries };
}
