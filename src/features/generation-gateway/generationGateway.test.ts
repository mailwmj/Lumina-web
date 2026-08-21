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
          size: '1K',
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
    expect(taskSnapshots[taskSnapshots.length - 1]).not.toHaveProperty('apiKey');
    expect(taskSnapshots[taskSnapshots.length - 1]).not.toHaveProperty('authorization');

    const result = await handler(new Request(`https://lumina.test/api/generation/jobs/${jobId}/result`, {
      headers: { authorization: 'Bearer browser-key', origin: 'https://lumina.test' },
    }));
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('image/png');
    expect(await result.text()).toBe('fake-image');
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

  it('limits active generation tasks per same-origin source', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => (
      Promise.resolve(new Response(JSON.stringify({ id: 'upstream-running' }), { status: 200 }))
    ));
    const handler = createGenerationGatewayHandler({
      providers: { 'ai-media': { baseUrl: BASE_URL, modelIds: ['ai-media/gpt-image-2'] } },
      fetchImpl,
    });
    const submit = () => handler(new Request('https://lumina.test/api/generation/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer key', origin: 'https://lumina.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'submit', provider: 'ai-media', projectId: 'p', projectRevision: 'r1',
        request: { model: 'ai-media/gpt-image-2', prompt: 'test', size: '1K' },
      }),
    }));
    expect((await submit()).status).toBe(202);
    expect((await submit()).status).toBe(202);
    expect((await submit()).status).toBe(429);
  });

  it('requires a fresh browser key for each operation instead of retaining it in the task', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ id: 'upstream-1' }), { status: 200 });
      }
      if (url.endsWith('/images/generations/upstream-1')) {
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
