import type { TemporaryPublicMedia } from '@/features/media/domain/mediaProcessor';

export type BrowserGatewayMediaKind = 'image' | 'audio' | 'video';

const MEDIA_GATEWAY_PATH = '/api/generation/media';
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

export class BrowserMediaGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: string, message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BrowserMediaGatewayError';
    this.code = code;
    this.retryable = retryable;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface BrowserMediaGateway {
  transcode(file: File, kind: BrowserGatewayMediaKind): Promise<File>;
  publish(
    file: File,
    kind: BrowserGatewayMediaKind,
    providerId: string,
    context?: { projectId?: string },
  ): Promise<TemporaryPublicMedia>;
  publishRemote(
    source: string,
    kind: BrowserGatewayMediaKind,
    providerId: string,
    context?: { projectId?: string },
  ): Promise<TemporaryPublicMedia>;
  release(key: string): Promise<void>;
}

export interface BrowserMediaGatewayOptions {
  fetchImpl?: typeof fetch;
}

async function readGatewayError(response: Response): Promise<BrowserMediaGatewayError> {
  let payload: { error?: unknown; message?: unknown } | null = null;
  try {
    payload = await response.json() as { error?: unknown; message?: unknown };
  } catch {
    // The status remains useful when a proxy returns a non-JSON failure.
  }
  const code = typeof payload?.error === 'string' ? payload.error : 'media_gateway_error';
  const message = typeof payload?.message === 'string'
    ? payload.message
    : 'The media gateway request failed.';
  return new BrowserMediaGatewayError(code, message, response.status >= 500 || response.status === 429);
}

function assertMediaFile(file: File, kind: BrowserGatewayMediaKind): void {
  if (!file.type.startsWith(`${kind}/`)) {
    throw new BrowserMediaGatewayError(
      'media_type_invalid',
      `Expected a ${kind} file for the media gateway.`,
      false,
    );
  }
  if (file.size <= 0 || file.size > MAX_MEDIA_BYTES) {
    throw new BrowserMediaGatewayError(
      'media_size_invalid',
      'The media file exceeds the gateway size limit.',
      false,
    );
  }
}

async function readGatewayBlob(response: Response): Promise<Blob> {
  try {
    return await response.blob();
  } catch (error) {
    throw temporaryMediaError(error);
  }
}

async function readGatewayJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw temporaryMediaError(error);
  }
}

function temporaryMediaError(error: unknown): BrowserMediaGatewayError {
  return new BrowserMediaGatewayError(
    'network_error',
    'The media gateway could not be reached. Try again.',
    true,
    { cause: error },
  );
}

function mediaHeaders(
  operation: 'publish' | 'publish-url' | 'transcode',
  file: File,
  kind: BrowserGatewayMediaKind,
  providerId?: string,
  projectId?: string,
): HeadersInit {
  return {
    'content-type': file.type,
    'x-lumina-media-operation': operation,
    'x-lumina-media-kind': kind,
    'x-lumina-media-file-name': encodeURIComponent(file.name.slice(0, 256)),
    ...(providerId ? { 'x-lumina-media-provider': providerId } : {}),
    ...(projectId?.trim() ? { 'x-lumina-project-id': projectId.trim().slice(0, 256) } : {}),
  };
}

function assertProviderId(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) {
    throw new BrowserMediaGatewayError(
      'provider_required',
      'A provider scope is required for temporary media.',
      false,
    );
  }
  return normalized;
}

async function readTemporaryMediaGrant(response: Response): Promise<TemporaryPublicMedia> {
  if (!response.ok) throw await readGatewayError(response);
  const media = await readGatewayJson(response);
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    throw new BrowserMediaGatewayError(
      'temporary_media_invalid',
      'The media gateway returned an invalid temporary media grant.',
      true,
    );
  }
  const grant = media as Partial<TemporaryPublicMedia>;
  if (
    typeof grant.key !== 'string'
    || typeof grant.url !== 'string'
    || !Number.isFinite(grant.expiresAt)
    || typeof grant.contentType !== 'string'
    || !Number.isFinite(grant.sizeBytes)
  ) {
    throw new BrowserMediaGatewayError(
      'temporary_media_invalid',
      'The media gateway returned an invalid temporary media grant.',
      true,
    );
  }
  return grant as TemporaryPublicMedia;
}

function mediaFileName(file: File, kind: BrowserGatewayMediaKind): string {
  const extension = kind === 'video' ? 'mp4' : 'mp3';
  const baseName = file.name.replace(/\.[^.]+$/, '').trim() || kind;
  return `${baseName}.${extension}`;
}

export function createBrowserMediaGateway({
  fetchImpl = fetch,
}: BrowserMediaGatewayOptions = {}): BrowserMediaGateway {
  return {
    async transcode(file, kind) {
      assertMediaFile(file, kind);
      let response: Response;
      try {
        response = await fetchImpl(MEDIA_GATEWAY_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: mediaHeaders('transcode', file, kind),
          body: file,
        });
      } catch (error) {
        throw temporaryMediaError(error);
      }
      if (!response.ok) {
        throw await readGatewayError(response);
      }
      const mimeType = response.headers.get('content-type')?.split(';', 1)[0] ?? '';
      const expectedMimeType = kind === 'video' ? 'video/mp4' : 'audio/mpeg';
      if (mimeType !== expectedMimeType) {
        throw new BrowserMediaGatewayError(
          'transcode_output_invalid',
          'The media gateway returned an unsupported converted format.',
          true,
        );
      }
      const blob = await readGatewayBlob(response);
      if (blob.size <= 0 || blob.size > MAX_MEDIA_BYTES) {
        throw new BrowserMediaGatewayError(
          'transcode_output_invalid',
          'The media gateway returned an invalid converted file.',
          true,
        );
      }
      return new File([blob], mediaFileName(file, kind), { type: mimeType });
    },

    async publish(file, kind, providerId, context) {
      assertMediaFile(file, kind);
      const normalizedProviderId = assertProviderId(providerId);
      let response: Response;
      try {
        response = await fetchImpl(MEDIA_GATEWAY_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: mediaHeaders('publish', file, kind, normalizedProviderId, context?.projectId),
          body: file,
        });
      } catch (error) {
        throw temporaryMediaError(error);
      }
      return await readTemporaryMediaGrant(response);
    },

    async publishRemote(source, kind, providerId, context) {
      const normalizedProviderId = assertProviderId(providerId);
      let parsed: URL;
      try {
        parsed = new URL(source);
      } catch {
        throw new BrowserMediaGatewayError('media_source_invalid', 'The media URL is invalid.', false);
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new BrowserMediaGatewayError('media_source_invalid', 'The media URL is invalid.', false);
      }
      let response: Response;
      try {
        response = await fetchImpl(MEDIA_GATEWAY_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-lumina-media-operation': 'publish-url',
            'x-lumina-media-kind': kind,
            'x-lumina-media-provider': normalizedProviderId,
            ...(context?.projectId?.trim()
              ? { 'x-lumina-project-id': context.projectId.trim().slice(0, 256) }
              : {}),
          },
          body: JSON.stringify({ source: parsed.toString() }),
        });
      } catch (error) {
        throw temporaryMediaError(error);
      }
      return await readTemporaryMediaGrant(response);
    },

    async release(key) {
      let response: Response;
      try {
        response = await fetchImpl(`${MEDIA_GATEWAY_PATH}/${encodeURIComponent(key)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
      } catch (error) {
        throw temporaryMediaError(error);
      }
      if (!response.ok && response.status !== 404) {
        throw await readGatewayError(response);
      }
    },
  };
}
