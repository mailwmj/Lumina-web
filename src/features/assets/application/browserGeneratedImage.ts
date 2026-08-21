import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import {
  writeBrowserGeneratedAsset,
  type BrowserGeneratedAssetResult,
} from './browserGeneratedAsset';
import type { StorageCapacityGate } from '@/runtime/browserStorage';

export interface BrowserGeneratedImageInput {
  source: string;
  projectId: string;
  providerId: string;
  model: string;
}

export type BrowserGeneratedImageResult = BrowserGeneratedAssetResult;

/** Backward-compatible image specialization of the generic generated-asset writer. */
export async function writeBrowserGeneratedImage(
  input: BrowserGeneratedImageInput,
  repository: AssetRepository,
  storageCapacityGate?: StorageCapacityGate,
  fetchImpl?: typeof fetch,
): Promise<BrowserGeneratedImageResult> {
  return await writeBrowserGeneratedAsset(
    { ...input, kind: 'image' },
    repository,
    storageCapacityGate,
    fetchImpl,
  );
}
