import type {
  GenerateTextPayload,
  TextProviderRuntimeConfig,
} from '@/features/canvas/application/ports';
import { MAX_TEXT_GENERATION_REFERENCE_IMAGES } from '@/features/canvas/application/textGenerationInputs';
import {
  TEXT_REASONING_EFFORTS,
  type TextReasoningEffort,
} from '@/features/canvas/models/types';
import {
  DEFAULT_IMAGE_POLISH_PROMPT,
  DEFAULT_TEXT_POLISH_PROMPT,
  DEFAULT_VIDEO_API_PROMPT,
  type TextApiConfig,
} from '@/features/settings/domain/settingsSchema';
import i18n from '@/i18n';
import { assertNetworkAvailable } from '@/runtime/networkAvailability';
import { createBrowserMediaGateway } from '@/features/media/infrastructure/browserMediaGateway';
import { sourceToImageFile } from './webImageApi';

const TEXT_GATEWAY_PATH = '/api/generation/text';
const TEXT_REFERENCE_PROVIDER_ID = 'text-reference';

export interface WebTextApiOptions {
  fetchImpl?: typeof fetch;
}

export interface WebTextPolishPayload {
  text: string;
  referenceImages?: string[];
  videoDuration?: string;
  videoResolution?: string;
  videoAspectRatio?: string;
  videoShotType?: string;
  videoShotSize?: string;
  videoAngle?: string;
  videoCameraMovement?: string;
  videoCameraSpeed?: string;
  isVideoFrame?: boolean;
  customPrompt?: string;
  promptType?: string;
  reasoningEffort?: TextReasoningEffort;
}

interface TextApiRequest {
  endpoint: string;
  body: Record<string, unknown>;
}

interface TextApiConfigLike {
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

function normalizeBaseUrl(baseUrl: string): URL {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new Error(i18n.t('generationGateway.textBaseUrlRequired'));
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(i18n.t('generationGateway.textBaseUrlInvalid'));
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(i18n.t('generationGateway.textBaseUrlNotSupported'));
  }
  url.hash = '';
  return url;
}

function endpointWithPath(baseUrl: string, suffix: string): string {
  const url = normalizeBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(suffix) ? path : path ? `${path}${suffix}` : `/v1${suffix}`;
  return url.toString();
}

export function resolveModelsEndpoint(baseUrl: string): string {
  const url = normalizeBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/models')
    ? path
    : path ? `${path}/models` : '/v1/models';
  return url.toString();
}

export function resolveChatCompletionsEndpoint(baseUrl: string): string {
  const url = normalizeBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions')
    ? path
    : path.endsWith('/api/coding')
      ? `${path}/v3/chat/completions`
      : path ? `${path}/chat/completions` : '/v1/chat/completions';
  return url.toString();
}

export function resolveResponsesEndpoint(baseUrl: string): string {
  return endpointWithPath(baseUrl, '/responses');
}

function usesResponsesApi(baseUrl: string): boolean {
  const normalized = baseUrl.toLowerCase();
  return normalized.includes('/api/v3') && !normalized.includes('/coding');
}

function optionalField(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function imageParts(
  images: readonly string[],
  kind: 'chat' | 'responses',
  withLabels: boolean
): Array<Record<string, unknown>> {
  return images.flatMap((image, index) => {
    const imagePart = kind === 'chat'
      ? { type: 'image_url', image_url: { url: image } }
      : { type: 'input_image', image_url: image };
    return withLabels
      ? [
        kind === 'chat'
          ? { type: 'text', text: `图片 ${index + 1}：` }
          : { type: 'input_text', text: `图片 ${index + 1}：` },
        imagePart,
      ]
      : [imagePart];
  });
}

function addReasoning(
  body: Record<string, unknown>,
  effort: TextReasoningEffort | undefined,
  kind: 'chat' | 'responses'
): void {
  if (!effort) {
    return;
  }
  body[kind === 'chat' ? 'reasoning_effort' : 'reasoning'] = kind === 'chat'
    ? effort
    : { effort };
}

export function buildTextGenerationRequest(
  payload: GenerateTextPayload,
  apiConfig: TextApiConfigLike
): TextApiRequest {
  const images = payload.referenceImages ?? [];
  if (usesResponsesApi(apiConfig.baseUrl)) {
    const content = [
      ...imageParts(images, 'responses', true),
      ...(payload.text.trim() ? [{ type: 'input_text', text: payload.text }] : []),
    ];
    const body: Record<string, unknown> = {
      model: apiConfig.modelId,
      input: [{ role: 'user', content }],
    };
    addReasoning(body, payload.reasoningEffort, 'responses');
    return { endpoint: resolveResponsesEndpoint(apiConfig.baseUrl), body };
  }

  const content = images.length === 0
    ? payload.text
    : [
      ...imageParts(images, 'chat', true),
      ...(payload.text.trim() ? [{ type: 'text', text: payload.text }] : []),
    ];
  const body: Record<string, unknown> = {
    model: apiConfig.modelId,
    messages: [{ role: 'user', content }],
    stream: false,
  };
  addReasoning(body, payload.reasoningEffort, 'chat');
  return { endpoint: resolveChatCompletionsEndpoint(apiConfig.baseUrl), body };
}

function buildVideoMetadataPrefix(payload: WebTextPolishPayload): string {
  const parts = ['当前视频生成固定参数（由用户选择，AI需遵循）：'];
  const entries: Array<[string, string | undefined]> = [
    ['时长', payload.videoDuration ? `${payload.videoDuration}秒` : undefined],
    ['分辨率', payload.videoResolution],
    ['画面宽高比', payload.videoAspectRatio],
  ];
  entries.forEach(([label, value]) => {
    if (value?.trim()) {
      parts.push(`- ${label}：${value.trim()}`);
    }
  });
  if (payload.isVideoFrame) {
    parts.push('- 模式：首尾帧视频（图1为首帧，图2为尾帧）');
  }
  if (parts.length === 1) {
    return '';
  }
  parts.push('以上为用户已选择的固定参数，AI在优化提示词时必须遵循。');
  return parts.join('\n');
}

function defaultPolishTemplate(promptType: string | undefined): string {
  if (promptType === 'image') return DEFAULT_IMAGE_POLISH_PROMPT;
  if (promptType === 'text') return DEFAULT_TEXT_POLISH_PROMPT;
  return DEFAULT_VIDEO_API_PROMPT;
}

function buildPolishUserText(
  payload: WebTextPolishPayload,
  template: string,
  includeTemplate: boolean
): string {
  const metadata = buildVideoMetadataPrefix(payload);
  const enhancedText = metadata ? `${metadata}\n\n${payload.text}` : payload.text;
  const imageInstruction = payload.referenceImages?.length
    ? `请根据参考图片润色这个提示词：${enhancedText}\n\n参考图片已提供。`
    : `请润色这个提示词：${enhancedText}`;
  return includeTemplate ? `${template}\n\n${imageInstruction}` : imageInstruction;
}

export function buildTextPolishRequest(
  payload: WebTextPolishPayload,
  apiConfig: TextApiConfigLike
): TextApiRequest {
  const template = optionalField(payload.customPrompt) ?? defaultPolishTemplate(payload.promptType);
  const includeTemplate = usesResponsesApi(apiConfig.baseUrl);
  const userText = buildPolishUserText(payload, template, includeTemplate);
  const images = payload.referenceImages ?? [];

  if (includeTemplate) {
    const body: Record<string, unknown> = {
      model: apiConfig.modelId,
      input: [{
        role: 'user',
        content: [
          ...imageParts(images, 'responses', false),
          { type: 'input_text', text: userText },
        ],
      }],
    };
    addReasoning(body, payload.reasoningEffort, 'responses');
    return { endpoint: resolveResponsesEndpoint(apiConfig.baseUrl), body };
  }

  const body: Record<string, unknown> = {
    model: apiConfig.modelId,
    messages: [
      { role: 'system', content: template },
      {
        role: 'user',
        content: images.length > 0
          ? [...imageParts(images, 'chat', false), { type: 'text', text: userText }]
          : userText,
      },
    ],
    stream: false,
  };
  addReasoning(body, payload.reasoningEffort, 'chat');
  return { endpoint: resolveChatCompletionsEndpoint(apiConfig.baseUrl), body };
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(i18n.t('generationGateway.textResponseEmpty'));
  }
  const record = payload as Record<string, unknown>;
  const direct = normalizeTextResponseOrNull(record.output_text);
  if (direct) return direct;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choiceText = choices.flatMap((choice) => {
    if (!choice || typeof choice !== 'object') return [];
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object') return [];
    return textParts((message as Record<string, unknown>).content);
  }).join('');
  if (choiceText.trim()) return choiceText;

  const output = record.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const nestedChoices = (output as Record<string, unknown>).choices;
    const nestedText = Array.isArray(nestedChoices)
      ? nestedChoices.flatMap((choice) => {
        if (!choice || typeof choice !== 'object') return [];
        const message = (choice as Record<string, unknown>).message;
        return message && typeof message === 'object'
          ? textParts((message as Record<string, unknown>).content)
          : [];
      }).join('')
      : '';
    if (nestedText.trim()) return nestedText;
  }
  if (Array.isArray(output)) {
    const outputText = output.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      return entry.type === undefined || entry.type === 'output_text' || entry.type === 'message'
        ? [
          ...textParts(entry.text),
          ...(Array.isArray(entry.content)
            ? entry.content.flatMap((part) => part && typeof part === 'object'
              ? textParts((part as Record<string, unknown>).text)
              : [])
            : []),
        ]
        : [];
    }).join('');
    if (outputText.trim()) return outputText;
  }
  throw new Error(i18n.t('generationGateway.textResponseEmpty'));
}

function normalizeTextResponseOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function textParts(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' && text.trim() ? [text] : [];
  });
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown, status: number, prefix: string): string {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const error = record?.error;
  const nested = error && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>).message
    : error;
  const detail = typeof nested === 'string' && nested.trim()
    ? nested.trim()
    : i18n.t('generationGateway.httpError', { status });
  return `${prefix}：${detail}`;
}

function validateConfig(config: TextApiConfigLike): void {
  if (!config.apiKey.trim()) throw new Error(i18n.t('generationGateway.textApiKeyRequired'));
  if (!config.baseUrl.trim()) throw new Error(i18n.t('generationGateway.textBaseUrlRequired'));
  if (!config.modelId.trim()) throw new Error(i18n.t('generationGateway.textModelRequired'));
}

function validateTextGenerationPayload(payload: GenerateTextPayload): void {
  const imageCount = payload.referenceImages?.length ?? 0;
  if (!payload.text.trim() && imageCount === 0) {
    throw new Error(i18n.t('generationGateway.textInputRequired'));
  }
  if (imageCount > MAX_TEXT_GENERATION_REFERENCE_IMAGES) {
    throw new Error(i18n.t('generationGateway.textReferenceImageLimit', {
      max: MAX_TEXT_GENERATION_REFERENCE_IMAGES,
    }));
  }
  if (payload.reasoningEffort && !TEXT_REASONING_EFFORTS.includes(payload.reasoningEffort)) {
    throw new Error(i18n.t('generationGateway.textReasoningUnsupported'));
  }
}

async function requestJson(
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(TEXT_GATEWAY_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(
      payload,
      response.status,
      i18n.t('generationGateway.textRequestFailed'),
    ));
  }
  return payload;
}

async function withTemporaryTextReferences<T>(
  sources: readonly string[],
  fetchImpl: typeof fetch,
  operation: (referenceMediaKeys: string[]) => Promise<T>,
): Promise<T> {
  if (sources.length === 0) return await operation([]);
  const mediaGateway = createBrowserMediaGateway({ fetchImpl });
  const keys: string[] = [];
  try {
    for (const [index, source] of sources.entries()) {
      const file = await sourceToImageFile(source, index, fetchImpl);
      const grant = await mediaGateway.publish(file, 'image', TEXT_REFERENCE_PROVIDER_ID);
      keys.push(grant.key);
    }
    return await operation(keys);
  } finally {
    await Promise.all(keys.map((key) => mediaGateway.release(key).catch(() => undefined)));
  }
}

function textGatewayRequest(
  apiConfig: TextApiConfigLike,
  request: TextApiRequest,
  referenceMediaKeys: readonly string[],
): Record<string, unknown> {
  return {
    operation: 'request',
    base_url: apiConfig.baseUrl,
    protocol: usesResponsesApi(apiConfig.baseUrl) ? 'responses' : 'chat',
    request: request.body,
    ...(referenceMediaKeys.length ? { reference_media_keys: [...referenceMediaKeys] } : {}),
  };
}

function mediaPlaceholders(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `lumina-media:${index}`);
}

export async function generateTextViaWeb(
  payload: GenerateTextPayload,
  apiConfig: TextProviderRuntimeConfig,
  options: WebTextApiOptions = {}
): Promise<string> {
  validateConfig(apiConfig);
  validateTextGenerationPayload(payload);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sources = payload.referenceImages ?? [];
  return await withTemporaryTextReferences(sources, fetchImpl, async (referenceMediaKeys) => {
    const request = buildTextGenerationRequest({
      ...payload,
      ...(sources.length ? { referenceImages: mediaPlaceholders(sources.length) } : {}),
    }, apiConfig);
    const result = await requestJson(
      apiConfig.apiKey,
      textGatewayRequest(apiConfig, request, referenceMediaKeys),
      fetchImpl,
    );
    return extractText(result);
  });
}

export async function polishTextViaWeb(
  payload: WebTextPolishPayload,
  apiConfig: TextApiConfig,
  options: WebTextApiOptions = {}
): Promise<{ polished: string }> {
  validateConfig(apiConfig);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sources = payload.referenceImages ?? [];
  return await withTemporaryTextReferences(sources, fetchImpl, async (referenceMediaKeys) => {
    const request = buildTextPolishRequest({
      ...payload,
      ...(sources.length ? { referenceImages: mediaPlaceholders(sources.length) } : {}),
    }, apiConfig);
    const result = await requestJson(
      apiConfig.apiKey,
      textGatewayRequest(apiConfig, request, referenceMediaKeys),
      fetchImpl,
    );
    return { polished: extractText(result) };
  });
}

export interface DiscoverTextModelsRequest {
  base_url: string;
  api_key: string;
}

export interface DiscoveredTextModel {
  id: string;
  label?: string;
}

export async function discoverTextModelsViaWeb(
  request: DiscoverTextModelsRequest,
  options: WebTextApiOptions = {}
): Promise<DiscoveredTextModel[]> {
  assertNetworkAvailable();
  if (!request.api_key.trim()) throw new Error(i18n.t('generationGateway.textApiKeyRequired'));
  const response = await (options.fetchImpl ?? fetch)(TEXT_GATEWAY_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${request.api_key.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ operation: 'models', base_url: request.base_url }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(
      payload,
      response.status,
      i18n.t('generationGateway.textModelsRequestFailed'),
    ));
  }
  const models = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).models
    : payload;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  return models.flatMap((entry): DiscoveredTextModel[] => {
    const id = typeof entry === 'string'
      ? entry.trim()
      : entry && typeof entry === 'object'
        ? [
          'id',
          'model',
          'name',
        ].map((key) => (entry as Record<string, unknown>)[key]).find((value): value is string => (
          typeof value === 'string' && value.trim().length > 0
        ))?.trim() ?? ''
        : '';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const label = entry && typeof entry === 'object'
      ? ['display_name', 'displayName', 'label', 'name']
        .map((key) => (entry as Record<string, unknown>)[key])
        .find((value): value is string => (
          typeof value === 'string' && Boolean(value.trim()) && value.trim() !== id
        ))
        ?.trim()
      : undefined;
    return [{ id, ...(label ? { label } : {}) }];
  });
}

export async function testTextApiViaWeb(
  apiConfig: TextApiConfig,
  options: WebTextApiOptions = {}
): Promise<{ success: boolean; message: string }> {
  const result = await generateTextViaWeb({ text: '你是什么模型？请简单介绍一下你自己。' }, {
    apiKey: apiConfig.apiKey,
    baseUrl: apiConfig.baseUrl,
    modelId: apiConfig.modelId,
  }, options);
  return {
    success: true,
    message: i18n.t('generationGateway.textApiTestSuccess', { result }),
  };
}
