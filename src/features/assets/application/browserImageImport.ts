import type {
  AssetId,
  AssetRepository,
} from '@/features/assets/domain/assetRepository';
import { getRuntimeAssetRepository } from '@/runtime/mediaRuntime';
import {
  createBrowserStorageCapacityGate,
  isQuotaExceededError,
  notifyBrowserStorageCapacityError,
  StorageCapacityError,
  type StorageCapacityGate,
} from '@/runtime/browserStorage';

export interface BrowserImageImportResult {
  assetId: AssetId;
  previewAssetId: null;
  imageUrl: null;
  previewImageUrl: null;
  aspectRatio: string;
  width: number;
  height: number;
  sourceFileName: string;
}

function reduceAspectRatio(width: number, height: number): string {
  let left = Math.max(1, Math.round(width));
  let right = Math.max(1, Math.round(height));
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return `${Math.round(width) / left}:${Math.round(height) / left}`;
}

export async function readBrowserImageDimensions(
  file: Blob,
  objectUrlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): Promise<{ width: number; height: number }> {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file);
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall back to the HTML image decoder for browsers with partial bitmap support.
    }
  }

  if (typeof Image === 'undefined') {
    throw new Error('Browser image decoding is unavailable.');
  }

  const objectUrl = objectUrlApi.createObjectURL(file);
  try {
    const image = new Image();
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('Unable to decode imported image.'));
      image.src = objectUrl;
    });
  } finally {
    objectUrlApi.revokeObjectURL(objectUrl);
  }
}

export async function importBrowserImageAsset(
  file: File,
  projectId: string,
  repository: AssetRepository,
  storageCapacityGate: StorageCapacityGate = createBrowserStorageCapacityGate(),
): Promise<BrowserImageImportResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files can be imported into the browser canvas.');
  }
  if (!projectId.trim()) {
    throw new Error('An active project is required before importing an image.');
  }

  try {
    await storageCapacityGate.assertCanWrite(file.size);
  } catch (error) {
    if (error instanceof StorageCapacityError) {
      notifyBrowserStorageCapacityError();
    }
    throw error;
  }
  const { width, height } = await readBrowserImageDimensions(file);
  let metadata;
  try {
    metadata = await repository.write({
      projectId,
      kind: 'image',
      sourceKind: 'import',
      blob: file,
      width,
      height,
      sourceMetadata: { fileName: file.name },
    });
  } catch (error) {
    if (isQuotaExceededError(error)) {
      notifyBrowserStorageCapacityError();
      throw new StorageCapacityError(
        'quota-exceeded',
        'Browser storage became full while saving this image. Remove media or make a backup, then try again.',
      );
    }
    throw error;
  }

  return {
    assetId: metadata.assetId,
    previewAssetId: null,
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: reduceAspectRatio(width, height),
    width,
    height,
    sourceFileName: file.name,
  };
}

export async function importRuntimeBrowserImageAsset(
  file: File,
  projectId: string,
): Promise<BrowserImageImportResult> {
  const repository = getRuntimeAssetRepository();
  if (!repository) {
    throw new Error('Browser asset storage is unavailable.');
  }
  return importBrowserImageAsset(file, projectId, repository);
}
