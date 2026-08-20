import type { AssetId } from '@/features/assets/domain/assetRepository';
import type { StoryboardExportOptions } from '@/features/canvas/domain/canvasNodes';

export type MediaImageToolType = 'crop' | 'annotate' | 'split-storyboard';

export interface MediaStoryboardFrame {
  id: string;
  assetId?: AssetId | null;
  previewAssetId?: AssetId | null;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio?: string;
  note: string;
  order: number;
}

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
  outputAssetId?: AssetId | null;
  outputPreviewAssetId?: AssetId | null;
  outputAspectRatio?: string;
  outputImageUrl?: string;
  storyboardFrames?: MediaStoryboardFrame[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
  storyboardExportOptions?: StoryboardExportOptions;
}

export interface StoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
  exportOptions?: StoryboardExportOptions;
}

export interface DerivedImageWriteRequest {
  source: string;
  projectId?: string;
  width: number;
  height: number;
  metadata?: StoryboardMetadata;
}

export interface DerivedImageWriteResult {
  assetId: AssetId;
  previewAssetId: null;
  imageUrl: null;
  previewImageUrl: null;
  aspectRatio: string;
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
    toolType: MediaImageToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>,
  ): Promise<ImageToolResult>;
  mergeStoryboard(request: StoryboardMergeRequest): Promise<StoryboardMergeResult>;
  readStoryboardMetadata(source: string, assetId?: AssetId | null): Promise<StoryboardMetadata | null>;
  writeDerivedImage(request: DerivedImageWriteRequest): Promise<DerivedImageWriteResult | null>;
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
