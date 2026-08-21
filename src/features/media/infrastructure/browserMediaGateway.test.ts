import { describe, expect, it, vi } from 'vitest';

import {
  BrowserMediaGatewayError,
  createBrowserMediaGateway,
} from './browserMediaGateway';

describe('browser media Gateway client', () => {
  it('uploads an asset as a provider-scoped temporary grant without persisting its URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      key: 'media-opaque-id',
      url: 'https://lumina.test/api/generation/media/media-opaque-id?grant=opaque-grant&provider=volcengine-seedance',
      expiresAt: 456,
      contentType: 'video/mp4',
      sizeBytes: 5,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const gateway = createBrowserMediaGateway({ fetchImpl });

    const grant = await gateway.publish(
      new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      'video',
      'volcengine-seedance',
    );

    expect(fetchImpl).toHaveBeenCalledWith('/api/generation/media', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'x-lumina-media-operation': 'publish',
        'x-lumina-media-kind': 'video',
        'x-lumina-media-provider': 'volcengine-seedance',
      }),
    }));
    expect(grant).toEqual(expect.objectContaining({ key: 'media-opaque-id', expiresAt: 456 }));
  });

  it('turns gateway failures into retryable errors and does not return a converted file', async () => {
    const gateway = createBrowserMediaGateway({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: 'transcoder_unavailable',
        message: 'Gateway transcoding is temporarily unavailable.',
      }), { status: 503, headers: { 'content-type': 'application/json' } })),
    });

    await expect(gateway.transcode(
      new File(['mov'], 'clip.mov', { type: 'video/quicktime' }),
      'video',
    )).rejects.toEqual(expect.objectContaining<Partial<BrowserMediaGatewayError>>({
      name: 'BrowserMediaGatewayError',
      code: 'transcoder_unavailable',
      retryable: true,
    }));
  });

  it('normalizes transport failures for transcode, publish, and release as retryable errors', async () => {
    const gateway = createBrowserMediaGateway({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('network down')),
    });
    const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });

    for (const operation of [
      () => gateway.transcode(file, 'video'),
      () => gateway.publish(file, 'video', 'volcengine-seedance'),
      () => gateway.release('media-opaque-id'),
    ]) {
      await expect(operation()).rejects.toEqual(expect.objectContaining({
        name: 'BrowserMediaGatewayError',
        code: 'network_error',
        retryable: true,
      }));
    }
  });

  it('normalizes response body stream failures as retryable errors', async () => {
    const transcodeResponse = new Response('converted', {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    });
    vi.spyOn(transcodeResponse, 'blob').mockRejectedValue(new TypeError('truncated body'));
    const transcodeGateway = createBrowserMediaGateway({
      fetchImpl: vi.fn().mockResolvedValue(transcodeResponse),
    });
    await expect(transcodeGateway.transcode(
      new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      'video',
    )).rejects.toEqual(expect.objectContaining({
      name: 'BrowserMediaGatewayError',
      code: 'network_error',
      retryable: true,
    }));

    const publishResponse = new Response('{}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
    vi.spyOn(publishResponse, 'json').mockRejectedValue(new TypeError('truncated body'));
    const publishGateway = createBrowserMediaGateway({
      fetchImpl: vi.fn().mockResolvedValue(publishResponse),
    });
    await expect(publishGateway.publish(
      new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      'video',
      'volcengine-seedance',
    )).rejects.toEqual(expect.objectContaining({
      name: 'BrowserMediaGatewayError',
      code: 'network_error',
      retryable: true,
    }));
  });

  it('rejects non-object temporary media grants with a normalized error', async () => {
    const gateway = createBrowserMediaGateway({
      fetchImpl: vi.fn().mockResolvedValue(new Response('null', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(gateway.publish(
      new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      'video',
      'volcengine-seedance',
    )).rejects.toEqual(expect.objectContaining({
      name: 'BrowserMediaGatewayError',
      code: 'temporary_media_invalid',
      retryable: true,
    }));
  });
});
