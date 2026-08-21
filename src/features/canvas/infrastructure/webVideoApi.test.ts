import { describe, expect, it, vi } from 'vitest';

import type { GenerateImagePayload } from '@/features/canvas/application/ports';
import {
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
      'https://ark.example.test/api/v3/contents/generations/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer provider-key' }),
      }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
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
      'https://ark.example.test/api/v3/contents/generations/tasks/task-42',
      expect.objectContaining({ headers: { authorization: 'Bearer provider-key' } }),
    );
  });

  it('marks rate-limited and server-error polls as retryable', async () => {
    for (const status of [429, 503]) {
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

  it('publishes local frame bytes as provider-scoped temporary media and reclaims them after the task finishes', async () => {
    const publish = vi.fn().mockResolvedValue({
      key: 'frame-grant',
      url: 'https://gateway.example.test/media/frame-grant',
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
      mediaGateway: { publish, release },
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/png' }),
      'image',
      'volcengine-seedance',
    );
    expect(prepared.content).toEqual([
      { type: 'image_url', role: 'first_frame', url: 'https://gateway.example.test/media/frame-grant' },
      { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
      { type: 'text', text: 'A lantern drifts across a lake' },
    ]);
    expect(prepared.temporaryMediaKeys).toEqual(['frame-grant']);

    await prepared.release();
    expect(release).toHaveBeenCalledWith('frame-grant');
  });
});
