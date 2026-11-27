/**
 * Ask the browser to make this origin's IndexedDB data persistent so identity
 * keys, photos, and circle records are less likely to be evicted under storage
 * pressure. Browsers may still deny the request or evict data in private
 * browsing, so callers must not treat this as a durability guarantee.
 */
let request: Promise<boolean> | null = null;

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

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(open.error ?? new Error(`Could not open legacy database ${name}`));
    open.onblocked = () =>
      reject(new Error(`Opening legacy database ${name} is blocked by another tab`));
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () =>
      reject(deletion.error ?? new Error(`Could not delete legacy database ${name}`));
    deletion.onblocked = () =>
      reject(new Error(`Deleting legacy database ${name} is blocked by another tab`));
  });
}

async function legacyDatabaseExists(name: string): Promise<boolean | null> {
  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof factory.databases !== 'function') return null;
  try {
    const databases = await factory.databases();
    return databases.some((database) => database.name === name);
  } catch {
    return null;
  }
}

/**
 * Copy records from a database created before the Randevouz -> Rendezvous
 * rename into the current database, then remove the legacy copy. Best-effort:
 * a blocked migration never prevents the app from starting.
 */
export async function migrateLegacyDatabase(
  legacyName: string,
  target: IDBDatabase,
): Promise<void> {
  if (typeof indexedDB === 'undefined' || legacyName === target.name) return;
  if ((await legacyDatabaseExists(legacyName)) === false) return;

  let legacy: IDBDatabase;
  try {
    legacy = await openDatabase(legacyName);
  } catch (error) {
    console.warn(`[rendezvous] could not open legacy database ${legacyName}`, error);
    return;
  }

  const copies: Array<{ name: string; records: unknown[] }> = [];
  try {
    const targetStores = new Set<string>(Array.from(target.objectStoreNames));
    for (const name of Array.from(legacy.objectStoreNames)) {
      if (!targetStores.has(name)) continue;
      const transaction = legacy.transaction(name, 'readonly');
      const records = await requestToPromise<unknown[]>(
        transaction.objectStore(name).getAll(),
      );
      if (records.length > 0) copies.push({ name, records });
    }
  } finally {
    legacy.close();
  }

  if (copies.length > 0) {
    const transaction = target.transaction(
      copies.map((copy) => copy.name),
      'readwrite',
    );
    for (const copy of copies) {
      const store = transaction.objectStore(copy.name);
      for (const record of copy.records) store.put(record);
    }
    await transactionToPromise(transaction);
  }

  await deleteDatabase(legacyName).catch((error: unknown) => {
    console.warn(`[rendezvous] could not delete legacy database ${legacyName}`, error);
  });
}

export function requestPersistentStorage(): Promise<boolean> {
  if (request) return request;

  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage || typeof storage.persist !== 'function') {
    request = Promise.resolve(false);
    return request;
  }

  request = (async () => {
    try {
      if (typeof storage.persisted === 'function' && (await storage.persisted())) {
        return true;
      }
      return await storage.persist();
    } catch (error) {
      console.warn('[rendezvous] persistent storage request failed', error);
      return false;
    }
  })();

  return request;
}
