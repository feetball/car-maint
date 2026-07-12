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

  // Stream a fresh consistent backup zip of the requesting user's OWN data only.
  router.get('/backup', async (req, res, next) => {
    const tmpDir = path.join(ctx.dataDir, '.backup-tmp');
    let tmpZip;
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      tmpZip = path.join(tmpDir, `${crypto.randomUUID()}.zip`);
      await createBackupZip(ctx, tmpZip, req.user.id);
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

  // Validate a backup zip fully, then import it into the REQUESTING USER's account:
  // open the extracted db read-only, write new photo files to the store, and inside
  // ONE transaction INSERT the archive's vehicle tree with fresh ids owned by
  // req.user (any user data in the archive is ignored/stripped). This is ADDITIVE —
  // it never wipes existing data, so it can't touch other users. Any failure
  // before/inside the tx leaves live data fully intact.
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

      // Write the archive's photo files to the store (UUID names). put() overwrites
      // idempotently if the same file already exists (e.g. re-importing own backup).
      for (const p of photos) {
        const src = path.join(staging, 'photos', p.filename);
        if (fs.existsSync(src)) {
          await ctx.store.put(p.filename, fs.readFileSync(src), mimeForFilename(p.filename));
        }
      }

      // One transaction: INSERT the tree with fresh ids owned by req.user, remapping
      // each child's vehicle_id from the archive id to the newly-assigned id. Archive
      // ids and any user_id are ignored. Existing data is left in place (additive).
      const me = req.user.id;
      const byVehicle = new Map(); // archive vehicle id -> its records/reminders/photos
      for (const v of vehicles) byVehicle.set(v.id, { records: [], reminders: [], photos: [] });
      for (const r of records) byVehicle.get(r.vehicle_id)?.records.push(r);
      for (const rm of reminders) byVehicle.get(rm.vehicle_id)?.reminders.push(rm);
      for (const p of photos) byVehicle.get(p.vehicle_id)?.photos.push(p);

      await ctx.db.tx(async (t) => {
        for (const v of vehicles) {
          const info = await t.run(
            `INSERT INTO vehicles
               (user_id, name, make, model, year, vin, license_plate, color, current_mileage, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              me, v.name, v.make, v.model, v.year, v.vin, v.license_plate, v.color,
              v.current_mileage, v.notes, v.created_at,
            ]
          );
          const newId = info.lastInsertRowid;
          const children = byVehicle.get(v.id);
          for (const r of children.records) {
            await t.run(
              `INSERT INTO records
                 (vehicle_id, type, description, date, mileage, cost, shop, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [newId, r.type, r.description, r.date, r.mileage, r.cost, r.shop, r.notes, r.created_at]
            );
          }
          for (const rm of children.reminders) {
            await t.run(
              `INSERT INTO reminders
                 (vehicle_id, type, description, interval_months, interval_miles, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [newId, rm.type, rm.description, rm.interval_months, rm.interval_miles, rm.created_at]
            );
          }
          for (const p of children.photos) {
            await t.run(
              `INSERT INTO photos
                 (vehicle_id, filename, original_name, is_primary, uploaded_at)
               VALUES (?, ?, ?, ?, ?)`,
              [newId, p.filename, p.original_name, p.is_primary, p.uploaded_at]
            );
          }
        }
      });

      res
        .status(200)
        .json({ restored: true, counts: await backupCounts(ctx.db, me) });
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

  // The stored backups (created by the cron/timer auto-backup) are GLOBAL whole-DB
  // snapshots — they contain every user's data, so they are NOT per-user scoped.
  // They require BOTH a valid logged-in session (req.user, set by the auth gate —
  // these routes are NOT cron paths, so unlike /api/cron/* they are never
  // machine-only) AND the CRON_SECRET bearer (admin/DR). The bearer is open when
  // CRON_SECRET is unset in dev/self-host, but fail-closed in production
  // (cronAuthorized), so a mere registered user can't read every account's data.
  function requireAdmin(req, res, next) {
    if (!req.user || !ctx.auth.cronAuthorized(req)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  }

  // List stored backups, newest first.
  router.get(
    '/backups',
    requireAdmin,
    asyncHandler(async (req, res) => {
      res.json(await listBackups(ctx));
    })
  );

  // Download a single stored backup (basename-sanitized).
  router.get(
    '/backups/:filename',
    requireAdmin,
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
