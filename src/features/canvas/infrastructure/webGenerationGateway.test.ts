import { describe, expect, it, vi } from 'vitest';

import { createWebGenerationGateway } from './webGenerationGateway';

describe('webGenerationGateway', () => {
  it('keeps the key in browser memory and sends project revision with submit', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'job-1', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job_id: 'job-1', status: 'succeeded', result: '/api/generation/jobs/job-1/result',
      }), { status: 200 }));
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('ai-media', 'temporary-key');

    const jobId = await gateway.submitGenerateImageJob({
      providerId: 'ai-media',
      model: 'ai-media/gpt-image-2',
      prompt: 'a kite',
      size: '1K',
      aspectRatio: '1:1',
      providerConfig: { base_url: 'https://api.ai-media.vip/v1' },
      projectId: 'project-1',
      projectRevision: 'r3',
    });
    expect(jobId).toBe('job-1');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      projectId: 'project-1',
      projectRevision: 'r3',
      request: { model: 'ai-media/gpt-image-2', prompt: 'a kite' },
    });
    expect(init.headers).toEqual(expect.objectContaining({ authorization: 'Bearer temporary-key' }));

    await expect(gateway.getGenerateImageJob(jobId)).resolves.toMatchObject({ status: 'succeeded' });
    const pollInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(pollInit.headers).toEqual(expect.objectContaining({ authorization: 'Bearer temporary-key' }));
  });

  it('runs preflight before invoking the result-node callback', async () => {
    const fetchImpl = vi.fn();
    const gateway = createWebGenerationGateway({ fetchImpl });
    const beforeSubmit = vi.fn();
    await expect(gateway.submitGenerateImageJobs({
      providerId: 'ai-media', model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K',
      aspectRatio: '1:1',
      providerConfig: { base_url: 'https://api.ai-media.vip/v1' },
    }, 1, vi.fn(), beforeSubmit)).rejects.toThrow();
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a custom provider endpoint instead of silently routing it through the official gateway', async () => {
    const gateway = createWebGenerationGateway({ fetchImpl: vi.fn() });
    await gateway.setApiKey('ai-media', 'temporary-key');
    await expect(gateway.submitGenerateImageJob({
      providerId: 'ai-media',
      model: 'ai-media/gpt-image-2',
      prompt: 'test',
      size: '1K',
      aspectRatio: '1:1',
      providerConfig: { base_url: 'https://custom.example/v1' },
      projectId: 'project-1',
      projectRevision: 'r1',
    })).rejects.toThrow();
  });

  it('uses browser-direct CORS for a custom OpenAI-compatible provider', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), { status: 200 })
    );
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('openai', 'custom-key');
    const jobId = await gateway.submitGenerateImageJob({
      providerId: 'openai',
      model: 'openai/vendor/image-model',
      prompt: 'a kite',
      size: '2K',
      aspectRatio: '16:9',
      providerConfig: { base_url: 'https://custom.example/v1' },
      referenceImages: ['data:image/png;base64,AQID'],
    });
    await expect(gateway.getGenerateImageJob(jobId)).resolves.toMatchObject({
      status: 'succeeded', result: 'data:image/png;base64,AQID',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual({ authorization: 'Bearer custom-key' });
    expect(request.body).toBeInstanceOf(FormData);
    expect((request.body as FormData).get('model')).toBe('vendor/image-model');
    expect((request.body as FormData).getAll('image')).toHaveLength(1);
  });

  it('keeps ordered reference data when submitting through the same-origin gateway', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'job-ref', status: 'queued' }), { status: 202 }));
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('ai-media', 'temporary-key');
    await gateway.submitGenerateImageJob({
      providerId: 'ai-media', model: 'ai-media/gpt-image-2', prompt: 'use refs', size: '1K', aspectRatio: '1:1',
      providerConfig: { base_url: 'https://api.ai-media.vip/v1' },
      referenceImages: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
      projectId: 'project-1', projectRevision: 'r1',
    });
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.request.referenceImages).toEqual([
      'data:image/png;base64,ONE', 'data:image/png;base64,TWO',
    ]);
  });

  it('polls asynchronous browser-direct providers for the synchronous gateway contract', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          request_id: 'fhl-task', status_url: 'https://fhl/status/fhl-task',
        }), { status: 202 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          status: 'COMPLETED', response: { images: [{ url: 'https://cdn/result.png' }] },
        }), { status: 200 }));
      const gateway = createWebGenerationGateway({ fetchImpl });
      const resultPromise = gateway.generateImage({
        providerId: 'fhl', model: 'fhl/gpt-image-2', prompt: 'a kite', size: '1K', aspectRatio: '1:1',
        providerConfig: { api_key: 'key', base_url: 'https://fhl', protocol: 'fhl-images' },
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(resultPromise).resolves.toBe('https://cdn/result.png');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
