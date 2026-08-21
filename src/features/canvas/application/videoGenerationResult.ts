import {
  writeBrowserGeneratedAsset,
  type BrowserGeneratedAssetResult,
} from '@/features/assets/application/browserGeneratedAsset';
import type { AssetId, AssetRepository } from '@/features/assets/domain/assetRepository';

export interface PersistBrowserVideoGenerationAssetsInput {
  projectId: string;
  providerId: string;
  model: string;
  result: string;
  preview?: string | null;
  lastFrame?: string | null;
  repository: AssetRepository;
  isCurrent: () => boolean;
  /** Injected by tests; production uses the browser asset writer. */
  writeAsset?: typeof writeBrowserGeneratedAsset;
}

export type PersistBrowserVideoGenerationAssetsResult =
  | {
    stale: false;
    videoAssetId: AssetId;
    previewAssetId: AssetId | null;
    lastFrameAssetId: AssetId | null;
  }
  | { stale: true };

async function deleteCreatedAssets(
  repository: AssetRepository,
  assets: readonly BrowserGeneratedAssetResult[],
): Promise<void> {
  await Promise.all(assets.map((asset) => repository.delete(asset.assetId).catch(() => undefined)));
}

/** Writes all returned video media, and removes any partial result after a stale/cancelled task. */
export async function persistBrowserVideoGenerationAssets(
  input: PersistBrowserVideoGenerationAssetsInput,
): Promise<PersistBrowserVideoGenerationAssetsResult> {
  const writeAsset = input.writeAsset ?? writeBrowserGeneratedAsset;
  const created: BrowserGeneratedAssetResult[] = [];
  const write = async (
    source: string,
    kind: 'video' | 'image',
  ): Promise<BrowserGeneratedAssetResult> => {
    const asset = await writeAsset({
      source,
      projectId: input.projectId,
      providerId: input.providerId,
      model: input.model,
      kind,
    }, input.repository);
    created.push(asset);
    return asset;
  };

  try {
    if (!input.isCurrent()) {
      return { stale: true };
    }
    const video = await write(input.result, 'video');
    if (!input.isCurrent()) {
      await deleteCreatedAssets(input.repository, created);
      return { stale: true };
    }

    const preview = input.preview?.trim()
      ? await write(input.preview.trim(), 'image')
      : null;
    if (!input.isCurrent()) {
      await deleteCreatedAssets(input.repository, created);
      return { stale: true };
    }

    const lastFrame = input.lastFrame?.trim()
      ? await write(input.lastFrame.trim(), 'image')
      : null;
    if (!input.isCurrent()) {
      await deleteCreatedAssets(input.repository, created);
      return { stale: true };
    }

    return {
      stale: false,
      videoAssetId: video.assetId,
      previewAssetId: preview?.assetId ?? null,
      lastFrameAssetId: lastFrame?.assetId ?? null,
    };
  } catch (error) {
    await deleteCreatedAssets(input.repository, created);
    throw error;
  }
}
