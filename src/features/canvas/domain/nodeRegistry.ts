import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_OUTPUT_COUNT,
  type ImageSize,
  type CanvasNodeData,
  type CanvasDataType,
  type CanvasNodeType,
  type ExportImageNodeData,
  type ExportVideoNodeData,
  type GroupNodeData,
  type ImageEditNodeData,
  type AudioUploadRefNodeData,
  type VideoUploadRefNodeData,
  type SD2VideoGenNodeData,
  type StoryboardSplitNodeData,
  type StoryboardGenNodeData,
  type TextAnnotationNodeData,
  type TextGenerationNodeData,
  type UploadImageNodeData,
  type VideoGenNodeData,
} from './canvasNodes';
import { DEFAULT_NODE_DISPLAY_NAME } from './nodeDisplay';
import { DEFAULT_IMAGE_MODEL_ID } from '../models';

export type MenuIconKey = 'upload' | 'sparkles' | 'layout' | 'text' | 'video';

export interface CanvasNodeCapabilities {
  toolbar: boolean;
  promptInput: boolean;
}

export interface CanvasNodeConnectivity {
  sourceHandle: boolean;
  targetHandle: boolean;
  sourceHandleIds?: readonly string[];
  targetHandleIds?: readonly string[];
  sourceDataTypes: CanvasDataType[];
  targetDataTypes: CanvasDataType[];
  /** Limits incoming values of each type for nodes with a shared input surface. */
  targetInputLimits?: Partial<Record<CanvasDataType, number>>;
  /** Per-handle capacity when a node gives semantic meaning to individual ports. */
  targetHandleInputLimits?: Partial<Record<string, number>>;
  /** Default handle used when a connection creates a node from the canvas menu. */
  defaultTargetHandleByDataType?: Partial<Record<CanvasDataType, string>>;
  connectMenu: {
    fromSource: boolean;
    fromTarget: boolean;
  };
}

export interface CanvasNodeAgentAccess {
  creatable: boolean;
  readableFields: readonly string[];
  writableFields: readonly string[];
}

export interface CanvasNodeDefinition<TData extends CanvasNodeData = CanvasNodeData> {
  type: CanvasNodeType;
  menuLabelKey: string;
  menuIcon: MenuIconKey;
  visibleInMenu: boolean;
  capabilities: CanvasNodeCapabilities;
  connectivity: CanvasNodeConnectivity;
  agent: CanvasNodeAgentAccess;
  createDefaultData: () => TData;
}

const uploadNodeDefinition: CanvasNodeDefinition<UploadImageNodeData> = {
  type: CANVAS_NODE_TYPES.upload,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: ['displayName', 'aspectRatio', 'sourceFileName'],
    writableFields: ['displayName'],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    sourceDataTypes: ['image'],
    targetDataTypes: [],
    connectMenu: {
      fromSource: false,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.upload],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '1:1',
    isSizeManuallyAdjusted: false,
    sourceFileName: null,
  }),
};

const imageEditNodeDefinition: CanvasNodeDefinition<ImageEditNodeData> = {
  type: CANVAS_NODE_TYPES.imageEdit,
  menuLabelKey: 'node.menu.aiImageGeneration',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: true,
    readableFields: [
      'displayName',
      'prompt',
      'model',
      'size',
      'outputCount',
      'requestAspectRatio',
      'aspectRatio',
      'extraParams',
    ],
    writableFields: [
      'displayName',
      'prompt',
      'model',
      'size',
      'outputCount',
      'requestAspectRatio',
      'extraParams',
    ],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['image'],
    targetDataTypes: ['image', 'text'],
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.imageEdit],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    prompt: '',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    outputCount: DEFAULT_IMAGE_OUTPUT_COUNT,
    extraParams: {},
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const exportImageNodeDefinition: CanvasNodeDefinition<ExportImageNodeData> = {
  type: CANVAS_NODE_TYPES.exportImage,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: [
      'displayName',
      'aspectRatio',
      'resultKind',
      'isGenerating',
      'generationStartedAt',
      'generationError',
      'generationRecoveryState',
      'generationBatchId',
      'generationBatchIndex',
      'generationBatchSize',
    ],
    writableFields: ['displayName'],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['image'],
    targetDataTypes: ['image'],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.exportImage],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    resultKind: 'generic',
  }),
};

const groupNodeDefinition: CanvasNodeDefinition<GroupNodeData> = {
  type: CANVAS_NODE_TYPES.group,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: ['displayName', 'label'],
    writableFields: [],
  },
  connectivity: {
    sourceHandle: false,
    targetHandle: false,
    sourceDataTypes: [],
    targetDataTypes: [],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.group],
    label: '组',
  }),
};

const textAnnotationNodeDefinition: CanvasNodeDefinition<TextAnnotationNodeData> = {
  type: CANVAS_NODE_TYPES.textAnnotation,
  menuLabelKey: 'node.menu.textAnnotation',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: true,
    readableFields: ['displayName', 'content'],
    writableFields: ['displayName', 'content'],
  },
  connectivity: {
    sourceHandle: false,
    targetHandle: false,
    sourceDataTypes: [],
    targetDataTypes: [],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.textAnnotation],
    content: '',
  }),
};

const textGenerationNodeDefinition: CanvasNodeDefinition<TextGenerationNodeData> = {
  type: CANVAS_NODE_TYPES.textGeneration,
  menuLabelKey: 'node.menu.textGeneration',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: true,
    readableFields: [
      'displayName',
      'inputText',
      'generatedText',
      'textApiId',
      'textModelId',
      'textReasoningEffort',
    ],
    writableFields: [
      'displayName',
      'inputText',
      'textApiId',
      'textModelId',
      'textReasoningEffort',
    ],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['text'],
    targetDataTypes: ['text', 'image'],
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.textGeneration],
    inputText: '',
    generatedText: null,
    isSizeManuallyAdjusted: false,
    isGenerating: false,
    generationError: null,
    generationErrorDetails: null,
  }),
};

const storyboardSplitDefinition: CanvasNodeDefinition<StoryboardSplitNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardSplit,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: [
      'displayName',
      'aspectRatio',
      'frameAspectRatio',
      'gridRows',
      'gridCols',
    ],
    writableFields: ['displayName'],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['image'],
    targetDataTypes: ['image'],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardSplit],
    aspectRatio: DEFAULT_ASPECT_RATIO,
    frameAspectRatio: DEFAULT_ASPECT_RATIO,
    gridRows: 2,
    gridCols: 2,
    frames: [],
    exportOptions: {
      showFrameIndex: false,
      showFrameNote: false,
      notePlacement: 'overlay',
      imageFit: 'cover',
      frameIndexPrefix: 'S',
      cellGap: 8,
      outerPadding: 0,
      fontSize: 4,
      backgroundColor: '#0f1115',
      textColor: '#f8fafc',
    },
  }),
};

const storyboardGenNodeDefinition: CanvasNodeDefinition<StoryboardGenNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardGen,
  menuLabelKey: 'node.menu.storyboardGen',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  agent: {
    creatable: true,
    readableFields: [
      'displayName',
      'gridRows',
      'gridCols',
      'frames',
      'ratioControlMode',
      'model',
      'size',
      'requestAspectRatio',
      'globalPrompt',
      'aspectRatio',
      'extraParams',
    ],
    writableFields: [
      'displayName',
      'gridRows',
      'gridCols',
      'frames',
      'ratioControlMode',
      'model',
      'size',
      'requestAspectRatio',
      'globalPrompt',
      'extraParams',
    ],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['image'],
    targetDataTypes: ['image'],
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardGen],
    gridRows: 2,
    gridCols: 2,
    frames: [],
    ratioControlMode: 'cell',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    globalPrompt: '',
    extraParams: {},
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const videoFrameNodeDefinition: CanvasNodeDefinition<VideoGenNodeData> = {
  type: CANVAS_NODE_TYPES.videoFrame,
  menuLabelKey: 'node.menu.videoFrame',
  menuIcon: 'video',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: [
      'displayName',
      'aspectRatio',
      'prompt',
      'model',
      'resolution',
      'duration',
      'inputMode',
    ],
    writableFields: [
      'displayName',
      'aspectRatio',
      'prompt',
      'model',
      'resolution',
      'duration',
      'inputMode',
    ],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    targetHandleIds: ['target-first', 'target-last'],
    targetHandleInputLimits: {
      'target-first': 1,
      'target-last': 1,
    },
    defaultTargetHandleByDataType: { image: 'target-first' },
    sourceDataTypes: ['video'],
    targetDataTypes: ['image'],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoFrame],
    videoUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    prompt: '',
    model: '',
    resolution: '720p',
    duration: 5,
    inputMode: 'first-last',
    referenceImagePrompt: false,
    referenceImages: [],
    isSizeManuallyAdjusted: false,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 120000,
  }),
};

const videoSingleNodeDefinition: CanvasNodeDefinition<VideoGenNodeData> = {
  type: CANVAS_NODE_TYPES.videoSingle,
  menuLabelKey: 'node.menu.videoSingle',
  menuIcon: 'video',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: true,
    readableFields: [
      'displayName',
      'aspectRatio',
      'prompt',
      'model',
      'resolution',
      'duration',
      'hasAudio',
      'returnLastFrame',
      'seed',
      'camerafixed',
      'watermark',
      'extraParams',
    ],
    writableFields: [
      'displayName',
      'aspectRatio',
      'prompt',
      'model',
      'resolution',
      'duration',
      'hasAudio',
      'returnLastFrame',
      'seed',
      'camerafixed',
      'watermark',
      'extraParams',
    ],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['video'],
    targetDataTypes: ['image'],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoSingle],
    videoUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    prompt: '',
    model: '',
    resolution: '720p',
    duration: 5,
    referenceImagePrompt: false,
    referenceImages: [],
    hasAudio: false,
    returnLastFrame: false,
    seed: undefined,
    extraParams: {},
    isSizeManuallyAdjusted: false,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 120000,
  }),
};

const seedanceAutoVideoNodeDefinition: CanvasNodeDefinition<VideoGenNodeData> = {
  type: CANVAS_NODE_TYPES.seedanceAutoVideo,
  menuLabelKey: 'node.menu.seedanceAutoVideo',
  menuIcon: 'video',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: true,
    readableFields: [
      'displayName',
      'aspectRatio',
      'prompt',
      'model',
      'resolution',
      'duration',
      'inputMode',
    ],
    writableFields: [
      'displayName',
      'aspectRatio',
      'prompt',
      'model',
      'resolution',
      'duration',
      'inputMode',
    ],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['video'],
    targetDataTypes: ['text', 'image', 'audio', 'video'],
    targetInputLimits: {
      image: 9,
      video: 3,
      audio: 3,
    },
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.seedanceAutoVideo],
    videoUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    prompt: '',
    model: 'doubao-seedance-2-0-260128',
    resolution: '720p',
    duration: 5,
    inputMode: 'automatic',
    referenceImagePrompt: false,
    referenceImages: [],
    isSizeManuallyAdjusted: false,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 120000,
  }),
};

const audioUploadNodeDefinition: CanvasNodeDefinition<AudioUploadRefNodeData> = {
  type: CANVAS_NODE_TYPES.audioUpload,
  menuLabelKey: 'node.menu.audioUploadRef',
  menuIcon: 'upload',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: ['displayName', 'sourceFileName'],
    writableFields: ['displayName'],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    sourceDataTypes: ['audio'],
    targetDataTypes: [],
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.audioUpload],
    audioUrl: null,
    sourceFileName: '',
  }),
};

const videoUploadNodeDefinition: CanvasNodeDefinition<VideoUploadRefNodeData> = {
  type: CANVAS_NODE_TYPES.videoUpload,
  menuLabelKey: 'node.menu.videoUploadRef',
  menuIcon: 'upload',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: ['displayName', 'sourceFileName'],
    writableFields: ['displayName'],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    sourceDataTypes: ['video'],
    targetDataTypes: [],
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoUpload],
    videoUrl: null,
    previewVideoUrl: null,
    sourceFileName: '',
  }),
};

const audioUploadRefNodeDefinition: CanvasNodeDefinition<AudioUploadRefNodeData> = {
  ...audioUploadNodeDefinition,
  type: CANVAS_NODE_TYPES.audioUploadRef,
  visibleInMenu: false,
};

const videoUploadRefNodeDefinition: CanvasNodeDefinition<VideoUploadRefNodeData> = {
  ...videoUploadNodeDefinition,
  type: CANVAS_NODE_TYPES.videoUploadRef,
  visibleInMenu: false,
};

const exportVideoNodeDefinition: CanvasNodeDefinition<ExportVideoNodeData> = {
  type: CANVAS_NODE_TYPES.exportVideo,
  menuLabelKey: 'node.menu.videoFrame',
  menuIcon: 'video',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  agent: {
    creatable: false,
    readableFields: [
      'displayName',
      'aspectRatio',
      'model',
      'resolution',
      'duration',
      'hasAudio',
      'prompt',
      'resultKind',
    ],
    writableFields: ['displayName'],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    sourceDataTypes: ['video'],
    targetDataTypes: ['video'],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: '视频结果',
    videoUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    model: '',
    resolution: '720p',
    duration: 5,
    hasAudio: false,
    returnLastFrame: false,
    seed: undefined,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 120000,
    resultKind: 'videoGen',
  }),
};

// SD 2.0 高级多模态请求尚未接入提交链路；保留已有项目的节点渲染，禁止新建。
const sd2VideoGenNodeDefinition: CanvasNodeDefinition<SD2VideoGenNodeData> = {
  type: CANVAS_NODE_TYPES.sd2VideoGen,
  menuLabelKey: 'node.menu.sd2VideoGen',
  menuIcon: 'video',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: true,
  },
  agent: {
    creatable: false,
    readableFields: [
      'displayName',
      'prompt',
      'model',
      'aspectRatio',
      'resolution',
      'duration',
      'hasAudio',
      'watermark',
      'returnLastFrame',
      'generationMode',
    ],
    writableFields: [
      'displayName',
      'prompt',
      'model',
      'aspectRatio',
      'resolution',
      'duration',
      'hasAudio',
      'watermark',
      'returnLastFrame',
      'generationMode',
    ],
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    targetHandleIds: ['target-images', 'target-audios', 'target-videos'],
    defaultTargetHandleByDataType: {
      image: 'target-images',
      audio: 'target-audios',
      video: 'target-videos',
    },
    sourceDataTypes: ['video'],
    targetDataTypes: ['image', 'audio', 'video'],
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.sd2VideoGen],
    prompt: '',
    model: 'doubao-seedance-2-0-260128',
    aspectRatio: '16:9',
    resolution: '1080p',
    duration: 5,
    hasAudio: true,
    returnLastFrame: false,
    watermark: false,
    generationMode: 'multimodal',
    referenceImageIds: [],
    referenceAudioIds: [],
    referenceVideoIds: [],
    isSizeManuallyAdjusted: false,
    isGenerating: false,
    generationJobId: null,
    generationError: null,
  }),
};

export const canvasNodeDefinitions: Record<CanvasNodeType, CanvasNodeDefinition> = {
  [CANVAS_NODE_TYPES.upload]: uploadNodeDefinition,
  [CANVAS_NODE_TYPES.imageEdit]: imageEditNodeDefinition,
  [CANVAS_NODE_TYPES.exportImage]: exportImageNodeDefinition,
  [CANVAS_NODE_TYPES.textGeneration]: textGenerationNodeDefinition,
  [CANVAS_NODE_TYPES.textAnnotation]: textAnnotationNodeDefinition,
  [CANVAS_NODE_TYPES.group]: groupNodeDefinition,
  [CANVAS_NODE_TYPES.storyboardSplit]: storyboardSplitDefinition,
  [CANVAS_NODE_TYPES.storyboardGen]: storyboardGenNodeDefinition,
  [CANVAS_NODE_TYPES.videoFrame]: videoFrameNodeDefinition,
  [CANVAS_NODE_TYPES.videoSingle]: videoSingleNodeDefinition,
  [CANVAS_NODE_TYPES.seedanceAutoVideo]: seedanceAutoVideoNodeDefinition,
  [CANVAS_NODE_TYPES.exportVideo]: exportVideoNodeDefinition,
  [CANVAS_NODE_TYPES.audioUpload]: audioUploadNodeDefinition,
  [CANVAS_NODE_TYPES.videoUpload]: videoUploadNodeDefinition,
  [CANVAS_NODE_TYPES.audioUploadRef]: audioUploadRefNodeDefinition,
  [CANVAS_NODE_TYPES.videoUploadRef]: videoUploadRefNodeDefinition,
  [CANVAS_NODE_TYPES.sd2VideoGen]: sd2VideoGenNodeDefinition,
};

const menuNodeTypeOrder = [
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.textGeneration,
  CANVAS_NODE_TYPES.seedanceAutoVideo,
  CANVAS_NODE_TYPES.videoUpload,
  CANVAS_NODE_TYPES.audioUpload,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.textAnnotation,
] as const satisfies readonly CanvasNodeType[];

export function getNodeDefinition(type: CanvasNodeType): CanvasNodeDefinition {
  return canvasNodeDefinitions[type];
}

export function getNodeAgentAccess(type: CanvasNodeType): CanvasNodeAgentAccess {
  return canvasNodeDefinitions[type].agent;
}

export function getAgentCreatableNodeTypes(): CanvasNodeType[] {
  return Object.values(canvasNodeDefinitions)
    .filter((definition) => definition.agent.creatable)
    .map((definition) => definition.type);
}

export function getMenuNodeDefinitions(): CanvasNodeDefinition[] {
  const prioritizedTypes = new Set<CanvasNodeType>(menuNodeTypeOrder);
  const orderedDefinitions = menuNodeTypeOrder
    .map((type) => canvasNodeDefinitions[type])
    .filter((definition) => definition.visibleInMenu);
  const unprioritizedDefinitions = Object.values(canvasNodeDefinitions)
    .filter((definition) => definition.visibleInMenu && !prioritizedTypes.has(definition.type));

  return [...orderedDefinitions, ...unprioritizedDefinitions];
}

export function nodeHasSourceHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.sourceHandle;
}

export function nodeHasTargetHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.targetHandle;
}

export function getNodeSourceDataTypes(type: CanvasNodeType): CanvasDataType[] {
  return canvasNodeDefinitions[type].connectivity.sourceDataTypes;
}

export function getNodeTargetDataTypes(type: CanvasNodeType): CanvasDataType[] {
  return canvasNodeDefinitions[type].connectivity.targetDataTypes;
}

export function getConnectMenuNodeTypes(handleType: 'source' | 'target'): CanvasNodeType[] {
  const fromSource = handleType === 'source';
  return Object.values(canvasNodeDefinitions)
    .filter((definition) => (fromSource
      ? definition.connectivity.connectMenu.fromSource
      : definition.connectivity.connectMenu.fromTarget))
    .filter((definition) => (fromSource
      ? definition.connectivity.targetHandle
      : definition.connectivity.sourceHandle))
    .map((definition) => definition.type);
}
