import { invoke, isTauri } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';
import type { SeedanceVideoContent } from '@/features/canvas/application/seedanceVideoRequestPlan';

export interface GenerateRequest {
  prompt: string;
  model: string;
  provider_id?: string;
  size: string;
  aspect_ratio: string;
  reference_images?: string[];
  video_content?: SeedanceVideoContent[];
  extra_params?: Record<string, unknown>;
  provider_config?: Record<string, string>;
  /** Draft task ID - when set, generates final video from this draft */
  draftTaskId?: string;
  /** Project ID - when set, images are saved under project-specific subdirectory */
  project_id?: string;
}

export type GenerationJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found' | 'cancelled';

export interface GenerationJobRecovery {
  retry_count: number;
  next_retry_at?: number | null;
  requires_manual_requery: boolean;
  last_error?: string | null;
}

export interface GenerationJobStatus {
  job_id: string;
  status: GenerationJobState;
  result?: string | null;
  error?: string | null;
  seed?: number | null;
  /** External task ID from provider (e.g., volcvideo task ID like "cgt-xxx") */
  external_task_id?: string | null;
  /** A recoverable task-query failure; the task itself remains active. */
  recovery?: GenerationJobRecovery | null;
}

export interface DiscoveredImageModel {
  id: string;
  label?: string;
}

export interface DiscoverImageModelsRequest {
  provider_id: string;
  base_url: string;
  api_key: string;
  protocol?: 'openai-images' | 'fhl-images' | 'gemini-native';
}

export interface DiscoverTextModelsRequest {
  base_url: string;
  api_key: string;
}

export interface GenerateTextRequest {
  text: string;
  model: string;
  api_key: string;
  base_url: string;
  reference_images?: string[];
  reasoning_effort?: string;
}

const BASE64_PREVIEW_HEAD = 96;
const BASE64_PREVIEW_TAIL = 24;

function truncateText(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...(${value.length} chars)`;
}

function truncateBase64Like(value: string): string {
  if (!value) {
    return value;
  }

  if (value.startsWith('data:')) {
    const [meta, payload = ''] = value.split(',', 2);
    if (payload.length <= BASE64_PREVIEW_HEAD + BASE64_PREVIEW_TAIL) {
      return value;
    }
    return `${meta},${payload.slice(0, BASE64_PREVIEW_HEAD)}...${payload.slice(-BASE64_PREVIEW_TAIL)}(${payload.length} chars)`;
  }

  const base64Like = /^[A-Za-z0-9+/=]+$/.test(value) && value.length > 256;
  if (!base64Like) {
    return truncateText(value, 280);
  }

  return `${value.slice(0, BASE64_PREVIEW_HEAD)}...${value.slice(-BASE64_PREVIEW_TAIL)}(${value.length} chars)`;
}

function sanitizeGenerateRequestForLog(request: GenerateRequest): Record<string, unknown> {
  const providerConfig = Object.fromEntries(
    Object.entries(request.provider_config ?? {}).map(([key, value]) => [
      key,
      /key|secret|token|authorization/i.test(key) ? '[REDACTED]' : value,
    ])
  );
  return {
    prompt: truncateText(request.prompt, 240),
    model: request.model,
    size: request.size,
    aspect_ratio: request.aspect_ratio,
    reference_images_count: request.reference_images?.length ?? 0,
    reference_images_preview: (request.reference_images ?? []).map((item) =>
      truncateBase64Like(item)
    ),
    video_content_count: request.video_content?.length ?? 0,
    extra_params: request.extra_params ?? {},
    provider_config: providerConfig,
  };
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function normalizeInvokeError(error: unknown): { message: string; details?: string } {
  if (error instanceof Error) {
    const detailsText =
      'details' in error
        ? typeof (error as { details?: unknown }).details === 'string'
          ? (error as { details?: string }).details
          : undefined
        : undefined;
    return { message: error.message || 'Generation failed', details: detailsText };
  }

  if (typeof error === 'string') {
    return { message: error || 'Generation failed', details: error || undefined };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.msg === 'string' && record.msg) ||
      'Generation failed';
    let details: string | undefined;
    try {
      details = truncateText(JSON.stringify(record, null, 2), 2000);
    } catch {
      details = truncateText(String(record), 2000);
    }
    return { message, details };
  }

  return { message: 'Generation failed' };
}

function createErrorWithDetails(message: string, details?: string): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  if (details) {
    error.details = details;
  }
  return error;
}

export async function setApiKey(provider: string, apiKey: string): Promise<void> {
  logger.info('[AI] set_api_key', {
    provider,
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}***${apiKey.slice(-2)}` : '',
    tauri: isTauri(),
  });
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke('set_api_key', { provider, apiKey });
}

export async function discoverImageModels(
  request: DiscoverImageModelsRequest
): Promise<DiscoveredImageModel[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<DiscoveredImageModel[]>('discover_image_models', { request });
}

export async function discoverTextModels(
  request: DiscoverTextModelsRequest
): Promise<DiscoveredImageModel[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<DiscoveredImageModel[]>('discover_text_models', { request });
}

export function normalizeGeneratedTextResponse(result: unknown): string {
  if (typeof result !== 'string' || !result.trim()) {
    throw new Error('API 返回内容为空');
  }
  return result;
}

export async function generateText(request: GenerateTextRequest): Promise<string> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  const result = await invoke<string>('generate_text', { request });
  return normalizeGeneratedTextResponse(result);
}

export async function generateImage(request: GenerateRequest): Promise<string> {
  const startedAt = performance.now();
  logger.info('[AI] generate_image request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  try {
    const rawResult = await invoke<unknown>('generate_image', { request });
    if (typeof rawResult !== 'string') {
      throw createErrorWithDetails(
        'Generation returned non-string payload',
        truncateText(
          (() => {
            try {
              return JSON.stringify(rawResult, null, 2);
            } catch {
              return String(rawResult);
            }
          })(),
          2000
        )
      );
    }
    const result = rawResult.trim();
    if (!result) {
      throw createErrorWithDetails('Generation returned empty image source');
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    logger.info('[AI] generate_image success', {
      elapsedMs,
      resultPreview: truncateText(result, 220),
    });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    logger.error('[AI] generate_image failed', {
      elapsedMs,
      request: sanitizeGenerateRequestForLog(request),
      error,
      normalizedError,
    });
    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details;
    throw commandError;
  }
}

export async function submitGenerateImageJob(request: GenerateRequest): Promise<string> {
  logger.info('[AI] submit_generate_image_job request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const jobId = await invoke<string>('submit_generate_image_job', { request });
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('submit_generate_image_job returned invalid job id');
  }
  return jobId.trim();
}

export async function getGenerateImageJob(
  jobId: string,
  providerConfig?: Record<string, string>
): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const result = await invoke<GenerationJobStatus>('get_generate_image_job', {
    jobId,
    providerConfig,
  });
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new Error('get_generate_image_job returned invalid payload');
  }
  return result;
}

export async function retryGenerateImageJob(
  jobId: string,
  providerConfig?: Record<string, string>
): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const result = await invoke<GenerationJobStatus>('retry_generate_image_job', {
    jobId,
    providerConfig,
  });
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new Error('retry_generate_image_job returned invalid payload');
  }
  return result;
}

export async function cancelVideoGenerationTask(
  apiKey: string,
  baseUrl: string,
  taskId: string
): Promise<void> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  await invoke('cancel_video_generation_task', { apiKey, baseUrl, taskId });
}

export async function listModels(): Promise<string[]> {
  return await invoke('list_models');
}
