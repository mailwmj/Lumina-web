import type {
  AssetId,
  AssetRepository,
  AssetSourceMetadata,
} from '@/features/assets/domain/assetRepository';
import type { StoryboardMetadata } from '@/features/media/domain/mediaProcessor';
import {
  createBrowserStorageCapacityGate,
  isQuotaExceededError,
  notifyBrowserStorageCapacityError,
  StorageCapacityError,
  type StorageCapacityGate,
} from '@/runtime/browserStorage';

const STORYBOARD_METADATA_KEY = 'storyboardMetadata';

export type StoryboardAssetMetadata = StoryboardMetadata;

export interface BrowserDerivedImageInput {
  projectId: string;
  blob: Blob;
  width: number;
  height: number;
  metadata?: StoryboardAssetMetadata;
}

export interface BrowserDerivedImageSourceInput {
  source: string;
  projectId?: string;
  width: number;
  height: number;
  metadata?: StoryboardAssetMetadata;
}

export interface BrowserDerivedImageResult {
  assetId: AssetId;
  previewAssetId: null;
  imageUrl: null;
  previewImageUrl: null;
  aspectRatio: string;
}

function reduceAspectRatio(width: number, height: number): string {
  let left = Math.max(1, Math.round(width));
  let right = Math.max(1, Math.round(height));
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return `${Math.round(width) / left}:${Math.round(height) / left}`;
}

function serializeMetadata(metadata: StoryboardAssetMetadata | undefined): AssetSourceMetadata {
  if (!metadata) {
    return {};
  }
  return { [STORYBOARD_METADATA_KEY]: JSON.stringify(metadata) };
}

function parseStoryboardMetadata(value: unknown): StoryboardAssetMetadata | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<StoryboardAssetMetadata>;
    if (
      typeof parsed.gridRows !== 'number' || !Number.isInteger(parsed.gridRows) || parsed.gridRows <= 0 ||
      typeof parsed.gridCols !== 'number' || !Number.isInteger(parsed.gridCols) || parsed.gridCols <= 0 ||
      !Array.isArray(parsed.frameNotes) || !parsed.frameNotes.every((note) => typeof note === 'string')
    ) {
      return null;
    }
    return {
      gridRows: parsed.gridRows,
      gridCols: parsed.gridCols,
      frameNotes: parsed.frameNotes,
      ...(parsed.exportOptions ? { exportOptions: parsed.exportOptions } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeBrowserDerivedImageSource(
  input: BrowserDerivedImageSourceInput,
  repository: AssetRepository,
  storageCapacityGate: StorageCapacityGate = createBrowserStorageCapacityGate(),
): Promise<BrowserDerivedImageResult> {
  const response = await fetch(input.source);
  if (!response.ok) {
    throw new Error('Unable to save the derived image.');
  }
  if (!input.projectId?.trim()) {
    throw new Error('An active project is required before saving a derived image.');
  }
  return writeBrowserDerivedImageAsset({
    ...input,
    projectId: input.projectId,
    blob: await response.blob(),
  }, repository, storageCapacityGate);
}

export async function writeBrowserDerivedImageAsset(
  input: BrowserDerivedImageInput,
  repository: AssetRepository,
  storageCapacityGate: StorageCapacityGate = createBrowserStorageCapacityGate(),
): Promise<BrowserDerivedImageResult> {
  if (!input.projectId.trim()) {
    throw new Error('An active project is required before saving a derived image.');
  }
  await storageCapacityGate.assertCanWrite(input.blob.size);

  try {
    const metadata = await repository.write({
      projectId: input.projectId,
      kind: 'image',
      sourceKind: 'derived',
      blob: input.blob,
      width: input.width,
      height: input.height,
      sourceMetadata: serializeMetadata(input.metadata),
    });
    return {
      assetId: metadata.assetId,
      previewAssetId: null,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: reduceAspectRatio(input.width, input.height),
    };
  } catch (error) {
    if (isQuotaExceededError(error)) {
      notifyBrowserStorageCapacityError();
      throw new StorageCapacityError(
        'quota-exceeded',
        'Browser storage became full while saving this image. Remove media or make a backup, then try again.',
      );
    }
    throw error;
  }
}

export async function readStoryboardAssetMetadata(
  assetId: AssetId,
  repository: Pick<AssetRepository, 'getMetadata'>,
): Promise<StoryboardAssetMetadata | null> {
  const metadata = await repository.getMetadata(assetId);
  return parseStoryboardMetadata(metadata?.sourceMetadata[STORYBOARD_METADATA_KEY]);
}
