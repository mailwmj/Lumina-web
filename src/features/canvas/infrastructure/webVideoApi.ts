import type { GenerateImagePayload } from '@/features/canvas/application/ports';
import type { SeedanceVideoContent } from '@/features/canvas/application/seedanceVideoRequestPlan';
import { normalizeBrowserGenerationProviderBaseUrl } from '@/features/canvas/domain/generationJobHandle';
import {
  createBrowserMediaGateway,
  type BrowserGatewayMediaKind,
  type BrowserMediaGateway,
} from '@/features/media/infrastructure/browserMediaGateway';
import i18n from '@/i18n';

const VIDEO_GATEWAY_PATH = '/api/generation/video';

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
  mediaGateway?: Pick<BrowserMediaGateway, 'publish' | 'publishRemote' | 'release'>;
  projectId?: string;
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstUrl(...values: unknown[]): string | null {
  return values.find((value) => typeof value === 'string' && value.trim())?.toString().trim() ?? null;
}

function resultUrls(payload: Record<string, unknown>): {
  result: string | null;
  preview: string | null;
  lastFrame: string | null;
} {
  const data = objectRecord(payload.data);
  const content = Array.isArray(payload.content)
    ? payload.content.map(objectRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : objectRecord(payload.content)
      ? [objectRecord(payload.content)!]
      : [];
  const video = content.find((item) => item.type === 'video') ?? null;
  return {
    result: firstUrl(
      payload.output_url,
      payload.video_url,
      data?.video_url,
      data?.output_url,
      video?.video_url,
      video?.output_url,
    ),
    preview: firstUrl(
      payload.preview_url,
      payload.preview_image_url,
      payload.cover_url,
      data?.preview_url,
      data?.preview_image_url,
      data?.cover_url,
      data?.cover_image_url,
      data?.thumbnail_url,
      data?.poster_url,
    ),
    lastFrame: firstUrl(
      payload.last_frame_url,
      payload.last_frame_image_url,
      data?.last_frame_url,
      data?.last_frame_image_url,
    ),
  };
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

function isRemoteMediaUrl(source: string): boolean {
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
  const temporaryMediaKeys: Array<string | undefined> = new Array(content.length);
  const releasePublishedMedia = async (): Promise<void> => {
    const keys = temporaryMediaKeys.filter((key): key is string => Boolean(key));
    await Promise.all(keys.map((key) => mediaGateway.release(key).catch(() => undefined)));
  };
  const prepareOperations = content.map(async (item, index) => {
    if (item.type === 'text') {
      return item;
    }
    const kind = mediaKindForContent(item);
    if (isRemoteMediaUrl(item.url)) {
      const temporaryMedia = await mediaGateway.publishRemote(
        item.url,
        kind,
        'volcengine-seedance',
        { projectId: options.projectId },
      );
      temporaryMediaKeys[index] = temporaryMedia.key;
      return { ...item, url: temporaryMedia.url };
    }
    const response = await fetchImpl(item.url);
    if (!response.ok) {
      throw new Error(i18n.t('generationGateway.seedanceLocalMediaReadFailed', { status: response.status }));
    }
    const blob = await response.blob();
    const file = new File([blob], mediaFileName(kind, index), {
      type: blob.type || `${kind}/${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mpeg'}`,
    });
    const temporaryMedia = await mediaGateway.publish(
      file,
      kind,
      'volcengine-seedance',
      { projectId: options.projectId },
    );
    temporaryMediaKeys[index] = temporaryMedia.key;
    return { ...item, url: temporaryMedia.url };
  });
  try {
    const prepared = await Promise.all(prepareOperations);
    const publishedKeys = temporaryMediaKeys.filter((key): key is string => Boolean(key));
    return {
      content: prepared,
      temporaryMediaKeys: publishedKeys,
      release: releasePublishedMedia,
    };
  } catch (error) {
    await Promise.allSettled(prepareOperations);
    await releasePublishedMedia();
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
  const response = await fetchImpl(VIDEO_GATEWAY_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ operation: 'submit', base_url: baseUrl, request: body }),
  });
  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(readError(responseBody, i18n.t('generationGateway.seedanceRequestFailed', { status: response.status })));
  }
  const responseData = responseBody?.data;
  const externalTaskId = optionalString(responseBody?.task_id)
    ?? optionalString(responseBody?.id)
    ?? optionalString(responseBody?.request_id)
    ?? (responseData && typeof responseData === 'object'
      ? optionalString((responseData as Record<string, unknown>).task_id)
        ?? optionalString((responseData as Record<string, unknown>).id)
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
  const response = await fetchImpl(VIDEO_GATEWAY_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'poll',
      base_url: taskHandle.baseUrl,
      task_id: taskHandle.externalTaskId,
    }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    return {
      status: 'failed',
      error: readError(payload, i18n.t('generationGateway.seedanceQueryFailed', { status: response.status })),
      retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
    };
  }
  const status = typeof payload?.status === 'string'
    ? payload.status.toLowerCase().replace(/[\s-]+/g, '_')
    : '';
  if (payload?.deleted === true || status === 'cancelled' || status === 'canceled' || status === 'deleted') {
    return { status: 'cancelled', error: i18n.t('generationGateway.seedanceCancelled') };
  }
  if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'complete') {
    const urls = resultUrls(payload ?? {});
    const data = objectRecord(payload?.data);
    const responseSeed = optionalNumber(payload?.seed) ?? optionalNumber(data?.seed);
    return urls.result
      ? {
        status: 'succeeded',
        result: urls.result,
        ...(urls.preview ? { preview: urls.preview } : {}),
        ...(urls.lastFrame ? { lastFrame: urls.lastFrame } : {}),
        ...(responseSeed !== undefined ? { seed: responseSeed } : {}),
      }
      : { status: 'failed', error: i18n.t('generationGateway.seedanceResultMissing') };
  }
  if (status === 'failed' || status === 'expired' || status === 'error') {
    return { status: 'failed', error: readError(payload, i18n.t('generationGateway.seedanceFailed')) };
  }
  if (!status || ['creating', 'submitted', 'queued', 'running', 'processing'].includes(status)) {
    return { status: 'running' };
  }
  return { status: 'failed', error: i18n.t('generationGateway.invalidStatus') };
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
    const response = await fetchImpl(VIDEO_GATEWAY_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        authorization: `Bearer ${normalizedKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation: 'cancel',
        base_url: taskHandle.baseUrl,
        task_id: taskHandle.externalTaskId,
      }),
    });
    if (response.ok) {
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
