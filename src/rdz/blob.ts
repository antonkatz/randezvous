/**
 * Read a Blob without relying solely on Blob.arrayBuffer(). Some mobile
 * browsers either omit that method or reject it for selected Files even though
 * FileReader can still access the same bytes.
 */
export async function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    try {
      return await blob.arrayBuffer();
    } catch {
      // Fall through to the long-standing FileReader API.
    }
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
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
}
