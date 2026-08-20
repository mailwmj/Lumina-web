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
} from '@/features/canvas/application/imageData';
import { CanvasToolProcessor } from '@/features/canvas/application/toolProcessor';
import { uuidGenerator } from '@/features/canvas/infrastructure/idGenerator';
import { tauriImageSplitGateway } from '@/features/canvas/infrastructure/tauriImageSplitGateway';
import type { MediaProcessor } from '@/features/media/domain/mediaProcessor';
import { createTauriMediaProcessor } from '@/features/media/infrastructure/tauriMediaProcessor';

export function createMediaProcessor(): MediaProcessor {
  const imageToolProcessor = new CanvasToolProcessor(tauriImageSplitGateway, uuidGenerator);
  const importMedia = async (
    file: File,
    projectId: string,
    kind: 'videos' | 'audios',
  ): Promise<string> => {
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
  };

  return createTauriMediaProcessor({
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
}
