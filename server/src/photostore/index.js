import { createDiskStore } from './diskStore.js';
import { createBlobStore } from './blobStore.js';

// Selects the photo store. Blob when a Vercel Blob RW token is present, else the
// default disk store under <dataDir>/photos. Every store implements the same
// interface: put(filename, buffer, mimetype) -> {url}, read(filename) -> Buffer,
// delete(filename), list() -> filename[], urlFor(filename) -> string (sync).
export function createPhotoStore({ dataDir, blobToken } = {}) {
  if (blobToken) return createBlobStore({ token: blobToken });
  return createDiskStore({ dataDir });
}
