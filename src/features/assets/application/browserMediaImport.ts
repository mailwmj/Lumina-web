import type { AssetId, AssetKind, AssetRepository } from '@/features/assets/domain/assetRepository';
import { createBrowserMediaGateway } from '@/features/media/infrastructure/browserMediaGateway';
import {
  createBrowserStorageCapacityGate,
  isQuotaExceededError,
  notifyBrowserStorageCapacityError,
  StorageCapacityError,
} from '@/runtime/browserStorage';
import { getRuntimeAssetRepository } from '@/runtime/mediaRuntime';

export type BrowserMediaKind = Extract<AssetKind, 'audio' | 'video'>;

export interface BrowserMediaMetadata {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export interface BrowserMediaImportResult {
  assetId: AssetId;
  mediaUrl: null;
  sourceFileName: string;
  sourceMimeType: string;
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export interface BrowserMediaImportOptions {
  readMetadata?: (file: File, kind: BrowserMediaKind) => Promise<BrowserMediaMetadata>;
  transcode?: (file: File, kind: BrowserMediaKind) => Promise<File>;
  assertCanWrite?: (byteCount: number) => Promise<void>;
}

const RELIABLE_MEDIA_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'video/mp4',
  'video/webm',
]);

function mediaKindForFile(file: File): BrowserMediaKind {
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  throw new Error('Only audio and video files can be imported into the browser canvas.');
}

function mediaElementFor(kind: BrowserMediaKind): HTMLAudioElement | HTMLVideoElement {
  return document.createElement(kind) as HTMLAudioElement | HTMLVideoElement;
}

export async function readBrowserMediaMetadata(
  file: File,
  kind: BrowserMediaKind,
  objectUrlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): Promise<BrowserMediaMetadata> {
  if (typeof document === 'undefined') {
    throw new Error('Browser media decoding is unavailable.');
  }
  const source = objectUrlApi.createObjectURL(file);
  const media = mediaElementFor(kind);
  media.preload = 'metadata';
  try {
    return await new Promise<BrowserMediaMetadata>((resolve, reject) => {
      media.onloadedmetadata = () => {
        const durationMs = Number.isFinite(media.duration) ? Math.round(media.duration * 1_000) : null;
        const video = kind === 'video' ? media as HTMLVideoElement : null;
        resolve({
          durationMs,
          width: video?.videoWidth || null,
          height: video?.videoHeight || null,
        });
      };
      media.onerror = () => reject(new Error('Unable to read imported media metadata.'));
      media.src = source;
    });
  } finally {
    media.removeAttribute('src');
    media.load();
    objectUrlApi.revokeObjectURL(source);
  }
}

async function assertCapacity(byteCount: number, assertCanWrite?: (byteCount: number) => Promise<void>): Promise<void> {
  try {
    await (assertCanWrite ?? createBrowserStorageCapacityGate().assertCanWrite)(byteCount);
  } catch (error) {
    if (error instanceof StorageCapacityError) {
      notifyBrowserStorageCapacityError();
    }
    throw error;
  }
}

function transcodeUnavailable(): Error {
  return new Error('This media format requires Gateway transcoding, which is not available.');
}

export async function importBrowserMediaAsset(
  file: File,
  projectId: string,
  repository: AssetRepository,
  options: BrowserMediaImportOptions = {},
): Promise<BrowserMediaImportResult> {
  const kind = mediaKindForFile(file);
  if (!projectId.trim()) {
    throw new Error('An active project is required before importing media.');
  }
  await assertCapacity(file.size, options.assertCanWrite);

  const readMetadata = options.readMetadata ?? readBrowserMediaMetadata;
  const sourceMimeType = file.type;
  let processedFile = file;
  let metadata: BrowserMediaMetadata;
  const requiresTranscode = !RELIABLE_MEDIA_MIME_TYPES.has(file.type.toLowerCase());
  try {
    if (requiresTranscode) {
      if (!options.transcode) throw transcodeUnavailable();
      processedFile = await options.transcode(file, kind);
      await assertCapacity(processedFile.size, options.assertCanWrite);
    }
    metadata = await readMetadata(processedFile, kind);
  } catch (error) {
    if (requiresTranscode || !options.transcode) {
      throw error;
    }
    processedFile = await options.transcode(file, kind);
    await assertCapacity(processedFile.size, options.assertCanWrite);
    metadata = await readMetadata(processedFile, kind);
  }

  let persisted;
  try {
    persisted = await repository.write({
      projectId,
      kind,
      sourceKind: 'import',
      blob: processedFile,
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
      sourceMetadata: {
        fileName: file.name,
        sourceMimeType,
      },
    });
  } catch (error) {
    if (isQuotaExceededError(error)) {
      notifyBrowserStorageCapacityError();
      throw new StorageCapacityError(
        'quota-exceeded',
        'Browser storage became full while saving this media. Remove media or make a backup, then try again.',
      );
    }
    throw error;
  }

  return {
    assetId: persisted.assetId,
    mediaUrl: null,
    sourceFileName: file.name,
    sourceMimeType,
    mimeType: processedFile.type,
    durationMs: metadata.durationMs,
    width: metadata.width,
    height: metadata.height,
  };
}

export async function importRuntimeBrowserMediaAsset(
  file: File,
  projectId: string,
): Promise<BrowserMediaImportResult> {
  const repository = getRuntimeAssetRepository();
  if (!repository) {
    throw new Error('Browser asset storage is unavailable.');
  }
  const gateway = createBrowserMediaGateway();
  return await importBrowserMediaAsset(file, projectId, repository, {
    transcode: gateway.transcode,
  });
}
