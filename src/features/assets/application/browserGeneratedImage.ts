import type { AssetId, AssetRepository } from '@/features/assets/domain/assetRepository';
import i18n from '@/i18n';
import {
  createBrowserStorageCapacityGate,
  isQuotaExceededError,
  notifyBrowserStorageCapacityError,
  StorageCapacityError,
  type StorageCapacityGate,
} from '@/runtime/browserStorage';

export interface BrowserGeneratedImageResult {
  assetId: AssetId;
  mimeType: string;
  byteCount: number;
}

export interface BrowserGeneratedImageInput {
  source: string;
  projectId: string;
  providerId: string;
  model: string;
}

export async function writeBrowserGeneratedImage(
  input: BrowserGeneratedImageInput,
  repository: AssetRepository,
  storageCapacityGate: StorageCapacityGate = createBrowserStorageCapacityGate(),
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserGeneratedImageResult> {
  if (!input.projectId.trim()) {
    throw new Error(i18n.t('generationGateway.projectRequired'));
  }
  const response = await fetchImpl(input.source);
  if (!response.ok) {
    throw new Error(i18n.t('generationGateway.resultDownloadFailed', { status: response.status }));
  }
  const blob = await response.blob();
  await storageCapacityGate.assertCanWrite(blob.size);

  try {
    const metadata = await repository.write({
      projectId: input.projectId,
      kind: 'image',
      sourceKind: 'generation',
      blob,
      sourceMetadata: {
        providerId: input.providerId,
        model: input.model,
      },
    });
    return {
      assetId: metadata.assetId,
      mimeType: metadata.mimeType,
      byteCount: metadata.byteCount,
    };
  } catch (error) {
    if (isQuotaExceededError(error)) {
      notifyBrowserStorageCapacityError();
      throw new StorageCapacityError(
        'quota-exceeded',
        i18n.t('generationGateway.storageQuotaExceeded'),
      );
    }
    throw error;
  }
}
