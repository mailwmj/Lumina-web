import { describe, expect, it } from 'vitest';

import { submitGenerationJobBatch } from './generationJobBatch';

describe('generation job batch submission', () => {
  it('reports each task receipt before the full batch submission has completed', async () => {
    let resolveFirst: ((jobId: string) => void) | undefined;
    const firstSubmission = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecondSettled: (() => void) | undefined;
    const secondSettled = new Promise<void>((resolve) => {
      resolveSecondSettled = resolve;
    });
    const settledIndexes: number[] = [];

    const batch = submitGenerationJobBatch({
      outputCount: 2,
      submit: (outputIndex) =>
        outputIndex === 0 ? firstSubmission : Promise.resolve('job-2'),
      onSettled: (_result, outputIndex) => {
        settledIndexes.push(outputIndex);
        if (outputIndex === 1) {
          resolveSecondSettled?.();
        }
      },
    });
    let batchSettled = false;
    void batch.then(() => {
      batchSettled = true;
    });

    await secondSettled;
    expect(settledIndexes).toEqual([1]);
    expect(batchSettled).toBe(false);

    resolveFirst?.('job-1');
    await expect(batch).resolves.toEqual([
      { status: 'fulfilled', jobId: 'job-1' },
      { status: 'fulfilled', jobId: 'job-2' },
    ]);
    expect(settledIndexes).toEqual([1, 0]);
  });

  it('reports rejected submissions independently', async () => {
    const settled: Array<{ status: string; outputIndex: number }> = [];

    const results = await submitGenerationJobBatch({
      outputCount: 2,
      submit: async (outputIndex) => {
        if (outputIndex === 0) {
          throw new Error('submit failed');
        }
        return 'job-2';
      },
      onSettled: (result, outputIndex) => {
        settled.push({ status: result.status, outputIndex });
      },
    });

    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results[1]).toEqual({ status: 'fulfilled', jobId: 'job-2' });
    expect(settled).toEqual([
      { status: 'rejected', outputIndex: 0 },
      { status: 'fulfilled', outputIndex: 1 },
    ]);
  });

  it('does not turn a submitted job into a batch failure when the listener throws', async () => {
    await expect(
      submitGenerationJobBatch({
        outputCount: 1,
        submit: async () => 'job-1',
        onSettled: () => {
          throw new Error('listener failed');
        },
      })
    ).resolves.toEqual([{ status: 'fulfilled', jobId: 'job-1' }]);
  });
});
