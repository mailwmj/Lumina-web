import { describe, expect, it } from 'vitest';

import {
  WEB_DATABASE_STORES,
  WebDatabaseError,
  createIndexedDbWebDatabase,
} from './webDatabase';

describe('Web IndexedDB boundary', () => {
  it('declares the fixed first-version schema stores', () => {
    expect(WEB_DATABASE_STORES).toEqual(['projects', 'history', 'settings', 'meta']);
  });

  it('fails explicitly when IndexedDB is unavailable instead of falling back to browser storage', async () => {
    const database = createIndexedDbWebDatabase(undefined);

    await expect(database.run(['projects'], 'readonly', async () => undefined)).rejects.toMatchObject({
      code: 'unavailable',
    } satisfies Partial<WebDatabaseError>);
  });
});
