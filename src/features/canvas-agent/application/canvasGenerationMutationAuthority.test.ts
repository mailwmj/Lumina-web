import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CanvasGenerationAuthorityUnavailableError,
  clearCanvasGenerationMutationAuthoritiesForTests,
  invalidateCanvasGenerationMutationAuthorities,
  registerCanvasGenerationMutationAuthority,
  releaseCanvasGenerationMutationAuthority,
  runCanvasGenerationMutation,
} from './canvasGenerationMutationAuthority';

afterEach(() => {
  clearCanvasGenerationMutationAuthoritiesForTests();
});

describe('canvasGenerationMutationAuthority', () => {
  it('runs registered generation mutations through their action authority', async () => {
    let runCount = 0;
    const run = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      runCount += 1;
      return await operation();
    };
    const operation = vi.fn(() => 'saved');
    registerCanvasGenerationMutationAuthority({
      sessionId: 'session-1',
      nodeIds: ['result-1'],
      run,
    });

    await expect(runCanvasGenerationMutation('result-1', operation)).resolves.toBe('saved');
    expect(runCount).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('fails closed after the owning bridge session is invalidated', async () => {
    const operation = vi.fn();
    registerCanvasGenerationMutationAuthority({
      sessionId: 'session-1',
      nodeIds: ['result-1'],
      run: async (candidate) => candidate(),
    });
    invalidateCanvasGenerationMutationAuthorities('session-1');

    await expect(runCanvasGenerationMutation('result-1', operation)).rejects.toBeInstanceOf(
      CanvasGenerationAuthorityUnavailableError,
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('returns to the normal Chrome mutation path only after the node authority is released', async () => {
    const operation = vi.fn(() => 'saved');
    registerCanvasGenerationMutationAuthority({
      sessionId: 'session-1',
      nodeIds: ['result-1'],
      run: async (candidate) => candidate(),
    });
    invalidateCanvasGenerationMutationAuthorities('session-1');
    releaseCanvasGenerationMutationAuthority('result-1');

    await expect(runCanvasGenerationMutation('result-1', operation)).resolves.toBe('saved');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
