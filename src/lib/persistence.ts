/**
 * Ask the browser to make this origin's IndexedDB data persistent so identity
 * keys, photos, and circle records are less likely to be evicted under storage
 * pressure. Browsers may still deny the request or evict data in private
 * browsing, so callers must not treat this as a durability guarantee.
 */
let request: Promise<boolean> | null = null;

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
      console.warn('[randevouz] persistent storage request failed', error);
      return false;
    }
  })();

  return request;
}
