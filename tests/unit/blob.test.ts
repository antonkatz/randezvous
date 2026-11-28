import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBlobArrayBuffer } from '../../src/rdz/blob';

function stubFileReader(result: ArrayBuffer | DOMException): void {
  class FakeFileReader extends EventTarget {
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;

    readAsArrayBuffer(): void {
      if (result instanceof DOMException) {
        this.error = result;
        this.dispatchEvent(new Event('error'));
      } else {
        this.result = result;
        this.dispatchEvent(new Event('load'));
      }
    }
  }
  vi.stubGlobal('FileReader', FakeFileReader);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readBlobArrayBuffer', () => {
  it('uses the native promise API when it works', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const nativeRead = vi.spyOn(blob, 'arrayBuffer');

    expect(new Uint8Array(await readBlobArrayBuffer(blob))).toEqual(new Uint8Array([1, 2, 3]));
    expect(nativeRead).toHaveBeenCalledOnce();
  });

  it('falls back to FileReader when arrayBuffer is unavailable', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    stubFileReader(bytes.buffer);
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined });

    expect(new Uint8Array(await readBlobArrayBuffer(blob))).toEqual(bytes);
  });

  it('retries with FileReader when a mobile browser rejects arrayBuffer', async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    stubFileReader(bytes.buffer);
    const blob = new Blob([bytes]);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(
      new DOMException('The selected file is unavailable.', 'NotReadableError'),
    );

    expect(new Uint8Array(await readBlobArrayBuffer(blob))).toEqual(bytes);
  });

  it('rejects when neither file-reading API can access the bytes', async () => {
    const failure = new DOMException('The selected file is unavailable.', 'NotReadableError');
    stubFileReader(failure);
    const blob = new Blob([new Uint8Array([1])]);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Native read failed.'));

    await expect(readBlobArrayBuffer(blob)).rejects.toBe(failure);
  });
});
