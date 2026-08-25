const WEB_DATABASE_NAME = 'lumina-web';
const WEB_DATABASE_VERSION = 2;
const SETTINGS_RECORD_KEY = 'settings-storage';

export const WEB_DATABASE_STORES = ['settings'] as const;
export type WebDatabaseStoreName = (typeof WEB_DATABASE_STORES)[number];

export type WebDatabaseTransactionMode = 'readonly' | 'readwrite';

export class WebDatabaseError extends Error {
  readonly code: 'unavailable' | 'open-failed' | 'transaction-failed';
  readonly cause?: unknown;

  constructor(
    message: string,
    code: 'unavailable' | 'open-failed' | 'transaction-failed',
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'WebDatabaseError';
    this.code = code;
    this.cause = options?.cause;
  }
}

export interface WebDatabaseTransaction {
  get<T>(storeName: WebDatabaseStoreName, key: IDBValidKey): Promise<T | undefined>;
  put<T>(storeName: WebDatabaseStoreName, value: T): Promise<void>;
  delete(storeName: WebDatabaseStoreName, key: IDBValidKey): Promise<void>;
}

export interface WebDatabase {
  run<T>(
    storeNames: readonly WebDatabaseStoreName[],
    mode: WebDatabaseTransactionMode,
    operation: (transaction: WebDatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}

interface StoredSettingsRecord {
  key: string;
  value: string;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function createRequestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function createTransactionPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function createIndexedDbTransaction(transaction: IDBTransaction): WebDatabaseTransaction {
  return {
    get: async <T>(storeName: WebDatabaseStoreName, key: IDBValidKey) =>
      createRequestPromise(transaction.objectStore(storeName).get(key)) as Promise<T | undefined>,
    put: async <T>(storeName: WebDatabaseStoreName, value: T) => {
      await createRequestPromise(transaction.objectStore(storeName).put(value));
    },
    delete: async (storeName: WebDatabaseStoreName, key: IDBValidKey) => {
      await createRequestPromise(transaction.objectStore(storeName).delete(key));
    },
  };
}

function createSchema(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains('settings')) {
    database.createObjectStore('settings', { keyPath: 'key' });
  }
}

function openDatabase(factory: IDBFactory | undefined): Promise<IDBDatabase> {
  if (!factory) {
    return Promise.reject(new WebDatabaseError(
      'IndexedDB is unavailable in this browser context.',
      'unavailable',
    ));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(WEB_DATABASE_NAME, WEB_DATABASE_VERSION);
    } catch (error) {
      reject(new WebDatabaseError(
        `Unable to open IndexedDB: ${toErrorMessage(error)}`,
        'open-failed',
        { cause: error },
      ));
      return;
    }

    request.onupgradeneeded = () => {
      try {
        createSchema(request.result);
      } catch (error) {
        request.transaction?.abort();
        reject(new WebDatabaseError(
          `Unable to initialize IndexedDB schema: ${toErrorMessage(error)}`,
          'open-failed',
          { cause: error },
        ));
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new WebDatabaseError(
      `Unable to open IndexedDB: ${toErrorMessage(request.error)}`,
      'open-failed',
      { cause: request.error },
    ));
    request.onblocked = () => reject(new WebDatabaseError(
      'IndexedDB is blocked by another open tab. Close older Lumina tabs and retry.',
      'open-failed',
    ));
  });
}

class IndexedDbWebDatabase implements WebDatabase {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory | undefined) {}

  private open(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = openDatabase(this.factory).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise;
  }

  async run<T>(
    storeNames: readonly WebDatabaseStoreName[],
    mode: WebDatabaseTransactionMode,
    operation: (transaction: WebDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const database = await this.open();
    let nativeTransaction: IDBTransaction;
    try {
      nativeTransaction = database.transaction([...storeNames], mode);
    } catch (error) {
      throw new WebDatabaseError(
        `IndexedDB transaction could not start: ${toErrorMessage(error)}`,
        'transaction-failed',
        { cause: error },
      );
    }

    const transactionDone = createTransactionPromise(nativeTransaction);
    try {
      const result = await operation(createIndexedDbTransaction(nativeTransaction));
      await transactionDone;
      return result;
    } catch (error) {
      try {
        nativeTransaction.abort();
      } catch {
        // The transaction may already be inactive or completed.
      }
      await transactionDone.catch(() => undefined);
      if (error instanceof WebDatabaseError) {
        throw error;
      }
      throw new WebDatabaseError(
        `IndexedDB transaction failed: ${toErrorMessage(error)}`,
        'transaction-failed',
        { cause: error },
      );
    }
  }
}

let defaultDatabase: WebDatabase | null = null;

export function createIndexedDbWebDatabase(factory?: IDBFactory): WebDatabase {
  return new IndexedDbWebDatabase(factory ?? globalThis.indexedDB);
}

export function getWebDatabase(): WebDatabase {
  if (!defaultDatabase) {
    defaultDatabase = createIndexedDbWebDatabase();
  }
  return defaultDatabase;
}

export function resetWebDatabaseForTests(): void {
  defaultDatabase = null;
}

export function createSettingsRecord(value: string): StoredSettingsRecord {
  return { key: SETTINGS_RECORD_KEY, value };
}

export function readSettingsRecord(record: StoredSettingsRecord | undefined): string | null {
  return record?.key === SETTINGS_RECORD_KEY && typeof record.value === 'string'
    ? record.value
    : null;
}
