import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { badRequest } from './helpers.js';

const BACKUP_TABLES = ['vehicles', 'photos', 'records', 'reminders'];

// Row counts for the manifest / restore response. Uses the passed db handle.
export function backupCounts(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    vehicles: count('vehicles'),
    records: count('records'),
    reminders: count('reminders'),
    photos: count('photos'),
  };
}

// Writes a zip backup to destPath: manifest.json, a consistent carmaint.db
// snapshot (via better-sqlite3 db.backup(), never a raw copy of the live file),
// and photos/<filename> for each file on disk. Resolves with destPath.
export function createBackupZip(db, dataDir, destPath) {
  const photosDir = path.join(dataDir, 'photos');
  const tmpSnapshot = path.join(dataDir, `.snapshot-${crypto.randomUUID()}.db`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      try {
        fs.rmSync(tmpSnapshot, { force: true });
      } catch {
        /* best-effort */
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // Consistent, WAL-safe snapshot to a temp file.
    db.backup(tmpSnapshot)
      .then(() => {
        if (settled) return;
        const manifest = {
          app: 'carmaint',
          version: 1,
          exported_at: new Date().toISOString(),
          counts: backupCounts(db),
        };

        const zip = new yazl.ZipFile();
        zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
        zip.addFile(tmpSnapshot, 'carmaint.db');

        let photoFiles = [];
        try {
          photoFiles = fs.readdirSync(photosDir);
        } catch {
          photoFiles = [];
        }
        for (const name of photoFiles) {
          const full = path.join(photosDir, name);
          try {
            if (fs.statSync(full).isFile()) zip.addFile(full, `photos/${name}`);
          } catch {
            /* skip unreadable entries */
          }
        }

        const out = fs.createWriteStream(destPath);
        out.on('error', fail);
        out.on('close', () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(destPath);
        });
        zip.outputStream.on('error', fail);
        zip.outputStream.pipe(out);
        zip.end();
      })
      .catch(fail);
  });
}

function openReadStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

function streamEntryToFile(zipfile, entry, dest) {
  return openReadStream(zipfile, entry).then(
    (rs) =>
      new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        rs.pipe(ws);
      })
  );
}

function readEntryToBuffer(zipfile, entry) {
  return openReadStream(zipfile, entry).then(
    (rs) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        rs.on('data', (c) => chunks.push(c));
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

        if (name === 'manifest.json') {
          readEntryToBuffer(zipfile, entry)
            .then((buf) => {
              manifestBuf = buf;
              zipfile.readEntry();
            })
            .catch(() => bail(badRequest('Backup zip is corrupt')));
          return;
        }

        if (name === 'carmaint.db') {
          streamEntryToFile(zipfile, entry, path.join(stagingDir, 'carmaint.db'))
            .then(() => {
              hasDb = true;
              zipfile.readEntry();
            })
            .catch(() => bail(badRequest('Backup zip is corrupt')));
          return;
        }

        const photoMatch = /^photos\/([^/\\]+)$/.exec(name);
        if (photoMatch) {
          try {
            fs.mkdirSync(stagingPhotos, { recursive: true });
          } catch {
            return bail(badRequest('Could not stage backup photos'));
          }
          streamEntryToFile(zipfile, entry, path.join(stagingPhotos, photoMatch[1]))
            .then(() => zipfile.readEntry())
            .catch(() => bail(badRequest('Backup zip is corrupt')));
          return;
        }

        // Unknown entries are ignored.
        zipfile.readEntry();
      });

      zipfile.readEntry();
    });
  });
}

export { BACKUP_TABLES };
