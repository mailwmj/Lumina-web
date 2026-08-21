import { submitGenerationJobBatch } from '@/features/canvas/application/generationJobBatch';
import type {
  AiGateway,
  GenerateImagePayload,
} from '@/features/canvas/application/ports';
import {
  AI_MEDIA_PROVIDER_ID,
  GENERATION_GATEWAY_PATH,
  type GenerationGatewayJobState,
} from '@/features/generation-gateway/generationGateway';
import i18n from '@/i18n';
import { DEFAULT_OPENAI_IMAGE_BASE_URL } from '@/features/settings/domain/settingsSchema';

export interface WebGenerationGatewayOptions {
  fetchImpl?: typeof fetch;
  basePath?: string;
}

function providerForPayload(payload: GenerateImagePayload): string {
  return payload.providerId?.trim() || (
    payload.model.startsWith(`${AI_MEDIA_PROVIDER_ID}/`) ? AI_MEDIA_PROVIDER_ID : ''
  );
}

function requireAiMediaProvider(payload: GenerateImagePayload): void {
  if (providerForPayload(payload) !== AI_MEDIA_PROVIDER_ID) {
    throw new Error(i18n.t('generationGateway.providerNotConfigured'));
  }
}

function requireProjectContext(payload: GenerateImagePayload): { projectId: string; projectRevision: string } {
  const projectId = payload.projectId?.trim() ?? '';
  const projectRevision = payload.projectRevision?.trim() ?? '';
  if (!projectId || !projectRevision) {
    throw new Error(i18n.t('generationGateway.projectRequired'));
  }
  return { projectId, projectRevision };
}

function requireConfiguredBaseUrl(payload: GenerateImagePayload): string {
  const baseUrl = payload.providerConfig?.base_url?.trim() ?? '';
  if (!baseUrl) {
    throw new Error(i18n.t('generationGateway.baseUrlRequired'));
  }
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error(i18n.t('generationGateway.baseUrlInvalid'));
  }
  if (baseUrl.replace(/\/+$/, '') !== DEFAULT_OPENAI_IMAGE_BASE_URL) {
    throw new Error(i18n.t('generationGateway.baseUrlNotSupported'));
  }
  return baseUrl;
}

function normalizeStatus(value: unknown): GenerationGatewayJobState {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'not_found') {
    return value;
  }
  throw new Error(i18n.t('generationGateway.invalidStatus'));
}

function parseJobStatus(value: unknown): Awaited<ReturnType<AiGateway['getGenerateImageJob']>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(i18n.t('generationGateway.invalidResponse'));
  }
  const record = value as Record<string, unknown>;
  const jobId = typeof record.job_id === 'string' ? record.job_id.trim() : '';
  if (!jobId) {
    throw new Error(i18n.t('generationGateway.invalidJobId'));
  }
  const status = normalizeStatus(record.status);
  return {
    job_id: jobId,
    status,
    result: typeof record.result === 'string' ? record.result : null,
    error: typeof record.error === 'string' ? record.error : null,
  };
}

export function createWebGenerationGateway(
  options: WebGenerationGatewayOptions = {},
): AiGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const basePath = options.basePath ?? GENERATION_GATEWAY_PATH;
  const apiKeys = new Map<string, string>();

  const request = async (url: string, key: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).message === 'string'
        ? (payload as Record<string, string>).message
        : i18n.t('generationGateway.httpError', { status: response.status });
      throw new Error(message);
    }
    return payload;
  };

  const submitOne = async (payload: GenerateImagePayload): Promise<string> => {
    requireAiMediaProvider(payload);
    const provider = AI_MEDIA_PROVIDER_ID;
    const key = apiKeys.get(provider) ?? '';
    if (!key) {
      throw new Error(i18n.t('generationGateway.apiKeyRequired'));
    }
    const { projectId, projectRevision } = requireProjectContext(payload);
    requireConfiguredBaseUrl(payload);
    const response = await request(`${basePath}/jobs`, key, {
      operation: 'submit',
      provider,
      projectId,
      projectRevision,
      request: {
        model: payload.model,
        prompt: payload.prompt,
        size: payload.size,
        aspectRatio: payload.aspectRatio,
        ...(payload.extraParams ? { extraParams: payload.extraParams } : {}),
      },
    });
    if (!response || typeof response !== 'object' || typeof (response as Record<string, unknown>).job_id !== 'string') {
      throw new Error(i18n.t('generationGateway.invalidSubmission'));
    }
    return String((response as Record<string, unknown>).job_id);
  };

  const getJob = async (jobId: string): Promise<Awaited<ReturnType<AiGateway['getGenerateImageJob']>>> => {
    const key = apiKeys.get(AI_MEDIA_PROVIDER_ID) ?? '';
    if (!key) {
      throw new Error(i18n.t('generationGateway.apiKeyRequired'));
    }
    const response = await request(`${basePath}/jobs/${encodeURIComponent(jobId)}`, key, { operation: 'poll' });
    return parseJobStatus(response);
  };

  return {
    setApiKey: async (provider, apiKey) => {
      if (provider !== AI_MEDIA_PROVIDER_ID) {
        throw new Error(i18n.t('generationGateway.providerNotConfigured'));
      }
      const normalized = apiKey.trim();
      if (!normalized) {
        apiKeys.delete(provider);
      } else {
        apiKeys.set(provider, normalized);
      }
    },
    generateImage: async () => {
      throw new Error(i18n.t('generationGateway.synchronousUnsupported'));
    },
    submitGenerateImageJob: submitOne,
    submitGenerateImageJobs: async (payload, outputCount, onSettled, beforeSubmit) => {
      // Validate all inputs and storage-independent request fields before creating any result nodes.
      requireAiMediaProvider(payload);
      requireProjectContext(payload);
      requireConfiguredBaseUrl(payload);
      const safeOutputCount = Math.max(1, Math.min(4, Math.floor(outputCount)));
      beforeSubmit();
      const results = await submitGenerationJobBatch({
        outputCount: safeOutputCount,
        submit: async () => submitOne(payload),
        onSettled,
      });
      return results;
    },
    getGenerateImageJob: getJob,
    retryGenerateImageJob: getJob,
  };
}

export const webGenerationGateway = createWebGenerationGateway();
