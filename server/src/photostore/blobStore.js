// Vercel Blob photo store, active when BLOB_READ_WRITE_TOKEN is set. Photos are
// stored under the `photos/` prefix with public access; backups (used by the
// backup module) under `backups/`. @vercel/blob is imported lazily so the disk
// path never loads it.
//
// The public base URL is derived from the token. A RW token is
// `vercel_blob_rw_<STOREID>_<SECRET>`, and a store's public files are served from
// `https://<storeid>.public.blob.vercel-storage.com/<pathname>`. Combined with
// addRandomSuffix:false (deterministic pathname), that lets urlFor() return a
// photo's absolute URL synchronously without a network round-trip.
function deriveBase(token) {
  const m = /^vercel_blob_rw_([^_]+)_/.exec(token || '');
  const storeId = m ? m[1].toLowerCase() : '';
  return `https://${storeId}.public.blob.vercel-storage.com`;
}

export function createBlobStore({ token }) {
  const base = deriveBase(token);
  let mod = null;
  const lib = async () => (mod ??= await import('@vercel/blob'));

  async function putPath(pathname, buffer, contentType) {
    const { put } = await lib();
    const res = await put(pathname, buffer, {
      access: 'public',
      token,
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(contentType ? { contentType } : {}),
    });
    return res.url;
  }

  async function readPath(pathname) {
    const res = await fetch(`${base}/${pathname}`);
    if (!res.ok) throw new Error(`blob read failed (${res.status}) for ${pathname}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function deletePath(pathname) {
    const { del } = await lib();
    try {
      await del(`${base}/${pathname}`, { token });
    } catch {
      /* best-effort: already gone */
    }
  }

  async function listPrefix(prefix) {
    const { list } = await lib();
    const out = [];
    let cursor;
    do {
      const res = await list({ prefix, token, cursor });
      for (const b of res.blobs) out.push(b);
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor);
    return out;
  }

  return {
    kind: 'blob',
    base,
    token,

    urlFor(filename) {
      return `${base}/photos/${filename}`;
    },

    async put(filename, buffer, mimetype) {
      const url = await putPath(`photos/${filename}`, buffer, mimetype);
      return { url };
    },
    async read(filename) {
      return readPath(`photos/${filename}`);
    },
    async delete(filename) {
      return deletePath(`photos/${filename}`);
    },
    async list() {
      const blobs = await listPrefix('photos/');
      return blobs.map((b) => b.pathname.slice('photos/'.length)).filter(Boolean);
    },

    // Low-level, prefix-agnostic helpers reused by the backup module for the
    // backups/ location in blob mode.
    putPath,
    readPath,
    deletePath,
    listPrefix,
  };
}
