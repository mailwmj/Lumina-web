import { describe, expect, it, vi } from 'vitest';

import type { PersistedGenerationJobHandle } from '@/features/canvas/domain/generationJobHandle';
import { createWebGenerationGateway } from './webGenerationGateway';

describe('webGenerationGateway', () => {
  it('keeps a credential-free Seedance task handle and polls only its original video task', async () => {
    let mediaCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/media' && init?.method === 'POST') {
        mediaCount += 1;
        return new Response(JSON.stringify({
          key: `frame-grant-${mediaCount}`,
          url: `https://gateway.example.test/media/frame-grant-${mediaCount}`,
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: 5,
        }), { status: 201 });
      }
      if (url === '/api/generation/video' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.operation === 'submit') {
          return new Response(JSON.stringify({ id: 'video-task-42', status: 'queued' }), { status: 200 });
        }
        if (body.operation === 'poll') {
          return new Response(JSON.stringify({
            id: 'video-task-42',
            status: 'succeeded',
            output_url: 'https://cdn.example.test/video.mp4',
          }), { status: 200 });
        }
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
    expect(JSON.stringify(receipt)).not.toContain('frame-grant');
    expect(receipt.taskHandle).not.toHaveProperty('temporaryMediaKeys');
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
      '/api/generation/media',
      '/api/generation/media',
      '/api/generation/video',
      '/api/generation/video',
    ]);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.credentials === 'same-origin')).toBe(true);
    const videoBodies = fetchImpl.mock.calls
      .filter(([url]) => String(url) === '/api/generation/video')
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(videoBodies).toMatchObject([
      { operation: 'submit', base_url: providerConfig.base_url },
      { operation: 'poll', base_url: providerConfig.base_url, task_id: 'video-task-42' },
    ]);
  });

  it('releases temporary Seedance frames after a terminal provider result', async () => {
    let mediaCount = 0;
    const releases: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('blob:')) {
        return new Response(new Blob(['frame'], { type: 'image/png' }), { status: 200 });
      }
      if (url === '/api/generation/media' && init?.method === 'POST') {
        mediaCount += 1;
        return new Response(JSON.stringify({
          key: `frame-grant-${mediaCount}`,
          url: `https://gateway.example.test/media/frame-grant-${mediaCount}`,
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: 5,
        }), { status: 201 });
      }
      if (url === '/api/generation/video' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.operation === 'submit') {
          return new Response(JSON.stringify({ id: 'video-task-43', status: 'queued' }), { status: 200 });
        }
        if (body.operation === 'poll') {
          return new Response(JSON.stringify({ status: 'succeeded', output_url: 'https://cdn.example.test/video.mp4' }), { status: 200 });
        }
      }
      if (url.startsWith('/api/generation/media/frame-grant-') && init?.method === 'DELETE') {
        releases.push(url);
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
    expect(receipt.taskHandle).not.toHaveProperty('temporaryMediaKeys');
    expect(releases).toHaveLength(2);
    expect(releases).toEqual(expect.arrayContaining([
      '/api/generation/media/frame-grant-1',
      '/api/generation/media/frame-grant-2',
    ]));
  });

  it('recovers the original Seedance task without persisting temporary media keys', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/video' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.operation === 'poll' && body.task_id === 'video-task-43') {
          return new Response(JSON.stringify({ status: 'succeeded', output_url: 'https://cdn.example.test/video.mp4' }), { status: 200 });
        }
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
    };

    await expect(gateway.getGenerateImageJob('web-video-local-task', {
      api_key: 'video-key',
    }, taskHandle)).resolves.toMatchObject({
      status: 'succeeded', result: 'https://cdn.example.test/video.mp4',
    });
    expect(taskHandle).not.toHaveProperty('temporaryMediaKeys');
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['/api/generation/video']);
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
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
      '/api/generation/video',
      '/api/generation/video',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => (
      JSON.parse(String(init?.body)) as Record<string, unknown>
    ).operation)).toEqual(['poll', 'poll']);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.credentials === 'same-origin')).toBe(true);
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
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url !== '/api/generation/video' || init?.method !== 'POST') {
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
      }
      if (body.operation === 'submit') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'video-task-cancel', status: 'queued' }), { status: 200 }));
      }
      if (body.operation === 'cancel') {
        return new Promise((resolve) => { resolveCancel = resolve; });
      }
      if (body.operation === 'poll') {
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
    const operations = fetchImpl.mock.calls.map(([, init]) => (
      JSON.parse(String(init?.body)) as Record<string, unknown>
    ).operation);
    expect(operations.filter((operation) => operation === 'cancel')).toHaveLength(1);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.credentials === 'same-origin')).toBe(true);
  });

  it('does not schedule recovery when an in-flight poll fails after local cancellation', async () => {
    let rejectPoll!: (error: unknown) => void;
    let resolveCancel!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url !== '/api/generation/video' || init?.method !== 'POST') {
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
      }
      if (body.operation === 'submit') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'video-task-cancel-network' }), { status: 200 }));
      }
      if (body.operation === 'cancel') {
        return new Promise((resolve) => { resolveCancel = resolve; });
      }
      if (body.operation === 'poll') {
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

  it('proxies a direct OpenAI-compatible multipart request without setting its boundary', async () => {
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
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/generation/image-provider');
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get('authorization')).toBe('Bearer custom-key');
    expect(headers.get('x-lumina-image-protocol')).toBe('openai-images');
    expect(decodeURIComponent(headers.get('x-lumina-image-base-url') ?? '')).toBe('https://custom.example/v1');
    expect(decodeURIComponent(headers.get('x-lumina-image-target-url') ?? '')).toBe('https://custom.example/v1/images/edits');
    expect(headers.get('x-lumina-image-method')).toBe('POST');
    expect(headers.has('content-type')).toBe(false);
    expect(request.body).toBeInstanceOf(FormData);
    expect((request.body as FormData).get('model')).toBe('vendor/image-model');
    expect((request.body as FormData).getAll('image')).toHaveLength(1);
  });

  it('routes every direct image protocol through the same-origin provider transport and materializes results', async () => {
    const cases = [
      { protocol: 'fal', providerId: 'fal', model: 'fal/nano-banana-2', baseUrl: 'https://queue.fal.run', target: 'https://queue.fal.run/fal-ai/nano-banana-2' },
      { protocol: 'kie', providerId: 'kie', model: 'kie/nano-banana-2', baseUrl: 'https://api.kie.ai', target: 'https://api.kie.ai/api/v1/jobs/createTask' },
      { protocol: 'grsai', providerId: 'grsai', model: 'grsai/nano-banana-2', baseUrl: 'https://grsai.dakka.com.cn', target: 'https://grsai.dakka.com.cn/v1/draw/nano-banana' },
      { protocol: 'runninghub', providerId: 'runninghub', model: 'runninghub/rhart-image-v1', baseUrl: 'https://www.runninghub.cn/openapi/v2', target: 'https://www.runninghub.cn/openapi/v2/rhart-image-v1/edit' },
      { protocol: 'ppio', providerId: 'ppio', model: 'ppio/gemini-3.1-flash', baseUrl: 'https://api.ppio.com', target: 'https://api.ppio.com/v3/gemini-3.1-flash-image-text-to-image' },
      { protocol: 'bltcy', providerId: 'bltcy', model: 'bltcy/nano-banana', baseUrl: 'https://api.bltcy.ai', target: 'https://api.bltcy.ai/v1/images/edits' },
      { protocol: 'gemini-native', providerId: 'gemini', model: 'gemini/gemini-3-pro-image-preview', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', target: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent' },
      { protocol: 'fhl-images', providerId: 'fhl', model: 'fhl/gpt-image-2', baseUrl: 'https://www.fhl.mom', target: 'https://www.fhl.mom/images/generations' },
    ] as const;

    for (const item of cases) {
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url === '/api/generation/image-provider') {
          const headers = new Headers(init?.headers);
          expect(headers.get('x-lumina-image-protocol')).toBe(item.protocol);
          expect(decodeURIComponent(headers.get('x-lumina-image-base-url') ?? '')).toBe(item.baseUrl);
          expect(decodeURIComponent(headers.get('x-lumina-image-target-url') ?? '')).toBe(item.target);
          expect(headers.get('x-lumina-image-method')).toBe('POST');
          expect(headers.get('authorization')).toBe('Bearer provider-key');
          return new Response(JSON.stringify({ data: [{ url: `https://results.example/${item.protocol}.png` }] }), { status: 200 });
        }
        if (url === '/api/generation/image-provider/result') {
          expect(JSON.parse(String(init?.body))).toEqual({
            protocol: item.protocol,
            base_url: item.baseUrl,
            source: `https://results.example/${item.protocol}.png`,
          });
          return new Response(JSON.stringify({ url: `/api/generation/image-provider/result/${item.protocol}` }), { status: 200 });
        }
        throw new Error(`Provider origin must not be fetched by the browser: ${url}`);
      });
      const gateway = createWebGenerationGateway({ fetchImpl });
      const jobId = await gateway.submitGenerateImageJob({
        providerId: item.providerId,
        model: item.model,
        prompt: 'a kite',
        size: '2K',
        aspectRatio: '1:1',
        providerConfig: {
          api_key: 'provider-key',
          base_url: item.baseUrl,
          protocol: item.protocol,
        },
      });

      await expect(gateway.getGenerateImageJob(jobId)).resolves.toMatchObject({
        status: 'succeeded',
        result: `/api/generation/image-provider/result/${item.protocol}`,
      });
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        '/api/generation/image-provider',
        '/api/generation/image-provider/result',
      ]);
    }
  });

  it('reads a KIE reference directly but proxies its upload and task submission', async () => {
    const referenceUrl = 'https://assets.example/reference.png';
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === referenceUrl) {
        return new Response(new Blob(['reference'], { type: 'image/png' }), { status: 200 });
      }
      if (url !== '/api/generation/image-provider') {
        throw new Error(`Unexpected request: ${url}`);
      }
      const headers = new Headers(init?.headers);
      const target = decodeURIComponent(headers.get('x-lumina-image-target-url') ?? '');
      if (target === 'https://kieai.redpandaai.co/api/file-stream-upload') {
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ data: { downloadUrl: 'https://cdn.kie.ai/reference.png' } }), { status: 200 });
      }
      if (target === 'https://api.kie.ai/api/v1/jobs/createTask') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          input: { image_input: ['https://cdn.kie.ai/reference.png'] },
        });
        return new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), { status: 200 });
      }
      throw new Error(`Unexpected provider target: ${target}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const jobId = await gateway.submitGenerateImageJob({
      providerId: 'kie',
      model: 'kie/nano-banana-2',
      prompt: 'use the reference',
      size: '2K',
      aspectRatio: '1:1',
      referenceImages: [referenceUrl],
      providerConfig: {
        api_key: 'kie-key',
        base_url: 'https://api.kie.ai',
        protocol: 'kie',
      },
    });

    await expect(gateway.getGenerateImageJob(jobId)).resolves.toMatchObject({
      status: 'succeeded',
      result: 'data:image/png;base64,AQID',
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      referenceUrl,
      '/api/generation/image-provider',
      '/api/generation/image-provider',
    ]);
  });

  it('publishes local FAL references until the original async task reaches a terminal state', async () => {
    const releases: string[] = [];
    const publicReferenceUrl = 'https://public-media.example/reference.png';
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/media' && init?.method === 'POST') {
        expect(new Headers(init.headers).get('x-lumina-media-provider')).toBe('fal-reference');
        return new Response(JSON.stringify({
          key: 'media-fal-reference',
          url: publicReferenceUrl,
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: (init.body as Blob).size,
        }), { status: 201 });
      }
      if (url === '/api/generation/image-provider') {
        const target = decodeURIComponent(new Headers(init?.headers).get('x-lumina-image-target-url') ?? '');
        if (target === 'https://queue.fal.run/fal-ai/nano-banana-2/edit') {
          expect(JSON.parse(String(init?.body))).toMatchObject({ image_urls: [publicReferenceUrl] });
          return new Response(JSON.stringify({ task_id: 'fal-reference-task' }), { status: 202 });
        }
        if (target === 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-reference-task/status') {
          return new Response(JSON.stringify({
            status: 'COMPLETED',
            images: [{ b64_json: 'AQID' }],
          }), { status: 200 });
        }
      }
      if (url === '/api/generation/media/media-fal-reference' && init?.method === 'DELETE') {
        releases.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const settled: Array<{
      status: 'fulfilled';
      jobId: string;
      taskHandle?: PersistedGenerationJobHandle;
    }> = [];
    await gateway.submitGenerateImageJobs({
      providerId: 'fal',
      model: 'fal/nano-banana-2',
      prompt: 'use the local reference',
      size: '2K',
      aspectRatio: '1:1',
      referenceImages: ['data:image/png;base64,AQID'],
      providerConfig: {
        api_key: 'fal-key',
        base_url: 'https://queue.fal.run',
        protocol: 'fal',
      },
      projectId: 'project-1',
    }, 1, (result) => {
      if (result.status === 'fulfilled') settled.push(result);
    }, vi.fn());

    const receipt = settled[0]!;
    expect(JSON.stringify(receipt.taskHandle)).not.toContain('media-fal-reference');
    expect(JSON.stringify(receipt.taskHandle)).not.toContain(publicReferenceUrl);
    expect(releases).toEqual([]);
    await expect(gateway.getGenerateImageJob(
      receipt.jobId,
      { api_key: 'fal-key' },
      receipt.taskHandle,
    )).resolves.toMatchObject({
      status: 'succeeded',
      result: 'data:image/png;base64,AQID',
    });
    expect(releases).toEqual(['/api/generation/media/media-fal-reference']);
  });

  it('recovers an initial FAL result through its stable task after materialization fails', async () => {
    const releases: string[] = [];
    const providerTargets: string[] = [];
    let materializeAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/media' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          key: 'media-fal-recovery',
          url: 'https://public-media.example/recovery-reference.png',
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: (init.body as Blob).size,
        }), { status: 201 });
      }
      if (url === '/api/generation/image-provider') {
        const target = decodeURIComponent(new Headers(init?.headers).get('x-lumina-image-target-url') ?? '');
        providerTargets.push(target);
        if (target.endsWith('/edit')) {
          return new Response(JSON.stringify({
            task_id: 'fal-recovery-task',
            images: [{ url: 'https://cdn.example.test/initial-result.png' }],
          }), { status: 200 });
        }
        if (target.endsWith('/requests/fal-recovery-task/status')) {
          return new Response(JSON.stringify({
            status: 'COMPLETED',
            images: [{ url: 'https://cdn.example.test/recovered-result.png' }],
          }), { status: 200 });
        }
      }
      if (url === '/api/generation/image-provider/result' && init?.method === 'POST') {
        materializeAttempts += 1;
        if (materializeAttempts === 1) {
          return new Response(JSON.stringify({ error: 'temporarily unavailable' }), { status: 503 });
        }
        return new Response(JSON.stringify({
          url: '/api/generation/image-provider/result/fal-recovery-task',
        }), { status: 200 });
      }
      if (url === '/api/generation/media/media-fal-recovery' && init?.method === 'DELETE') {
        releases.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const settled: Array<{
      status: 'fulfilled';
      jobId: string;
      taskHandle?: PersistedGenerationJobHandle;
    }> = [];

    await gateway.submitGenerateImageJobs({
      providerId: 'fal',
      model: 'fal/nano-banana-2',
      prompt: 'recover the original task',
      size: '2K',
      aspectRatio: '1:1',
      referenceImages: ['data:image/png;base64,AQID'],
      providerConfig: {
        api_key: 'fal-key',
        base_url: 'https://queue.fal.run',
        protocol: 'fal',
      },
      projectId: 'project-1',
    }, 1, (result) => {
      if (result.status === 'fulfilled') settled.push(result);
    }, vi.fn());

    const receipt = settled[0]!;
    expect(receipt.taskHandle).toEqual(expect.objectContaining({
      externalTaskId: 'fal-recovery-task',
      protocol: 'fal',
    }));
    expect(releases).toEqual([]);
    await expect(gateway.getGenerateImageJob(
      receipt.jobId,
      { api_key: 'fal-key' },
      receipt.taskHandle,
    )).resolves.toMatchObject({
      status: 'succeeded',
      result: '/api/generation/image-provider/result/fal-recovery-task',
    });
    expect(providerTargets).toEqual([
      'https://queue.fal.run/fal-ai/nano-banana-2/edit',
      'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-recovery-task/status',
    ]);
    expect(materializeAttempts).toBe(2);
    expect(releases).toEqual(['/api/generation/media/media-fal-recovery']);
  });

  it('keeps a restored direct task nonterminal while its API key is unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe('/api/generation/image-provider');
      return new Response(JSON.stringify({
        status: 'COMPLETED',
        images: [{ b64_json: 'AQID' }],
      }), { status: 200 });
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const handle: PersistedGenerationJobHandle = {
      version: 1,
      kind: 'browser-direct',
      externalTaskId: 'fal-missing-key-task',
      protocol: 'fal',
      baseUrl: 'https://queue.fal.run',
      model: 'fal/nano-banana-2',
      statusUrl: 'https://queue.fal.run/tasks/fal-missing-key-task',
    };

    await expect(gateway.getGenerateImageJob('web-image-missing-key', {}, handle)).resolves.toMatchObject({
      status: 'running',
      recovery: {
        requires_manual_requery: true,
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(gateway.retryGenerateImageJob(
      'web-image-missing-key',
      { api_key: 'restored-key' },
      handle,
    )).resolves.toMatchObject({
      status: 'succeeded',
      result: 'data:image/png;base64,AQID',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes a permanently invalid direct URL result terminal without polling it again', async () => {
    let providerPolls = 0;
    let materializeAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/image-provider') {
        const target = decodeURIComponent(new Headers(init?.headers).get('x-lumina-image-target-url') ?? '');
        if (target.endsWith('/fal-ai/nano-banana-2')) {
          return new Response(JSON.stringify({ task_id: 'fal-invalid-result-task' }), { status: 202 });
        }
        providerPolls += 1;
        return new Response(JSON.stringify({
          status: 'COMPLETED',
          images: [{ url: 'https://cdn.example.test/oversized.png' }],
        }), { status: 200 });
      }
      if (url === '/api/generation/image-provider/result') {
        materializeAttempts += 1;
        return new Response(JSON.stringify({ error: 'invalid_provider_result' }), { status: 422 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const providerConfig = {
      api_key: 'fal-key',
      base_url: 'https://queue.fal.run',
      protocol: 'fal',
    };
    const receipt = await gateway.submitGenerateImageJob({
      providerId: 'fal',
      model: 'fal/nano-banana-2',
      prompt: 'invalid result fixture',
      size: '1K',
      aspectRatio: '1:1',
      providerConfig,
    });

    await expect(gateway.getGenerateImageJob(receipt, providerConfig)).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(gateway.getGenerateImageJob(receipt, providerConfig)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(providerPolls).toBe(1);
    expect(materializeAttempts).toBe(1);
  });

  it('coalesces concurrent direct polling through result materialization', async () => {
    let pollCount = 0;
    let materializeCount = 0;
    let resolveMaterialize: ((response: Response) => void) | undefined;
    let signalMaterializeStarted: (() => void) | undefined;
    const observedMaterialize = new Promise<void>((resolve) => {
      signalMaterializeStarted = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/image-provider') {
        const target = decodeURIComponent(new Headers(init?.headers).get('x-lumina-image-target-url') ?? '');
        if (target.endsWith('/requests/fal-concurrent-task/status')) {
          pollCount += 1;
          if (pollCount > 1) {
            return new Response(JSON.stringify({ error: 'late failure' }), { status: 400 });
          }
          return new Response(JSON.stringify({
            status: 'COMPLETED',
            images: [{ url: 'https://cdn.example.test/concurrent-result.png' }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ task_id: 'fal-concurrent-task' }), { status: 202 });
      }
      if (url === '/api/generation/image-provider/result' && init?.method === 'POST') {
        materializeCount += 1;
        signalMaterializeStarted?.();
        return await new Promise<Response>((resolve) => {
          resolveMaterialize = resolve;
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    const receipt = await gateway.submitGenerateImageJob({
      providerId: 'fal',
      model: 'fal/nano-banana-2',
      prompt: 'coalesce this task',
      size: '1K',
      aspectRatio: '1:1',
      providerConfig: {
        api_key: 'fal-key',
        base_url: 'https://queue.fal.run',
        protocol: 'fal',
      },
    });

    const first = gateway.getGenerateImageJob(receipt, { api_key: 'fal-key' });
    await observedMaterialize;
    const second = gateway.getGenerateImageJob(receipt, { api_key: 'fal-key' });
    resolveMaterialize?.(new Response(JSON.stringify({
      url: '/api/generation/image-provider/result/fal-concurrent-task',
    }), { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        status: 'succeeded',
        result: '/api/generation/image-provider/result/fal-concurrent-task',
      }),
      expect.objectContaining({
        status: 'succeeded',
        result: '/api/generation/image-provider/result/fal-concurrent-task',
      }),
    ]);
    expect(pollCount).toBe(1);
    expect(materializeCount).toBe(1);
    await expect(gateway.getGenerateImageJob(receipt, { api_key: 'fal-key' })).resolves.toMatchObject({
      status: 'succeeded',
      result: '/api/generation/image-provider/result/fal-concurrent-task',
    });
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

  it('parses managed recovery metadata and uses explicit requery without resubmitting', async () => {
    const operations: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url !== '/api/generation/jobs/job-recovery') {
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      }
      const operation = String((JSON.parse(String(init?.body)) as { operation?: unknown }).operation);
      operations.push(operation);
      return Promise.resolve(new Response(JSON.stringify({
        job_id: 'job-recovery',
        status: 'running',
        recovery: {
          retry_count: operation === 'requery' ? 1 : 5,
          ...(operation === 'requery' ? { next_retry_at: 12_345 } : {}),
          requires_manual_requery: operation !== 'requery',
          last_error: 'The image provider is temporarily unavailable.',
        },
      }), { status: 200 }));
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('ai-media', 'temporary-key');
    const providerConfig = { base_url: 'https://api.ai-media.vip/v1' };

    await expect(gateway.getGenerateImageJob('job-recovery', providerConfig)).resolves.toMatchObject({
      status: 'running',
      recovery: {
        retry_count: 5,
        requires_manual_requery: true,
      },
    });
    await expect(gateway.retryGenerateImageJob('job-recovery', providerConfig)).resolves.toMatchObject({
      status: 'running',
      recovery: {
        retry_count: 1,
        next_retry_at: 12_345,
        requires_manual_requery: false,
      },
    });
    expect(operations).toEqual(['poll', 'requery']);
  });

  it('uploads ordered references once and reuses opaque media keys across output jobs', async () => {
    const uploads: string[] = [];
    const submissions: Array<Record<string, unknown>> = [];
    const releases: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/media' && init?.method === 'POST') {
        const key = `media-ref-${uploads.length + 1}`;
        uploads.push(key);
        return new Response(JSON.stringify({
          key,
          url: `https://lumina.test/api/generation/media/${key}?grant=opaque&provider=ai-media`,
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: (init.body as Blob).size,
        }), { status: 201 });
      }
      if (url === '/api/generation/jobs' && init?.method === 'POST') {
        submissions.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          job_id: `job-ref-${submissions.length}`,
          status: 'queued',
        }), { status: 202 });
      }
      if (url.startsWith('/api/generation/media/') && init?.method === 'DELETE') {
        releases.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('ai-media', 'temporary-key');
    const references = Array.from({ length: 5 }, (_, index) => (
      `data:image/png;base64,${index % 2 === 0 ? 'AQID' : 'BAUG'}`
    ));
    await gateway.submitGenerateImageJobs({
      providerId: 'ai-media', model: 'ai-media/gpt-image-2', prompt: 'use refs', size: '1K', aspectRatio: '1:1',
      providerConfig: { base_url: 'https://api.ai-media.vip/v1' },
      referenceImages: references,
      projectId: 'project-1', projectRevision: 'r1',
    }, 2, vi.fn(), vi.fn());

    expect(uploads).toEqual([
      'media-ref-1', 'media-ref-2', 'media-ref-3', 'media-ref-4', 'media-ref-5',
    ]);
    expect(submissions).toHaveLength(2);
    for (const submission of submissions) {
      const request = submission.request as Record<string, unknown>;
      expect(request.referenceMediaKeys).toEqual(uploads);
      expect(request).not.toHaveProperty('referenceImages');
      expect(JSON.stringify(submission)).not.toContain('data:image');
    }
    expect(releases).toHaveLength(5);
  });

  it('releases uploaded references when result-node preparation fails', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/generation/media' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          key: 'media-00000000-0000-4000-8000-000000000001',
          url: 'https://lumina.test/api/generation/media/media-00000000-0000-4000-8000-000000000001',
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: (init.body as Blob).size,
        }), { status: 201 });
      }
      if (url.includes('/api/generation/media/media-') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const gateway = createWebGenerationGateway({ fetchImpl });
    await gateway.setApiKey('ai-media', 'temporary-key');

    await expect(gateway.submitGenerateImageJobs({
      providerId: 'ai-media', model: 'ai-media/gpt-image-2', prompt: 'use ref', size: '1K', aspectRatio: '1:1',
      providerConfig: { base_url: 'https://api.ai-media.vip/v1' },
      referenceImages: ['data:image/png;base64,AQID'],
      projectId: 'project-1', projectRevision: 'r1',
    }, 1, vi.fn(), () => {
      throw new Error('result nodes unavailable');
    })).rejects.toThrow('result nodes unavailable');

    expect(requests).toEqual([
      'POST /api/generation/media',
      'DELETE /api/generation/media/media-00000000-0000-4000-8000-000000000001',
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
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          url: '/api/generation/image-provider/result/fhl-task',
        }), { status: 200 }));
      const gateway = createWebGenerationGateway({ fetchImpl });
      const resultPromise = gateway.generateImage({
        providerId: 'fhl', model: 'fhl/gpt-image-2', prompt: 'a kite', size: '1K', aspectRatio: '1:1',
        providerConfig: { api_key: 'key', base_url: 'https://fhl', protocol: 'fhl-images' },
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(resultPromise).resolves.toBe('/api/generation/image-provider/result/fhl-task');
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        '/api/generation/image-provider',
        '/api/generation/image-provider',
        '/api/generation/image-provider',
        '/api/generation/image-provider/result',
      ]);
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
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        url: '/api/generation/image-provider/result/fal-task-42',
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
      result: '/api/generation/image-provider/result/fal-task-42',
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/generation/image-provider',
      '/api/generation/image-provider',
      '/api/generation/image-provider/result',
    ]);
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
      expect(fetchImpl.mock.calls.slice(1).every(([url]) => url === '/api/generation/image-provider'))
        .toBe(true);
      expect(fetchImpl.mock.calls.slice(1).every(([, init]) => {
        const headers = new Headers(init?.headers);
        return decodeURIComponent(headers.get('x-lumina-image-target-url') ?? '')
          === 'https://queue.fal.run/tasks/fal-task-42';
      })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
