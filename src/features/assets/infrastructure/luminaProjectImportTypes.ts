import type {
  AssetKind,
  AssetSourceKind,
} from '@/features/assets/domain/assetRepository';

export type LuminaProjectImportErrorCode =
  | 'invalid_archive_type'
  | 'invalid_archive'
  | 'invalid_manifest'
  | 'invalid_path'
  | 'entry_mismatch'
  | 'checksum_mismatch'
  | 'unsupported_schema'
  | 'id_conflict';

export class LuminaProjectImportError extends Error {
  constructor(readonly code: LuminaProjectImportErrorCode) {
    super(code);
    this.name = 'LuminaProjectImportError';
  }
}

export function importError(code: LuminaProjectImportErrorCode): never {
  throw new LuminaProjectImportError(code);
}

export function assertImport(
  condition: unknown,
  code: LuminaProjectImportErrorCode,
): asserts condition {
  if (!condition) {
    importError(code);
  }
}

export interface LuminaArchiveEntry {
  path: string;
  bytes: Uint8Array;
}

export interface LuminaManifestEntry {
  path: string;
  byteCount: number;
  sha256: string;
}

export interface LuminaArchiveProject {
  id: string;
  revision: string;
  projectPath: string;
  historyPath: string;
}

export interface LuminaArchiveAsset {
  assetId: string;
  path: string;
  projectId: string;
  kind: AssetKind;
  mimeType: string;
  sourceKind: AssetSourceKind;
  sourceMetadata: Record<string, string | number | boolean | null>;
  byteCount: number;
  sha256: string;
}

export interface LuminaArchiveManifest {
  format: 'lumina-project-export';
  version: 1;
  projects: LuminaArchiveProject[];
  assets: LuminaArchiveAsset[];
  entries: LuminaManifestEntry[];
}
