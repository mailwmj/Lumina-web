import { describe, expect, it, vi } from 'vitest';

import type { GenerateImagePayload } from '@/features/canvas/application/ports';
import {
  cancelSeedanceVideoGenerationViaWeb,
  pollSeedanceVideoGenerationViaWeb,
  prepareSeedanceVideoContentForWeb,
  submitSeedanceVideoGenerationViaWeb,
} from './webVideoApi';

const payload: GenerateImagePayload = {
  providerId: 'volcvideo',
  model: 'volcvideo/doubao-seedance-2-0-260128',
  prompt: 'A lantern drifts across a lake',
  size: '720p',
  aspectRatio: '16:9',
  videoContent: [
    { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
    { type: 'image_url', role: 'first_frame', url: 'https://media.example/first.png' },
    { type: 'text', text: 'A lantern drifts across a lake' },
  ],
  extraParams: {
    duration: 5,
    hasaudio: true,
    watermark: false,
    seed: 42,
    camerafixed: true,
  },
  providerConfig: {
    api_key: 'provider-key',
    base_url: 'https://ark.example.test/api/v3',
    protocol: 'volcengine-seedance',
  },
};

describe('web Seedance video API', () => {
  it('submits a strict first-last frame request with the provider fixture mapping', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'task-42', status: 'queued',
    }), { status: 200 }));

    const submission = await submitSeedanceVideoGenerationViaWeb(payload, { fetchImpl });

    expect(submission).toEqual({
      externalTaskId: 'task-42',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: 'volcvideo/doubao-seedance-2-0-260128',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/generation/video',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer provider-key' }),
        credentials: 'same-origin',
      }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'submit',
      base_url: 'https://ark.example.test/api/v3',
      request: {
        model: 'doubao-seedance-2-0-260128',
        content: [
          { type: 'image_url', role: 'last_frame', image_url: { url: 'https://media.example/last.png' } },
          { type: 'image_url', role: 'first_frame', image_url: { url: 'https://media.example/first.png' } },
          { type: 'text', text: 'A lantern drifts across a lake' },
        ],
        generate_audio: true,
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
        seed: 42,
        camera_fixed: true,
        watermark: false,
      },
    });
  });

  it('normalizes a provider base URL with a trailing slash before building the task endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'task-trailing-slash', status: 'queued',
    }), { status: 200 }));

    await submitSeedanceVideoGenerationViaWeb({
      ...payload,
      providerConfig: {
        ...payload.providerConfig,
        base_url: 'https://ark.example.test/api/v3/',
      },
    }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/generation/video',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      operation: 'submit',
      base_url: 'https://ark.example.test/api/v3',
    });
  });

  it('re-queries only the persisted provider task and extracts its video result', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'task-42',
      status: 'succeeded',
      content: [{ type: 'video', video_url: 'https://cdn.example.test/result.mp4' }],
      seed: 42,
    }), { status: 200 }));

    await expect(pollSeedanceVideoGenerationViaWeb({
      externalTaskId: 'task-42',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: 'volcvideo/doubao-seedance-2-0-260128',
    }, 'provider-key', { fetchImpl })).resolves.toEqual({
      status: 'succeeded',
      result: 'https://cdn.example.test/result.mp4',
      seed: 42,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/generation/video',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ authorization: 'Bearer provider-key' }),
      }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'poll',
      base_url: 'https://ark.example.test/api/v3',
      task_id: 'task-42',
    });
  });

  it('marks only transient provider poll responses as retryable', async () => {
    for (const status of [408, 425, 429, 503]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'Try again later' },
      }), { status }));

      await expect(pollSeedanceVideoGenerationViaWeb({
        externalTaskId: 'task-42',
        protocol: 'volcengine-seedance',
        baseUrl: 'https://ark.example.test/api/v3',
        model: 'volcvideo/doubao-seedance-2-0-260128',
      }, 'provider-key', { fetchImpl })).resolves.toEqual({
        status: 'failed',
        error: 'Try again later',
        retryable: true,
      });
    }
  });

  it('publishes local and remote frames as provider-scoped temporary media and reclaims them after the task finishes', async () => {
    const publish = vi.fn().mockResolvedValue({
      key: 'local-frame-grant',
      url: 'https://tos.example.test/local-frame',
      expiresAt: 2,
      contentType: 'image/png',
      sizeBytes: 4,
    });
    const publishRemote = vi.fn().mockResolvedValue({
      key: 'remote-frame-grant',
      url: 'https://tos.example.test/remote-frame',
      expiresAt: 2,
      contentType: 'image/png',
      sizeBytes: 4,
    });
    const release = vi.fn().mockResolvedValue(undefined);
    const prepared = await prepareSeedanceVideoContentForWeb([
      { type: 'image_url', role: 'first_frame', url: 'blob:https://lumina.test/first' },
      { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
      { type: 'text', text: 'A lantern drifts across a lake' },
    ], {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Blob(['frame'], { type: 'image/png' }), { status: 200 }),
      ),
      mediaGateway: { publish, publishRemote, release },
      projectId: 'project-1',
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/png' }),
      'image',
      'volcengine-seedance',
      { projectId: 'project-1' },
    );
    expect(publishRemote).toHaveBeenCalledWith(
      'https://media.example/last.png',
      'image',
      'volcengine-seedance',
      { projectId: 'project-1' },
    );
    expect(prepared.content).toEqual([
      { type: 'image_url', role: 'first_frame', url: 'https://tos.example.test/local-frame' },
      { type: 'image_url', role: 'last_frame', url: 'https://tos.example.test/remote-frame' },
      { type: 'text', text: 'A lantern drifts across a lake' },
    ]);
    expect(prepared.temporaryMediaKeys).toEqual(['local-frame-grant', 'remote-frame-grant']);

    await prepared.release();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith('local-frame-grant');
    expect(release).toHaveBeenCalledWith('remote-frame-grant');
  });

  it('waits for concurrent media publication before cleaning up after a sibling failure', async () => {
    let finishLocalPublish: (() => void) | undefined;
    const publish = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishLocalPublish = resolve;
      });
      return {
        key: 'late-local-grant',
        url: 'https://tos.example.test/late-local-frame',
        expiresAt: 2,
        contentType: 'image/png',
        sizeBytes: 4,
      };
    });
    const publishRemote = vi.fn().mockRejectedValue(new Error('remote publication failed'));
    const release = vi.fn().mockResolvedValue(undefined);

    const preparation = prepareSeedanceVideoContentForWeb([
      { type: 'image_url', role: 'first_frame', url: 'blob:first-frame' },
      { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
    ], {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Blob(['frame'], { type: 'image/png' }), { status: 200 }),
      ),
      mediaGateway: { publish, publishRemote, release },
    });

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    finishLocalPublish?.();

    await expect(preparation).rejects.toThrow('remote publication failed');
    expect(release).toHaveBeenCalledWith('late-local-grant');
  });

  it('treats a provider-deleted task as cancelled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ id: 'task-deleted', deleted: true }),
      { status: 200 },
    ));

    await expect(pollSeedanceVideoGenerationViaWeb({
      externalTaskId: 'task-deleted',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: payload.model,
    }, 'provider-key', { fetchImpl })).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('treats a missing provider task as a non-retryable query failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: 'task not found' }),
      { status: 404 },
    ));

    await expect(pollSeedanceVideoGenerationViaWeb({
      externalTaskId: 'task-missing',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: 'volcvideo/doubao-seedance-2-0-260128',
    }, 'provider-key', { fetchImpl })).resolves.toEqual({
      status: 'failed',
      error: 'task not found',
      retryable: false,
    });
  });

  it('rejects unknown provider statuses instead of polling forever', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ id: 'task-unknown', status: 'mystery_state' }),
      { status: 200 },
    ));

    await expect(pollSeedanceVideoGenerationViaWeb({
      externalTaskId: 'task-unknown',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: payload.model,
    }, 'provider-key', { fetchImpl })).resolves.toMatchObject({ status: 'failed' });
  });

  it('does not select unrelated nested URLs as a completed video result', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'task-with-input-echo',
      status: 'succeeded',
      data: { request: { video_url: 'https://inputs.example.test/reference.mp4' } },
    }), { status: 200 }));

    await expect(pollSeedanceVideoGenerationViaWeb({
      externalTaskId: 'task-with-input-echo',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: payload.model,
    }, 'provider-key', { fetchImpl })).resolves.toMatchObject({ status: 'failed' });
  });

  it('maps Seedance model parameters to typed provider fields and keeps draft final requests minimal', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'draft-task-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'final-task-1' }), { status: 200 }));

    await submitSeedanceVideoGenerationViaWeb({
      ...payload,
      model: 'volcvideo/doubao-seedance-1-5-pro-251215',
      videoContent: [{ type: 'text', text: 'A dancer turns' }],
      extraParams: {
        duration: 8,
        hasaudio: false,
        watermark: true,
        seed: 17,
        camerafixed: true,
        draft: true,
        returnLastFrame: true,
      },
    }, { fetchImpl });

    const draftEnvelope = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(draftEnvelope).toMatchObject({ operation: 'submit', base_url: 'https://ark.example.test/api/v3' });
    expect(draftEnvelope.request).toMatchObject({
      model: 'doubao-seedance-1-5-pro-251215',
      generate_audio: false,
      duration: 8,
      seed: 17,
      camera_fixed: true,
      watermark: true,
      draft: true,
      return_last_frame: true,
    });

    await submitSeedanceVideoGenerationViaWeb({
      ...payload,
      draftTaskId: 'draft-task-1',
      extraParams: { duration: 8, watermark: true, returnLastFrame: true },
    }, { fetchImpl });
    const finalEnvelope = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(finalEnvelope).toEqual({
      operation: 'submit',
      base_url: 'https://ark.example.test/api/v3',
      request: {
        model: 'doubao-seedance-2-0-260128',
        content: [{ type: 'draft_task', draft_task: { id: 'draft-task-1' } }],
      },
    });
  });

  it('adds the Seedance 2 web-search tool and preserves preview and last-frame result metadata', async () => {
    const submitFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ id: 'task-meta-1' }), { status: 200 },
    ));
    await submitSeedanceVideoGenerationViaWeb({
      ...payload,
      videoContent: [{ type: 'text', text: 'fresh facts' }],
      extraParams: { enableWebSearch: true, return_last_frame: true },
    }, { fetchImpl: submitFetch });
    const body = JSON.parse(String(submitFetch.mock.calls[0]?.[1]?.body)).request;
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.return_last_frame).toBe(true);

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'task-meta-1',
      status: 'COMPLETED',
      data: {
        video_url: '/api/generation/media/video-result?grant=result&provider=volcengine-seedance-result',
        preview_url: '/api/generation/media/video-preview?grant=preview&provider=volcengine-seedance-result',
        last_frame_url: '/api/generation/media/video-last?grant=last&provider=volcengine-seedance-result',
      },
    }), { status: 200 }));
    await expect(pollSeedanceVideoGenerationViaWeb({
      externalTaskId: 'task-meta-1',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: payload.model,
    }, 'provider-key', { fetchImpl })).resolves.toEqual({
      status: 'succeeded',
      result: '/api/generation/media/video-result?grant=result&provider=volcengine-seedance-result',
      preview: '/api/generation/media/video-preview?grant=preview&provider=volcengine-seedance-result',
      lastFrame: '/api/generation/media/video-last?grant=last&provider=volcengine-seedance-result',
    });
  });

  it.each([
    { status: 204, providerConfirmed: true },
    { status: 404, providerConfirmed: false },
    { status: 503, providerConfirmed: false },
  ])('distinguishes provider cancellation confirmation for HTTP $status', async ({ status, providerConfirmed }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      status === 503 ? JSON.stringify({ message: 'provider unavailable' }) : null,
      { status },
    ));

    await expect(cancelSeedanceVideoGenerationViaWeb({
      externalTaskId: 'task-cancel-1',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: payload.model,
    }, 'provider-key', { fetchImpl })).resolves.toMatchObject({
      status: 'cancelled',
      providerConfirmed,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/generation/video',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'cancel',
      base_url: 'https://ark.example.test/api/v3',
      task_id: 'task-cancel-1',
    });
  });
});
