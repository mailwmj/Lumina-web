import { describe, expect, it, vi } from 'vitest';

import type { PersistedGenerationJobHandle } from '@/features/canvas/domain/generationJobHandle';
import { createWebGenerationGateway } from './webGenerationGateway';

describe('webGenerationGateway', () => {
  it('keeps a credential-free Seedance task handle and polls only its original video task', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'video-task-42', status: 'queued' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'video-task-42',
        status: 'succeeded',
        output_url: 'https://cdn.example.test/video.mp4',
      }), { status: 200 }));
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'video-key',
      base_url: 'https://ark.example.test/api/v3',
      protocol: 'volcengine-seedance',
    };

    const receipt = await gateway.submitGenerateVideoJob({
      providerId: 'volcvideo',
      model: 'volcvideo/doubao-seedance-2-0-260128',
      prompt: 'A lantern drifts across a lake',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [
        { type: 'image_url', role: 'first_frame', url: 'https://media.example/first.png' },
        { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
        { type: 'text', text: 'A lantern drifts across a lake' },
      ],
      providerConfig,
    });

    expect(receipt).toMatchObject({
      jobId: expect.stringMatching(/^web-video-/),
      taskHandle: {
        kind: 'browser-direct',
        externalTaskId: 'video-task-42',
        protocol: 'volcengine-seedance',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('video-key');
    const reloadedGateway = createWebGenerationGateway({ fetchImpl });
    await expect(reloadedGateway.getGenerateImageJob(
      receipt.jobId,
      providerConfig,
      receipt.taskHandle,
    )).resolves.toMatchObject({
      status: 'succeeded',
      result: 'https://cdn.example.test/video.mp4',
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://ark.example.test/api/v3/contents/generations/tasks',
      'https://ark.example.test/api/v3/contents/generations/tasks/video-task-42',
    ]);
  });

  it('releases temporary Seedance frames after a terminal provider result', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('blob:')) {
        return new Response(new Blob(['frame'], { type: 'image/png' }), { status: 200 });
      }
      if (url === '/api/generation/media' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          key: 'frame-grant',
          url: 'https://gateway.example.test/media/frame-grant',
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: 5,
        }), { status: 201 });
      }
      if (url === 'https://ark.example.test/api/v3/contents/generations/tasks') {
        return new Response(JSON.stringify({ id: 'video-task-43', status: 'queued' }), { status: 200 });
      }
      if (url === 'https://ark.example.test/api/v3/contents/generations/tasks/video-task-43') {
        return new Response(JSON.stringify({ status: 'succeeded', output_url: 'https://cdn.example.test/video.mp4' }), { status: 200 });
      }
      if (url === '/api/generation/media/frame-grant' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'video-key',
      base_url: 'https://ark.example.test/api/v3',
      protocol: 'volcengine-seedance',
    };
    const receipt = await gateway.submitGenerateVideoJob({
      providerId: 'volcvideo',
      model: 'volcvideo/doubao-seedance-2-0-260128',
      prompt: 'A lantern drifts across a lake',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [
        { type: 'image_url', role: 'first_frame', url: 'blob:https://lumina.test/first' },
        { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
        { type: 'text', text: 'A lantern drifts across a lake' },
      ],
      providerConfig,
    });

    await expect(gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/generation/media/frame-grant', expect.objectContaining({ method: 'DELETE' }));
  });

  it('reclaims persisted temporary Seedance frames after refresh without resubmitting', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://ark.example.test/api/v3/contents/generations/tasks/video-task-43') {
        return new Response(JSON.stringify({ status: 'succeeded', output_url: 'https://cdn.example.test/video.mp4' }), { status: 200 });
      }
      if (url === '/api/generation/media/frame-grant' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const taskHandle: PersistedGenerationJobHandle = {
      version: 1,
      kind: 'browser-direct',
      externalTaskId: 'video-task-43',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: 'volcvideo/doubao-seedance-2-0-260128',
      temporaryMediaKeys: ['frame-grant'],
    };

    await expect(gateway.getGenerateImageJob('web-video-local-task', {
      api_key: 'video-key',
    }, taskHandle)).resolves.toMatchObject({
      status: 'succeeded', result: 'https://cdn.example.test/video.mp4',
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://ark.example.test/api/v3/contents/generations/tasks/video-task-43',
      '/api/generation/media/frame-grant',
    ]);
  });

  it('keeps a transient Seedance poll recoverable and retries only its original task', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Try again later' } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'succeeded',
        output_url: 'https://cdn.example.test/video.mp4',
      }), { status: 200 }));
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'video-key',
      base_url: 'https://ark.example.test/api/v3',
      protocol: 'volcengine-seedance',
    };
    const taskHandle: PersistedGenerationJobHandle = {
      version: 1,
      kind: 'browser-direct',
      externalTaskId: 'video-task-44',
      protocol: 'volcengine-seedance',
      baseUrl: 'https://ark.example.test/api/v3',
      model: 'volcvideo/doubao-seedance-2-0-260128',
    };

    await expect(gateway.getGenerateImageJob('web-video-local-task', providerConfig, taskHandle))
      .resolves.toMatchObject({ status: 'running', recovery: { retry_count: 1 } });
    await expect(gateway.retryGenerateImageJob('web-video-local-task', providerConfig, taskHandle))
      .resolves.toMatchObject({ status: 'succeeded', result: 'https://cdn.example.test/video.mp4' });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://ark.example.test/api/v3/contents/generations/tasks/video-task-44',
      'https://ark.example.test/api/v3/contents/generations/tasks/video-task-44',
    ]);
  });

  it('returns preview and last-frame metadata from the original Seedance task', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'video-task-meta', status: 'queued' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'video-task-meta',
        status: 'succeeded',
        output_url: 'https://cdn.example.test/video.mp4',
        preview_url: 'https://cdn.example.test/video.jpg',
        last_frame_url: 'https://cdn.example.test/video-last.jpg',
      }), { status: 200 }));
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'video-key',
      base_url: 'https://ark.example.test/api/v3',
      protocol: 'volcengine-seedance',
    };
    const receipt = await gateway.submitGenerateVideoJob({
      providerId: 'volcvideo',
      model: 'volcvideo/doubao-seedance-2-0-260128',
      prompt: 'metadata',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [{ type: 'text', text: 'metadata' }],
      providerConfig,
    });

    await expect(gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({
        status: 'succeeded',
        result: 'https://cdn.example.test/video.mp4',
        preview: 'https://cdn.example.test/video.jpg',
        last_frame: 'https://cdn.example.test/video-last.jpg',
        external_task_id: 'video-task-meta',
      });
    await expect(gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({
        status: 'succeeded',
        result: 'https://cdn.example.test/video.mp4',
        preview: 'https://cdn.example.test/video.jpg',
        last_frame: 'https://cdn.example.test/video-last.jpg',
        external_task_id: 'video-task-meta',
      });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('marks a video task cancelled locally before provider confirmation and ignores a late poll', async () => {
    let resolvePoll!: (response: Response) => void;
    let resolveCancel!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'video-task-cancel', status: 'queued' }), { status: 200 }));
      }
      if (init?.method === 'DELETE') {
        return new Promise((resolve) => { resolveCancel = resolve; });
      }
      if (url.endsWith('/video-task-cancel')) {
        return new Promise((resolve) => { resolvePoll = resolve; });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'video-key',
      base_url: 'https://ark.example.test/api/v3',
      protocol: 'volcengine-seedance',
    };
    const receipt = await gateway.submitGenerateVideoJob({
      providerId: 'volcvideo',
      model: 'volcvideo/doubao-seedance-2-0-260128',
      prompt: 'cancel me',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [{ type: 'text', text: 'cancel me' }],
      providerConfig,
    });
    const latePoll = gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle);
    await vi.waitFor(() => expect(resolvePoll).toBeTypeOf('function'));
    const cancelPromise = gateway.cancelGenerateImageJob(
      receipt.jobId,
      providerConfig,
      receipt.taskHandle,
    );
    await expect(gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({ status: 'cancelled' });
    resolveCancel(new Response(JSON.stringify({ message: 'provider unavailable' }), { status: 503 }));
    await expect(cancelPromise).resolves.toMatchObject({
      status: 'cancelled',
      providerConfirmed: false,
    });
    resolvePoll(new Response(JSON.stringify({
      status: 'succeeded', output_url: 'https://cdn.example.test/late.mp4',
    }), { status: 200 }));
    await expect(latePoll).resolves.toMatchObject({ status: 'cancelled' });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });

  it('does not schedule recovery when an in-flight poll fails after local cancellation', async () => {
    let rejectPoll!: (error: unknown) => void;
    let resolveCancel!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'video-task-cancel-network' }), { status: 200 }));
      }
      if (init?.method === 'DELETE') {
        return new Promise((resolve) => { resolveCancel = resolve; });
      }
      if (url.endsWith('/video-task-cancel-network')) {
        return new Promise((_resolve, reject) => { rejectPoll = reject; });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'video-key',
      base_url: 'https://ark.example.test/api/v3',
      protocol: 'volcengine-seedance',
    };
    const receipt = await gateway.submitGenerateVideoJob({
      providerId: 'volcvideo',
      model: 'volcvideo/doubao-seedance-2-0-260128',
      prompt: 'cancel network error',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [{ type: 'text', text: 'cancel network error' }],
      providerConfig,
    });
    const latePoll = gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle);
    await vi.waitFor(() => expect(rejectPoll).toBeTypeOf('function'));
    const cancelPromise = gateway.cancelGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle);
    await expect(gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({ status: 'cancelled' });
    resolveCancel(new Response(null, { status: 204 }));
    await expect(cancelPromise).resolves.toMatchObject({ providerConfirmed: true });
    rejectPoll(new Error('late network failure'));
    await expect(latePoll).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('does not overwrite a terminal video task when a late cancellation arrives', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'video-task-terminal', status: 'queued' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'succeeded', output_url: 'https://cdn.example.test/terminal.mp4',
      }), { status: 200 }));
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'video-key',
      base_url: 'https://ark.example.test/api/v3',
      protocol: 'volcengine-seedance',
    };
    const receipt = await gateway.submitGenerateVideoJob({
      providerId: 'volcvideo',
      model: 'volcvideo/doubao-seedance-2-0-260128',
      prompt: 'terminal task',
      size: '720p',
      aspectRatio: '16:9',
      videoContent: [{ type: 'text', text: 'terminal task' }],
      providerConfig,
    });

    await expect(gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({ status: 'succeeded', result: 'https://cdn.example.test/terminal.mp4' });
    await expect(gateway.cancelGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({ status: 'cancelled', providerConfirmed: false });
    await expect(gateway.getGenerateImageJob(receipt.jobId, providerConfig, receipt.taskHandle))
      .resolves.toMatchObject({ status: 'succeeded', result: 'https://cdn.example.test/terminal.mp4' });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

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
    expect(init.credentials).toBe('same-origin');

    await expect(gateway.getGenerateImageJob(jobId)).resolves.toMatchObject({ status: 'succeeded' });
    const pollInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(pollInit.headers).toEqual(expect.objectContaining({ authorization: 'Bearer temporary-key' }));
    expect(pollInit.credentials).toBe('same-origin');
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

  it('registers a custom OpenAI-compatible provider before same-origin submit and poll', async () => {
    const provider = 'custom-openai:tenant-a';
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url === '/api/generation/providers/custom') {
        expect(JSON.parse(String(init?.body))).toEqual({
          operation: 'register',
          provider: {
            id: provider,
            base_url: 'https://custom.example/v1',
            protocol: 'openai-images',
          },
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === '/api/generation/jobs') {
        return Promise.resolve(new Response(JSON.stringify({ job_id: 'job-custom', status: 'running' }), { status: 202 }));
      }
      if (url === '/api/generation/jobs/job-custom') {
        return Promise.resolve(new Response(JSON.stringify({
          job_id: 'job-custom', status: 'succeeded', result: '/api/generation/jobs/job-custom/result',
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`Custom provider must not be called from the browser: ${url}`));
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('openai', 'custom-temporary-key');
    const providerConfig = {
      base_url: 'https://custom.example/v1',
      protocol: 'openai-images',
      gateway_provider: provider,
    };

    const jobId = await gateway.submitGenerateImageJob({
      providerId: 'openai',
      model: `${provider}/vendor-image-v1`,
      prompt: 'a kite',
      size: '2K',
      aspectRatio: '16:9',
      providerConfig,
      projectId: 'project-1',
      projectRevision: 'revision-1',
    });
    expect(jobId).toBe('job-custom');
    await expect(gateway.getGenerateImageJob(jobId, providerConfig)).resolves.toMatchObject({
      status: 'succeeded', result: '/api/generation/jobs/job-custom/result',
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/generation/providers/custom',
      '/api/generation/jobs',
      '/api/generation/providers/custom',
      '/api/generation/jobs/job-custom',
    ]);
    const submit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(submit.body))).toMatchObject({
      provider,
      request: { model: `${provider}/vendor-image-v1` },
    });
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).toEqual(expect.objectContaining({
        authorization: 'Bearer custom-temporary-key',
      }));
      expect(init?.credentials).toBe('same-origin');
    }
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

  it('routes Chaomo submission and polling through the same-origin gateway', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url === '/api/generation/jobs') {
        return Promise.resolve(new Response(JSON.stringify({ job_id: 'job-chaomo', status: 'running' }), { status: 202 }));
      }
      if (url === '/api/generation/jobs/job-chaomo') {
        return Promise.resolve(new Response(JSON.stringify({
          job_id: 'job-chaomo', status: 'succeeded', result: '/api/generation/jobs/job-chaomo/result',
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`Chaomo must not be requested from the browser: ${url} ${init?.method ?? 'GET'}`));
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('chaomo', 'chaomo-temporary-key');

    const jobId = await gateway.submitGenerateImageJob({
      providerId: 'chaomo',
      model: 'chaomo/gpt-image2-4K',
      prompt: 'a lantern',
      size: '4K',
      aspectRatio: '16:9',
      providerConfig: { base_url: 'https://www.chaomoapi.com/v1', provider_id: 'chaomo' },
      projectId: 'project-1',
      projectRevision: 'revision-1',
    });

    expect(jobId).toBe('job-chaomo');
    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      operation: 'submit',
      provider: 'chaomo',
      request: { model: 'chaomo/gpt-image2-4K', prompt: 'a lantern' },
    });
    await expect(gateway.getGenerateImageJob(jobId, { provider_id: 'chaomo' })).resolves.toMatchObject({
      status: 'succeeded',
      result: '/api/generation/jobs/job-chaomo/result',
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/generation/jobs',
      '/api/generation/jobs/job-chaomo',
    ]);
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).headers).toEqual(expect.objectContaining({
      authorization: 'Bearer chaomo-temporary-key',
    }));
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

  it('restores a browser-direct task from its credential-free handle without submitting again', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        request_id: 'fal-task-42',
        status_url: 'https://queue.fal.run/tasks/fal-task-42',
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'COMPLETED',
        response: { images: [{ url: 'https://cdn.example.test/result.png' }] },
      }), { status: 200 }));
    const firstGateway = createWebGenerationGateway({ fetchImpl });
    await firstGateway.setApiKey('fal', 'first-key');
    const settled: Array<{
      status: 'fulfilled';
      jobId: string;
      taskHandle?: PersistedGenerationJobHandle;
    }> = [];

    await firstGateway.submitGenerateImageJobs({
      providerId: 'fal',
      model: 'fal/nano-banana-2',
      prompt: 'a kite',
      size: '1K',
      aspectRatio: '1:1',
      providerConfig: { base_url: 'https://queue.fal.run' },
    }, 1, (result) => {
      if (result.status === 'fulfilled') {
        settled.push(result);
      }
    }, vi.fn());

    const receipt = settled[0];
    expect(receipt?.taskHandle).toEqual(expect.objectContaining({
      externalTaskId: 'fal-task-42',
      protocol: 'fal',
    }));
    expect(JSON.stringify(receipt?.taskHandle)).not.toContain('first-key');

    const reloadedGateway = createWebGenerationGateway({ fetchImpl });
    await reloadedGateway.setApiKey('fal', 'second-key');

    await expect(reloadedGateway.getGenerateImageJob(
      receipt!.jobId,
      { api_key: 'second-key' },
      receipt!.taskHandle,
    )).resolves.toMatchObject({
      status: 'succeeded',
      result: 'https://cdn.example.test/result.png',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('backs off transient browser-direct polls and re-queries only the original task manually', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          request_id: 'fal-task-42',
          status_url: 'https://queue.fal.run/tasks/fal-task-42',
        }), { status: 202 }))
        .mockRejectedValue(new Error('Network timed out'));
      const gateway = createWebGenerationGateway({ fetchImpl });
      await gateway.setApiKey('fal', 'provider-key');
      const settled: Array<{
        status: 'fulfilled';
        jobId: string;
        taskHandle?: PersistedGenerationJobHandle;
      }> = [];

      await gateway.submitGenerateImageJobs({
        providerId: 'fal',
        model: 'fal/nano-banana-2',
        prompt: 'a kite',
        size: '1K',
        aspectRatio: '1:1',
        providerConfig: { base_url: 'https://queue.fal.run' },
      }, 1, (result) => {
        if (result.status === 'fulfilled') {
          settled.push(result);
        }
      }, vi.fn());

      const receipt = settled[0]!;
      let status = await gateway.getGenerateImageJob(
        receipt.jobId,
        { api_key: 'provider-key' },
        receipt.taskHandle,
      );
      for (let retryCount = 2; retryCount <= 5; retryCount += 1) {
        vi.setSystemTime(status.recovery?.next_retry_at ?? Date.now());
        status = await gateway.getGenerateImageJob(
          receipt.jobId,
          { api_key: 'provider-key' },
          receipt.taskHandle,
        );
      }

      expect(status).toMatchObject({
        status: 'running',
        recovery: {
          retry_count: 5,
          requires_manual_requery: true,
          last_error: 'Network timed out',
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(6);

      await gateway.getGenerateImageJob(receipt.jobId, { api_key: 'provider-key' }, receipt.taskHandle);
      expect(fetchImpl).toHaveBeenCalledTimes(6);

      await gateway.retryGenerateImageJob(receipt.jobId, { api_key: 'provider-key' }, receipt.taskHandle);
      expect(fetchImpl).toHaveBeenCalledTimes(7);
      expect(fetchImpl.mock.calls.slice(1).every(([url]) => url === 'https://queue.fal.run/tasks/fal-task-42'))
        .toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
