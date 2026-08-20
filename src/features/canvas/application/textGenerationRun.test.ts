import { describe, expect, it } from 'vitest';

import {
  TextGenerationRunController,
  canStartTextGeneration,
} from './textGenerationRun';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('text generation run lifecycle', () => {
  it('allows only one active run and commits a non-empty result', async () => {
    const controller = new TextGenerationRunController<{ prompt: string }>();
    const pending = deferred<string>();
    const first = controller.run(
      { prompt: 'captured prompt' },
      async (snapshot) => {
        expect(snapshot).toEqual({ prompt: 'captured prompt' });
        return await pending.promise;
      }
    );

    await expect(controller.run({ prompt: 'new prompt' }, async () => 'ignored'))
      .resolves.toEqual({ status: 'busy' });

    pending.resolve(' generated result\n');
    await expect(first).resolves.toEqual({
      status: 'committed',
      text: ' generated result\n',
    });
    expect(controller.isRunning()).toBe(false);
  });

  it('invalidates a late provider result after stop', async () => {
    const controller = new TextGenerationRunController<{ prompt: string }>();
    const pending = deferred<string>();
    const capturedSignals: AbortSignal[] = [];
    const run = controller.run({ prompt: 'snapshot' }, async (_snapshot, signal) => {
      capturedSignals.push(signal);
      return await pending.promise;
    });

    expect(controller.stop()).toBe(true);
    expect(capturedSignals[0]?.aborted).toBe(true);
    pending.resolve('late result');

    await expect(run).resolves.toEqual({ status: 'stopped' });
    expect(controller.isRunning()).toBe(false);
  });

  it('keeps a new run active when a stopped older request finishes late', async () => {
    const controller = new TextGenerationRunController<{ prompt: string }>();
    const oldPending = deferred<string>();
    const newPending = deferred<string>();
    const oldRun = controller.run({ prompt: 'old' }, async () => await oldPending.promise);

    controller.stop();
    const newRun = controller.run({ prompt: 'new' }, async () => await newPending.promise);
    oldPending.resolve('late old result');

    await expect(oldRun).resolves.toEqual({ status: 'stopped' });
    expect(controller.isRunning()).toBe(true);

    newPending.resolve('new result');
    await expect(newRun).resolves.toEqual({ status: 'committed', text: 'new result' });
    expect(controller.isRunning()).toBe(false);
  });

  it('preserves the existing result for empty responses and failures', async () => {
    const controller = new TextGenerationRunController<null>();

    await expect(controller.run(null, async () => '   ')).resolves.toEqual({ status: 'empty' });
    await expect(controller.run(null, async () => {
      throw new Error('provider failed');
    })).resolves.toEqual({ status: 'failed', error: expect.any(Error) });
  });

  it('requires a resolved model plus valid text or image input', () => {
    expect(canStartTextGeneration({
      effectivePrompt: '',
      referenceImageCount: 0,
      blockingImageCount: 0,
      hasResolvedModel: true,
    })).toBe(false);
    expect(canStartTextGeneration({
      effectivePrompt: '',
      referenceImageCount: 1,
      blockingImageCount: 0,
      hasResolvedModel: true,
    })).toBe(true);
    expect(canStartTextGeneration({
      effectivePrompt: 'prompt',
      referenceImageCount: 0,
      blockingImageCount: 0,
      hasResolvedModel: false,
    })).toBe(false);
    expect(canStartTextGeneration({
      effectivePrompt: 'prompt',
      referenceImageCount: 1,
      blockingImageCount: 1,
      hasResolvedModel: true,
    })).toBe(false);
  });
});
