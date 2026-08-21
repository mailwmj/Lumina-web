import { blobToDataUrl } from '@/features/canvas/application/imageData';

export const MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_CANVAS_AGENT_IMPORT_BATCH_BYTES = 24 * 1024 * 1024;

const MAX_CANVAS_AGENT_IMAGE_SOURCE_LENGTH = Math.ceil(
  MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES * 4 / 3,
) + 128;
const RASTER_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/avif',
]);
const RASTER_DATA_URL_PATTERN = /^data:(image\/(?:png|jpe?g|webp|gif|bmp|tiff|avif));base64,([A-Za-z0-9+/]+={0,2})$/i;

export class RestrictedCanvasAgentImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestrictedCanvasAgentImageError';
  }
}

export function validateRestrictedCanvasAgentImageSource(source: string): number | null {
  if (source.length > MAX_CANVAS_AGENT_IMAGE_SOURCE_LENGTH) {
    throw new RestrictedCanvasAgentImageError('The imported image exceeds the maximum size.');
  }
  if (/^https:\/\//i.test(source)) {
    return null;
  }
  const match = source.match(RASTER_DATA_URL_PATTERN);
  if (!match || match[2].length % 4 !== 0) {
    throw new RestrictedCanvasAgentImageError(
      'source must be an HTTPS URL or a raster image data URL.'
    );
  }
  const byteLength = estimateBase64ByteLength(match[2]);
  if (byteLength > MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES) {
    throw new RestrictedCanvasAgentImageError('The imported image exceeds the maximum size.');
  }
  return byteLength;
}

export async function materializeRestrictedCanvasAgentImageSources(
  images: readonly { source: string }[],
): Promise<string[]> {
  let totalBytes = 0;
  const sources: string[] = [];
  for (const image of images) {
    const inlineBytes = validateRestrictedCanvasAgentImageSource(image.source);
    if (inlineBytes !== null) {
      totalBytes = addImportedBytes(totalBytes, inlineBytes);
      sources.push(image.source);
      continue;
    }
    const response = await fetch(image.source, { redirect: 'error' });
    if (!response.ok) {
      throw new RestrictedCanvasAgentImageError(
        `The imported image could not be downloaded (status ${response.status}).`
      );
    }
    const mimeType = normalizeRasterMimeType(response.headers.get('content-type'));
    if (!mimeType) {
      throw new RestrictedCanvasAgentImageError('The imported source is not a supported raster image.');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES) {
      throw new RestrictedCanvasAgentImageError('The imported image exceeds the maximum size.');
    }
    const blob = await readRemoteImageBlob(response, mimeType);
    totalBytes = addImportedBytes(totalBytes, blob.size);
    sources.push(await blobToDataUrl(new Blob([blob], { type: mimeType })));
  }
  return sources;
}

async function readRemoteImageBlob(response: Response, mimeType: string): Promise<Blob> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new RestrictedCanvasAgentImageError('The imported image response did not include image data.');
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RestrictedCanvasAgentImageError('The imported image exceeds the maximum size.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: mimeType });
}

function estimateBase64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function addImportedBytes(total: number, next: number): number {
  const result = total + next;
  if (result > MAX_CANVAS_AGENT_IMPORT_BATCH_BYTES) {
    throw new RestrictedCanvasAgentImageError('The imported image batch exceeds the maximum size.');
  }
  return result;
}

function normalizeRasterMimeType(value: string | null): string | null {
  const mimeType = value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return RASTER_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null;
}
