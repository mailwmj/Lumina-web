import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { TextReasoningEffort } from '@/features/canvas/models/types';

export const CANVAS_NODE_TYPES = {
  upload: 'uploadNode',
  imageEdit: 'imageNode',
  exportImage: 'exportImageNode',
  textGeneration: 'textGenerationNode',
  textAnnotation: 'textAnnotationNode',
  group: 'groupNode',
  storyboardSplit: 'storyboardNode',
  storyboardGen: 'storyboardGenNode',
  videoFrame: 'videoFrameNode',
  videoSingle: 'videoSingleNode',
  seedanceAutoVideo: 'seedanceAutoVideoNode',
  exportVideo: 'exportVideoNode',
  // SD 2.0 参考节点
  audioUpload: 'audioUploadNode',
  videoUpload: 'videoUploadNode',
  audioUploadRef: 'audioUploadRefNode',
  videoUploadRef: 'videoUploadRefNode',
  sd2VideoGen: 'sd2VideoGenNode',
} as const;

export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[keyof typeof CANVAS_NODE_TYPES];

export const DEFAULT_ASPECT_RATIO = '1:1';
export const AUTO_REQUEST_ASPECT_RATIO = 'auto';
export const DEFAULT_NODE_WIDTH = 220;
export const EXPORT_RESULT_NODE_DEFAULT_WIDTH = 384;
export const EXPORT_RESULT_NODE_LAYOUT_HEIGHT = 288;
export const EXPORT_RESULT_NODE_MIN_WIDTH = 168;
export const EXPORT_RESULT_NODE_MIN_HEIGHT = 168;
export const VIDEO_RESULT_NODE_DEFAULT_WIDTH = 560;
export const VIDEO_RESULT_NODE_DEFAULT_HEIGHT = 400;
export const VIDEO_RESULT_NODE_MIN_WIDTH = 320;
export const VIDEO_RESULT_NODE_MIN_HEIGHT = 240;

export const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K'] as const;
export const IMAGE_OUTPUT_COUNTS = [1, 2, 4] as const;
export type ImageOutputCount = (typeof IMAGE_OUTPUT_COUNTS)[number];
export const DEFAULT_IMAGE_OUTPUT_COUNT: ImageOutputCount = 1;
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '21:9',
] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

export interface NodeDisplayData {
  displayName?: string;
  [key: string]: unknown;
}

export interface TextModelSelectionData {
  textApiId?: string;
  textModelId?: string;
  textReasoningEffort?: TextReasoningEffort;
}

export interface NodeImageData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
  [key: string]: unknown;
}

export interface UploadImageNodeData extends NodeImageData {
  sourceFileName?: string | null;
}

export type ExportImageNodeResultKind =
  | 'generic'
  | 'storyboardGenOutput'
  | 'storyboardSplitExport'
  | 'storyboardFrameEdit';

export type GenerationRecoveryState =
  | 'retrying'
  | 'attention_required'
  | 'retry_requested';

export interface ExportImageNodeData extends NodeImageData {
  resultKind?: ExportImageNodeResultKind;
  /** Stable identity shared by all result nodes from one image generation run. */
  generationBatchId?: string;
  generationBatchIndex?: number;
  generationBatchSize?: ImageOutputCount;
  /** Stable, source-local slot used to keep generated images in a predictable result lane. */
  generationLaneSlot?: number;
  /** Provider display name snapshot used while persisting a generated image. */
  generationProviderName?: string | null;
  /** Model display name snapshot used while persisting a generated image. */
  generationModelName?: string | null;
  /** Runtime state for a resumable task whose result query hit a transient network failure. */
  generationRecoveryState?: GenerationRecoveryState | null;
  generationRetryCount?: number;
  generationNextRetryAt?: number | null;
  generationRetryError?: string | null;
}

export interface GroupNodeData extends NodeDisplayData {
  label: string;
  [key: string]: unknown;
}

export interface TextAnnotationNodeData extends NodeDisplayData {
  content: string;
  [key: string]: unknown;
}

export interface TextGenerationNodeData extends NodeDisplayData, TextModelSelectionData {
  /** User-authored local text. It is never overwritten by generation. */
  inputText: string;
  /** Latest non-empty generated result. Null means the composite input is effective. */
  generatedText: string | null;
  /** Locks context-driven default dimensions after the user resizes this node. */
  isSizeManuallyAdjusted?: boolean;
  /** Runtime-only state; restored projects always start idle. */
  isGenerating?: boolean;
  generationError?: string | null;
  generationErrorDetails?: string | null;
  [key: string]: unknown;
}

export interface ImageEditNodeData extends NodeImageData {
  prompt: string;
  model: string;
  size: ImageSize;
  outputCount?: ImageOutputCount;
  requestAspectRatio?: string;
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
}

export interface StoryboardFrameItem {
  id: string;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio?: string;
  note: string;
  order: number;
}

export interface StoryboardExportOptions {
  showFrameIndex: boolean;
  showFrameNote: boolean;
  notePlacement: 'overlay' | 'bottom';
  imageFit: 'cover' | 'contain';
  frameIndexPrefix: string;
  cellGap: number;
  outerPadding: number;
  fontSize: number;
  backgroundColor: string;
  textColor: string;
}

export interface StoryboardSplitNodeData {
  displayName?: string;
  aspectRatio: string;
  frameAspectRatio?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardFrameItem[];
  exportOptions?: StoryboardExportOptions;
  [key: string]: unknown;
}

export interface StoryboardGenFrameItem {
  id: string;
  description: string;
  referenceIndex: number | null;
}

export type StoryboardRatioControlMode = 'overall' | 'cell';

export interface StoryboardGenNodeData {
  displayName?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardGenFrameItem[];
  ratioControlMode?: StoryboardRatioControlMode;
  model: string;
  size: ImageSize;
  requestAspectRatio: string;
  /** 全局提示词：分镜描述的整体控制（如画风、情节等） */
  globalPrompt?: string;
  extraParams?: Record<string, unknown>;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  [key: string]: unknown;
}

export type VideoResolution = '480p' | '720p' | '1080p' | '4k';
export type SeedanceVideoInputMode = 'automatic' | 'first-last';

export interface VideoGenNodeData extends NodeDisplayData {
  videoUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  prompt: string;
  model: string;
  resolution?: VideoResolution;
  duration?: number;
  /** Determines whether connected media is passed as general references or as strict first/last frames. */
  inputMode?: SeedanceVideoInputMode;
  referenceImagePrompt?: boolean;
  referenceImages?: string[];
  hasAudio?: boolean;
  returnLastFrame?: boolean;
  seed?: number;
  camerafixed?: boolean;  // 相机固定
  watermark?: boolean;    // 水印
  /** Locks context-driven default dimensions after the user resizes this node. */
  isSizeManuallyAdjusted?: boolean;
  // 视频元信息（用于润色提示词）
  shotType?: string;       // 镜头类型
  shotSize?: string;       // 景别
  angle?: string;         // 角度
  cameraMovement?: string; // 运镜
  cameraSpeed?: string;   // 运镜速度
  // SD 2.0 新参数
  generateAudio?: boolean; // 是否生成音频 (SD 2.0 & 1.5 pro)
  draft?: boolean;         // 样片模式 (SD 1.5 pro only)
  enableWebSearch?: boolean; // 联网搜索 (SD 2.0 only)
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationJobId?: string | null;
  generationProviderId?: string | null;
  /** Stable settings entry used for submit/poll/cancel of this task. */
  videoApiId?: string | null;
  generationError?: string | null;
  /** Draft task ID - when set, generates final video from this draft */
  draftTaskId?: string;
  [key: string]: unknown;
}

export interface ExportVideoNodeData extends NodeDisplayData {
  videoUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  model: string;
  resolution?: VideoResolution;
  duration?: number;
  hasAudio?: boolean;
  returnLastFrame?: boolean;
  seed?: number;
  prompt?: string;
  resultKind?: 'videoGen';
  /** Stable, source-local slot used to keep generated videos in a predictable result lane. */
  generationLaneSlot?: number;
  // SD 2.0 新参数
  generateAudio?: boolean;
  draft?: boolean;
  /** Draft task ID - stored when this node contains a draft video, used to generate final video */
  draftTaskId?: string;
  enableWebSearch?: boolean;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationJobId?: string | null;
  generationProviderId?: string | null;
  /** Stable settings entry used for submit/poll/cancel of this task. */
  videoApiId?: string | null;
  generationError?: string | null;
  generationRecoveryState?: GenerationRecoveryState | null;
  generationRetryCount?: number;
  generationNextRetryAt?: number | null;
  generationRetryError?: string | null;
  [key: string]: unknown;
}

// SD 2.0 参考上传节点数据类型

export interface AudioUploadRefNodeData extends NodeDisplayData {
  audioUrl: string | null;
  sourceFileName: string;
}

export interface VideoUploadRefNodeData extends NodeDisplayData {
  videoUrl: string | null;
  sourceFileName: string;
  previewVideoUrl?: string | null;
}

// SD 2.0 视频生成节点模式
export type SD2GenerationMode = 'multimodal' | 'edit' | 'extend';

export interface SD2VideoGenNodeData extends NodeDisplayData {
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution?: VideoResolution;
  duration?: number;
  hasAudio?: boolean;
  watermark?: boolean;
  returnLastFrame?: boolean;
  generationMode?: SD2GenerationMode;
  // 输入引用（存储连接的节点 ID 列表）
  referenceImageIds?: string[];
  referenceAudioIds?: string[];
  referenceVideoIds?: string[];
  /** Locks context-driven default dimensions after the user resizes this node. */
  isSizeManuallyAdjusted?: boolean;
  isGenerating?: boolean;
  generationJobId?: string | null;
  generationError?: string | null;
}

export type CanvasNodeData =
  | UploadImageNodeData
  | ExportImageNodeData
  | TextGenerationNodeData
  | TextAnnotationNodeData
  | GroupNodeData
  | ImageEditNodeData
  | StoryboardSplitNodeData
  | StoryboardGenNodeData
  | VideoGenNodeData
  | ExportVideoNodeData
  | AudioUploadRefNodeData
  | VideoUploadRefNodeData
  | SD2VideoGenNodeData;

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;
export interface CanvasWorkflowNode {
  readonly id: string;
  readonly type: CanvasNodeType;
  readonly data: CanvasNodeData;
}
export type CanvasDataType = 'text' | 'image' | 'audio' | 'video';

export interface CanvasEdgeData extends Record<string, unknown> {
  valueType?: CanvasDataType;
  /** Order within the target node's independent value-type list. */
  inputOrder?: number;
}

export type CanvasEdge = Edge<CanvasEdgeData>;

export interface NodeCreationDto {
  type: CanvasNodeType;
  position: XYPosition;
  data?: Partial<CanvasNodeData>;
}

export interface StoryboardNodeCreationDto {
  position: XYPosition;
  rows: number;
  cols: number;
  frames: StoryboardFrameItem[];
}

export const NODE_TOOL_TYPES = {
  crop: 'crop',
  annotate: 'annotate',
  splitStoryboard: 'split-storyboard',
} as const;

export type NodeToolType = (typeof NODE_TOOL_TYPES)[keyof typeof NODE_TOOL_TYPES];

export interface ActiveToolDialog {
  nodeId: string;
  toolType: NodeToolType;
}

type CanvasNodeWithData<
  TNode extends CanvasWorkflowNode,
  TData extends CanvasNodeData,
  TType extends CanvasNodeType,
> = TNode & { data: TData; type: TType };

export function isUploadNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, UploadImageNodeData, typeof CANVAS_NODE_TYPES.upload> {
  return node?.type === CANVAS_NODE_TYPES.upload;
}

export function isImageEditNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, ImageEditNodeData, typeof CANVAS_NODE_TYPES.imageEdit> {
  return node?.type === CANVAS_NODE_TYPES.imageEdit;
}

export function isExportImageNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, ExportImageNodeData, typeof CANVAS_NODE_TYPES.exportImage> {
  return node?.type === CANVAS_NODE_TYPES.exportImage;
}

export function isGroupNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  return node?.type === CANVAS_NODE_TYPES.group;
}

export function isTextAnnotationNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, TextAnnotationNodeData, typeof CANVAS_NODE_TYPES.textAnnotation> {
  return node?.type === CANVAS_NODE_TYPES.textAnnotation;
}

export function isTextGenerationNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, TextGenerationNodeData, typeof CANVAS_NODE_TYPES.textGeneration> {
  return node?.type === CANVAS_NODE_TYPES.textGeneration;
}

export function isStoryboardSplitNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, StoryboardSplitNodeData, typeof CANVAS_NODE_TYPES.storyboardSplit> {
  return node?.type === CANVAS_NODE_TYPES.storyboardSplit;
}

export function isStoryboardGenNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, StoryboardGenNodeData, typeof CANVAS_NODE_TYPES.storyboardGen> {
  return node?.type === CANVAS_NODE_TYPES.storyboardGen;
}

export function isVideoGenNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<
  TNode,
  VideoGenNodeData,
  | typeof CANVAS_NODE_TYPES.videoFrame
  | typeof CANVAS_NODE_TYPES.videoSingle
  | typeof CANVAS_NODE_TYPES.seedanceAutoVideo
> {
  return node?.type === CANVAS_NODE_TYPES.videoFrame
    || node?.type === CANVAS_NODE_TYPES.videoSingle
    || node?.type === CANVAS_NODE_TYPES.seedanceAutoVideo;
}

export function isExportVideoNode<TNode extends CanvasWorkflowNode>(
  node: TNode | null | undefined
): node is CanvasNodeWithData<TNode, ExportVideoNodeData, typeof CANVAS_NODE_TYPES.exportVideo> {
  return node?.type === CANVAS_NODE_TYPES.exportVideo;
}

export function nodeHasImage(node: CanvasNode | null | undefined): boolean {
  if (!node) {
    return false;
  }

  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  if (isStoryboardSplitNode(node)) {
    return node.data.frames.some((frame) => Boolean(frame.imageUrl));
  }

  if (isStoryboardGenNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  if (isVideoGenNode(node) || isExportVideoNode(node)) {
    return Boolean(node.data.videoUrl);
  }

  return false;
}
