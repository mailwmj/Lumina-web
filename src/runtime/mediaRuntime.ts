import { isTauri } from '@tauri-apps/api/core';
import {
  embedStoryboardImageMetadata,
  mergeStoryboardImages,
  readStoryboardImageMetadata,
} from '@/commands/image';
import {
  convertAudioToMp3,
  convertVideoToMp4,
  persistMediaBytesToProject,
  uploadMediaToTos,
} from '@/commands/media';
import {
  createNodeImagePreview,
  prepareNodeImage,
  prepareNodeImageFromFile,
  resolveAudioDisplayUrl,
  resolveImageDisplayUrl,
  resolveVideoDisplayUrl,
} from '@/features/canvas/application/imageData';
import { CanvasToolProcessor } from '@/features/canvas/application/toolProcessor';
import { uuidGenerator } from '@/features/canvas/infrastructure/idGenerator';
import { tauriImageSplitGateway } from '@/features/canvas/infrastructure/tauriImageSplitGateway';
import {
  createMediaDisplayResolver,
  type MediaDisplayResolver,
  type AssetObjectUrlRepository,
} from '@/features/assets/application/mediaDisplayResolver';
import type {
  AssetKind,
  AssetRepository,
} from '@/features/assets/domain/assetRepository';
import { createIndexedDbAssetRepository } from '@/features/assets/infrastructure/indexedDbAssetRepository';
import type { MediaProcessor } from '@/features/media/domain/mediaProcessor';
import { createTauriMediaProcessor } from '@/features/media/infrastructure/tauriMediaProcessor';
import { createBrowserImageToolProcessor } from '@/features/media/infrastructure/browserImageToolProcessor';
import { mergeBrowserStoryboard } from '@/features/media/infrastructure/browserStoryboardMerger';
import {
  readStoryboardAssetMetadata,
  writeBrowserDerivedImageSource,
} from '@/features/assets/application/browserDerivedImage';

export function resolveLegacyMediaDisplayUrl(kind: AssetKind, url: string): string {
  switch (kind) {
    case 'image':
      return resolveImageDisplayUrl(url);
    case 'video':
      return resolveVideoDisplayUrl(url);
    case 'audio':
      return resolveAudioDisplayUrl(url);
  }
}

export function createRuntimeMediaDisplayResolver(
  assetRepository: AssetObjectUrlRepository | null,
) {
  return createMediaDisplayResolver(assetRepository, resolveLegacyMediaDisplayUrl);
}

function createDefaultRuntimeAssetRepository(): AssetRepository | null {
  if (isTauri() || typeof indexedDB === 'undefined') {
    return null;
  }
  return createIndexedDbAssetRepository();
}

let activeAssetRepository: AssetRepository | null = createDefaultRuntimeAssetRepository();
let activeMediaDisplayResolver = createRuntimeMediaDisplayResolver(activeAssetRepository);

export const runtimeMediaDisplayResolver: MediaDisplayResolver = {
  resolve: (reference) => activeMediaDisplayResolver.resolve(reference),
};

// Keep persisted legacy URLs readable as a fallback when no browser repository is available.
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

const imageToolProcessor = new CanvasToolProcessor(tauriImageSplitGateway, uuidGenerator);
const browserImageToolProcessor = createBrowserImageToolProcessor({
  getAssetRepository: getRuntimeAssetRepository,
  createFrameId: () => uuidGenerator.next(),
});

async function importMedia(
  file: File,
  projectId: string,
  kind: 'videos' | 'audios',
): Promise<string> {
  const filePath = (file as File & { path?: string }).path;
  if (typeof filePath === 'string' && filePath.trim()) {
    return kind === 'videos'
      ? convertVideoToMp4(filePath, projectId)
      : convertAudioToMp3(filePath, projectId);
  }
  return persistMediaBytesToProject(
    new Uint8Array(await file.arrayBuffer()),
    file.name,
    projectId,
    kind,
  );
}

export const runtimeMediaProcessor: MediaProcessor = createTauriMediaProcessor({
  prepareImage: (source, maxPreviewDimension, projectId) => (
    typeof File !== 'undefined' && source instanceof File
      ? prepareNodeImageFromFile(source, maxPreviewDimension, projectId)
      : prepareNodeImage(source as string, maxPreviewDimension, projectId)
  ),
  createImagePreview: createNodeImagePreview,
  processImageTool: (toolType, sourceImageUrl, options) => (
    isTauri()
      ? imageToolProcessor.process(toolType, sourceImageUrl, options)
      : browserImageToolProcessor.process(toolType, sourceImageUrl, options)
  ),
  mergeStoryboard: (request) => (
    isTauri() ? mergeStoryboardImages(request) : mergeBrowserStoryboard(request)
  ),
  readStoryboardMetadata: (source, assetId) => (
    isTauri()
      ? readStoryboardImageMetadata(source)
      : assetId && activeAssetRepository
        ? readStoryboardAssetMetadata(assetId, activeAssetRepository)
        : Promise.resolve(null)
  ),
  writeDerivedImage: (request) => {
    if (isTauri()) {
      return Promise.resolve(null);
    }
    if (!activeAssetRepository) {
      return Promise.reject(new Error('Browser asset storage is unavailable.'));
    }
    return writeBrowserDerivedImageSource(request, activeAssetRepository);
  },
  embedStoryboardMetadata: (source, metadata, projectId) => (
    isTauri()
      ? embedStoryboardImageMetadata(source, metadata, projectId)
      : Promise.resolve(source)
  ),
  convertVideoToMp4,
  convertAudioToMp3,
  importVideo: (file, projectId) => importMedia(file, projectId, 'videos'),
  importAudio: (file, projectId) => importMedia(file, projectId, 'audios'),
  prepareTemporaryPublicMedia: uploadMediaToTos,
});
