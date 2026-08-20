import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { logger } from '@/lib/logger';
import {
  DEFAULT_ACCENT_COLOR,
  migrateAppearanceSettings,
  migrateAccentColor,
  normalizeAccentColor,
} from '@/features/settings/application/accentColor';
import {
  TEXT_REASONING_EFFORTS,
  type TextReasoningEffort,
} from '@/features/canvas/models/types';
import {
  IMAGE_OUTPUT_COUNTS,
  IMAGE_SIZES,
  type ImageOutputCount,
  type ImageSize,
  type StoryboardRatioControlMode,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_CUSTOM_IMAGE_PROTOCOL,
  FHL_IMAGE_DEFAULT_BASE_URL,
  isFhlImageBaseUrl,
  normalizeCustomImageProtocol,
  type CustomImageProtocol,
} from '@/features/canvas/models/imageProviderProtocols';

export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';
export const DEFAULT_EXTERNAL_AGENT_URL = 'http://127.0.0.1:17372';

export interface ExternalAgentConnectionConfig {
  enabled: boolean;
  url: string;
  token: string;
}

export function createDefaultExternalAgentConnectionConfig(): ExternalAgentConnectionConfig {
  return {
    enabled: false,
    url: DEFAULT_EXTERNAL_AGENT_URL,
    token: '',
  };
}

export function normalizeExternalAgentConnectionConfig(
  input: unknown
): ExternalAgentConnectionConfig {
  const defaults = createDefaultExternalAgentConnectionConfig();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defaults;
  }
  const record = input as Record<string, unknown>;
  const url = normalizeExternalAgentUrl(record.url);
  return {
    enabled: record.enabled === true && url !== null,
    url: url ?? defaults.url,
    token: typeof record.token === 'string' ? record.token.trim() : '',
  };
}

export function normalizeExternalAgentUrl(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  try {
    const url = new URL(input.trim());
    if (
      url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
export type BuiltInImageProviderId = 'ai-media' | 'chaomo';
export const CUSTOM_IMAGE_PROVIDER_ID_PREFIX = 'custom-openai:';
export type CustomImageProviderId = `${typeof CUSTOM_IMAGE_PROVIDER_ID_PREFIX}${string}`;
export type ImageProviderId = BuiltInImageProviderId | CustomImageProviderId;

export const DEFAULT_OPENAI_IMAGE_BASE_URL = 'https://api.ai-media.vip/v1';
export const DEFAULT_CHAOMO_IMAGE_BASE_URL = 'https://www.chaomoapi.com/v1';

export interface DiscoveredImageModel {
  id: string;
  label?: string;
}

export interface ImageModelCatalog {
  models: DiscoveredImageModel[];
  refreshedAt: number;
}

export interface ImageModelSelection {
  providerId: string;
  modelId: string;
}

export interface BatchAiFillSelection {
  modelId: string;
  resolution: string;
}

export type ImageGenerationExtraParamValue = boolean | number | string;

/**
 * User-level defaults applied only when a new image or storyboard generation
 * node is created. Prompt, references, frames, and generated assets remain
 * node-local creative content.
 */
export interface LastImageGenerationOptions {
  size?: ImageSize;
  requestAspectRatio?: string;
  outputCount?: ImageOutputCount;
  extraParams?: Record<string, ImageGenerationExtraParamValue>;
  storyboardGridRows?: number;
  storyboardGridCols?: number;
  storyboardRatioControlMode?: StoryboardRatioControlMode;
}

export type LastImageGenerationOptionsPatch = Omit<
  Partial<LastImageGenerationOptions>,
  'extraParams'
> & {
  extraParams?: Record<string, unknown>;
};

export interface TextGenerationModelSelection {
  apiId: string;
  modelId: string;
}

/**
 * A persisted reference to a configured text API and model used for prompt
 * polishing. It deliberately stores no credentials: the selected API remains
 * the single source of truth for connection details.
 */
export interface PromptPolishConfig {
  textApiId: string | null;
  textModelId: string | null;
  reasoningEffort: TextReasoningEffort | null;
  prompt: string;
}

export interface ImageProviderApiConfig {
  apiKey: string;
  baseUrl: string;
  modelCatalog: ImageModelCatalog | null;
  selectedModelIds: string[];
}

export type OpenAiImageApiConfig = ImageProviderApiConfig;
export type ChaomoImageApiConfig = ImageProviderApiConfig;

export interface CustomImageApiConfig extends ImageProviderApiConfig {
  id: CustomImageProviderId;
  name: string;
  protocol: CustomImageProtocol;
}

export function isCustomImageProviderId(providerId: string): providerId is CustomImageProviderId {
  return providerId.startsWith(CUSTOM_IMAGE_PROVIDER_ID_PREFIX)
    && providerId.length > CUSTOM_IMAGE_PROVIDER_ID_PREFIX.length;
}

export function createCustomImageApiConfig(
  id: CustomImageProviderId = `${CUSTOM_IMAGE_PROVIDER_ID_PREFIX}${crypto.randomUUID()}`
): CustomImageApiConfig {
  return {
    id,
    name: '',
    protocol: DEFAULT_CUSTOM_IMAGE_PROTOCOL,
    apiKey: '',
    baseUrl: '',
    modelCatalog: null,
    selectedModelIds: [],
  };
}

export function createDefaultOpenAiImageApiConfig(): OpenAiImageApiConfig {
  return {
    apiKey: '',
    baseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
    modelCatalog: null,
    selectedModelIds: [],
  };
}

export function createDefaultChaomoImageApiConfig(): ChaomoImageApiConfig {
  return {
    apiKey: '',
    baseUrl: DEFAULT_CHAOMO_IMAGE_BASE_URL,
    modelCatalog: null,
    selectedModelIds: [],
  };
}

export interface TextApiConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  modelCatalog: ImageModelCatalog | null;
  selectedModelIds: string[];
  enabled: boolean;
}

export function createTextApiConfig(): TextApiConfig {
  return {
    id: `custom-${crypto.randomUUID()}`,
    name: '',
    apiKey: '',
    baseUrl: '',
    modelId: '',
    modelCatalog: null,
    selectedModelIds: [],
    enabled: false,
  };
}

export interface VideoApiConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  /** Runtime protocol used by this video endpoint. */
  protocol?: 'volcengine-seedance';
  polishPrompt?: string;
  defaultPolishPrompt?: string;
}

export const PRESET_TEXT_APIS: TextApiConfig[] = [
  {
    id: 'volc-coding-plan',
    name: '火山引擎 Coding Plan (Chat)',
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    modelId: 'doubao-seed-2.0-pro',
    modelCatalog: null,
    selectedModelIds: ['doubao-seed-2.0-pro'],
    enabled: false,
  },
  {
    id: 'volc-responses-api',
    name: '火山引擎 Responses API',
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelId: 'doubao-seed-2-0-pro-260215',
    modelCatalog: null,
    selectedModelIds: ['doubao-seed-2-0-pro-260215'],
    enabled: false,
  },
];

export const DEFAULT_IMAGE_POLISH_PROMPT = `你是专业的AI绘画提示词润色专家。我将为你提供待优化的原始AI绘画提示词（可能包含参考图片的@引用标记），请按照以下要求进行深度优化：

1. 核心任务：深度理解原始提示词的核心语义和用户期望的视觉目标
2. 视觉增强：从画面构图、风格流派、色彩调性、光影效果、主体元素、质感表现、氛围情绪等维度进行专业增强
3. AI适配：结合AI绘画工具的生成逻辑进行优化补充
4. 输出要求：直接输出润色后的提示词，不需要任何解释或前缀说明

请直接输出优化后的提示词文本。`;

export const DEFAULT_TEXT_POLISH_PROMPT = `你是专业的文本提示词润色助手。我将为你提供一段需要交给文本模型处理的提示词，请按照以下要求优化：

1. 保留原始任务、事实、限制条件、语气和输出要求，不擅自改变用户意图
2. 消除歧义与重复，补全必要的上下文、对象、步骤与验收条件，使指令清晰可执行
3. 使用结构化、自然且简洁的表达；只有原始内容确实需要时才补充合理细节
4. 输出要求：只输出润色后的提示词，不解释修改过程，不添加前缀或结语

请直接输出优化后的文本提示词。`;

export function createPromptPolishConfig(prompt: string): PromptPolishConfig {
  return {
    textApiId: null,
    textModelId: null,
    reasoningEffort: null,
    prompt,
  };
}

export const DEFAULT_VIDEO_API_PROMPT = `你是专业的 AI 视频生成提示词润色专家，具备丰富的镜头语言、视觉美学和 AI 生成适配经验。我将为你提供参考图片和待优化的原始 AI 视频提示词（可能为空），请严格遵循以下要求，完成深度优化，确保优化后的提示词精准适配 AI 视频生成工具，能直接生成符合预期的视觉效果：
核心前提：深度拆解原始提示词的核心语义、镜头逻辑、动态需求和视觉预期，不偏离用户核心诉求，不添加无关元素，同时弥补原始提示词的细节缺失。
优化核心维度（按需精准融入，不冗余，贴合 AI 生成特性）：
场景：明确环境、具体地点、背景细节（如天气、植被、建筑风格、空间层次），补充环境动态变化（如风吹，光影流动、烟雾飘动）；
时长：根据视频总时长，可拆分关键镜头时长分配；
景别：精准标注每段镜头景别（远景 / 全景 / 中景 / 近景 / 特写），明确景别切换逻辑，贴合内容节奏；
运镜：适配 AI 工具可实现的运镜方式（固定镜头、镜头推进、镜头拉远、镜头跟随、镜头环绕、镜头右摇、镜头左摇、镜头上摇、镜头下摇），标注运镜速度和幅度，避免复杂难实现的运镜；
角色 / 主体：详细描述外观细节、色彩、纹理、状态，明确表情、连贯动作及运动轨迹，突出主体辨识度；
情绪基调：精准定位整体情绪（紧张、压抑、温馨、科幻、惊悚等），并通过光影、色彩、动作强化情绪表达；
光影：明确光源类型（自然光 / 人工光 / 特殊光源）、光线方向、明暗对比，补充光影动态效果（如光斑移动、反光变化），增强画面层次感；
动作：细化主体及环境的连贯动作，标注动作速度、幅度，确保动态流畅自然，符合逻辑；
氛围：强化整体视觉氛围（写实、科幻、复古、梦幻、末日等），通过色彩、光影、环境细节统一氛围基调；
台词 / 旁白（按需）：简洁适配视频时长，贴合内容节奏，语言自然，符合整体情绪；
音效 / 配乐（按需）：明确背景音乐风格、环境音细节、特效音，贴合画面节奏和情绪，增强沉浸感。
AI 适配优化：结合主流 AI 视频生成工具的特性（时长限制、运镜兼容性、动态效果上限、细节渲染能力），优化提示词表述，避免模糊化描述，确保视频生成 AI 能精准解析，减少生成偏差；优先选择视频生成 AI 易实现的动态和光影效果，同时保留核心视觉诉求。
输出规范：仅输出润色后的完整视频提示词，无任何多余解释、前缀或后缀，语言简洁精准、逻辑清晰，镜头和动态描述连贯，可直接复制用于 AI 视频生成。`;

// Seedance-1.0-pro / pro-fast 提示词润色模板
export const DEFAULT_VIDEO_SD10_POLISH_PROMPT = `一、润色总规则
1. 按官方逻辑：主体 + 动作 + 镜头语言 + 景别视角 + 风格美感 + 多镜头（可选）+ 特效（可选）
2. 动作按时序清晰描述，多动作依次写明
3. 镜头使用官方标准运镜词，不自创术语
4. 多镜头用镜头切换连接，保持主体、风格、场景统一
5. 描述具体、细节充足、无模糊笼统表述

二、固定输出结构
【主体】
【动作】
【镜头语言】
【景别与视角】
【画面风格与美感】
【多镜头叙事（可选）】
【创意特效（可选）】

三、各模块润色标准
【主体】
• 明确人物 / 动物 / 事物
• 可描述外貌、衣着、体型、神态、特征
• 多人 / 多物分别说明，避免模糊指代
【动作】
• 基础动作：主体 + 动作
• 多动作：按发生顺序依次描述
• 单人物多动作、多人物多动作均按时序写清
【镜头语言】
• 支持运镜：推、拉、摇、移、环绕、跟随、升、降、变焦
• 复杂运镜：可组合多个动作，实现长镜头、一镜到底
【景别与视角】
• 景别：远景、全景、中景、近景、特写
• 视角：航拍、高机位俯拍、低机位仰拍、微距摄影、过肩镜头、水下镜头、以 xx 为前景的镜头
【画面风格与美感】
• 风格：2D、3D，体素、像素，毛毡、粘土、插画、黑白线稿
• 视频类型：喜庆土味短视频、欧洲文艺电影、复古香港电影、恐怖片，写实电影
• 氛围：油画感、复古氛围、温馨、治愈、紧张、悬疑、高级质感、柔和
• 画质：1080P 高清、磨皮、美颜滤镜、细节清晰、有质感
【多镜头叙事】
• 用镜头切换连接各镜头
• 切镜后保持主体、风格、场景统一
• 每个镜头写明景别、视角、动作、氛围
【创意特效】
• 描述发光、色彩变化、粒子、环境突变等效果
• 与动作、镜头、氛围匹配

四、禁止项
• 动作时序混乱
• 使用非官方镜头术语
• 多镜头不用 "镜头切换" 连接
• 风格前后不一致
• 描述模糊、笼统、缺失关键信息`;

// Seedance-1.5-pro 提示词润色模板
export const DEFAULT_VIDEO_SD15_PROMPT = `Seedance-1.5-pro 提示词润色规范（AI 专用）
润色总原则
按固定结构：主体 + 运动 + 环境 + 运镜 / 切镜 + 美学描述 + 声音
描述必要信息，描述清晰信息
提示词与画面、音频形成正确对应
用特征指定主体，指定方式全程一致
精准进行切镜描述
输出结构
【主体】【运动】【环境】【镜头 / 运镜 / 切镜】【美学风格】【声音】
各模块润色标准
主体
用特征指定主体，全程指定方式保持一致
多人场景按位置与顺序明确区分身份
不使用模糊表述
运动
动作幅度自然，节奏感强
精准捕捉动作细节
人物情绪与表情呈现细腻
环境
明确场景地点，光线、氛围与背景元素
与主体、动作、情绪保持统一
镜头 / 运镜 / 切镜
景别：远景、全景、中景、近景、特写、头像，胸像、半身像，全身像
运镜：推、拉、摇、移、跟、升、降、甩、环绕、旋转、变焦、希区柯克、子弹时间
视角：高机位、低机位、俯视、仰视、平视、正扣、正仰、过肩、正面、侧面、背面、鱼眼、望远镜
稳定度：固定、手持呼吸感、稳定无抖动
切镜：明确每个镜头，精准标注切镜时机，切镜之间有明确景别与内容区分
美学风格
全程使用单一主风格
可使用：写实、迪士尼、皮克斯、宫崎骏、小森林日剧、赛博朋克、暗黑奇幻等
保持画面质感与色调统一
声音
人声格式：性别 + 年龄区间 + 声音属性 + 语速 + 情绪基线 + 语言 / 方言 + 台词
支持语言：普通话、四川话、粤语、陕西话、台湾腔、英语、日语、韩语、西班牙语、印尼语及小语种
音效：环境音、动作音、合成音、乐器音，与画面同步触发
BGM：风格、情绪、节奏与画面运动匹配
禁止项
主体特征前后不一致
切镜无标注、逻辑混乱
音画不同步、口型不匹配
使用非规范镜头术语
描述模糊、笼统、冗余
多种风格混搭冲突`;

export const PRESET_VIDEO_APIS: VideoApiConfig[] = [
  {
    id: 'volc-seedance-2-0',
    name: 'Seedance 2.0',
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelId: 'doubao-seedance-2-0-260128',
    enabled: true,
    protocol: 'volcengine-seedance',
    defaultPolishPrompt: DEFAULT_VIDEO_SD10_POLISH_PROMPT,
  },
  {
    id: 'volc-seedance-2-0-fast',
    name: 'Seedance 2.0 Fast',
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelId: 'doubao-seedance-2-0-fast-260128',
    enabled: false,
    protocol: 'volcengine-seedance',
    defaultPolishPrompt: DEFAULT_VIDEO_SD10_POLISH_PROMPT,
  },
];

/**
 * 合并视频API配置，确保所有预设模型都存在
 * 保留用户已添加的自定义API，同时添加缺失的预设模型
 */
export function normalizeVideoApiConfigs(input: unknown): VideoApiConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenIds = new Set<string>();
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);

    return [{
      id,
      name: typeof record.name === 'string' ? record.name.trim() : '',
      apiKey: normalizeApiKey(typeof record.apiKey === 'string' ? record.apiKey : ''),
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '',
      modelId: typeof record.modelId === 'string' ? record.modelId.trim() : '',
      enabled: record.enabled === true,
      protocol: 'volcengine-seedance',
      ...(typeof record.polishPrompt === 'string' ? { polishPrompt: record.polishPrompt } : {}),
      ...(typeof record.defaultPolishPrompt === 'string'
        ? { defaultPolishPrompt: record.defaultPolishPrompt }
        : {}),
    }];
  });
}

function mergeVideoApis(existingApis?: VideoApiConfig[]): VideoApiConfig[] {
  const normalizedApis = normalizeVideoApiConfigs(existingApis);
  if (normalizedApis.length === 0) {
    return PRESET_VIDEO_APIS;
  }

  // Preset membership is defined by the stable configuration ID. Model IDs are user-editable.
  const existingIds = new Set(normalizedApis.map((api) => api.id));

  // 找出缺失的预设配置
  const missingPresets = PRESET_VIDEO_APIS.filter(
    (preset) => !existingIds.has(preset.id)
  );

  // 如果有缺失的预设配置，合并它们
  if (missingPresets.length > 0) {
    return [...normalizedApis, ...missingPresets];
  }

  return normalizedApis;
}

interface SettingsState {
  isHydrated: boolean;
  openAiImageApi: OpenAiImageApiConfig;
  chaomoImageApi: ChaomoImageApiConfig;
  customImageApis: CustomImageApiConfig[];
  downloadPresetPaths: string[];
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  snapToGridEnabled: boolean;
  snapGridSize: number;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  externalAgentConnection: ExternalAgentConnectionConfig;
  textApis: TextApiConfig[];
  activeTextApiId: string | null;
  imagePolishConfig: PromptPolishConfig;
  textPolishConfig: PromptPolishConfig;
  videoApis: VideoApiConfig[];
  activeVideoApiId: string | null;
  lastImageModelSelection: ImageModelSelection | null;
  lastBatchAiFillSelection: BatchAiFillSelection | null;
  lastImageGenerationOptions: LastImageGenerationOptions;
  lastTextGenerationModelSelection: TextGenerationModelSelection | null;
  setOpenAiImageApi: (config: OpenAiImageApiConfig) => void;
  setChaomoImageApi: (config: ChaomoImageApiConfig) => void;
  setCustomImageApis: (configs: CustomImageApiConfig[]) => void;
  setLastImageModelSelection: (selection: ImageModelSelection | null) => void;
  setLastBatchAiFillSelection: (selection: BatchAiFillSelection | null) => void;
  updateLastImageGenerationOptions: (options: LastImageGenerationOptionsPatch) => void;
  setLastTextGenerationModelSelection: (
    selection: TextGenerationModelSelection | null
  ) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setAccentColor: (color: string) => void;
  setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => void;
  setSnapToGridEnabled: (enabled: boolean) => void;
  setSnapGridSize: (size: number) => void;
  setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => void;
  setEnableUpdateDialog: (enabled: boolean) => void;
  setExternalAgentConnection: (config: ExternalAgentConnectionConfig) => void;
  setTextApis: (apis: TextApiConfig[]) => void;
  setActiveTextApiId: (id: string | null) => void;
  setImagePolishConfig: (config: PromptPolishConfig) => void;
  setTextPolishConfig: (config: PromptPolishConfig) => void;
  setVideoApis: (apis: VideoApiConfig[]) => void;
  setActiveVideoApiId: (id: string | null) => void;
}

function normalizeApiKey(input: string): string {
  return input.trim();
}

function normalizeDiscoveredImageModels(input: unknown): DiscoveredImageModel[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const modelById = new Map<string, DiscoveredImageModel>();
  input.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || modelById.has(id)) {
      return;
    }
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    modelById.set(id, label ? { id, label } : { id });
  });

  return Array.from(modelById.values());
}

function normalizeImageModelCatalog(input: unknown): ImageModelCatalog | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const models = normalizeDiscoveredImageModels(record.models);
  const refreshedAt = typeof record.refreshedAt === 'number' && Number.isFinite(record.refreshedAt)
    ? record.refreshedAt
    : Date.now();

  return { models, refreshedAt };
}

export function normalizeTextApiConfigs(input: unknown): TextApiConfig[] {
  const source = Array.isArray(input) ? input : PRESET_TEXT_APIS;
  const seenIds = new Set<string>();

  return source.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);

    const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
    const selectedModelIds = Array.from(new Set([
      ...(Array.isArray(record.selectedModelIds)
        ? record.selectedModelIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
        : []),
      ...(modelId ? [modelId] : []),
    ]));
    return [{
      id,
      name: typeof record.name === 'string' ? record.name.trim() : '',
      apiKey: normalizeApiKey(typeof record.apiKey === 'string' ? record.apiKey : ''),
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '',
      modelId: modelId || selectedModelIds[0] || '',
      modelCatalog: normalizeImageModelCatalog(record.modelCatalog),
      selectedModelIds,
      enabled: record.enabled === true,
    }];
  });
}

function normalizeSelectedModelIds(input: unknown, catalog: ImageModelCatalog | null): string[] {
  if (!catalog || !Array.isArray(input)) {
    return [];
  }

  const availableIds = new Set(catalog.models.map((model) => model.id));
  return Array.from(
    new Set(
      input
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => availableIds.has(value))
    )
  );
}

function normalizeOpenAiImageApiConfig(
  input: Partial<OpenAiImageApiConfig> | null | undefined
): OpenAiImageApiConfig {
  const defaults = createDefaultOpenAiImageApiConfig();
  const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const modelCatalog = normalizeImageModelCatalog(input?.modelCatalog);

  return {
    apiKey: normalizeApiKey(input?.apiKey ?? ''),
    baseUrl: baseUrl || defaults.baseUrl,
    modelCatalog,
    selectedModelIds: normalizeSelectedModelIds(input?.selectedModelIds, modelCatalog),
  };
}

function normalizeChaomoImageApiConfig(
  input: Partial<ChaomoImageApiConfig> | null | undefined
): ChaomoImageApiConfig {
  const defaults = createDefaultChaomoImageApiConfig();
  const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const modelCatalog = normalizeImageModelCatalog(input?.modelCatalog);

  return {
    apiKey: normalizeApiKey(input?.apiKey ?? ''),
    baseUrl: baseUrl || defaults.baseUrl,
    modelCatalog,
    selectedModelIds: normalizeSelectedModelIds(input?.selectedModelIds, modelCatalog),
  };
}

function normalizeCustomImageApiConfigs(input: unknown): CustomImageApiConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenIds = new Set<string>();
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!isCustomImageProviderId(id) || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);

    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const protocol = normalizeCustomImageProtocol(record.protocol);
    const configuredBaseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '';
    const baseUrl = protocol === 'fhl-images' && !configuredBaseUrl
      ? FHL_IMAGE_DEFAULT_BASE_URL
      : configuredBaseUrl;
    const modelCatalog = normalizeImageModelCatalog(record.modelCatalog);
    return [{
      id,
      name,
      protocol,
      apiKey: normalizeApiKey(typeof record.apiKey === 'string' ? record.apiKey : ''),
      baseUrl,
      modelCatalog,
      selectedModelIds: normalizeSelectedModelIds(record.selectedModelIds, modelCatalog),
    }];
  });
}

function migrateLegacyFhlImageApiConfigs(
  configs: CustomImageApiConfig[]
): CustomImageApiConfig[] {
  return configs.map((config) => (
    config.protocol === 'openai-images' && isFhlImageBaseUrl(config.baseUrl)
      ? { ...config, protocol: 'fhl-images' }
      : config
  ));
}

function normalizeImageModelSelection(input: unknown): ImageModelSelection | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const providerId = record.providerId;
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  if (
    (providerId !== 'ai-media'
      && providerId !== 'chaomo'
      && !(typeof providerId === 'string' && isCustomImageProviderId(providerId)))
    || !modelId
  ) {
    return null;
  }
  return { providerId, modelId };
}

export function normalizeBatchAiFillSelection(input: unknown): BatchAiFillSelection | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  const resolution = typeof record.resolution === 'string' ? record.resolution.trim() : '';
  return modelId && resolution ? { modelId, resolution } : null;
}

function normalizeImageGenerationExtraParams(
  input: unknown
): Record<string, ImageGenerationExtraParamValue> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }

  const normalized: Record<string, ImageGenerationExtraParamValue> = {};
  Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    if (
      typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || typeof value === 'string'
    ) {
      normalized[normalizedKey] = value;
    }
  });
  return normalized;
}

export function normalizeLastImageGenerationOptions(input: unknown): LastImageGenerationOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const record = input as Record<string, unknown>;
  const size = typeof record.size === 'string' && (IMAGE_SIZES as readonly string[]).includes(record.size)
    ? record.size as ImageSize
    : undefined;
  const requestAspectRatio = typeof record.requestAspectRatio === 'string'
    && record.requestAspectRatio.trim()
    ? record.requestAspectRatio.trim()
    : undefined;
  const outputCount = typeof record.outputCount === 'number'
    && (IMAGE_OUTPUT_COUNTS as readonly number[]).includes(record.outputCount)
    ? record.outputCount as ImageOutputCount
    : undefined;
  const storyboardGridRows = typeof record.storyboardGridRows === 'number'
    && Number.isInteger(record.storyboardGridRows)
    && record.storyboardGridRows >= 1
    && record.storyboardGridRows <= 9
    ? record.storyboardGridRows
    : undefined;
  const storyboardGridCols = typeof record.storyboardGridCols === 'number'
    && Number.isInteger(record.storyboardGridCols)
    && record.storyboardGridCols >= 1
    && record.storyboardGridCols <= 9
    ? record.storyboardGridCols
    : undefined;
  const storyboardRatioControlMode = record.storyboardRatioControlMode === 'overall'
    || record.storyboardRatioControlMode === 'cell'
    ? record.storyboardRatioControlMode
    : undefined;
  const extraParams = normalizeImageGenerationExtraParams(record.extraParams);

  return {
    ...(size ? { size } : {}),
    ...(requestAspectRatio ? { requestAspectRatio } : {}),
    ...(outputCount !== undefined ? { outputCount } : {}),
    ...(extraParams ? { extraParams } : {}),
    ...(storyboardGridRows !== undefined ? { storyboardGridRows } : {}),
    ...(storyboardGridCols !== undefined ? { storyboardGridCols } : {}),
    ...(storyboardRatioControlMode ? { storyboardRatioControlMode } : {}),
  };
}

function normalizeTextGenerationModelSelection(
  input: unknown
): TextGenerationModelSelection | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const apiId = typeof record.apiId === 'string' ? record.apiId.trim() : '';
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  return apiId && modelId ? { apiId, modelId } : null;
}

export function normalizePromptPolishConfig(
  input: unknown,
  defaultPrompt: string
): PromptPolishConfig {
  if (!input || typeof input !== 'object') {
    return createPromptPolishConfig(defaultPrompt);
  }
  const record = input as Record<string, unknown>;
  const textApiId = typeof record.textApiId === 'string' && record.textApiId.trim()
    ? record.textApiId.trim()
    : null;
  const textModelId = typeof record.textModelId === 'string' && record.textModelId.trim()
    ? record.textModelId.trim()
    : null;
  const reasoningEffort = typeof record.reasoningEffort === 'string'
    && TEXT_REASONING_EFFORTS.includes(record.reasoningEffort as TextReasoningEffort)
    ? record.reasoningEffort as TextReasoningEffort
    : null;
  return {
    textApiId,
    textModelId,
    reasoningEffort,
    prompt: typeof record.prompt === 'string' ? record.prompt : defaultPrompt,
  };
}

function resolveLegacyPromptPolishSelection(
  textApis: TextApiConfig[]
): TextGenerationModelSelection | null {
  const api = textApis.find((candidate) => candidate.enabled);
  if (!api) {
    return null;
  }
  const modelIds = api.selectedModelIds.length > 0
    ? api.selectedModelIds
    : api.modelId ? [api.modelId] : [];
  const modelId = modelIds.includes(api.modelId) ? api.modelId : modelIds[0];
  return modelId ? { apiId: api.id, modelId } : null;
}

function createLegacyImagePolishConfig(
  textApis: TextApiConfig[],
  reasoningEffort: TextReasoningEffort | null | undefined,
  prompt: string | undefined
): PromptPolishConfig {
  const selection = resolveLegacyPromptPolishSelection(textApis);
  return {
    textApiId: selection?.apiId ?? null,
    textModelId: selection?.modelId ?? null,
    reasoningEffort: reasoningEffort && TEXT_REASONING_EFFORTS.includes(reasoningEffort)
      ? reasoningEffort
      : null,
    prompt: prompt ?? DEFAULT_IMAGE_POLISH_PROMPT,
  };
}

function normalizeCanvasEdgeRoutingMode(
  input: CanvasEdgeRoutingMode | string | null | undefined
): CanvasEdgeRoutingMode {
  if (input === 'orthogonal' || input === 'smartOrthogonal' || input === 'spline') {
    return input;
  }
  return 'spline';
}

export function migrateSettingsState(persistedState: unknown, persistedVersion: number) {
  const state = migrateAppearanceSettings(persistedState) as Record<string, unknown> & {
    openAiImageApi?: Partial<OpenAiImageApiConfig>;
    chaomoImageApi?: Partial<ChaomoImageApiConfig>;
    customImageApis?: CustomImageApiConfig[];
    canvasEdgeRoutingMode?: CanvasEdgeRoutingMode | string;
    textApis?: TextApiConfig[];
    activeTextApiId?: string | null;
    textPolishReasoningEffort?: TextReasoningEffort | null;
    imagePolishPrompt?: string;
    imagePolishConfig?: PromptPolishConfig;
    textPolishConfig?: PromptPolishConfig;
    videoApis?: VideoApiConfig[];
    activeVideoApiId?: string | null;
    lastImageModelSelection?: ImageModelSelection | null;
    lastBatchAiFillSelection?: BatchAiFillSelection | null;
    lastImageGenerationOptions?: LastImageGenerationOptions;
    lastTextGenerationModelSelection?: TextGenerationModelSelection | null;
    accentColor?: unknown;
    externalAgentConnection?: ExternalAgentConnectionConfig;
  };
  const {
    apiKey: _legacyApiKey,
    apiKeys: _legacyApiKeys,
    grsaiNanoBananaProModel: _legacyGrsaiModel,
    hideProviderGuidePopover: _legacyProviderGuide,
    showNodePrice: _legacyShowNodePrice,
    priceDisplayCurrencyMode: _legacyPriceCurrency,
    usdToCnyRate: _legacyUsdToCnyRate,
    preferDiscountedPrice: _legacyDiscountPreference,
    grsaiCreditTierId: _legacyGrsaiCreditTier,
    textPolishReasoningEffort: legacyTextPolishReasoningEffort,
    imagePolishPrompt: legacyImagePolishPrompt,
    ...retainedState
  } = state;

  const textApis = normalizeTextApiConfigs(state.textApis);
  const normalizedCustomImageApis = normalizeCustomImageApiConfigs(state.customImageApis);
  const customImageApis = persistedVersion < 28
    ? migrateLegacyFhlImageApiConfigs(normalizedCustomImageApis)
    : normalizedCustomImageApis;
  const legacyImagePolishConfig = createLegacyImagePolishConfig(
    textApis,
    legacyTextPolishReasoningEffort,
    legacyImagePolishPrompt
  );
  const imagePolishConfig = normalizePromptPolishConfig(
    state.imagePolishConfig ?? legacyImagePolishConfig,
    DEFAULT_IMAGE_POLISH_PROMPT
  );

  return {
    ...retainedState,
    isHydrated: true,
    openAiImageApi: normalizeOpenAiImageApiConfig(state.openAiImageApi),
    chaomoImageApi: normalizeChaomoImageApiConfig(state.chaomoImageApi),
    customImageApis,
    canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
    accentColor: migrateAccentColor(state.accentColor),
    externalAgentConnection: normalizeExternalAgentConnectionConfig(
      state.externalAgentConnection
    ),
    ...(persistedVersion < 22 && (state.snapGridSize === 20 || state.snapGridSize === 36)
      ? { snapGridSize: 72 }
      : {}),
    textApis,
    activeTextApiId: state.activeTextApiId ?? null,
    imagePolishConfig,
    textPolishConfig: normalizePromptPolishConfig(
      state.textPolishConfig ?? {
        textApiId: imagePolishConfig.textApiId,
        textModelId: imagePolishConfig.textModelId,
        reasoningEffort: imagePolishConfig.reasoningEffort,
        prompt: DEFAULT_TEXT_POLISH_PROMPT,
      },
      DEFAULT_TEXT_POLISH_PROMPT
    ),
    videoApis: mergeVideoApis(state.videoApis),
    activeVideoApiId: state.activeVideoApiId ?? null,
    lastImageModelSelection: normalizeImageModelSelection(state.lastImageModelSelection),
    lastBatchAiFillSelection: normalizeBatchAiFillSelection(state.lastBatchAiFillSelection),
    lastImageGenerationOptions: normalizeLastImageGenerationOptions(
      state.lastImageGenerationOptions
    ),
    lastTextGenerationModelSelection: normalizeTextGenerationModelSelection(
      state.lastTextGenerationModelSelection
    ),
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      isHydrated: false,
      openAiImageApi: createDefaultOpenAiImageApiConfig(),
      chaomoImageApi: createDefaultChaomoImageApiConfig(),
      customImageApis: [],
      downloadPresetPaths: [],
      useUploadFilenameAsNodeTitle: true,
      storyboardGenKeepStyleConsistent: true,
      storyboardGenDisableTextInImage: true,
      storyboardGenAutoInferEmptyFrame: true,
      ignoreAtTagWhenCopyingAndGenerating: true,
      enableStoryboardGenGridPreviewShortcut: false,
      showStoryboardGenAdvancedRatioControls: false,
      accentColor: DEFAULT_ACCENT_COLOR,
      canvasEdgeRoutingMode: 'spline',
      snapToGridEnabled: false,
      snapGridSize: 72,
      autoCheckAppUpdateOnLaunch: true,
      enableUpdateDialog: true,
      externalAgentConnection: createDefaultExternalAgentConnectionConfig(),
      setOpenAiImageApi: (config) =>
        set((state) => {
          const openAiImageApi = normalizeOpenAiImageApiConfig(config);
          const lastImageModelSelection = state.lastImageModelSelection?.providerId === 'ai-media' &&
            !openAiImageApi.selectedModelIds.includes(state.lastImageModelSelection.modelId)
            ? null
            : state.lastImageModelSelection;
          return { openAiImageApi, lastImageModelSelection };
        }),
      setChaomoImageApi: (config) =>
        set((state) => {
          const chaomoImageApi = normalizeChaomoImageApiConfig(config);
          const lastImageModelSelection = state.lastImageModelSelection?.providerId === 'chaomo' &&
            !chaomoImageApi.selectedModelIds.includes(state.lastImageModelSelection.modelId)
            ? null
            : state.lastImageModelSelection;
          return { chaomoImageApi, lastImageModelSelection };
        }),
      setCustomImageApis: (configs) =>
        set((state) => {
          const customImageApis = normalizeCustomImageApiConfigs(configs);
          const lastSelection = state.lastImageModelSelection;
          const selectedProvider = lastSelection && isCustomImageProviderId(lastSelection.providerId)
            ? customImageApis.find((config) => config.id === lastSelection.providerId)
            : undefined;
          const lastImageModelSelection = lastSelection && isCustomImageProviderId(lastSelection.providerId)
            && (!selectedProvider || !selectedProvider.selectedModelIds.includes(lastSelection.modelId))
            ? null
            : lastSelection;
          return { customImageApis, lastImageModelSelection };
        }),
      setDownloadPresetPaths: (paths) => {
        const uniquePaths = Array.from(
          new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))
        ).slice(0, 8);
        set({ downloadPresetPaths: uniquePaths });
      },
      setUseUploadFilenameAsNodeTitle: (enabled) => set({ useUploadFilenameAsNodeTitle: enabled }),
      setStoryboardGenKeepStyleConsistent: (enabled) =>
        set({ storyboardGenKeepStyleConsistent: enabled }),
      setStoryboardGenDisableTextInImage: (enabled) =>
        set({ storyboardGenDisableTextInImage: enabled }),
      setStoryboardGenAutoInferEmptyFrame: (enabled) =>
        set({ storyboardGenAutoInferEmptyFrame: enabled }),
      setIgnoreAtTagWhenCopyingAndGenerating: (enabled) =>
        set({ ignoreAtTagWhenCopyingAndGenerating: enabled }),
      setEnableStoryboardGenGridPreviewShortcut: (enabled) =>
        set({ enableStoryboardGenGridPreviewShortcut: enabled }),
      setShowStoryboardGenAdvancedRatioControls: (enabled) =>
        set({ showStoryboardGenAdvancedRatioControls: enabled }),
      setAccentColor: (color) => set({ accentColor: normalizeAccentColor(color) }),
      setCanvasEdgeRoutingMode: (canvasEdgeRoutingMode) =>
        set({ canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(canvasEdgeRoutingMode) }),
      setSnapToGridEnabled: (enabled: boolean) => set({ snapToGridEnabled: enabled }),
      setSnapGridSize: (size: number) => set({ snapGridSize: Math.max(5, Math.min(100, size)) }),
      setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => set({ autoCheckAppUpdateOnLaunch: enabled }),
      setEnableUpdateDialog: (enabled) => set({ enableUpdateDialog: enabled }),
      setExternalAgentConnection: (config) => set({
        externalAgentConnection: normalizeExternalAgentConnectionConfig(config),
      }),
      textApis: PRESET_TEXT_APIS,
      activeTextApiId: null,
      setTextApis: (apis) => set({ textApis: normalizeTextApiConfigs(apis) }),
      setActiveTextApiId: (id) => set({ activeTextApiId: id }),
      imagePolishConfig: createPromptPolishConfig(DEFAULT_IMAGE_POLISH_PROMPT),
      textPolishConfig: createPromptPolishConfig(DEFAULT_TEXT_POLISH_PROMPT),
      setImagePolishConfig: (config) => set({
        imagePolishConfig: normalizePromptPolishConfig(config, DEFAULT_IMAGE_POLISH_PROMPT),
      }),
      setTextPolishConfig: (config) => set({
        textPolishConfig: normalizePromptPolishConfig(config, DEFAULT_TEXT_POLISH_PROMPT),
      }),
      videoApis: PRESET_VIDEO_APIS,
      activeVideoApiId: null,
      lastImageModelSelection: null,
      setLastImageModelSelection: (selection) =>
        set({ lastImageModelSelection: normalizeImageModelSelection(selection) }),
      lastBatchAiFillSelection: null,
      setLastBatchAiFillSelection: (selection) =>
        set({ lastBatchAiFillSelection: normalizeBatchAiFillSelection(selection) }),
      lastImageGenerationOptions: {},
      updateLastImageGenerationOptions: (options) =>
        set((state) => ({
          lastImageGenerationOptions: {
            ...state.lastImageGenerationOptions,
            ...normalizeLastImageGenerationOptions(options),
          },
        })),
      lastTextGenerationModelSelection: null,
      setLastTextGenerationModelSelection: (selection) => set({
        lastTextGenerationModelSelection: normalizeTextGenerationModelSelection(selection),
      }),
      setVideoApis: (apis) => {
        set({ videoApis: mergeVideoApis(apis) });
      },
      setActiveVideoApiId: (id) => set({ activeVideoApiId: id }),
    }),
    {
      name: 'settings-storage',
      version: 31,
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            logger.error('failed to hydrate settings storage', error);
          }
          useSettingsStore.setState({ isHydrated: true });
        };
      },
      migrate: migrateSettingsState,
    }
  )
);
