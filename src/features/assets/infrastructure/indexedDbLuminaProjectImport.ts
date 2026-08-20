import type { WebDatabase } from '@/runtime/webDatabase';
import {
  createIndexedDbLuminaProjectImportPersistence,
  type LuminaProjectImportResult,
} from './indexedDbLuminaProjectImportPersistence';
import { verifyLuminaProjectArchive } from './luminaProjectImportArchive';
import { prepareLuminaProjectImport } from './luminaProjectImportPreparation';

export {
  LuminaProjectImportError,
  type LuminaProjectImportErrorCode,
} from './luminaProjectImportTypes';
export type { LuminaProjectImportResult } from './indexedDbLuminaProjectImportPersistence';

export interface ImportLuminaProjectArchiveOptions {
  archive: Blob;
  database: WebDatabase;
  now?: () => number;
}

export async function importLuminaProjectArchive({
  archive,
  database,
  now,
}: ImportLuminaProjectArchiveOptions): Promise<LuminaProjectImportResult> {
  const verifiedArchive = await verifyLuminaProjectArchive(archive);
  const preparedImport = prepareLuminaProjectImport(verifiedArchive);
  return createIndexedDbLuminaProjectImportPersistence(database).stageAndPublish(preparedImport, now);
}

export function cleanupLuminaImportStaging(database: WebDatabase): Promise<number> {
  return createIndexedDbLuminaProjectImportPersistence(database).cleanupStaging();
}
