import type {
  ImageToolResult,
  MediaProcessor,
  PreparedMediaImage,
  PreparedMediaPreview,
  StoryboardMergeRequest,
  StoryboardMergeResult,
  StoryboardMetadata,
  TemporaryPublicMedia,
} from '@/features/media/domain/mediaProcessor';
import type { NodeToolType } from '@/features/canvas/domain/canvasNodes';

const DEFAULT_PREVIEW_DIMENSION = 512;

export interface TauriMediaProcessorDependencies {
  prepareImage(
    source: string | File,
    maxPreviewDimension: number,
    projectId?: string,
  ): Promise<PreparedMediaImage>;
  createImagePreview(
    source: string,
    maxPreviewDimension: number,
    projectId?: string,
  ): Promise<PreparedMediaPreview>;
  processImageTool(
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>,
  ): Promise<ImageToolResult>;
  mergeStoryboard(request: StoryboardMergeRequest): Promise<StoryboardMergeResult>;
  readStoryboardMetadata(source: string): Promise<StoryboardMetadata | null>;
  embedStoryboardMetadata(
    source: string,
    metadata: StoryboardMetadata,
    projectId?: string,
  ): Promise<string>;
  convertVideoToMp4(sourcePath: string, projectId: string): Promise<string>;
  convertAudioToMp3(sourcePath: string, projectId: string): Promise<string>;
  importVideo(file: File, projectId: string): Promise<string>;
  importAudio(file: File, projectId: string): Promise<string>;
  prepareTemporaryPublicMedia(source: string, projectId?: string): Promise<TemporaryPublicMedia>;
}

export function createTauriMediaProcessor(
  dependencies: TauriMediaProcessorDependencies,
): MediaProcessor {
  return {
    prepareImage: (source, options) => dependencies.prepareImage(
      source,
      options?.maxPreviewDimension ?? DEFAULT_PREVIEW_DIMENSION,
      options?.projectId,
    ),
    createImagePreview: (source, options) => dependencies.createImagePreview(
      source,
      options?.maxPreviewDimension ?? DEFAULT_PREVIEW_DIMENSION,
      options?.projectId,
    ),
    processImageTool: (toolType, sourceImageUrl, options) => (
      dependencies.processImageTool(toolType, sourceImageUrl, options)
    ),
    mergeStoryboard: (request) => dependencies.mergeStoryboard(request),
    readStoryboardMetadata: (source) => dependencies.readStoryboardMetadata(source),
    embedStoryboardMetadata: (source, metadata, projectId) => (
      dependencies.embedStoryboardMetadata(source, metadata, projectId)
    ),
    convertVideoToMp4: (sourcePath, projectId) => (
      dependencies.convertVideoToMp4(sourcePath, projectId)
    ),
    convertAudioToMp3: (sourcePath, projectId) => (
      dependencies.convertAudioToMp3(sourcePath, projectId)
    ),
    importVideo: (file, projectId) => dependencies.importVideo(file, projectId),
    importAudio: (file, projectId) => dependencies.importAudio(file, projectId),
    prepareTemporaryPublicMedia: (source, projectId) => (
      dependencies.prepareTemporaryPublicMedia(source, projectId)
    ),
  };
}
