import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadHelper() {
  return (await import('../src/lib/persistence')).requestPersistentStorage;
}

describe('requestPersistentStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('asks the browser when storage is not already persistent', async () => {
    const persisted = vi.fn(async () => false);
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted, persist } });

    await expect((await loadHelper())()).resolves.toBe(true);
    expect(persisted).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not ask again when storage is already persistent', async () => {
    const persisted = vi.fn(async () => true);
    const persist = vi.fn(async () => false);
    vi.stubGlobal('navigator', { storage: { persisted, persist } });

    await expect((await loadHelper())()).resolves.toBe(true);
    expect(persisted).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns false when the Storage API is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    await expect((await loadHelper())()).resolves.toBe(false);
  });

  it('returns false when the browser rejects the request', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => false,
        persist: async () => {
          throw new Error('denied');
        },
      },
    });

    await expect((await loadHelper())()).resolves.toBe(false);
  });
});
