import { createIdentity } from './crypto';
import { randomTransferId } from './ids';
import type {
  Envelope,
  MaskRecord,
  MaskState,
  MaskVerificationRecord,
  PeerRecord,
  PinRecord,
  StoredIdentity,
  VerificationRecord,
} from './types';

const DB_NAME = 'rdz';
const DB_VERSION = 3;
const LEGACY_IDENTITY_STORE = 'identity';
const MASK_STORE = 'masks';
const META_STORE = 'meta';
const VERIFICATION_STORE = 'verification';
const MASK_VERIFICATION_STORE = 'maskVerification';
const PIN_STORE = 'pins';
const MESSAGE_STORE = 'messages';
const PEER_STORE = 'peerRegistry';
const PEER_TTL_MS = 24 * 60 * 60 * 1000;

interface MetaRecord {
  key: string;
  value: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let persistenceRequested = false;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_IDENTITY_STORE)) {
        db.createObjectStore(LEGACY_IDENTITY_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(MASK_STORE)) {
        db.createObjectStore(MASK_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(VERIFICATION_STORE)) {
        db.createObjectStore(VERIFICATION_STORE, { keyPath: 'humanId' });
      }
      if (!db.objectStoreNames.contains(MASK_VERIFICATION_STORE)) {
        db.createObjectStore(MASK_VERIFICATION_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE, { keyPath: 'channelId' });
      }
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        db.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PEER_STORE)) {
        db.createObjectStore(PEER_STORE, { keyPath: 'humanId' });
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

async function readMeta(key: string): Promise<string | null> {
  const db = await openDb();
  const record = (await request(
    db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key),
  )) as MetaRecord | undefined;
  return record?.value ?? null;
}

async function writeMeta(key: string, value: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put({ key, value } satisfies MetaRecord);
  await transactionDone(tx);
}

export async function createMaskRecord(): Promise<MaskRecord> {
  const identity: StoredIdentity = await createIdentity();
  return {
    ...identity,
    id: `mask-${randomTransferId()}`,
    createdAt: Date.now(),
    verifiedOnlySignalling: false,
  };
}

export async function loadMaskState(): Promise<MaskState> {
  if (!persistenceRequested) {
    persistenceRequested = true;
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Persistence is best effort.
    }
  }
  const db = await openDb();
  let masks = (await request(
    db.transaction(MASK_STORE, 'readonly').objectStore(MASK_STORE).getAll(),
  )) as MaskRecord[];
  masks.sort((left, right) => left.createdAt - right.createdAt);

  // The preference lives on the mask, so each identity keeps its own privacy
  // policy. Older mask records predate the switch and default to the existing
  // permissionless mesh behaviour without a schema migration.
  if (masks.some((mask) => typeof mask.verifiedOnlySignalling !== 'boolean')) {
    masks = masks.map((mask) => ({
      ...mask,
      verifiedOnlySignalling: mask.verifiedOnlySignalling ?? false,
    }));
    for (const mask of masks) await saveMask(mask);
  }

  if (masks.length === 0) {
    masks = [await migrateLegacyIdentity()];
    await saveMask(masks[0]!);
  }

  let activeMaskId = await readMeta('activeMaskId');
  if (!activeMaskId || !masks.some((mask) => mask.id === activeMaskId)) {
    activeMaskId = masks[0]!.id;
    await writeMeta('activeMaskId', activeMaskId);
  }

  const migrated = await readMeta('activeMaskMigrated');
  if (!migrated) {
    await migrateLegacyVerifications(activeMaskId);
    await writeMeta('activeMaskMigrated', '1');
  }

  return { masks, activeMaskId };
}

async function migrateLegacyIdentity(): Promise<MaskRecord> {
  const db = await openDb();
  const legacy = (await request(
    db.transaction(LEGACY_IDENTITY_STORE, 'readonly').objectStore(LEGACY_IDENTITY_STORE).get('self'),
  )) as (StoredIdentity & { key?: string }) | undefined;
  if (legacy) {
    const mask: MaskRecord = {
      id: `mask-${legacy.humanId}`,
      privateKey: legacy.privateKey,
      publicKey: legacy.publicKey,
      humanId: legacy.humanId,
      createdAt: Date.now(),
      verifiedOnlySignalling: false,
    };
    await saveMask(mask);
    await writeMeta('activeMaskId', mask.id);
    await migrateLegacyVerifications(mask.id);
    await writeMeta('activeMaskMigrated', '1');
    const tx = db.transaction(LEGACY_IDENTITY_STORE, 'readwrite');
    tx.objectStore(LEGACY_IDENTITY_STORE).delete('self');
    await transactionDone(tx);
    return mask;
  }
  const mask = await createMaskRecord();
  await saveMask(mask);
  await writeMeta('activeMaskId', mask.id);
  await writeMeta('activeMaskMigrated', '1');
  return mask;
}

async function migrateLegacyVerifications(maskId: string): Promise<void> {
  const db = await openDb();
  const records = (await request(
    db.transaction(VERIFICATION_STORE, 'readonly').objectStore(VERIFICATION_STORE).getAll(),
  )) as VerificationRecord[];
  if (records.length === 0) return;
  const tx = db.transaction(MASK_VERIFICATION_STORE, 'readwrite');
  const store = tx.objectStore(MASK_VERIFICATION_STORE);
  for (const record of records) {
    store.put({
      ...record,
      id: `${maskId}:${record.humanId}`,
      maskId,
    } satisfies MaskVerificationRecord);
  }
  await transactionDone(tx);
}

export async function saveMask(mask: MaskRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MASK_STORE, 'readwrite');
  tx.objectStore(MASK_STORE).put(mask);
  await transactionDone(tx);
}

export async function setActiveMask(maskId: string): Promise<void> {
  await writeMeta('activeMaskId', maskId);
}

export async function removeMaskRecord(maskId: string): Promise<void> {
  const db = await openDb();
  const records = (await request(
    db.transaction(MASK_VERIFICATION_STORE, 'readonly').objectStore(MASK_VERIFICATION_STORE).getAll(),
  )) as MaskVerificationRecord[];
  const tx = db.transaction([MASK_STORE, MASK_VERIFICATION_STORE], 'readwrite');
  tx.objectStore(MASK_STORE).delete(maskId);
  const verifications = tx.objectStore(MASK_VERIFICATION_STORE);
  for (const record of records) {
    if (record.maskId === maskId) verifications.delete(record.id);
  }
  await transactionDone(tx);
}

export async function loadVerifications(maskId: string): Promise<Map<string, VerificationRecord>> {
  const db = await openDb();
  const records = (await request(
    db.transaction(MASK_VERIFICATION_STORE, 'readonly').objectStore(MASK_VERIFICATION_STORE).getAll(),
  )) as MaskVerificationRecord[];
  return new Map(
    records
      .filter((record) => record.maskId === maskId)
      .map((record) => [record.humanId, record as VerificationRecord]),
  );
}

export async function setVerification(
  maskId: string,
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
  const tx = db.transaction(MASK_VERIFICATION_STORE, 'readwrite');
  tx.objectStore(MASK_VERIFICATION_STORE).put({
    ...record,
    id: `${maskId}:${humanId}`,
    maskId,
  } satisfies MaskVerificationRecord);
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

export async function loadPeerRegistry(now = Date.now()): Promise<PeerRecord[]> {
  const db = await openDb();
  const records = (await request(
    db.transaction(PEER_STORE, 'readonly').objectStore(PEER_STORE).getAll(),
  )) as PeerRecord[];
  const fresh = records.filter((record) => now - record.lastSeen < PEER_TTL_MS);
  const stale = records.filter((record) => now - record.lastSeen >= PEER_TTL_MS);
  if (stale.length > 0) {
    const tx = db.transaction(PEER_STORE, 'readwrite');
    const store = tx.objectStore(PEER_STORE);
    for (const record of stale) store.delete(record.humanId);
    await transactionDone(tx);
  }
  return fresh;
}

export async function savePeerRegistryEntry(record: PeerRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PEER_STORE, 'readwrite');
  tx.objectStore(PEER_STORE).put(record);
  await transactionDone(tx);
}
