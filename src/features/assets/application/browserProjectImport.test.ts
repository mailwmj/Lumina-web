import { describe, expect, it, vi } from 'vitest';

import { StorageCapacityError, type StorageCapacityGate } from '@/runtime/browserStorage';
import type { WebDatabase } from '@/runtime/webDatabase';
import { createBrowserProjectImportService } from './browserProjectImport';

describe('browser project import', () => {
  it('checks browser storage capacity before parsing or staging an archive', async () => {
    const assertCanWrite = vi.fn().mockRejectedValue(new StorageCapacityError(
      'insufficient-capacity',
      'Browser storage does not have enough space for this import.',
    ));
    const database = { run: vi.fn() } as unknown as WebDatabase;
    const archive = new File(['archive'], 'restore.lumina', { type: 'application/zip' });
    const service = createBrowserProjectImportService(database, {
      storageCapacityGate: { assertCanWrite } satisfies StorageCapacityGate,
    });

    await expect(service.import(archive)).rejects.toMatchObject({ code: 'insufficient-capacity' });

    expect(assertCanWrite).toHaveBeenCalledWith(archive.size);
    expect(database.run).not.toHaveBeenCalled();
  });
});
