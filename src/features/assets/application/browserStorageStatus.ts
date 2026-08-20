import type { BrowserStorageStatus } from '@/runtime/browserStorage';

export interface BrowserStorageStatusService {
  read(requestPersistence: boolean): Promise<BrowserStorageStatus>;
  subscribeToCapacityErrors(listener: () => void): () => void;
}
