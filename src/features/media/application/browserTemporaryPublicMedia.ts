import type { AssetId, AssetRepository } from '@/features/assets/domain/assetRepository';
import type { TemporaryPublicMedia } from '@/features/media/domain/mediaProcessor';
import type { BrowserMediaGateway } from '@/features/media/infrastructure/browserMediaGateway';

export interface BrowserTemporaryPublicMediaRequest {
  assetId: AssetId;
  providerId: string;
  repository: Pick<AssetRepository, 'getMetadata' | 'read'>;
  gateway: Pick<BrowserMediaGateway, 'publish'>;
}

export async function prepareBrowserAssetTemporaryMedia({
  assetId,
  providerId,
  repository,
  gateway,
}: BrowserTemporaryPublicMediaRequest): Promise<TemporaryPublicMedia> {
  const metadata = await repository.getMetadata(assetId);
  if (!metadata || (metadata.kind !== 'audio' && metadata.kind !== 'video')) {
    throw new Error('The requested media asset is unavailable.');
  }
  const blob = await repository.read(assetId);
  if (!blob) {
    throw new Error('The requested media asset is unavailable.');
  }
  const fileName = typeof metadata.sourceMetadata.fileName === 'string'
    ? metadata.sourceMetadata.fileName
    : `${assetId}.${metadata.kind === 'video' ? 'mp4' : 'mp3'}`;
  const file = new File([blob], fileName, { type: metadata.mimeType || blob.type });
  return await gateway.publish(file, metadata.kind, providerId);
}
