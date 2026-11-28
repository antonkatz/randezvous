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

  it('reads through Blob.stream when native and legacy readers reject the file', async () => {
    const bytes = new Uint8Array([10, 11, 12, 13]);
    stubFileReader(new DOMException('The selected file is unavailable.', 'NotReadableError'));
    const blob = new Blob([bytes]);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Native read failed.'));
    vi.spyOn(blob, 'stream').mockImplementation(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, 2));
            controller.enqueue(bytes.slice(2));
            controller.close();
          },
        }),
    );

    expect(new Uint8Array(await readBlobArrayBuffer(blob))).toEqual(bytes);
  });

  it('fetches a temporary Blob URL when stream reading is unavailable', async () => {
    const bytes = new Uint8Array([14, 15, 16]);
    stubFileReader(new DOMException('The selected file is unavailable.', 'NotReadableError'));
    const blob = new Blob([bytes]);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Native read failed.'));
    Object.defineProperty(blob, 'stream', { value: undefined });
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo-test');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);

    expect(new Uint8Array(await readBlobArrayBuffer(blob))).toEqual(bytes);
    expect(createUrl).toHaveBeenCalledWith(blob);
    expect(fetchMock).toHaveBeenCalledWith('blob:photo-test');
    expect(revokeUrl).toHaveBeenCalledWith('blob:photo-test');
  });

  it('rejects when no reader can access the bytes', async () => {
    const failure = new DOMException('The selected file is unavailable.', 'NotReadableError');
    stubFileReader(failure);
    const blob = new Blob([new Uint8Array([1])]);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Native read failed.'));
    Object.defineProperty(blob, 'stream', { value: undefined });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw failure;
    });

    await expect(readBlobArrayBuffer(blob)).rejects.toBe(failure);
  });
});
