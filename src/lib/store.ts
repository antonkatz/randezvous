import { migrateLegacyDatabase, requestPersistentStorage } from './persistence';
import type { JoinRequest } from './protocol';
import type { StoredHuman, StoredIdentity, StoredRendezvous } from './types';

const DB_VERSION = 1;
const IDENTITY_KEY = 'self';
const PENDING_JOINS_KEY = 'pending-joins';
const PENDING_REMOVALS_KEY = 'pending-removals';
const REVOKED_INVITES_KEY = 'revoked-invites';

export interface PendingRemoval {
  id: string;
  to: string;
  createdAt: number;
  revokedInvites: string[];
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

export class RendezvousStore {
  private readonly name: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(storageName = 'rendezvous') {
    this.name = storageName;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    void requestPersistentStorage();
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('humans')) {
          db.createObjectStore('humans', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('rendezvous')) {
          const store = db.createObjectStore('rendezvous', { keyPath: 'id' });
          store.createIndex('scheduledFor', 'scheduledFor');
          store.createIndex('direction', 'direction');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    }).then(async (db) => {
      try {
        await migrateLegacyDatabase('randevouz', db);
      } catch (error) {
        console.warn('[rendezvous] could not migrate the legacy database', error);
      }
      return db;
    });
    return this.dbPromise;
  }

  async getIdentity(): Promise<StoredIdentity | null> {
    const db = await this.open();
    const tx = db.transaction('identity', 'readonly');
    const value = await requestToPromise<StoredIdentity | undefined>(
      tx.objectStore('identity').get(IDENTITY_KEY),
    );
    return value ?? null;
  }

  async putIdentity(identity: StoredIdentity): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('identity', 'readwrite');
    tx.objectStore('identity').put({ ...identity, key: IDENTITY_KEY });
    await transactionToPromise(tx);
  }

  async getHumans(): Promise<StoredHuman[]> {
    const db = await this.open();
    const tx = db.transaction('humans', 'readonly');
    const humans = await requestToPromise<StoredHuman[]>(tx.objectStore('humans').getAll());
    return humans.sort((a, b) => a.addedAt - b.addedAt);
  }

  async putHuman(human: StoredHuman): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('humans', 'readwrite');
    tx.objectStore('humans').put(human);
    await transactionToPromise(tx);
  }

  async deleteHuman(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('humans', 'readwrite');
    tx.objectStore('humans').delete(id);
    await transactionToPromise(tx);
  }

  async listRendezvous(): Promise<StoredRendezvous[]> {
    const db = await this.open();
    const tx = db.transaction('rendezvous', 'readonly');
    const records = await requestToPromise<StoredRendezvous[]>(
      tx.objectStore('rendezvous').getAll(),
    );
    return records.sort((a, b) => a.scheduledFor - b.scheduledFor);
  }

  async putRendezvous(record: StoredRendezvous): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('rendezvous', 'readwrite');
    tx.objectStore('rendezvous').put(record);
    await transactionToPromise(tx);
  }

  async deleteRendezvous(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('rendezvous', 'readwrite');
    tx.objectStore('rendezvous').delete(id);
    await transactionToPromise(tx);
  }

  async deletePendingRendezvousForHuman(peerId: string): Promise<string[]> {
    const all = await this.listRendezvous();
    const ids = all
      .filter((record) => record.peerId === peerId && record.status !== 'delivered')
      .map((record) => record.id);
    if (ids.length === 0) return ids;
    const db = await this.open();
    const tx = db.transaction('rendezvous', 'readwrite');
    const store = tx.objectStore('rendezvous');
    for (const id of ids) store.delete(id);
    await transactionToPromise(tx);
    return ids;
  }

  async getPendingJoins(): Promise<JoinRequest[]> {
    const db = await this.open();
    const tx = db.transaction('meta', 'readonly');
    const value = await requestToPromise<{ key: string; value: JoinRequest[] } | undefined>(
      tx.objectStore('meta').get(PENDING_JOINS_KEY),
    );
    return value?.value ?? [];
  }

  async addPendingJoin(join: JoinRequest): Promise<void> {
    const joins = await this.getPendingJoins();
    if (joins.some((entry) => entry.id === join.id)) return;
    joins.push(join);
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: PENDING_JOINS_KEY, value: joins });
    await transactionToPromise(tx);
  }

  async removePendingJoin(id: string): Promise<void> {
    const joins = await this.getPendingJoins();
    const next = joins.filter((entry) => entry.id !== id);
    if (next.length === joins.length) return;
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: PENDING_JOINS_KEY, value: next });
    await transactionToPromise(tx);
  }

  async getRevokedInvites(): Promise<string[]> {
    const db = await this.open();
    const tx = db.transaction('meta', 'readonly');
    const value = await requestToPromise<{ key: string; value: string[] } | undefined>(
      tx.objectStore('meta').get(REVOKED_INVITES_KEY),
    );
    return value?.value ?? [];
  }

  async addRevokedInvites(hashes: string[]): Promise<void> {
    if (hashes.length === 0) return;
    const existing = new Set(await this.getRevokedInvites());
    for (const hash of hashes) existing.add(hash);
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: REVOKED_INVITES_KEY, value: [...existing] });
    await transactionToPromise(tx);
  }

  async getPendingRemovals(): Promise<PendingRemoval[]> {
    const db = await this.open();
    const tx = db.transaction('meta', 'readonly');
    const value = await requestToPromise<
      { key: string; value: PendingRemoval[] } | undefined
    >(tx.objectStore('meta').get(PENDING_REMOVALS_KEY));
    return value?.value ?? [];
  }

  async addPendingRemoval(removal: PendingRemoval): Promise<void> {
    const removals = await this.getPendingRemovals();
    removals.push(removal);
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: PENDING_REMOVALS_KEY, value: removals });
    await transactionToPromise(tx);
  }

  async removePendingRemoval(id: string): Promise<void> {
    const removals = await this.getPendingRemovals();
    const next = removals.filter((entry) => entry.id !== id);
    if (next.length === removals.length) return;
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: PENDING_REMOVALS_KEY, value: next });
    await transactionToPromise(tx);
  }
}
