import { describe, expect, it } from 'vitest';

import {
  WEB_DATABASE_STORES,
  WebDatabaseError,
  createIndexedDbWebDatabase,
} from './webDatabase';

describe('Web IndexedDB boundary', () => {
  it('declares only the browser settings store', () => {
    expect(WEB_DATABASE_STORES).toEqual(['settings']);
  });

  it('fails explicitly when IndexedDB is unavailable instead of falling back to another settings store', async () => {
    const database = createIndexedDbWebDatabase(undefined);

    await expect(database.run(['settings'], 'readonly', async () => undefined)).rejects.toMatchObject({
      code: 'unavailable',
    } satisfies Partial<WebDatabaseError>);
  });
});
