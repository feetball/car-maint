import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import { HttpError, asyncHandler, badRequest, notFound } from '../helpers.js';
import {
  BACKUP_TABLES,
  backupCounts,
  createBackupZip,
  extractBackupZip,
  listBackups,
  mimeForFilename,
} from '../backup.js';

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
      await createBackupZip(ctx, tmpZip);
      const size = fs.statSync(tmpZip).size;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="carmaint-backup-${isoDate()}.zip"`);
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

  // Validate a backup zip fully, then import it at the data level (v3): open the
  // extracted db read-only, write new photo files to the store, and inside ONE
  // transaction wipe children-first and re-insert every row preserving ids. Any
  // failure before/inside the tx leaves live data fully intact.
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

      // Open the extracted db READ-ONLY via better-sqlite3 and pull all rows.
      const stagedDbPath = path.join(staging, 'carmaint.db');
      let staged;
      try {
        staged = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
      } catch {
        throw badRequest('backup carmaint.db could not be opened');
      }
      let vehicles, records, reminders, photos;
      try {
        const tables = new Set(
          staged
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((r) => r.name)
        );
        for (const table of BACKUP_TABLES) {
          if (!tables.has(table)) throw badRequest(`backup database is missing the ${table} table`);
        }
        vehicles = staged.prepare('SELECT * FROM vehicles').all();
        records = staged.prepare('SELECT * FROM records').all();
        reminders = staged.prepare('SELECT * FROM reminders').all();
        photos = staged.prepare('SELECT * FROM photos').all();
      } finally {
        staged.close();
      }

      // --- Everything validated; live data has not been touched yet. ---

      // Write all new photo files to the store first (UUID names can't collide
      // with live files), tracking which old files become orphaned.
      const oldFiles = await ctx.store.list();
      const newFilenames = new Set(photos.map((p) => p.filename));
      for (const p of photos) {
        const src = path.join(staging, 'photos', p.filename);
        if (fs.existsSync(src)) {
          await ctx.store.put(p.filename, fs.readFileSync(src), mimeForFilename(p.filename));
        }
      }

      // One transaction: wipe children-first, re-insert preserving ids.
      await ctx.db.tx(async (t) => {
        await t.run('DELETE FROM photos');
        await t.run('DELETE FROM records');
        await t.run('DELETE FROM reminders');
        await t.run('DELETE FROM vehicles');
        for (const v of vehicles) {
          await t.run(
            `INSERT INTO vehicles
               (id, name, make, model, year, vin, license_plate, color, current_mileage, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              v.id, v.name, v.make, v.model, v.year, v.vin, v.license_plate, v.color,
              v.current_mileage, v.notes, v.created_at,
            ]
          );
        }
        for (const r of records) {
          await t.run(
            `INSERT INTO records
               (id, vehicle_id, type, description, date, mileage, cost, shop, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.id, r.vehicle_id, r.type, r.description, r.date, r.mileage, r.cost, r.shop, r.notes, r.created_at]
          );
        }
        for (const rm of reminders) {
          await t.run(
            `INSERT INTO reminders
               (id, vehicle_id, type, description, interval_months, interval_miles, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [rm.id, rm.vehicle_id, rm.type, rm.description, rm.interval_months, rm.interval_miles, rm.created_at]
          );
        }
        for (const p of photos) {
          await t.run(
            `INSERT INTO photos
               (id, vehicle_id, filename, original_name, is_primary, uploaded_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [p.id, p.vehicle_id, p.filename, p.original_name, p.is_primary, p.uploaded_at]
          );
        }
      });

      // Best-effort: remove old photo files no longer referenced by the import.
      for (const f of oldFiles) {
        if (!newFilenames.has(f)) await ctx.store.delete(f);
      }

      res.status(200).json({ restored: true, counts: await backupCounts(ctx.db) });
    } catch (err) {
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
  router.get(
    '/backups',
    asyncHandler(async (req, res) => {
      res.json(await listBackups(ctx));
    })
  );

  // Download a single stored backup (basename-sanitized).
  router.get(
    '/backups/:filename',
    asyncHandler(async (req, res) => {
      const base = path.basename(req.params.filename);

      if (ctx.store.kind === 'blob') {
        // Confirm it exists, then redirect to the public blob URL.
        const items = await listBackups(ctx);
        if (!items.some((b) => b.filename === base)) throw notFound('Backup not found');
        return res.redirect(`${ctx.store.base}/backups/${base}`);
      }

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
    })
  );

  return router;
}
