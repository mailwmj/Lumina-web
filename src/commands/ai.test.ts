import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getGenerateImageJob,
  normalizeGeneratedTextResponse,
  retryGenerateImageJob,
} from './ai';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: () => true,
}));

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockResolvedValue({
    job_id: 'job-1',
    status: 'running',
  });
});

describe('text generation command response', () => {
  it('uses trimming only to detect emptiness and preserves the complete response', () => {
    expect(normalizeGeneratedTextResponse('  indented result\n')).toBe('  indented result\n');
    expect(() => normalizeGeneratedTextResponse('   \n')).toThrow('API 返回内容为空');
  });
});

describe('generation job polling commands', () => {
  const providerConfig = {
    base_url: 'https://gemini.example/v1beta',
    api_key: 'job-key',
  };

  it('forwards the task provider configuration when polling a persisted job', async () => {
    await getGenerateImageJob('job-1', providerConfig);

    expect(tauri.invoke).toHaveBeenCalledWith('get_generate_image_job', {
      jobId: 'job-1',
      providerConfig,
    });
  });

  it('forwards the task provider configuration for an explicit re-query', async () => {
    await retryGenerateImageJob('job-1', providerConfig);

    expect(tauri.invoke).toHaveBeenCalledWith('retry_generate_image_job', {
      jobId: 'job-1',
      providerConfig,
    });
  });
});
