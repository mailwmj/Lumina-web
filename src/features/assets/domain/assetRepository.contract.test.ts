import type {
  AssetId,
  AssetMetadata,
  AssetRepository,
  AssetWriteInput,
} from './assetRepository';
import { defineAssetRepositoryContract } from './assetRepositoryContract';

interface StoredAsset {
  blob: Blob;
  metadata: AssetMetadata;
}

class InMemoryAssetRepository implements AssetRepository {
  private readonly assets = new Map<AssetId, StoredAsset>();
  private readonly objectUrls = new Map<AssetId, { url: string; leases: number }>();
  private nextAssetId = 1;
  private nextObjectUrl = 1;

  async write(input: AssetWriteInput): Promise<AssetMetadata> {
    const assetId = `asset-${this.nextAssetId}`;
    this.nextAssetId += 1;
    const metadata: AssetMetadata = {
      assetId,
      projectId: input.projectId,
      kind: input.kind,
      mimeType: input.blob.type,
      byteCount: input.blob.size,
      createdAt: Date.now(),
      sourceKind: input.sourceKind,
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs: input.durationMs ?? null,
      sourceMetadata: input.sourceMetadata ?? {},
    };
    this.assets.set(assetId, { blob: input.blob, metadata });
    return structuredClone(metadata);
  }

  async read(assetId: AssetId): Promise<Blob | null> {
    return this.assets.get(assetId)?.blob ?? null;
  }

  async getMetadata(assetId: AssetId): Promise<AssetMetadata | null> {
    const metadata = this.assets.get(assetId)?.metadata;
    return metadata ? structuredClone(metadata) : null;
  }

  async delete(assetId: AssetId): Promise<void> {
    this.objectUrls.delete(assetId);
    this.assets.delete(assetId);
  }

  async hydrateObjectUrl(assetId: AssetId): Promise<string | null> {
    if (!this.assets.has(assetId)) {
      return null;
    }
    const current = this.objectUrls.get(assetId);
    if (current) {
      current.leases += 1;
      return current.url;
    }
    const url = `blob:test-${this.nextObjectUrl}`;
    this.nextObjectUrl += 1;
    this.objectUrls.set(assetId, { url, leases: 1 });
    return url;
  }

  releaseObjectUrl(assetId: AssetId): void {
    const current = this.objectUrls.get(assetId);
    if (!current) {
      return;
    }
    current.leases -= 1;
    if (current.leases <= 0) {
      this.objectUrls.delete(assetId);
    }
  }
}

defineAssetRepositoryContract('in-memory', () => new InMemoryAssetRepository());
