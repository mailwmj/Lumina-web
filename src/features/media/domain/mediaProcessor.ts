import type {
  NodeToolType,
  StoryboardFrameItem,
} from '@/features/canvas/domain/canvasNodes';

export interface MediaProcessingOptions {
  maxPreviewDimension?: number;
  projectId?: string;
}

export interface PreparedMediaImage {
  imageUrl: string;
  previewImageUrl: string;
  aspectRatio: string;
}

export interface PreparedMediaPreview {
  previewImageUrl: string;
  aspectRatio: string;
}

export interface ImageToolResult {
  outputImageUrl?: string;
  storyboardFrames?: StoryboardFrameItem[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
}

export interface StoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

export interface StoryboardMergeRequest {
  frameSources: string[];
  rows: number;
  cols: number;
  cellGap: number;
  outerPadding: number;
  noteHeight: number;
  fontSize: number;
  backgroundColor: string;
  maxDimension: number;
  showFrameIndex?: boolean;
  showFrameNote?: boolean;
  notePlacement?: 'overlay' | 'bottom';
  imageFit?: 'cover' | 'contain';
  frameIndexPrefix?: string;
  textColor?: string;
  frameNotes?: string[];
  projectId?: string;
}

export interface StoryboardMergeResult {
  imagePath: string;
  canvasWidth: number;
  canvasHeight: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  padding: number;
  noteHeight: number;
  fontSize: number;
  textOverlayApplied: boolean;
}

export interface TemporaryPublicMedia {
  key: string;
  url: string;
  expiresAt: number;
  contentType: string;
  sizeBytes: number;
}

export interface MediaProcessor {
  prepareImage(
    source: string | File,
    options?: MediaProcessingOptions,
  ): Promise<PreparedMediaImage>;
  createImagePreview(
    source: string,
    options?: MediaProcessingOptions,
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
