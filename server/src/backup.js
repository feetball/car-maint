import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { badRequest, HttpError } from './helpers.js';

const BACKUP_TABLES = ['vehicles', 'photos', 'records', 'reminders'];

// Ceiling on total decompressed bytes written during a restore, and on any
// single entry. Guards against zip bombs: a tiny upload whose entries expand
// to fill the data volume. Overridable via RESTORE_MAX_BYTES; defaults to 2 GB.
const RESTORE_MAX_BYTES = (() => {
  const raw = Number.parseInt(process.env.RESTORE_MAX_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 1024 * 1024 * 1024;
})();

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function mimeForFilename(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

// Row counts for the manifest / restore response, read through the async facade.
export async function backupCounts(db) {
  const count = async (table) => (await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;
  return {
    vehicles: await count('vehicles'),
    records: await count('records'),
    reminders: await count('reminders'),
    photos: await count('photos'),
  };
}

// Writes a zip backup to destPath: manifest.json, a consistent carmaint.db
// snapshot (built by the active driver — native db.backup() for sqlite, a copied
// better-sqlite3 file for libsql), and photos/<filename> read from the store.
// Resolves with destPath. ctx: { db, store, dataDir }.
export async function createBackupZip(ctx, destPath) {
  const tmpSnapshot = path.join(ctx.dataDir, `.snapshot-${crypto.randomUUID()}.db`);
  const cleanup = () => {
    try {
      fs.rmSync(tmpSnapshot, { force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    await ctx.db.snapshot(tmpSnapshot);

    const manifest = {
      app: 'carmaint',
      version: 1,
      exported_at: new Date().toISOString(),
      counts: await backupCounts(ctx.db),
    };

    // Pull photo bytes from the store (disk read or blob fetch) up front.
    const photoNames = await ctx.store.list();
    const photos = [];
    for (const name of photoNames) {
      try {
        photos.push([name, await ctx.store.read(name)]);
      } catch {
        /* skip unreadable entries */
      }
    }

    await new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
      zip.addFile(tmpSnapshot, 'carmaint.db');
      for (const [name, buf] of photos) zip.addBuffer(buf, `photos/${name}`);

      const out = fs.createWriteStream(destPath);
      out.on('error', reject);
      out.on('close', resolve);
      zip.outputStream.on('error', reject);
      zip.outputStream.pipe(out);
      zip.end();
    });
  } finally {
    cleanup();
  }
  return destPath;
}

function openReadStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

// Streams one entry to dest, counting bytes actually written (yauzl's declared
// uncompressedSize can be forged). If the real decompressed size exceeds
// `limit`, the streams are destroyed and it rejects with a 400. Resolves with
// the number of bytes written.
function streamEntryToFile(zipfile, entry, dest, limit) {
  return openReadStream(zipfile, entry).then(
    (rs) =>
      new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        let written = 0;
        let aborted = false;
        const abort = (err) => {
          if (aborted) return;
          aborted = true;
          rs.destroy();
          ws.destroy();
          reject(err);
        };
        rs.on('data', (chunk) => {
          written += chunk.length;
          if (written > limit) abort(badRequest('Backup exceeds the maximum allowed size'));
        });
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve(written));
        rs.pipe(ws);
      })
  );
}

// Reads one entry fully into memory, capped at `limit` bytes so a compressible
// entry cannot exhaust the heap. Rejects with a 400 past the cap.
function readEntryToBuffer(zipfile, entry, limit) {
  return openReadStream(zipfile, entry).then(
    (rs) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        rs.on('data', (c) => {
          if (aborted) return;
          size += c.length;
          if (size > limit) {
            aborted = true;
            rs.destroy();
            reject(badRequest('Backup exceeds the maximum allowed size'));
            return;
          }
          chunks.push(c);
        });
        rs.on('error', reject);
        rs.on('end', () => resolve(Buffer.concat(chunks)));
      })
  );
}

// Extracts a backup zip into stagingDir. Only carmaint.db and flat basenames
// under photos/ are written; manifest.json is read into memory. Entry names
// with absolute paths or '..' segments are rejected. Resolves with
// { manifestBuf, hasDb }. Rejects HttpError(400) on unsafe/corrupt input.
export function extractBackupZip(zipPath, stagingDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(badRequest('Backup is not a valid zip file'));

      const stagingPhotos = path.join(stagingDir, 'photos');
      let manifestBuf = null;
      let hasDb = false;
      let done = false;
      let totalBytes = 0; // real decompressed bytes written/read so far

      const bail = (e) => {
        if (done) return;
        done = true;
        try {
          zipfile.close();
        } catch {
          /* ignore */
        }
        reject(e);
      };

      zipfile.on('error', () => bail(badRequest('Backup zip is corrupt')));
      zipfile.on('end', () => {
        if (done) return;
        done = true;
        resolve({ manifestBuf, hasDb });
      });

      zipfile.on('entry', (entry) => {
        if (done) return;
        const name = entry.fileName;

        // Directory entries.
        if (/\/$/.test(name)) return zipfile.readEntry();

        const segments = name.split(/[/\\]/);
        if (path.isAbsolute(name) || name.startsWith('/') || segments.includes('..')) {
          return bail(badRequest('Backup zip contains an unsafe entry path'));
        }

        // Cheap early reject on the declared size. It is only a hint (yauzl's
        // uncompressedSize can be forged), so the real cap is enforced by
        // counting bytes below, but this rejects obvious bombs before we read.
        if (typeof entry.uncompressedSize === 'number' && entry.uncompressedSize > RESTORE_MAX_BYTES) {
          return bail(badRequest('Backup exceeds the maximum allowed size'));
        }
        // Remaining budget across all entries; the per-entry ceiling is the same
        // total, so passing the remainder enforces both at once.
        const remaining = RESTORE_MAX_BYTES - totalBytes;

        // Map read failures to a 400, but preserve an already-shaped size error.
        const asBadRequest = (e) => (e instanceof HttpError ? e : badRequest('Backup zip is corrupt'));

        if (name === 'manifest.json') {
          readEntryToBuffer(zipfile, entry, remaining)
            .then((buf) => {
              totalBytes += buf.length;
              manifestBuf = buf;
              zipfile.readEntry();
            })
            .catch((e) => bail(asBadRequest(e)));
          return;
        }

        if (name === 'carmaint.db') {
          streamEntryToFile(zipfile, entry, path.join(stagingDir, 'carmaint.db'), remaining)
            .then((n) => {
              totalBytes += n;
              hasDb = true;
              zipfile.readEntry();
            })
            .catch((e) => bail(asBadRequest(e)));
          return;
        }

        const photoMatch = /^photos\/([^/\\]+)$/.exec(name);
        if (photoMatch) {
          try {
            fs.mkdirSync(stagingPhotos, { recursive: true });
          } catch {
            return bail(badRequest('Could not stage backup photos'));
          }
          streamEntryToFile(zipfile, entry, path.join(stagingPhotos, photoMatch[1]), remaining)
            .then((n) => {
              totalBytes += n;
              zipfile.readEntry();
            })
            .catch((e) => bail(asBadRequest(e)));
          return;
        }

        // Unknown entries are ignored.
        zipfile.readEntry();
      });

      zipfile.readEntry();
    });
  });
}

// --- Stored auto-backup location (disk <dataDir>/backups or blob backups/) -----

function newestFirst(a, b) {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.filename < b.filename ? 1 : -1;
}

// Lists stored backups, newest first, as [{ filename, size, created_at }].
export async function listBackups(ctx) {
  if (ctx.store.kind === 'blob') {
    const blobs = await ctx.store.listPrefix('backups/');
    return blobs
      .map((b) => ({
        filename: b.pathname.slice('backups/'.length),
        size: b.size,
        created_at: new Date(b.uploadedAt).toISOString(),
      }))
      .filter((x) => x.filename && x.filename.toLowerCase().endsWith('.zip'))
      .sort(newestFirst);
  }

  const dir = path.join(ctx.dataDir, 'backups');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && n.toLowerCase().endsWith('.zip'))
    .map((filename) => {
      try {
        const st = fs.statSync(path.join(dir, filename));
        if (!st.isFile()) return null;
        const created = st.birthtimeMs || st.mtimeMs;
        return { filename, size: st.size, created_at: new Date(created).toISOString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(newestFirst);
}

function pruneDiskBackups(dir, keep) {
  if (!(Number.isFinite(keep) && keep >= 0)) return;
  const zips = fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith('.') && n.toLowerCase().endsWith('.zip'))
    .sort(); // ISO-ish timestamps sort chronologically
  if (zips.length > keep) {
    for (const name of zips.slice(0, zips.length - keep)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

async function pruneBlobBackups(ctx, keep) {
  if (!(Number.isFinite(keep) && keep >= 0)) return;
  const items = await listBackups(ctx); // newest first
  for (const item of items.slice(keep)) {
    await ctx.store.deletePath(`backups/${item.filename}`);
  }
}

// Creates a fresh backup zip and stores it in the active location (disk or blob),
// then prunes to the newest `keep`. Shared by the index.js timer and the cron
// backup route. Returns the stored filename.
export async function runAutoBackup(ctx, keep) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `carmaint-backup-${stamp}.zip`;

  if (ctx.store.kind === 'blob') {
    const tmp = path.join(os.tmpdir(), `.carmaint-backup-${crypto.randomUUID()}.zip`);
    try {
      await createBackupZip(ctx, tmp);
      await ctx.store.putPath(`backups/${name}`, fs.readFileSync(tmp), 'application/zip');
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
    }
    await pruneBlobBackups(ctx, keep);
    return name;
  }

  const dir = path.join(ctx.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  // Write to a temp name in the same dir and rename into place only on success,
  // so a failed/aborted write never leaves a truncated zip that listing would
  // report as a valid backup.
  const tmpDest = path.join(dir, `.tmp-${name}`);
  try {
    await createBackupZip(ctx, tmpDest);
    fs.renameSync(tmpDest, dest);
  } catch (err) {
    try {
      fs.rmSync(tmpDest, { force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
  pruneDiskBackups(dir, keep);
  return name;
}

export { BACKUP_TABLES };
