import { normalizeGenerationProviderRequestId } from '@/lib/generationProviderError';

export const BROWSER_DIRECT_GENERATION_JOB_PREFIX = 'web-image-';
export const BROWSER_DIRECT_VIDEO_GENERATION_JOB_PREFIX = 'web-video-';

export interface BrowserGenerationJobHandle {
  version: 1;
  kind: 'browser-direct';
  externalTaskId: string;
  protocol: string;
  baseUrl: string;
  model: string;
  statusUrl?: string;
  resultUrl?: string;
  /** Opaque same-origin temporary media keys to reclaim after a recovered video task completes. */
  temporaryMediaKeys?: string[];
}

export type PersistedGenerationJobHandle = BrowserGenerationJobHandle;

interface BrowserGenerationJobHandleInput {
  externalTaskId?: string;
  protocol?: string;
  baseUrl?: string;
  model?: string;
  statusUrl?: string;
  resultUrl?: string;
  temporaryMediaKeys?: string[];
}

interface RecoverableImageGenerationJobInput {
  jobId?: string | null;
  taskHandle?: PersistedGenerationJobHandle | null;
}

function safeText(value: string | undefined, maximumLength: number): string | null {
  const normalized = value?.trim() ?? '';
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

export function normalizeBrowserGenerationProviderBaseUrl(value: string | undefined): string | null {
  const normalized = safeText(value, 2_048);
  if (!normalized) {
    return null;
  }
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function safeCallbackUrl(value: string | undefined, baseUrl: string): string | undefined {
  const normalized = safeText(value, 2_048);
  if (!normalized) {
    return undefined;
  }
  try {
    const base = new URL(baseUrl);
    const callback = new URL(normalized, base.origin);
    if (callback.origin !== base.origin
      || callback.username
      || callback.password
      || callback.search
      || callback.hash) {
      return undefined;
    }
    return callback.toString();
  } catch {
    return undefined;
  }
}

function safeTemporaryMediaKeys(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const keys = Array.from(new Set(value.filter((key) => (
    typeof key === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(key)
  )))).slice(0, 16);
  return keys.length > 0 ? keys : undefined;
}

export function createBrowserGenerationJobHandle(
  input: BrowserGenerationJobHandleInput
): BrowserGenerationJobHandle | null {
  const externalTaskId = normalizeGenerationProviderRequestId(input.externalTaskId);
  const protocol = safeText(input.protocol, 128);
  const baseUrl = normalizeBrowserGenerationProviderBaseUrl(input.baseUrl);
  const model = safeText(input.model, 512);
  const temporaryMediaKeys = safeTemporaryMediaKeys(input.temporaryMediaKeys);
  if (!externalTaskId || !protocol || !baseUrl || !model) {
    return null;
  }

  return {
    version: 1,
    kind: 'browser-direct',
    externalTaskId,
    protocol,
    baseUrl,
    model,
    ...(safeCallbackUrl(input.statusUrl, baseUrl) ? { statusUrl: safeCallbackUrl(input.statusUrl, baseUrl) } : {}),
    ...(safeCallbackUrl(input.resultUrl, baseUrl) ? { resultUrl: safeCallbackUrl(input.resultUrl, baseUrl) } : {}),
    ...(temporaryMediaKeys ? { temporaryMediaKeys } : {}),
  };
}

export function canRecoverImageGenerationJob({
  jobId,
  taskHandle,
}: RecoverableImageGenerationJobInput): boolean {
  const normalizedJobId = jobId?.trim() ?? '';
  if (!normalizedJobId) {
    return false;
  }
  if (!(
    normalizedJobId.startsWith(BROWSER_DIRECT_GENERATION_JOB_PREFIX)
    || normalizedJobId.startsWith(BROWSER_DIRECT_VIDEO_GENERATION_JOB_PREFIX)
  )) {
    return true;
  }
  return taskHandle?.kind === 'browser-direct' && taskHandle.externalTaskId.length > 0;
}
