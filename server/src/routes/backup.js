import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import { createDb } from '../db.js';
import { HttpError, badRequest, notFound } from '../helpers.js';
import { BACKUP_TABLES, backupCounts, createBackupZip, extractBackupZip } from '../backup.js';

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function backupRouter(ctx) {
  const router = Router();

  const restoreTmpDir = path.join(ctx.dataDir, '.restore-uploads');
  fs.mkdirSync(restoreTmpDir, { recursive: true });

  const uploadRestore = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, restoreTmpDir),
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
    }),
    limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 10 },
    fileFilter(req, file, cb) {
      const okType =
        file.mimetype === 'application/zip' ||
        file.mimetype === 'application/x-zip-compressed' ||
        file.mimetype === 'application/octet-stream';
      if (okType || /\.zip$/i.test(file.originalname || '')) cb(null, true);
      else cb(new HttpError(400, 'backup must be a .zip file'));
    },
  });

  // Stream a fresh consistent backup zip.
  router.get('/backup', async (req, res, next) => {
    const tmpDir = path.join(ctx.dataDir, '.backup-tmp');
    let tmpZip;
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      tmpZip = path.join(tmpDir, `${crypto.randomUUID()}.zip`);
      await createBackupZip(ctx.db, ctx.dataDir, tmpZip);
      const size = fs.statSync(tmpZip).size;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="carmaint-backup-${isoDate()}.zip"`
      );
      res.setHeader('Content-Length', String(size));
      const stream = fs.createReadStream(tmpZip);
      const removeTmp = () => {
        try {
          fs.rmSync(tmpZip, { force: true });
        } catch {
          /* best-effort */
        }
      };
      stream.on('error', (err) => {
        removeTmp();
        next(err);
      });
      stream.on('close', removeTmp);
      stream.pipe(res);
    } catch (err) {
      if (tmpZip) {
        try {
          fs.rmSync(tmpZip, { force: true });
        } catch {
          /* best-effort */
        }
      }
      next(err);
    }
  });

  // Validate a backup zip fully, then swap in its db + photos.
  router.post('/restore', uploadRestore.single('backup'), async (req, res, next) => {
    const file = req.file;
    const staging = path.join(ctx.dataDir, `.restore-${crypto.randomUUID()}`);
    try {
      if (!file) throw badRequest('backup file is required');
      fs.mkdirSync(staging, { recursive: true });

      const { manifestBuf, hasDb } = await extractBackupZip(file.path, staging);

      if (!manifestBuf) throw badRequest('backup is missing manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(manifestBuf.toString('utf8'));
      } catch {
        throw badRequest('backup manifest.json is not valid JSON');
      }
      if (manifest.app !== 'carmaint' || manifest.version !== 1) {
        throw badRequest('backup is not a CarMaint version 1 backup');
      }
      if (!hasDb) throw badRequest('backup is missing carmaint.db');

      const stagedDbPath = path.join(staging, 'carmaint.db');
      let check;
      try {
        check = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
      } catch {
        throw badRequest('backup carmaint.db could not be opened');
      }
      try {
        const tables = new Set(
          check
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((r) => r.name)
        );
        for (const table of BACKUP_TABLES) {
          if (!tables.has(table)) throw badRequest(`backup database is missing the ${table} table`);
        }
      } finally {
        check.close();
      }

      // --- Everything validated; live data has not been touched yet. Swap. ---
      ctx.db.close();

      const dbPath = path.join(ctx.dataDir, 'carmaint.db');
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.renameSync(stagedDbPath, dbPath);

      const livePhotos = path.join(ctx.dataDir, 'photos');
      fs.rmSync(livePhotos, { recursive: true, force: true });
      const stagedPhotos = path.join(staging, 'photos');
      if (fs.existsSync(stagedPhotos)) fs.renameSync(stagedPhotos, livePhotos);
      else fs.mkdirSync(livePhotos, { recursive: true });

      ctx.db = createDb(ctx.dataDir);
      res.status(200).json({ restored: true, counts: backupCounts(ctx.db) });
    } catch (err) {
      // If a failure occurred after we closed the live db mid-swap, reopen so the
      // server keeps serving rather than holding a dead handle.
      if (!ctx.db.open) {
        try {
          ctx.db = createDb(ctx.dataDir);
        } catch {
          /* nothing more we can safely do */
        }
      }
      next(err);
    } finally {
      if (file && file.path) {
        try {
          fs.rmSync(file.path, { force: true });
        } catch {
          /* best-effort */
        }
      }
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  // List stored backups, newest first.
  router.get('/backups', (req, res) => {
    const dir = path.join(ctx.dataDir, 'backups');
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return res.json([]);
    }
    const items = names
      .filter((n) => n.toLowerCase().endsWith('.zip'))
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
      .sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
        return a.filename < b.filename ? 1 : -1;
      });
    res.json(items);
  });

  // Download a single stored backup (basename-sanitized).
  router.get('/backups/:filename', (req, res) => {
    const base = path.basename(req.params.filename);
    const full = path.join(ctx.dataDir, 'backups', base);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      throw notFound('Backup not found');
    }
    if (!st.isFile()) throw notFound('Backup not found');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    res.setHeader('Content-Length', String(st.size));
    fs.createReadStream(full).pipe(res);
  });

  return router;
}
