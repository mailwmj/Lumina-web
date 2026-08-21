import type { AssetId, AssetKind, AssetRepository } from '@/features/assets/domain/assetRepository';
import i18n from '@/i18n';
import {
  createBrowserStorageCapacityGate,
  isQuotaExceededError,
  notifyBrowserStorageCapacityError,
  StorageCapacityError,
  type StorageCapacityGate,
} from '@/runtime/browserStorage';

export interface BrowserGeneratedAssetResult {
  assetId: AssetId;
  mimeType: string;
  byteCount: number;
}

export interface BrowserGeneratedAssetInput {
  source: string;
  projectId: string;
  providerId: string;
  model: string;
  kind: AssetKind;
}

function gatewayResultConfirmationPath(source: string): string | null {
  return /^\/api\/generation\/jobs\/[A-Za-z0-9-]{1,128}\/result$/.test(source)
    ? `${source}/confirmed`
    : null;
}

export async function writeBrowserGeneratedAsset(
  input: BrowserGeneratedAssetInput,
  repository: AssetRepository,
  storageCapacityGate: StorageCapacityGate = createBrowserStorageCapacityGate(),
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserGeneratedAssetResult> {
  if (!input.projectId.trim()) {
    throw new Error(i18n.t('generationGateway.projectRequired'));
  }
  let response: Response;
  try {
    response = await fetchImpl(input.source);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(i18n.t('generationGateway.corsRequired'));
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(i18n.t('generationGateway.resultDownloadFailed', { status: response.status }));
  }
  const blob = await response.blob();
  await storageCapacityGate.assertCanWrite(blob.size);

  try {
    const metadata = await repository.write({
      projectId: input.projectId,
      kind: input.kind,
      sourceKind: 'generation',
      blob,
      sourceMetadata: {
        providerId: input.providerId,
        model: input.model,
      },
    });
    const confirmationPath = gatewayResultConfirmationPath(input.source);
    if (confirmationPath) {
      await fetchImpl(confirmationPath, {
        method: 'POST',
        credentials: 'same-origin',
      }).catch(() => undefined);
    }
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
