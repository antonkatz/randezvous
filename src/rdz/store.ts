import { createIdentity } from './crypto';
import type {
  Envelope,
  PinRecord,
  StoredIdentity,
  VerificationRecord,
} from './types';

const DB_NAME = 'rdz';
const DB_VERSION = 1;
const IDENTITY_STORE = 'identity';
const VERIFICATION_STORE = 'verification';
const PIN_STORE = 'pins';
const MESSAGE_STORE = 'messages';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(VERIFICATION_STORE)) {
        db.createObjectStore(VERIFICATION_STORE, { keyPath: 'humanId' });
      }
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE, { keyPath: 'channelId' });
      }
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        db.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('Local storage request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Local storage write failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local storage write was aborted.'));
  });
}

export async function loadIdentity(): Promise<StoredIdentity> {
  const db = await openDb();
  const existing = await request(
    db.transaction(IDENTITY_STORE, 'readonly').objectStore(IDENTITY_STORE).get('self'),
  );
  if (existing) return existing as StoredIdentity;
  const identity = await createIdentity();
  await saveIdentity(identity);
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is best effort.
  }
  return identity;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(IDENTITY_STORE, 'readwrite');
  tx.objectStore(IDENTITY_STORE).put(identity);
  await transactionDone(tx);
}

export async function loadVerifications(): Promise<Map<string, VerificationRecord>> {
  const db = await openDb();
  const records = (await request(
    db.transaction(VERIFICATION_STORE, 'readonly').objectStore(VERIFICATION_STORE).getAll(),
  )) as VerificationRecord[];
  return new Map(records.map((record) => [record.humanId, record]));
}

export async function setVerification(
  humanId: string,
  publicKey: string,
  verified: boolean,
): Promise<VerificationRecord> {
  const record: VerificationRecord = {
    humanId,
    publicKey,
    verifiedAt: verified ? Date.now() : null,
  };
  const db = await openDb();
  const tx = db.transaction(VERIFICATION_STORE, 'readwrite');
  tx.objectStore(VERIFICATION_STORE).put(record);
  await transactionDone(tx);
  return record;
}

export async function loadPins(): Promise<PinRecord[]> {
  const db = await openDb();
  return (await request(
    db.transaction(PIN_STORE, 'readonly').objectStore(PIN_STORE).getAll(),
  )) as PinRecord[];
}

export async function savePin(pin: PinRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PIN_STORE, 'readwrite');
  tx.objectStore(PIN_STORE).put(pin);
  await transactionDone(tx);
}

export async function removePin(channelId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PIN_STORE, 'readwrite');
  tx.objectStore(PIN_STORE).delete(channelId);
  await transactionDone(tx);
}

interface StoredEnvelope {
  id: string;
  envelope: Envelope;
}

export async function loadEnvelopes(): Promise<StoredEnvelope[]> {
  const db = await openDb();
  return (await request(
    db.transaction(MESSAGE_STORE, 'readonly').objectStore(MESSAGE_STORE).getAll(),
  )) as StoredEnvelope[];
}

export async function saveEnvelope(id: string, envelope: Envelope): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MESSAGE_STORE, 'readwrite');
  tx.objectStore(MESSAGE_STORE).put({ id, envelope });
  await transactionDone(tx);
}

export async function deleteEnvelopes(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(MESSAGE_STORE, 'readwrite');
  const store = tx.objectStore(MESSAGE_STORE);
  for (const id of ids) store.delete(id);
  await transactionDone(tx);
}
