import {
  createBrowserStorageCapacityGate,
  notifyBrowserStorageCapacityError,
  type StorageCapacityGate,
} from '@/runtime/browserStorage';
import {
  assertNetworkAvailable,
  NetworkUnavailableError,
} from '@/runtime/networkAvailability';
import { runtime } from '@/runtime/runtime';

export interface GenerationSubmissionGuardOptions {
  estimatedOutputBytes: number;
  assertNetworkAvailable?: () => void;
  storageCapacityGate?: StorageCapacityGate;
}

export function estimateGenerationOutputBytes(size: string, outputCount = 1): number {
  const normalizedSize = size.trim().toUpperCase();
  const dimensions = normalizedSize === '4K'
    ? { width: 4096, height: 4096 }
    : normalizedSize === '2K'
      ? { width: 2048, height: 2048 }
      : normalizedSize === '1080P'
        ? { width: 1920, height: 1080 }
        : normalizedSize === '720P'
          ? { width: 1280, height: 720 }
          : { width: 1024, height: 1024 };
  const safeOutputCount = Math.max(1, Math.min(4, Math.floor(outputCount)));
  return dimensions.width * dimensions.height * 4 * safeOutputCount;
}

export async function assertGenerationSubmissionAllowed({
  estimatedOutputBytes,
  assertNetworkAvailable: assertNetwork = assertNetworkAvailable,
  storageCapacityGate = runtime.isDesktop() ? undefined : createBrowserStorageCapacityGate(),
}: GenerationSubmissionGuardOptions): Promise<void> {
  try {
    assertNetwork();
  } catch (error) {
    if (error instanceof NetworkUnavailableError) {
      throw error;
    }
    throw new NetworkUnavailableError();
  }
  try {
    await storageCapacityGate?.assertCanWrite(estimatedOutputBytes);
  } catch (error) {
    if (!runtime.isDesktop()) {
      notifyBrowserStorageCapacityError();
    }
    throw error;
  }
}
