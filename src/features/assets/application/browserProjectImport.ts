import { getWebDatabase, type WebDatabase } from '@/runtime/webDatabase';
import {
  createBrowserStorageCapacityGate,
  isQuotaExceededError,
  notifyBrowserStorageCapacityError,
  StorageCapacityError,
  type StorageCapacityGate,
} from '@/runtime/browserStorage';
import {
  cleanupLuminaImportStaging,
  importLuminaProjectArchive,
  type LuminaProjectImportResult,
} from '@/features/assets/infrastructure/indexedDbLuminaProjectImport';

export interface BrowserProjectImportService {
  import(archive: File): Promise<LuminaProjectImportResult>;
  cleanupStaging(): Promise<number>;
}

export interface BrowserProjectImportOptions {
  storageCapacityGate?: StorageCapacityGate;
}

export function createBrowserProjectImportService(
  database: WebDatabase = getWebDatabase(),
  { storageCapacityGate = createBrowserStorageCapacityGate() }: BrowserProjectImportOptions = {},
): BrowserProjectImportService {
  return {
    import: async (archive) => {
      try {
        await storageCapacityGate.assertCanWrite(archive.size);
      } catch (error) {
        if (error instanceof StorageCapacityError) {
          notifyBrowserStorageCapacityError();
        }
        throw error;
      }
      try {
        return await importLuminaProjectArchive({ archive, database });
      } catch (error) {
        if (isQuotaExceededError(error)) {
          notifyBrowserStorageCapacityError();
          throw new StorageCapacityError(
            'quota-exceeded',
            'Browser storage became full while importing this archive.',
          );
        }
        throw error;
      }
    },
    cleanupStaging: () => cleanupLuminaImportStaging(database),
  };
}
