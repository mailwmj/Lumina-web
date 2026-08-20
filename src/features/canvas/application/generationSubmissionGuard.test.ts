import { describe, expect, it, vi } from 'vitest';

import {
  assertGenerationSubmissionAllowed,
  estimateGenerationOutputBytes,
} from './generationSubmissionGuard';

describe('generation submission guard', () => {
  it('checks the network and reserves estimated output before provider submission', async () => {
    const assertNetworkAvailable = vi.fn();
    const assertCanWrite = vi.fn().mockResolvedValue(undefined);

    await assertGenerationSubmissionAllowed({
      estimatedOutputBytes: 4_000_000,
      assertNetworkAvailable,
      storageCapacityGate: { assertCanWrite },
    });

    expect(assertNetworkAvailable).toHaveBeenCalledOnce();
    expect(assertCanWrite).toHaveBeenCalledWith(4_000_000);
  });

  it('uses the requested output count and resolution for the reservation estimate', () => {
    expect(estimateGenerationOutputBytes('1K', 2)).toBe(1024 * 1024 * 4 * 2);
    expect(estimateGenerationOutputBytes('720p')).toBe(1280 * 720 * 4);
  });
});
