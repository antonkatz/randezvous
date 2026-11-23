import { requestPersistentStorage } from '../lib/persistence';
import { compareStrings } from './canonical';
import type { CircleId, CircleStore, StoredCircleRecord } from './types';

/** In-memory store used by tests and by hosts that do not want persistence. */
export class MemoryCircleStore implements CircleStore {
  private readonly circles = new Map<CircleId, Map<string, StoredCircleRecord>>();

  async load(circleId: CircleId): Promise<StoredCircleRecord[]> {
    const records = this.circles.get(circleId);
    if (!records) return [];
    return [...records.values()].sort((a, b) => compareStrings(a.id, b.id));
  }

  async append(circleId: CircleId, records: readonly StoredCircleRecord[]): Promise<void> {
    if (records.length === 0) return;
    let bucket = this.circles.get(circleId);
    if (!bucket) {
      bucket = new Map();
      this.circles.set(circleId, bucket);
    }
    for (const record of records) {
      if (!bucket.has(record.id)) bucket.set(record.id, record);
    }
  }

  async listCircles(): Promise<CircleId[]> {
    return [...this.circles.keys()].sort(compareStrings);
  }

  /** Test helper: the full set held for a circle, including empty circles. */
  snapshot(circleId: CircleId): StoredCircleRecord[] {
    return [...(this.circles.get(circleId)?.values() ?? [])].sort((a, b) =>
      compareStrings(a.id, b.id),
    );
  }
}

interface StoredRow {
  key: string;
  circleId: CircleId;
  id: string;
  record: StoredCircleRecord['record'];
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * Small isolated IndexedDB adapter. It uses its own database so the existing
 * photo/identity store is untouched. Records are immutable and keyed by
 * (circleId, content id).
 */
export class IndexedDbCircleStore implements CircleStore {
  private readonly name: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(databaseName = 'randevouz-circles') {
    this.name = databaseName;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    void requestPersistentStorage();
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('circles')) {
          db.createObjectStore('circles', { keyPath: 'circleId' });
        }
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: 'key' });
          store.createIndex('circleId', 'circleId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open circle IndexedDB'));
      request.onblocked = () =>
        reject(new Error('Circle IndexedDB upgrade blocked by another tab'));
    });
    return this.dbPromise;
  }

  async load(circleId: CircleId): Promise<StoredCircleRecord[]> {
    const db = await this.open();
    const tx = db.transaction('records', 'readonly');
    const index = tx.objectStore('records').index('circleId');
    const rows = await requestToPromise<StoredRow[]>(index.getAll(circleId));
    return rows
      .map((row) => ({ id: row.id, record: row.record }))
      .sort((a, b) => compareStrings(a.id, b.id));
  }

  async append(circleId: CircleId, records: readonly StoredCircleRecord[]): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['circles', 'records'], 'readwrite');
    tx.objectStore('circles').put({ circleId });
    const store = tx.objectStore('records');
    for (const entry of records) {
      const row: StoredRow = {
        key: `${circleId}\u0000${entry.id}`,
        circleId,
        id: entry.id,
        record: entry.record,
      };
      store.put(row);
    }
    await transactionToPromise(tx);
  }

  async listCircles(): Promise<CircleId[]> {
    const db = await this.open();
    const tx = db.transaction('circles', 'readonly');
    const keys = await requestToPromise<IDBValidKey[]>(
      tx.objectStore('circles').getAllKeys(),
    );
    return keys
      .filter((key): key is string => typeof key === 'string')
      .sort(compareStrings);
  }
}
