export interface BrowserStorageManager {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<StorageEstimate>;
}

export interface BrowserStorageStatus {
  supported: boolean;
  persisted: boolean | null;
  persistResult: boolean | null;
  usage: number | null;
  quota: number | null;
  available: number | null;
}

export const MIN_STORAGE_SAFETY_MARGIN_BYTES = 1024 * 1024;
const STORAGE_SAFETY_MARGIN_RATIO = 0.25;
export const STORAGE_CAPACITY_ERROR_EVENT = 'lumina:storage-capacity-error';

export type StorageCapacityErrorCode = 'insufficient-capacity' | 'quota-exceeded';

export class StorageCapacityError extends Error {
  constructor(
    readonly code: StorageCapacityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageCapacityError';
  }
}

export interface StorageCapacityGate {
  assertCanWrite(estimatedOutputBytes: number): Promise<void>;
}

function toFiniteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function getBrowserStorageManager(): BrowserStorageManager | null {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return null;
  }
  return navigator.storage;
}

export async function readBrowserStorageStatus(
  storage: BrowserStorageManager | null = getBrowserStorageManager(),
  options: { requestPersistence?: boolean } = {},
): Promise<BrowserStorageStatus> {
  if (!storage) {
    return {
      supported: false,
      persisted: null,
      persistResult: null,
      usage: null,
      quota: null,
      available: null,
    };
  }

  let persisted: boolean | null = null;
  try {
    persisted = storage.persisted ? await storage.persisted() : null;
  } catch {
    persisted = null;
  }

  let persistResult: boolean | null = null;
  if (options.requestPersistence && persisted === false && storage.persist) {
    try {
      persistResult = await storage.persist();
      persisted = persistResult;
    } catch {
      persistResult = false;
      persisted = false;
    }
  }

  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const estimate = storage.estimate ? await storage.estimate() : undefined;
    usage = toFiniteNonNegative(estimate?.usage);
    quota = toFiniteNonNegative(estimate?.quota);
  } catch {
    usage = null;
    quota = null;
  }

  return {
    supported: true,
    persisted,
    persistResult,
    usage,
    quota,
    available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
  };
}

export function estimateStorageReservation(estimatedOutputBytes: number): number {
  const estimated = Math.max(0, Math.ceil(estimatedOutputBytes));
  return estimated + Math.max(
    MIN_STORAGE_SAFETY_MARGIN_BYTES,
    Math.ceil(estimated * STORAGE_SAFETY_MARGIN_RATIO),
  );
}

export async function assertBrowserStorageCapacity(
  storage: Pick<BrowserStorageManager, 'estimate'> | null,
  estimatedOutputBytes: number,
): Promise<void> {
  if (!storage?.estimate) {
    return;
  }

  const estimate = await storage.estimate();
  const usage = toFiniteNonNegative(estimate.usage);
  const quota = toFiniteNonNegative(estimate.quota);
  if (usage === null || quota === null) {
    return;
  }

  const reservation = estimateStorageReservation(estimatedOutputBytes);
  if (Math.max(0, quota - usage) < reservation) {
    throw new StorageCapacityError(
      'insufficient-capacity',
      'Browser storage does not have enough free space for this media operation.',
    );
  }
}

export function createBrowserStorageCapacityGate(
  storage: Pick<BrowserStorageManager, 'estimate'> | null = getBrowserStorageManager(),
): StorageCapacityGate {
  return {
    assertCanWrite: (estimatedOutputBytes) => assertBrowserStorageCapacity(storage, estimatedOutputBytes),
  };
}

export function isQuotaExceededError(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    if ('name' in current && (current as { name?: unknown }).name === 'QuotaExceededError') {
      return true;
    }
    visited.add(current);
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export function notifyBrowserStorageCapacityError(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(STORAGE_CAPACITY_ERROR_EVENT));
  }
}
