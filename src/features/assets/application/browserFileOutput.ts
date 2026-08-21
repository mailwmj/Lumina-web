import { createStoredZip } from './storedZip';

export interface BrowserOutputFileInput {
  id: string;
  fileName: string;
  blob: Blob;
}

export interface BrowserOutputFile {
  id: string;
  fileName: string;
  byteCount: number;
  sha256: string;
}

export interface BrowserFileOutputFailure {
  id: string;
  fileName: string;
  reason:
    | 'asset_read_failed'
    | 'asset_unavailable'
    | 'source_read_failed'
    | 'permission_denied'
    | 'write_failed';
}

export interface BrowserFileOutputResult {
  disposition: 'download' | 'zip-download' | 'directory' | 'cancelled' | 'unavailable';
  permission: 'granted' | 'denied' | 'not-requested' | 'unsupported';
  files: BrowserOutputFile[];
  failures: BrowserFileOutputFailure[];
}

interface BrowserDocumentLike {
  createElement(tagName: string): HTMLAnchorElement;
  body: { appendChild(element: HTMLAnchorElement): void };
}

interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface BrowserFileSystemDirectoryHandle {
  queryPermission?(descriptor?: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode: 'readwrite' }): Promise<PermissionState>;
  getFileHandle(
    fileName: string,
    options?: { create?: boolean },
  ): Promise<BrowserFileSystemFileHandle>;
}

interface BrowserFileSystemFileHandle {
  createWritable(): Promise<BrowserFileSystemWritableFileStream>;
}

interface BrowserFileSystemWritableFileStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface BrowserFileSystemAccess {
  showDirectoryPicker(): Promise<BrowserFileSystemDirectoryHandle>;
}

export interface BrowserFileOutputInput {
  intent: 'download' | 'directory';
  files: readonly BrowserOutputFileInput[];
  archiveFileName: string;
  forceArchive?: boolean;
  directory?: BrowserFileSystemDirectoryHandle;
}

export interface BrowserFileOutputEnvironment {
  documentRef?: BrowserDocumentLike;
  objectUrlApi?: ObjectUrlApi;
  fileSystemAccess?: BrowserFileSystemAccess | null;
}

type PreparedBrowserOutputFile = BrowserOutputFile & {
  bytes: Uint8Array;
  blob: Blob;
};

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function downloadBlob(
  blob: Blob,
  fileName: string,
  documentRef: BrowserDocumentLike,
  objectUrlApi: ObjectUrlApi,
): void {
  const objectUrl = objectUrlApi.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentRef.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    objectUrlApi.revokeObjectURL(objectUrl);
  }
}

function resolveDocument(documentRef: BrowserDocumentLike | undefined): BrowserDocumentLike {
  if (documentRef) {
    return documentRef;
  }
  if (typeof document === 'undefined') {
    throw new Error('Browser downloads require a document.');
  }
  return document;
}

function resolveObjectUrlApi(objectUrlApi: ObjectUrlApi | undefined): ObjectUrlApi {
  if (objectUrlApi) {
    return objectUrlApi;
  }
  return URL;
}

function browserFileSystemAccess(): BrowserFileSystemAccess | null {
  const browser = globalThis as typeof globalThis & Partial<BrowserFileSystemAccess>;
  const showDirectoryPicker = browser.showDirectoryPicker;
  return typeof showDirectoryPicker === 'function'
    ? { showDirectoryPicker: () => showDirectoryPicker.call(browser) }
    : null;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'NotFoundError';
}

function splitFileName(fileName: string): { stem: string; extension: string } {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot > 0
    ? { stem: fileName.slice(0, lastDot), extension: fileName.slice(lastDot) }
    : { stem: fileName, extension: '' };
}

function hasFileExtension(fileName: string): boolean {
  const { stem, extension } = splitFileName(fileName);
  return Boolean(stem && extension.length > 1);
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/avif': return 'avif';
    case 'image/gif': return 'gif';
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/svg+xml': return 'svg';
    case 'image/webp': return 'webp';
    case 'video/mp4': return 'mp4';
    case 'video/quicktime': return 'mov';
    case 'video/webm': return 'webm';
    case 'audio/mpeg': return 'mp3';
    case 'audio/ogg': return 'ogg';
    case 'audio/wav': return 'wav';
    case 'application/zip': return 'zip';
    default: return 'bin';
  }
}

export function resolveBrowserOutputFileName(fileName: string, mimeType: string): string {
  const normalized = fileName.trim() || 'output';
  return hasFileExtension(normalized)
    ? normalized
    : `${normalized}.${extensionForMimeType(mimeType)}`;
}

function resolveUniqueOutputFileNames(
  files: readonly PreparedBrowserOutputFile[],
): PreparedBrowserOutputFile[] {
  const usedFileNames = new Set<string>();
  return files.map((file) => {
    const { stem, extension } = splitFileName(file.fileName);
    let suffix = 1;
    let fileName = file.fileName;
    while (usedFileNames.has(fileName)) {
      suffix += 1;
      fileName = `${stem} (${suffix})${extension}`;
    }
    usedFileNames.add(fileName);
    return fileName === file.fileName ? file : { ...file, fileName };
  });
}

async function resolveAvailableFileName(
  directory: BrowserFileSystemDirectoryHandle,
  requestedFileName: string,
): Promise<string> {
  const { stem, extension } = splitFileName(requestedFileName);
  let suffix = 1;
  while (true) {
    const candidate = suffix === 1 ? requestedFileName : `${stem} (${suffix})${extension}`;
    try {
      await directory.getFileHandle(candidate);
      suffix += 1;
    } catch (error) {
      if (isNotFoundError(error)) {
        return candidate;
      }
      throw error;
    }
  }
}

async function ensureDirectoryWritePermission(
  directory: BrowserFileSystemDirectoryHandle,
): Promise<'granted' | 'denied'> {
  try {
    const descriptor = { mode: 'readwrite' as const };
    const current = await directory.queryPermission?.(descriptor) ?? 'prompt';
    if (current === 'granted') {
      return 'granted';
    }
    const requested = await directory.requestPermission?.(descriptor) ?? 'denied';
    return requested === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

async function saveFilesToDirectory(
  files: readonly PreparedBrowserOutputFile[],
  directory: BrowserFileSystemDirectoryHandle,
): Promise<Pick<BrowserFileOutputResult, 'files' | 'failures'>> {
  const saved: BrowserOutputFile[] = [];
  const failures: BrowserFileOutputFailure[] = [];

  // Sequential writes preserve selection order and make collision names deterministic.
  for (const file of files) {
    let resolvedFileName = file.fileName;
    try {
      resolvedFileName = await resolveAvailableFileName(directory, file.fileName);
      const fileHandle = await directory.getFileHandle(resolvedFileName, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(file.blob);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
      saved.push({ ...file, fileName: resolvedFileName });
    } catch {
      failures.push({ id: file.id, fileName: resolvedFileName, reason: 'write_failed' });
    }
  }

  return { files: saved, failures };
}

function downloadPreparedFiles(
  files: readonly PreparedBrowserOutputFile[],
  archiveFileName: string,
  documentRef: BrowserDocumentLike | undefined,
  objectUrlApi: ObjectUrlApi | undefined,
  forceArchive = false,
): BrowserFileOutputResult {
  if (files.length === 0) {
    throw new Error('At least one browser output file is required.');
  }
  const namedFiles = resolveUniqueOutputFileNames(files);
  const resolvedDocument = resolveDocument(documentRef);
  const resolvedObjectUrlApi = resolveObjectUrlApi(objectUrlApi);
  if (namedFiles.length === 1 && !forceArchive) {
    const [file] = namedFiles;
    if (!file) {
      throw new Error('At least one browser output file is required.');
    }
    downloadBlob(file.blob, file.fileName, resolvedDocument, resolvedObjectUrlApi);
    return {
      disposition: 'download',
      permission: 'not-requested',
      files: namedFiles.map(({ blob: _blob, bytes: _bytes, ...fileOutput }) => fileOutput),
      failures: [],
    };
  }

  const archive = createStoredZip(namedFiles.map((file) => ({
    path: file.fileName,
    bytes: file.bytes,
  })));
  downloadBlob(archive, archiveFileName, resolvedDocument, resolvedObjectUrlApi);
  return {
    disposition: 'zip-download',
    permission: 'not-requested',
    files: namedFiles.map(({ blob: _blob, bytes: _bytes, ...fileOutput }) => fileOutput),
    failures: [],
  };
}

export async function outputBrowserFiles(
  input: BrowserFileOutputInput,
  {
    documentRef,
    objectUrlApi,
    fileSystemAccess = browserFileSystemAccess(),
  }: BrowserFileOutputEnvironment = {},
): Promise<BrowserFileOutputResult> {
  const files = await Promise.all(input.files.map(async (file) => ({
    id: file.id,
    fileName: file.fileName,
    byteCount: file.blob.size,
    sha256: await sha256(file.blob),
    bytes: new Uint8Array(await file.blob.arrayBuffer()),
    blob: file.blob,
  })));

  if (files.length === 0) {
    return {
      disposition: 'unavailable',
      permission: 'not-requested',
      files: [],
      failures: [],
    };
  }

  if (input.intent === 'download') {
    return downloadPreparedFiles(
      files,
      input.archiveFileName,
      documentRef,
      objectUrlApi,
      input.forceArchive,
    );
  }

  if (!input.directory && !fileSystemAccess) {
    const fallback = downloadPreparedFiles(
      files,
      input.archiveFileName,
      documentRef,
      objectUrlApi,
      input.forceArchive,
    );
    return {
      ...fallback,
      permission: 'unsupported',
    };
  }

  let directory = input.directory;
  if (!directory) {
    try {
      directory = await fileSystemAccess!.showDirectoryPicker();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'name' in error
        && (error as { name?: unknown }).name === 'AbortError') {
        return { disposition: 'cancelled', permission: 'not-requested', files: [], failures: [] };
      }
      return {
        disposition: 'directory',
        permission: 'denied',
        files: [],
        failures: files.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          reason: 'permission_denied' as const,
        })),
      };
    }
  }

  const permission = await ensureDirectoryWritePermission(directory);
  if (permission === 'denied') {
    return {
      disposition: 'directory',
      permission,
      files: [],
      failures: files.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        reason: 'permission_denied' as const,
      })),
    };
  }

  const result = await saveFilesToDirectory(files, directory);
  return { disposition: 'directory', permission, ...result };
}
