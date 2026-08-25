export type AssetId = string;
export type AssetKind = 'image' | 'video' | 'audio';
export type AssetSourceKind = 'import' | 'generation' | 'derived';
export type AssetSourceMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface AssetWriteInput {
  projectId: string;
  kind: AssetKind;
  sourceKind: AssetSourceKind;
  blob: Blob;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  sourceMetadata?: AssetSourceMetadata;
}

export interface AssetMetadata {
  assetId: AssetId;
  projectId: string;
  kind: AssetKind;
  mimeType: string;
  byteCount: number;
  createdAt: number;
  sourceKind: AssetSourceKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sourceMetadata: AssetSourceMetadata;
}

export interface AssetRepository {
  /** Persists Blob bytes and returns their stable Runtime identity. */
  write(input: AssetWriteInput): Promise<AssetMetadata>;
  read(assetId: AssetId): Promise<Blob | null>;
  getMetadata(assetId: AssetId): Promise<AssetMetadata | null>;
  /** Deletes only when the current complete Runtime snapshot does not reference the asset. */
  delete(assetId: AssetId): Promise<void>;
  /** Acquires a shared Object URL lease for an asset. */
  hydrateObjectUrl(assetId: AssetId): Promise<string | null>;
  /** Releases one lease and revokes the Object URL after the final release. */
  releaseObjectUrl(assetId: AssetId): void;
}
