import type { TemporaryPublicMedia } from '@/features/media/domain/mediaProcessor';

export type BrowserGatewayMediaKind = 'audio' | 'video';

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

function temporaryMediaError(error: unknown): BrowserMediaGatewayError {
  return new BrowserMediaGatewayError(
    'network_error',
    'The media gateway could not be reached. Try again.',
    true,
    { cause: error },
  );
}

function mediaHeaders(
  operation: 'publish' | 'transcode',
  file: File,
  kind: BrowserGatewayMediaKind,
  providerId?: string,
): HeadersInit {
  return {
    'content-type': file.type,
    'x-lumina-media-operation': operation,
    'x-lumina-media-kind': kind,
    'x-lumina-media-file-name': encodeURIComponent(file.name.slice(0, 256)),
    ...(providerId ? { 'x-lumina-media-provider': providerId } : {}),
  };
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
      const blob = await response.blob();
      if (blob.size <= 0 || blob.size > MAX_MEDIA_BYTES) {
        throw new BrowserMediaGatewayError(
          'transcode_output_invalid',
          'The media gateway returned an invalid converted file.',
          true,
        );
      }
      return new File([blob], mediaFileName(file, kind), { type: mimeType });
    },

    async publish(file, kind, providerId) {
      assertMediaFile(file, kind);
      if (!providerId.trim()) {
        throw new BrowserMediaGatewayError(
          'provider_required',
          'A provider scope is required for temporary media.',
          false,
        );
      }
      let response: Response;
      try {
        response = await fetchImpl(MEDIA_GATEWAY_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: mediaHeaders('publish', file, kind, providerId.trim()),
          body: file,
        });
      } catch (error) {
        throw temporaryMediaError(error);
      }
      if (!response.ok) {
        throw await readGatewayError(response);
      }
      const media = await response.json() as Partial<TemporaryPublicMedia>;
      if (
        typeof media.key !== 'string'
        || typeof media.url !== 'string'
        || !Number.isFinite(media.expiresAt)
        || typeof media.contentType !== 'string'
        || !Number.isFinite(media.sizeBytes)
      ) {
        throw new BrowserMediaGatewayError(
          'temporary_media_invalid',
          'The media gateway returned an invalid temporary media grant.',
          true,
        );
      }
      return media as TemporaryPublicMedia;
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
