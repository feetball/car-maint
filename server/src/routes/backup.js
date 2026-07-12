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
  runAutoBackup,
} from '../backup.js';

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Same keep-count the index.js auto-backup timer and the cron route use.
function autoBackupKeep() {
  const n = Number.parseInt(process.env.AUTO_BACKUP_KEEP ?? '14', 10);
  return Number.isFinite(n) ? n : 14;
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
  // Access is granted to EITHER:
  //   (a) an ADMIN session (is_admin cookie) — the backup UI path, added with roles; or
  //   (b) a valid CRON_SECRET bearer — cron/DR tooling (machine access, no cookie).
  // A bearer-only request has no cookie, so the global auth gate special-cases these
  // /api/backups paths to let a valid bearer through without a session (see auth.js).
  // A mere NON-admin logged-in user is refused (403). Note the earlier "session AND
  // bearer" contract is intentionally replaced by "admin session OR bearer": the
  // original goal — a random registered user must not read every account — still holds,
  // now enforced by is_admin instead of by also demanding the bearer.
  function requireAdminOrBearer(req, res, next) {
    if (req.user?.is_admin) return next();
    if (ctx.auth.bearerPresentAndValid(req)) return next();
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    return res.status(403).json({ error: 'Admin access required' });
  }

  // List stored backups, newest first.
  router.get(
    '/backups',
    requireAdminOrBearer,
    asyncHandler(async (req, res) => {
      res.json(await listBackups(ctx));
    })
  );

  // Trigger a fresh GLOBAL whole-DB backup on demand (same path the cron/timer uses),
  // then prune to AUTO_BACKUP_KEEP. Admin-session or bearer only.
  router.post(
    '/backups',
    requireAdminOrBearer,
    asyncHandler(async (req, res) => {
      const filename = await runAutoBackup(ctx, autoBackupKeep());
      res.status(201).json({ ok: true, filename });
    })
  );

  // DANGEROUS: restore a GLOBAL whole-DB backup — this REPLACES every account and its
  // data with the snapshot's contents (distinct from the additive per-user /api/restore
  // above). Admin-session or bearer only. To avoid catastrophically wiping all users
  // when a per-user backup (whose snapshot carries no users) is uploaded here, the
  // snapshot MUST contain at least one user row or the request is rejected 400.
  router.post(
    '/backups/restore',
    requireAdminOrBearer,
    uploadRestore.single('backup'),
    async (req, res, next) => {
      const file = req.file;
      const staging = path.join(ctx.dataDir, `.grestore-${crypto.randomUUID()}`);
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
        let staged;
        try {
          staged = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
        } catch {
          throw badRequest('backup carmaint.db could not be opened');
        }
        let users, vehicles, records, reminders, photos, recalls;
        let mfaTotp, mfaBackup, mfaEmail, webauthnCreds;
        try {
          const tables = new Set(
            staged
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
              .all()
              .map((r) => r.name)
          );
          for (const table of ['users', ...BACKUP_TABLES]) {
            if (!tables.has(table)) throw badRequest(`backup database is missing the ${table} table`);
          }
          users = staged.prepare('SELECT * FROM users').all();
          if (users.length === 0) {
            throw badRequest('backup is not a global backup (no users) — use /api/restore instead');
          }
          vehicles = staged.prepare('SELECT * FROM vehicles').all();
          records = staged.prepare('SELECT * FROM records').all();
          reminders = staged.prepare('SELECT * FROM reminders').all();
          photos = staged.prepare('SELECT * FROM photos').all();
          recalls = tables.has('recalls_cache')
            ? staged.prepare('SELECT * FROM recalls_cache').all()
            : [];
          // Durable MFA enrollment, when present (older snapshots may predate MFA —
          // tolerate their absence so restoring a pre-MFA backup still works; those
          // users simply land in the setup-required state on next login).
          mfaTotp = tables.has('mfa_totp') ? staged.prepare('SELECT * FROM mfa_totp').all() : [];
          mfaBackup = tables.has('mfa_backup_codes')
            ? staged.prepare('SELECT * FROM mfa_backup_codes').all()
            : [];
          mfaEmail = tables.has('mfa_email') ? staged.prepare('SELECT * FROM mfa_email').all() : [];
          // WebAuthn passkeys, when present (older snapshots predate them — tolerate
          // absence so restoring a pre-WebAuthn backup still works).
          webauthnCreds = tables.has('webauthn_credentials')
            ? staged.prepare('SELECT * FROM webauthn_credentials').all()
            : [];
        } finally {
          staged.close();
        }

        // --- Everything validated; live data has not been touched yet. ---

        for (const p of photos) {
          const src = path.join(staging, 'photos', p.filename);
          if (fs.existsSync(src)) {
            await ctx.store.put(p.filename, fs.readFileSync(src), mimeForFilename(p.filename));
          }
        }

        // One transaction: wipe every table (children before parents so FK-on drivers
        // stay happy) then reload with ORIGINAL ids/ownership preserved. Sessions are
        // dropped entirely — restored user ids may differ from live ones, so all live
        // cookies (including the admin's own) are invalidated and everyone re-logs in.
        await ctx.db.tx(async (t) => {
          await t.run('DELETE FROM sessions');
          // MFA rows are children of users; delete them explicitly (child-before-parent)
          // so the wipe is identical whether or not the driver enforces FK cascade.
          // mfa_challenges (ephemeral pending tokens) is cleared but never reloaded.
          await t.run('DELETE FROM mfa_challenges');
          await t.run('DELETE FROM mfa_backup_codes');
          await t.run('DELETE FROM mfa_email');
          await t.run('DELETE FROM mfa_totp');
          await t.run('DELETE FROM webauthn_credentials');
          await t.run('DELETE FROM photos');
          await t.run('DELETE FROM records');
          await t.run('DELETE FROM reminders');
          await t.run('DELETE FROM recalls_cache');
          await t.run('DELETE FROM vehicles');
          await t.run('DELETE FROM users');

          for (const u of users) {
            await t.run(
              `INSERT INTO users (id, username, password_hash, calendar_token, is_admin, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [u.id, u.username, u.password_hash, u.calendar_token, u.is_admin ?? 0, u.created_at]
            );
          }
          for (const v of vehicles) {
            await t.run(
              `INSERT INTO vehicles
                 (id, user_id, name, make, model, year, vin, license_plate, color, current_mileage, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                v.id, v.user_id, v.name, v.make, v.model, v.year, v.vin, v.license_plate,
                v.color, v.current_mileage, v.notes, v.created_at,
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
          for (const rc of recalls) {
            await t.run(
              'INSERT INTO recalls_cache (vehicle_id, fetched_at, payload) VALUES (?, ?, ?)',
              [rc.vehicle_id, rc.fetched_at, rc.payload]
            );
          }
          // MFA enrollment, reloaded with original ids/ownership so second factors
          // survive a whole-DB restore (users were re-inserted with their original ids).
          for (const m of mfaTotp) {
            await t.run(
              'INSERT INTO mfa_totp (user_id, secret, pending_secret, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?)',
              [m.user_id, m.secret, m.pending_secret, m.confirmed_at, m.created_at]
            );
          }
          for (const m of mfaBackup) {
            await t.run(
              'INSERT INTO mfa_backup_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, ?, ?)',
              [m.id, m.user_id, m.code_hash, m.used_at, m.created_at]
            );
          }
          for (const m of mfaEmail) {
            await t.run(
              'INSERT INTO mfa_email (user_id, email, code_hash, code_expires_at, attempts, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [m.user_id, m.email, m.code_hash, m.code_expires_at, m.attempts, m.confirmed_at, m.created_at]
            );
          }
          // WebAuthn credentials, reloaded with original ids/ownership so passkeys
          // survive a whole-DB restore (users were re-inserted with their original ids).
          for (const c of webauthnCreds) {
            await t.run(
              'INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [c.id, c.user_id, c.credential_id, c.public_key, c.counter, c.transports, c.name, c.created_at, c.last_used_at]
            );
          }
        });

        // The DB now holds ONLY the snapshot's photo rows, but the store still holds
        // every previously-written photo file/blob. Prune the files/blobs the restored
        // DB no longer references, or they orphan forever (a storage/cost leak, notably
        // on Vercel Blob). Best-effort: a store error here must never fail the restore,
        // which has already committed — log and continue.
        try {
          const keep = new Set(photos.map((p) => p.filename));
          const stored = await ctx.store.list();
          for (const name of stored) {
            if (keep.has(name)) continue;
            try {
              await ctx.store.delete(name);
            } catch (delErr) {
              console.error('global restore: failed to delete orphaned photo', name, delErr);
            }
          }
        } catch (listErr) {
          console.error('global restore: photo cleanup skipped (store list failed)', listErr);
        }

        res.status(200).json({ restored: true, scope: 'global', counts: await backupCounts(ctx.db) });
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
    }
  );

  // Download a single stored backup (basename-sanitized).
  router.get(
    '/backups/:filename',
    requireAdminOrBearer,
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
