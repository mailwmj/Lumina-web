import { downloadBrowserImage } from '@/features/assets/application/browserImageDownload';
import { writeBrowserDerivedImageAsset } from '@/features/assets/application/browserDerivedImage';
import type { AssetId, AssetRepository } from '@/features/assets/domain/assetRepository';
import { createBrowserStorageCapacityGate, type StorageCapacityGate } from '@/runtime/browserStorage';
import { createBatchCropResultFileName } from '../application/batchCropResultFileName';

export { createBatchCropResultFileName } from '../application/batchCropResultFileName';

export interface BrowserBatchCropResultInput {
  projectId: string;
  sourceFileName: string;
  target: { width: number; height: number };
  blob: Blob;
}

export interface BrowserBatchCropResult {
  assetId: AssetId;
  fileName: string;
}

export async function writeBrowserBatchCropResult(
  input: BrowserBatchCropResultInput,
  repository: Pick<AssetRepository, 'write'>,
  storageCapacityGate: StorageCapacityGate = createBrowserStorageCapacityGate(),
): Promise<BrowserBatchCropResult> {
  const fileName = createBatchCropResultFileName(input.sourceFileName, input.target);
  const result = await writeBrowserDerivedImageAsset({
    projectId: input.projectId,
    blob: input.blob,
    width: input.target.width,
    height: input.target.height,
    sourceMetadata: { fileName },
  }, repository as AssetRepository, storageCapacityGate);
  return { assetId: result.assetId, fileName };
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
