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
  | { status: 'succeeded'; result: string; seed?: number }
  | { status: 'failed'; error: string; retryable?: boolean }
  | { status: 'cancelled'; error: string };

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

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildContent(payload: GenerateImagePayload): unknown[] {
  if (payload.draftTaskId?.trim()) {
    return [{ type: 'draft_task', draft_task: { id: payload.draftTaskId.trim() } }];
  }
  return (payload.videoContent ?? []).map((item) => {
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
  return fallback;
}

function resultUrl(payload: Record<string, unknown>): string | null {
  const direct = payload.output_url;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const data = payload.data;
  if (data && typeof data === 'object') {
    const nested = data as Record<string, unknown>;
    for (const key of ['video_url', 'output_url']) {
      if (typeof nested[key] === 'string' && nested[key].trim()) {
        return String(nested[key]).trim();
      }
    }
  }
  const content = Array.isArray(payload.content) ? payload.content : [payload.content];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    for (const key of ['video_url', 'output_url']) {
      if (typeof record[key] === 'string' && record[key].trim()) {
        return String(record[key]).trim();
      }
    }
  }
  return null;
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
  const response = await fetchImpl(endpoint(baseUrl, '/contents/generations/tasks'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: bareModel(payload.model),
      content: buildContent(payload),
      ...(optionalBoolean(extraParams.generateAudio ?? extraParams.hasaudio) !== undefined
        ? { generate_audio: optionalBoolean(extraParams.generateAudio ?? extraParams.hasaudio) }
        : {}),
      ...(payload.size.trim() ? { resolution: payload.size } : {}),
      ...(payload.aspectRatio.trim() ? { ratio: payload.aspectRatio } : {}),
      ...(optionalNumber(extraParams.duration) !== undefined ? { duration: optionalNumber(extraParams.duration) } : {}),
      ...(optionalNumber(extraParams.seed) !== undefined ? { seed: optionalNumber(extraParams.seed) } : {}),
      ...(optionalBoolean(extraParams.cameraFixed ?? extraParams.camerafixed) !== undefined
        ? { camera_fixed: optionalBoolean(extraParams.cameraFixed ?? extraParams.camerafixed) }
        : {}),
      ...(optionalBoolean(extraParams.watermark) !== undefined ? { watermark: optionalBoolean(extraParams.watermark) } : {}),
      ...(optionalBoolean(extraParams.draft) !== undefined ? { draft: optionalBoolean(extraParams.draft) } : {}),
    }),
  });
  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(readError(responseBody, i18n.t('generationGateway.seedanceRequestFailed', { status: response.status })));
  }
  const externalTaskId = typeof responseBody?.id === 'string'
    ? responseBody.id.trim()
    : typeof responseBody?.task_id === 'string'
      ? responseBody.task_id.trim()
      : '';
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
    return {
      status: 'failed',
      error: readError(payload, i18n.t('generationGateway.seedanceQueryFailed', { status: response.status })),
      retryable: response.status === 429 || response.status >= 500,
    };
  }
  const status = typeof payload?.status === 'string' ? payload.status.toLowerCase() : '';
  if (status === 'succeeded' || status === 'success') {
    const result = resultUrl(payload ?? {});
    return result
      ? {
        status: 'succeeded',
        result,
        ...(optionalNumber(payload?.seed) !== undefined ? { seed: optionalNumber(payload?.seed) } : {}),
      }
      : { status: 'failed', error: i18n.t('generationGateway.seedanceResultMissing') };
  }
  if (status === 'cancelled' || status === 'canceled') {
    return { status: 'cancelled', error: i18n.t('generationGateway.seedanceCancelled') };
  }
  if (status === 'failed' || status === 'expired') {
    return { status: 'failed', error: readError(payload, i18n.t('generationGateway.seedanceFailed')) };
  }
  return { status: 'running' };
}
