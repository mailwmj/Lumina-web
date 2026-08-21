import { describe, expect, it } from 'vitest';

import { runtime } from './runtime';

describe('Web runtime', () => {
  it('reports the Web build version', async () => {
    await expect(runtime.getAppVersion()).resolves.toMatch(/\S/u);
  });
});
