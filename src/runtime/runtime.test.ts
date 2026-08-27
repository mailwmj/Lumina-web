import { describe, expect, it } from 'vitest';

import { version as packageVersion } from '../../package.json';

import { runtime } from './runtime';

describe('Web runtime', () => {
  it('reports the Web build version', async () => {
    await expect(runtime.getAppVersion()).resolves.toBe(packageVersion);
  });
});
