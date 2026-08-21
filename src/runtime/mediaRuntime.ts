import {
  createNodeImagePreview,
  prepareNodeImage,
  prepareNodeImageFromFile,
} from '@/features/canvas/application/imageData';
import { uuidGenerator } from '@/features/canvas/infrastructure/idGenerator';
import {
  createMediaDisplayResolver,
  type AssetObjectUrlRepository,
  type MediaDisplayResolver,
} from '@/features/assets/application/mediaDisplayResolver';
import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import { createIndexedDbAssetRepository } from '@/features/assets/infrastructure/indexedDbAssetRepository';
import {
  importRuntimeBrowserMediaAsset,
} from '@/features/assets/application/browserMediaImport';
import {
  readStoryboardAssetMetadata,
  writeBrowserDerivedImageSource,
} from '@/features/assets/application/browserDerivedImage';
import { prepareBrowserAssetTemporaryMedia } from '@/features/media/application/browserTemporaryPublicMedia';
import type {
  ImportedMedia,
  MediaProcessor,
  TemporaryPublicMedia,
} from '@/features/media/domain/mediaProcessor';
import { createBrowserImageToolProcessor } from '@/features/media/infrastructure/browserImageToolProcessor';
import { createBrowserMediaGateway } from '@/features/media/infrastructure/browserMediaGateway';
import { mergeBrowserStoryboard } from '@/features/media/infrastructure/browserStoryboardMerger';

export function resolveLegacyMediaDisplayUrl(_kind: string, url: string): string {
  return url;
}

export function createRuntimeMediaDisplayResolver(
  assetRepository: AssetObjectUrlRepository | null,
) {
  return createMediaDisplayResolver(assetRepository, resolveLegacyMediaDisplayUrl);
}

function createDefaultRuntimeAssetRepository(): AssetRepository | null {
  return typeof indexedDB === 'undefined' ? null : createIndexedDbAssetRepository();
}

let activeAssetRepository: AssetRepository | null = createDefaultRuntimeAssetRepository();
let activeMediaDisplayResolver = createRuntimeMediaDisplayResolver(activeAssetRepository);

export const runtimeMediaDisplayResolver: MediaDisplayResolver = {
  resolve: (reference) => activeMediaDisplayResolver.resolve(reference),
};

export function configureRuntimeAssetRepository(
  assetRepository: AssetObjectUrlRepository | null,
): void {
  activeAssetRepository = assetRepository && 'write' in assetRepository
    ? assetRepository as AssetRepository
    : null;
  activeMediaDisplayResolver = createRuntimeMediaDisplayResolver(assetRepository);
}

export function getRuntimeAssetRepository(): AssetRepository | null {
  return activeAssetRepository;
}

const browserImageToolProcessor = createBrowserImageToolProcessor({
  getAssetRepository: getRuntimeAssetRepository,
  createFrameId: () => uuidGenerator.next(),
});

async function importMedia(file: File, projectId: string): Promise<ImportedMedia> {
  return await importRuntimeBrowserMediaAsset(file, projectId);
}

async function prepareTemporaryPublicMedia(
  source: string,
  options?: { projectId?: string; providerId?: string },
): Promise<TemporaryPublicMedia> {
  const assetId = source.startsWith('asset:') ? source.slice('asset:'.length).trim() : '';
  if (!assetId) {
    throw new Error('Temporary public media must reference a persisted browser asset.');
  }
  if (!activeAssetRepository) {
    throw new Error('Browser asset storage is unavailable.');
  }
  return await prepareBrowserAssetTemporaryMedia({
    assetId,
    providerId: options?.providerId ?? 'volcengine-seedance',
    repository: activeAssetRepository,
    gateway: createBrowserMediaGateway(),
  });
}

export const runtimeMediaProcessor: MediaProcessor = {
  prepareImage: (source, options) => (
    typeof File !== 'undefined' && source instanceof File
      ? prepareNodeImageFromFile(source, options?.maxPreviewDimension, options?.projectId)
      : prepareNodeImage(source as string, options?.maxPreviewDimension, options?.projectId)
  ),
  createImagePreview: (source, options) => (
    createNodeImagePreview(source, options?.maxPreviewDimension, options?.projectId)
  ),
  processImageTool: (toolType, sourceImageUrl, options) => (
    browserImageToolProcessor.process(toolType, sourceImageUrl, options)
  ),
  mergeStoryboard: mergeBrowserStoryboard,
  readStoryboardMetadata: async (_source, assetId) => (
    assetId && activeAssetRepository
      ? await readStoryboardAssetMetadata(assetId, activeAssetRepository)
      : null
  ),
  writeDerivedImage: async (request) => {
    if (!activeAssetRepository) {
      throw new Error('Browser asset storage is unavailable.');
    }
    return await writeBrowserDerivedImageSource(request, activeAssetRepository);
  },
  embedStoryboardMetadata: async (source) => source,
  importVideo: importMedia,
  importAudio: importMedia,
  prepareTemporaryPublicMedia,
};
