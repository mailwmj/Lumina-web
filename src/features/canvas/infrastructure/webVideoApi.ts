import type { GenerateImagePayload } from '@/features/canvas/application/ports';
import type { SeedanceVideoContent } from '@/features/canvas/application/seedanceVideoRequestPlan';
import { normalizeBrowserGenerationProviderBaseUrl } from '@/features/canvas/domain/generationJobHandle';
import {
  createBrowserMediaGateway,
  type BrowserGatewayMediaKind,
  type BrowserMediaGateway,
} from '@/features/media/infrastructure/browserMediaGateway';
import i18n from '@/i18n';

export interface WebSeedanceVideoTaskHandle {
  externalTaskId: string;
  protocol: 'volcengine-seedance';
  baseUrl: string;
  model: string;
}

export type WebSeedanceVideoPollResult =
  | { status: 'running' }
  | {
    status: 'succeeded';
    result: string;
    preview?: string;
    lastFrame?: string;
    seed?: number;
  }
  | { status: 'failed'; error: string; retryable?: boolean }
  | { status: 'cancelled'; error: string };

export interface WebSeedanceVideoCancellationResult {
  status: 'cancelled';
  providerConfirmed: boolean;
  error?: string;
}

interface WebSeedanceVideoApiOptions {
  fetchImpl?: typeof fetch;
}

interface WebSeedanceVideoMediaOptions extends WebSeedanceVideoApiOptions {
  mediaGateway?: Pick<BrowserMediaGateway, 'publish' | 'release'>;
}

export interface PreparedSeedanceVideoContent {
  content: SeedanceVideoContent[];
  temporaryMediaKeys: string[];
  release: () => Promise<void>;
}

function providerConfig(payload: GenerateImagePayload): { apiKey: string; baseUrl: string } {
  const apiKey = payload.providerConfig?.api_key?.trim() ?? '';
  const baseUrl = normalizeBrowserGenerationProviderBaseUrl(
    payload.providerConfig?.base_url?.trim().replace(/\/+$/, ''),
  );
  if (!apiKey || !baseUrl) {
    throw new Error(i18n.t('generationGateway.seedanceCredentialsRequired'));
  }
  return { apiKey, baseUrl };
}

function endpoint(baseUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/api\/v3/, '');
  return baseUrl.endsWith('/api/v3')
    ? `${baseUrl}${normalizedPath}`
    : `${baseUrl}/api/v3${normalizedPath}`;
}

function bareModel(model: string): string {
  const segments = model.trim().split('/');
  return segments[segments.length - 1] ?? '';
}

function normalizedModelId(model: string): string {
  return bareModel(model).toLowerCase();
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstOptionalBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    const normalized = optionalBoolean(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function firstOptionalNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = optionalNumber(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function buildContent(payload: GenerateImagePayload): unknown[] {
  if (payload.draftTaskId?.trim()) {
    return [{ type: 'draft_task', draft_task: { id: payload.draftTaskId.trim() } }];
  }
  const content = (payload.videoContent ?? []).map((item) => {
    if (item.type === 'text') {
      return { type: 'text', text: item.text };
    }
    if (item.type === 'image_url') {
      return { type: 'image_url', role: item.role, image_url: { url: item.url } };
    }
    if (item.type === 'video_url') {
      return { type: 'video_url', role: item.role, video_url: { url: item.url } };
    }
    return { type: 'audio_url', role: item.role, audio_url: { url: item.url } };
  });
  if (content.length === 0 && payload.prompt.trim()) {
    content.push({ type: 'text', text: payload.prompt.trim() });
  }
  return content;
}

function readError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fallback;
  }
  const error = (payload as Record<string, unknown>).error;
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return String((error as Record<string, unknown>).message).trim() || fallback;
  }
  for (const key of ['message', 'detail', 'error_message']) {
    const message = optionalString((payload as Record<string, unknown>)[key]);
    if (message) return message;
  }
  return fallback;
}

function nestedRecords(payload: unknown, depth = 0): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth > 3) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const children = Object.values(record).flatMap((value) => (
    Array.isArray(value)
      ? value.flatMap((item) => nestedRecords(item, depth + 1))
      : nestedRecords(value, depth + 1)
  ));
  return [record, ...children];
}

function readMediaUrl(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['url', 'video_url', 'output_url', 'image_url', 'src']) {
    const direct = readMediaUrl(record[key]);
    if (direct) return direct;
  }
  return null;
}

function resultUrls(payload: Record<string, unknown>): {
  result: string | null;
  preview: string | null;
  lastFrame: string | null;
} {
  const records = nestedRecords(payload);
  let result: string | null = null;
  let preview: string | null = null;
  let lastFrame: string | null = null;
  for (const record of records) {
    if (!result) {
      for (const key of ['output_url', 'video_url', 'video']) {
        result = readMediaUrl(record[key]);
        if (result) break;
      }
      if (!result && record.type === 'video') {
        result = readMediaUrl(record.url) ?? readMediaUrl(record.content);
      }
    }
    if (!preview) {
      for (const key of [
        'preview_url',
        'preview_image_url',
        'preview',
        'cover_url',
        'cover_image_url',
        'thumbnail_url',
        'thumbnail',
        'poster_url',
      ]) {
        preview = readMediaUrl(record[key]);
        if (preview) break;
      }
    }
    if (!lastFrame) {
      for (const key of ['last_frame_url', 'last_frame_image_url', 'last_frame', 'lastFrameUrl', 'lastFrame']) {
        lastFrame = readMediaUrl(record[key]);
        if (lastFrame) break;
      }
      if (!lastFrame && record.role === 'last_frame') {
        lastFrame = readMediaUrl(record.url) ?? readMediaUrl(record.image_url);
      }
    }
  }
  return { result, preview, lastFrame };
}

function mediaKindForContent(item: Exclude<SeedanceVideoContent, { type: 'text' }>): BrowserGatewayMediaKind {
  if (item.type === 'image_url') return 'image';
  if (item.type === 'video_url') return 'video';
  return 'audio';
}

function mediaFileName(kind: BrowserGatewayMediaKind, index: number): string {
  const extension = kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3';
  return `seedance-${kind}-${index + 1}.${extension}`;
}

function isPublicMediaUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function prepareSeedanceVideoContentForWeb(
  content: readonly SeedanceVideoContent[],
  options: WebSeedanceVideoMediaOptions = {},
): Promise<PreparedSeedanceVideoContent> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const mediaGateway = options.mediaGateway ?? createBrowserMediaGateway({ fetchImpl });
  const temporaryMediaKeys: string[] = [];
  try {
    const prepared = await Promise.all(content.map(async (item, index) => {
      if (item.type === 'text' || isPublicMediaUrl(item.url)) {
        return item;
      }
      const response = await fetchImpl(item.url);
      if (!response.ok) {
        throw new Error(i18n.t('generationGateway.seedanceLocalMediaReadFailed', { status: response.status }));
      }
      const kind = mediaKindForContent(item);
      const blob = await response.blob();
      const file = new File([blob], mediaFileName(kind, index), {
        type: blob.type || `${kind}/${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mpeg'}`,
      });
      const temporaryMedia = await mediaGateway.publish(file, kind, 'volcengine-seedance');
      temporaryMediaKeys.push(temporaryMedia.key);
      return { ...item, url: temporaryMedia.url };
    }));
    return {
      content: prepared,
      temporaryMediaKeys: [...temporaryMediaKeys],
      release: async () => {
        await Promise.all(temporaryMediaKeys.map((key) => mediaGateway.release(key).catch(() => undefined)));
      },
    };
  } catch (error) {
    await Promise.all(temporaryMediaKeys.map((key) => mediaGateway.release(key).catch(() => undefined)));
    throw error;
  }
}

export async function releaseSeedanceVideoTemporaryMediaForWeb(
  temporaryMediaKeys: readonly string[],
  options: WebSeedanceVideoMediaOptions = {},
): Promise<void> {
  const mediaGateway = options.mediaGateway ?? createBrowserMediaGateway({ fetchImpl: options.fetchImpl ?? fetch });
  await Promise.all(temporaryMediaKeys.map((key) => mediaGateway.release(key).catch(() => undefined)));
}

export async function submitSeedanceVideoGenerationViaWeb(
  payload: GenerateImagePayload,
  options: WebSeedanceVideoApiOptions = {},
): Promise<WebSeedanceVideoTaskHandle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { apiKey, baseUrl } = providerConfig(payload);
  const extraParams = payload.extraParams ?? {};
  const isDraftFinal = Boolean(payload.draftTaskId?.trim());
  const generateAudio = firstOptionalBoolean(extraParams.generateAudio, extraParams.hasaudio);
  const cameraFixed = firstOptionalBoolean(extraParams.cameraFixed, extraParams.camerafixed);
  const returnLastFrame = firstOptionalBoolean(
    extraParams.returnLastFrame,
    extraParams.return_last_frame,
  );
  const draft = firstOptionalBoolean(extraParams.draft);
  const enableWebSearch = firstOptionalBoolean(
    extraParams.enableWebSearch,
    extraParams.enable_web_search,
  );
  const duration = firstOptionalNumber(extraParams.duration);
  const seed = firstOptionalNumber(extraParams.seed);
  const hasReferenceMedia = Boolean(
    payload.referenceImages?.some((source) => source.trim())
      || payload.videoContent?.some((item) => item.type !== 'text'),
  );
  const body: Record<string, unknown> = {
    model: bareModel(payload.model),
    content: buildContent(payload),
  };
  if (!isDraftFinal) {
    if (generateAudio !== undefined) body.generate_audio = generateAudio;
    if (payload.size.trim()) body.resolution = payload.size;
    if (payload.aspectRatio.trim()) body.ratio = payload.aspectRatio;
    if (duration !== undefined) body.duration = duration;
    if (seed !== undefined) body.seed = seed;
    if (cameraFixed !== undefined) body.camera_fixed = cameraFixed;
    const watermark = optionalBoolean(extraParams.watermark);
    if (watermark !== undefined) body.watermark = watermark;
    if (draft !== undefined) body.draft = draft;
    if (returnLastFrame !== undefined) body.return_last_frame = returnLastFrame;
    if (enableWebSearch === true
      && !hasReferenceMedia
      && normalizedModelId(payload.model).includes('seedance-2-0')) {
      body.tools = [{ type: 'web_search' }];
    }
  }
  const response = await fetchImpl(endpoint(baseUrl, '/contents/generations/tasks'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(readError(responseBody, i18n.t('generationGateway.seedanceRequestFailed', { status: response.status })));
  }
  const responseData = responseBody?.data;
  const externalTaskId = optionalString(responseBody?.id)
    ?? optionalString(responseBody?.task_id)
    ?? optionalString(responseBody?.request_id)
    ?? (responseData && typeof responseData === 'object'
      ? optionalString((responseData as Record<string, unknown>).id)
        ?? optionalString((responseData as Record<string, unknown>).task_id)
      : undefined)
    ?? '';
  if (!externalTaskId) {
    throw new Error(i18n.t('generationGateway.seedanceTaskIdMissing'));
  }
  return {
    externalTaskId,
    protocol: 'volcengine-seedance',
    baseUrl,
    model: payload.model,
  };
}

export async function pollSeedanceVideoGenerationViaWeb(
  taskHandle: WebSeedanceVideoTaskHandle,
  apiKey: string,
  options: WebSeedanceVideoApiOptions = {},
): Promise<WebSeedanceVideoPollResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    endpoint(taskHandle.baseUrl, `/contents/generations/tasks/${encodeURIComponent(taskHandle.externalTaskId)}`),
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    if (response.status === 404) {
      return { status: 'cancelled', error: i18n.t('generationGateway.seedanceCancelled') };
    }
    return {
      status: 'failed',
      error: readError(payload, i18n.t('generationGateway.seedanceQueryFailed', { status: response.status })),
      retryable: response.status === 429 || response.status >= 500,
    };
  }
  const status = typeof payload?.status === 'string'
    ? payload.status.toLowerCase().replace(/[\s-]+/g, '_')
    : '';
  if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'complete') {
    const urls = resultUrls(payload ?? {});
    return urls.result
      ? {
        status: 'succeeded',
        result: urls.result,
        ...(urls.preview ? { preview: urls.preview } : {}),
        ...(urls.lastFrame ? { lastFrame: urls.lastFrame } : {}),
        ...(optionalNumber(payload?.seed) !== undefined ? { seed: optionalNumber(payload?.seed) } : {}),
      }
      : { status: 'failed', error: i18n.t('generationGateway.seedanceResultMissing') };
  }
  if (status === 'cancelled' || status === 'canceled' || status === 'deleted' || payload?.deleted === true) {
    return { status: 'cancelled', error: i18n.t('generationGateway.seedanceCancelled') };
  }
  if (status === 'failed' || status === 'expired' || status === 'error') {
    return { status: 'failed', error: readError(payload, i18n.t('generationGateway.seedanceFailed')) };
  }
  return { status: 'running' };
}

/** Requests provider cancellation without losing the local orphan/stale guard. */
export async function cancelSeedanceVideoGenerationViaWeb(
  taskHandle: WebSeedanceVideoTaskHandle,
  apiKey: string,
  options: WebSeedanceVideoApiOptions = {},
): Promise<WebSeedanceVideoCancellationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    return { status: 'cancelled', providerConfirmed: false, error: i18n.t('generationGateway.apiKeyRequired') };
  }
  try {
    const response = await fetchImpl(
      endpoint(taskHandle.baseUrl, `/contents/generations/tasks/${encodeURIComponent(taskHandle.externalTaskId)}`),
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${normalizedKey}`,
          'content-type': 'application/json',
        },
      },
    );
    if (response.ok || response.status === 404) {
      return { status: 'cancelled', providerConfirmed: true };
    }
    const payload = await response.json().catch(() => null);
    return {
      status: 'cancelled',
      providerConfirmed: false,
      error: readError(payload, i18n.t('generationGateway.seedanceCancelFailed', { status: response.status })),
    };
  } catch (error) {
    return {
      status: 'cancelled',
      providerConfirmed: false,
      error: error instanceof Error
        ? error.message
        : i18n.t('generationGateway.seedanceCancelFailed', { status: 'network' }),
    };
  }
}
