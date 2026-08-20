import { describe, expect, it, vi } from 'vitest';

import {
  MIN_STORAGE_SAFETY_MARGIN_BYTES,
  StorageCapacityError,
  assertBrowserStorageCapacity,
  estimateStorageReservation,
  readBrowserStorageStatus,
} from './browserStorage';

describe('browser storage status', () => {
  it('records the persistence request result together with usage and quota', async () => {
    const storage = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
      estimate: vi.fn().mockResolvedValue({ usage: 40, quota: 100 }),
    };

    await expect(readBrowserStorageStatus(storage, { requestPersistence: true })).resolves.toEqual({
      supported: true,
      persisted: false,
      persistResult: false,
      usage: 40,
      quota: 100,
      available: 60,
    });
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it('keeps persistence denial as a supported state when the storage API is available', async () => {
    const storage = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
      estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 500 }),
    };

    const status = await readBrowserStorageStatus(storage);

    expect(status).toMatchObject({ supported: true, persisted: false, persistResult: null });
  });
});

describe('browser storage capacity gate', () => {
  it('reserves estimated output bytes plus a non-zero safety margin before a write', () => {
    const reservation = estimateStorageReservation(4_000_000);

    expect(reservation).toBeGreaterThan(4_000_000);
    expect(reservation).toBeGreaterThanOrEqual(4_000_000 + MIN_STORAGE_SAFETY_MARGIN_BYTES);
  });

  it('rejects a write before it starts when the available quota cannot cover the reservation', async () => {
    const storage = {
      estimate: vi.fn().mockResolvedValue({ usage: 90, quota: 100 }),
    };

    await expect(assertBrowserStorageCapacity(storage, 20)).rejects.toMatchObject({
      name: 'StorageCapacityError',
      code: 'insufficient-capacity',
    } satisfies Partial<StorageCapacityError>);
  });
});
