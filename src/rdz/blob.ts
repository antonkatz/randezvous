/**
 * Read a Blob without relying on a single browser API. Android file pickers can
 * return Files that reject Blob.arrayBuffer(), and some browser versions also
 * reject FileReader for the same provider-backed file.
 */
export async function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  let lastError: unknown = new Error('The file could not be read.');

  if (typeof blob.arrayBuffer === 'function') {
    try {
      return await blob.arrayBuffer();
    } catch (error) {
      lastError = error;
    }
  }

  if (typeof FileReader !== 'undefined') {
    try {
      return await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          if (reader.result instanceof ArrayBuffer) resolve(reader.result);
          else reject(new Error('The file reader did not return image bytes.'));
        });
        reader.addEventListener('error', () => {
          reject(reader.error ?? new Error('The file could not be read.'));
        });
        reader.addEventListener('abort', () => {
          reject(new Error('The file read was cancelled.'));
        });
        try {
          reader.readAsArrayBuffer(blob);
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      lastError = error;
    }
  }

  if (typeof blob.stream === 'function') {
    try {
      const reader = blob.stream().getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes.buffer;
    } catch (error) {
      lastError = error;
    }
  }

  if (
    typeof fetch === 'function' &&
    typeof URL.createObjectURL === 'function' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(blob);
      const response = await fetch(url);
      if (!response.ok) throw new Error('The file could not be opened.');
      return await response.arrayBuffer();
    } catch (error) {
      lastError = error;
    } finally {
      if (url !== null) URL.revokeObjectURL(url);
    }
  }

  throw lastError;
}
