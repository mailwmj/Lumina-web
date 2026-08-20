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
import type { AssetKind } from '@/features/assets/domain/assetRepository';
import type { MediaProcessor } from '@/features/media/domain/mediaProcessor';
import { createTauriMediaProcessor } from '@/features/media/infrastructure/tauriMediaProcessor';

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

let activeMediaDisplayResolver = createRuntimeMediaDisplayResolver(null);

export const runtimeMediaDisplayResolver: MediaDisplayResolver = {
  resolve: (reference) => activeMediaDisplayResolver.resolve(reference),
};

// T06 will install the browser repository here. A null repository keeps every
// persisted legacy URL readable during the expand phase.
export function configureRuntimeAssetRepository(
  assetRepository: AssetObjectUrlRepository | null,
): void {
  activeMediaDisplayResolver = createRuntimeMediaDisplayResolver(assetRepository);
}

const imageToolProcessor = new CanvasToolProcessor(tauriImageSplitGateway, uuidGenerator);

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
    imageToolProcessor.process(toolType, sourceImageUrl, options)
  ),
  mergeStoryboard: mergeStoryboardImages,
  readStoryboardMetadata: readStoryboardImageMetadata,
  embedStoryboardMetadata: embedStoryboardImageMetadata,
  convertVideoToMp4,
  convertAudioToMp3,
  importVideo: (file, projectId) => importMedia(file, projectId, 'videos'),
  importAudio: (file, projectId) => importMedia(file, projectId, 'audios'),
  prepareTemporaryPublicMedia: uploadMediaToTos,
});
