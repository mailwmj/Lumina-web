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
});
