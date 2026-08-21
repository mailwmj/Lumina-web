import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES,
  materializeRestrictedCanvasAgentImageSources,
} from './restrictedCanvasAgentImage';

const REMOTE_IMAGE = 'https://images.example.test/product.png';

describe('restricted Canvas Agent image sources', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a supported remote raster MIME type and disables redirect following', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(materializeRestrictedCanvasAgentImageSources([
      { source: REMOTE_IMAGE },
    ])).rejects.toThrow(/not a supported raster image/);
    expect(fetchMock).toHaveBeenCalledWith(REMOTE_IMAGE, { redirect: 'error' });
  });

  it('cancels an oversized remote response before buffering the complete image', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({
        done: false,
        value: new Uint8Array(MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES + 1),
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      body: { getReader: () => reader },
      blob: vi.fn().mockResolvedValue(new Blob([new Uint8Array(MAX_CANVAS_AGENT_IMPORT_IMAGE_BYTES + 1)])),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(materializeRestrictedCanvasAgentImageSources([
      { source: REMOTE_IMAGE },
    ])).rejects.toThrow(/maximum size/);
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(response.blob).not.toHaveBeenCalled();
  });
});
