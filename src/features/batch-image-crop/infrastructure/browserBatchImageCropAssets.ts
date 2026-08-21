import { downloadBrowserImage } from '@/features/assets/application/browserImageDownload';
import type { AssetId, AssetRepository } from '@/features/assets/domain/assetRepository';
import {
  createBrowserStorageCapacityGate,
  isQuotaExceededError,
  notifyBrowserStorageCapacityError,
  StorageCapacityError,
  type StorageCapacityGate,
} from '@/runtime/browserStorage';

export interface BrowserBatchCropResultInput {
  batchId: string;
  sourceFileName: string;
  target: { width: number; height: number };
  blob: Blob;
}

export interface BrowserBatchCropResult {
  assetId: AssetId;
  fileName: string;
}

const batchAssetIds = new Map<string, Set<AssetId>>();

function normalizedStem(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const stem = (lastDot > 0 ? fileName.slice(0, lastDot) : fileName).trim();
  const safe = [...stem]
    .map((character) => (character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character))
    .join('')
    .replace(/^[_ .]+|[_ .]+$/g, '');
  return safe || 'image';
}

export function createBatchCropResultFileName(
  sourceFileName: string,
  target: { width: number; height: number },
): string {
  return `${normalizedStem(sourceFileName)}_${target.width}x${target.height}.jpg`;
}

export async function writeBrowserBatchCropResult(
  input: BrowserBatchCropResultInput,
  repository: Pick<AssetRepository, 'write'>,
  storageCapacityGate: StorageCapacityGate = createBrowserStorageCapacityGate(),
): Promise<BrowserBatchCropResult> {
  await storageCapacityGate.assertCanWrite(input.blob.size);
  const fileName = createBatchCropResultFileName(input.sourceFileName, input.target);
  try {
    const metadata = await repository.write({
      projectId: `batch-image-crop:${input.batchId}`,
      kind: 'image',
      sourceKind: 'derived',
      blob: input.blob,
      width: input.target.width,
      height: input.target.height,
      sourceMetadata: { fileName },
    });
    const assetIds = batchAssetIds.get(input.batchId) ?? new Set<AssetId>();
    assetIds.add(metadata.assetId);
    batchAssetIds.set(input.batchId, assetIds);
    return { assetId: metadata.assetId, fileName };
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
}

export async function cleanupBrowserBatchCropResults(
  batchId: string,
  repository: Pick<AssetRepository, 'delete' | 'releaseObjectUrl'>,
): Promise<void> {
  const assetIds = batchAssetIds.get(batchId);
  if (!assetIds) return;
  batchAssetIds.delete(batchId);
  await Promise.all([...assetIds].map(async (assetId) => {
    repository.releaseObjectUrl(assetId);
    await repository.delete(assetId);
  }));
}

export async function downloadBrowserBatchCropResult(
  assetId: AssetId,
  fileName: string,
  repository: Pick<AssetRepository, 'hydrateObjectUrl' | 'releaseObjectUrl'>,
  download: typeof downloadBrowserImage = downloadBrowserImage,
): Promise<void> {
  const source = await repository.hydrateObjectUrl(assetId);
  if (!source) {
    throw new Error('Image source is unavailable for download.');
  }
  try {
    download(source, fileName);
  } finally {
    repository.releaseObjectUrl(assetId);
  }
}
