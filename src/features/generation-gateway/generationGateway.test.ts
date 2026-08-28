import { describe, expect, it, vi } from 'vitest';

import {
  createGenerationGatewayHandler,
  type GenerationGatewayTaskSnapshot,
} from './generationGateway';

const BASE_URL = 'https://fake-upstream.test/v1';

function createUpstreamFetch(resultUrl = 'https://fake-upstream.test/results/result.png') {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${BASE_URL}/images/generations`) {
      return new Response(JSON.stringify({
        data: [{ url: resultUrl }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://fake-upstream.test/results/result.png') {
      return new Response(new Blob(['fake-image'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  return { calls, fetchImpl };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('GenerationGateway server boundary', () => {
  it('completes an allowlisted OpenAI-compatible submit and poll without CORS', async () => {
    const { calls, fetchImpl } = createUpstreamFetch();
    const taskSnapshots: GenerationGatewayTaskSnapshot[] = [];
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
      inspectTask: (task) => taskSnapshots.push(task),
    });

    const submit = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer browser-key',
        origin: 'https://lumina.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation: 'submit',
        provider: 'ai-media',
        projectId: 'project-1',
        projectRevision: 'r7',
        request: {
          model: 'ai-media/gpt-image-2',
          prompt: 'A red paper kite',
          size: '2K',
          aspectRatio: '1:1',
        },
      }),
    }));

    expect(submit.status).toBe(202);
    expect(submit.headers.get('access-control-allow-origin')).toBeNull();
    const submitted = await json(submit);
    const jobId = String(submitted.job_id);
    expect(jobId).toMatch(/^job-/);

    const poll = await handler(new Request(`https://lumina.test/api/generation/jobs/${jobId}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer browser-key',
        origin: 'https://lumina.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation: 'poll' }),
    }));

    expect(poll.status).toBe(200);
    const status = await json(poll);
    expect(status.status).toBe('succeeded');
    expect(status.result).toBe(`/api/generation/jobs/${jobId}/result`);
    expect(calls[0]?.init?.headers).toEqual(expect.objectContaining({
      authorization: 'Bearer browser-key',
    }));
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'A red paper kite',
      n: 1,
      size: '2048x2048',
      quality: 'medium',
      async: true,
      response_format: 'b64_json',
    });
    expect(taskSnapshots[taskSnapshots.length - 1]).not.toHaveProperty('apiKey');
    expect(taskSnapshots[taskSnapshots.length - 1]).not.toHaveProperty('authorization');

    const result = await handler(new Request(`https://lumina.test/api/generation/jobs/${jobId}/result`, {
      headers: { authorization: 'Bearer browser-key', origin: 'https://lumina.test' },
    }));
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('image/png');
    expect(await result.text()).toBe('fake-image');
  });

  it('resolves an opaque image media key into an edit larger than the previous eight MiB limit', async () => {
    const referenceSize = 8 * 1024 * 1024 + 1;
    const referenceKey = 'media-00000000-0000-4000-8000-000000000001';
    const reference = new Blob([new Uint8Array(referenceSize)], { type: 'image/png' });
    const resolveReferenceImages = vi.fn(async (keys: readonly string[]) => {
      expect(keys).toEqual([referenceKey]);
      return [reference];
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${BASE_URL}/images/edits`);
      const form = init?.body as FormData;
      expect(init?.headers).toEqual(expect.objectContaining({
        'Idempotency-Key': expect.stringMatching(/^opencanvas-image-/),
      }));
      expect(form.get('model')).toBe('gpt-image-2');
      expect(form.get('size')).toBe('3072x4096');
      expect(form.get('quality')).toBe('high');
      const image = form.get('image');
      expect(image).toBeInstanceOf(Blob);
      expect((image as Blob).size).toBe(referenceSize);
      return new Response(JSON.stringify({ data: [{ image: { b64_json: 'ZmFrZS1pbWFnZQ==' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
      resolveReferenceImages,
    });

    const submit = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer browser-key',
        origin: 'https://lumina.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation: 'submit',
        provider: 'ai-media',
        projectId: 'project-1',
        projectRevision: 'r8',
        request: {
          model: 'ai-media/gpt-image-2',
          prompt: 'Generate a three-view model sheet',
          size: '4K',
          aspectRatio: '3:4',
          referenceMediaKeys: [referenceKey],
        },
      }),
    }));

    expect(submit.status).toBe(202);
    expect(await json(submit)).toMatchObject({ status: 'succeeded' });
    expect(resolveReferenceImages).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('tracks nested async task handles and materializes nested results', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { task_id: 'provider-0123456789abcdef' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: { base64: 'ZmFrZS1hc3luYy1pbWFnZQ==' },
      }), { status: 200 }));
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
      createTaskId: () => 'job-nested-async',
    });

    const submit = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    expect(await json(submit)).toMatchObject({ job_id: 'job-nested-async', status: 'running' });

    const poll = await handler(new Request('https://lumina.test/api/generation/jobs/job-nested-async', {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'poll' }),
    }));
    expect(await json(poll)).toMatchObject({
      status: 'succeeded',
      result: '/api/generation/jobs/job-nested-async/result',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${BASE_URL}/images/tasks/provider-0123456789abcdef?view=summary`,
      expect.objectContaining({ method: 'GET' }),
    );

    const result = await handler(new Request(
      'https://lumina.test/api/generation/jobs/job-nested-async/result',
    ));
    expect(await result.text()).toBe('fake-async-image');
  });

  it('rejects unknown providers, operations, origins, and client upstream URLs', async () => {
    const { fetchImpl } = createUpstreamFetch('https://other-origin.test/result.png');
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
      expectedOrigin: 'https://lumina.test',
    });

    const request = (body: unknown, headers: Record<string, string> = {
      authorization: 'Bearer key',
      origin: 'https://lumina.test',
      'content-type': 'application/json',
    }) => handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST', headers, body: JSON.stringify(body),
    }));

    expect((await request({ operation: 'submit', provider: 'unknown', request: {} })).status).toBe(400);
    expect((await request({ operation: 'proxy', provider: 'ai-media', request: {} })).status).toBe(400);
    expect((await request({
      operation: 'submit', provider: 'ai-media', baseUrl: 'http://127.0.0.1:9', request: {},
    })).status).toBe(400);
    expect((await request({ operation: 'submit', provider: 'ai-media', request: {} }, {
      authorization: 'Bearer key', origin: 'https://evil.test', 'content-type': 'application/json',
    })).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not fetch a result URL outside the configured provider origin', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [{ url: 'https://other-origin.test/result.png' }] }), { status: 200 });
    });
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
    });
    const response = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    expect(response.status).toBe(202);
    expect((await json(response)).status).toBe('failed');
    expect(calls).toEqual([`${BASE_URL}/images/generations`]);
  });

  it('returns a sanitized upstream error and request ID without retaining provider credentials', async () => {
    const taskSnapshots: GenerationGatewayTaskSnapshot[] = [];
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        request_id: 'req-gateway-42',
        error: {
          message: 'Rejected Bearer provider-secret',
          api_key: 'provider-secret',
        },
      }), { status: 429 })),
      inspectTask: (task) => taskSnapshots.push(task),
    });

    const response = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer browser-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    const body = await json(response);

    expect(body).toMatchObject({
      status: 'failed',
      error: 'Rejected Bearer [REDACTED]',
      request_id: 'req-gateway-42',
    });
    expect(body.error_details).toBe('Provider request failed with HTTP 429.');
    expect(JSON.stringify(body)).not.toContain('provider-secret');
    expect(JSON.stringify(taskSnapshots[taskSnapshots.length - 1])).not.toContain('provider-secret');
    expect(JSON.stringify(taskSnapshots[taskSnapshots.length - 1])).not.toContain('Rejected Bearer');
  });

  it('expires unconfirmed results after 24 hours and confirmed results after the one-hour safety window', async () => {
    let currentTime = 1_000_000;
    const { fetchImpl } = createUpstreamFetch();
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
      now: () => currentTime,
    });
    const submit = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    const jobId = String((await json(submit)).job_id);
    currentTime += 24 * 60 * 60 * 1000 + 1;
    const expired = await handler(new Request(`https://lumina.test/api/generation/jobs/${jobId}/result`));
    expect(expired.status).toBe(404);

    currentTime = 2_000_000;
    const second = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    const secondId = String((await json(second)).job_id);
    const resultPath = `https://lumina.test/api/generation/jobs/${secondId}/result`;
    expect((await handler(new Request(resultPath))).status).toBe(200);
    currentTime += 60 * 60 * 1000 + 1;
    expect((await handler(new Request(resultPath))).status).toBe(404);
  });

  it('queues submissions beyond the execution limit and rejects only when the queue is full', async () => {
    const resolveUpstream: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveUpstream.push(resolve);
    }));
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
      maxPendingTasksPerSource: 3,
      maxConcurrentTasks: 1,
    });
    const submit = () => handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer key', origin: 'https://lumina.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    const firstSubmission = submit();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const second = await submit();
    expect(second.status).toBe(202);
    expect(await json(second)).toMatchObject({ status: 'queued' });
    const third = await submit();
    expect(third.status).toBe(202);
    expect(await json(third)).toMatchObject({ status: 'queued' });
    const fourth = await submit();
    expect(fourth.status).toBe(429);
    expect(await json(fourth)).toMatchObject({ error: 'queue_capacity_exceeded' });

    resolveUpstream[0](new Response(JSON.stringify({
      data: [{ b64_json: 'Zmlyc3Q=' }],
    }), { status: 200 }));
    expect(await json(await firstSubmission)).toMatchObject({ status: 'succeeded' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    resolveUpstream[1](new Response(JSON.stringify({
      data: [{ b64_json: 'c2Vjb25k' }],
    }), { status: 200 }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    resolveUpstream[2](new Response(JSON.stringify({
      data: [{ b64_json: 'dGhpcmQ=' }],
    }), { status: 200 }));
  });

  it('requires a fresh browser key for each operation instead of retaining it in the task', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ id: 'upstream-1' }), { status: 200 });
      }
      if (url.endsWith('/images/tasks/upstream-1?view=summary')) {
        return new Response(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
    });
    const submit = await handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer first-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    const jobId = String((await json(submit)).job_id);
    await handler(new Request(`https://lumina.test/api/generation/jobs/${jobId}`, {
      method: 'POST',
      headers: { authorization: 'Bearer second-key', 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'poll' }),
    }));
    expect(calls.map((call) => (call.init?.headers as Record<string, string>).authorization)).toEqual([
      'Bearer first-key',
      'Bearer second-key',
    ]);
  });
});
