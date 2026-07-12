import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { HttpError, asyncHandler, badRequest, getOwnedChildOr404, getVehicleOr404, withPhotoUrl } from '../helpers.js';

const EXT_BY_MIMETYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function photosRouter(ctx) {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 10,
      fields: 10,
      fieldSize: 1024 * 1024,
      parts: 30,
    },
    fileFilter(req, file, cb) {
      if (EXT_BY_MIMETYPE[file.mimetype]) cb(null, true);
      else cb(new HttpError(400, `Unsupported file type: ${file.mimetype}`));
    },
  });

  router.post(
    '/vehicles/:id/photos',
    asyncHandler(async (req, res, next) => {
      req.vehicle = await getVehicleOr404(ctx.db, req.params.id, req.user.id);
      next();
    }),
    upload.array('photos', 10),
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const files = req.files ?? [];
      if (files.length === 0) throw badRequest('At least one file is required');
      const existing = (
        await db.get('SELECT COUNT(*) AS n FROM photos WHERE vehicle_id = ?', [req.vehicle.id])
      ).n;

      // Write every file to the store first; if any write fails, remove this
      // batch's already-written files and 500 so no orphan files or rows remain.
      const written = [];
      const planned = [];
      let isFirstEver = existing === 0;
      try {
        for (const file of files) {
          const filename = `${crypto.randomUUID()}.${EXT_BY_MIMETYPE[file.mimetype]}`;
          await ctx.store.put(filename, file.buffer, file.mimetype);
          written.push(filename);
          planned.push({
            filename,
            original_name: file.originalname ?? null,
            is_primary: isFirstEver ? 1 : 0,
          });
          isFirstEver = false;
        }
      } catch {
        for (const filename of written) {
          await ctx.store.delete(filename);
        }
        throw new HttpError(500, 'Failed to store uploaded files');
      }

      // Insert all rows for the batch in a single transaction.
      const ids = await db.tx(async (t) => {
        const out = [];
        for (const p of planned) {
          const info = await t.run(
            'INSERT INTO photos (vehicle_id, filename, original_name, is_primary) VALUES (?, ?, ?, ?)',
            [req.vehicle.id, p.filename, p.original_name, p.is_primary]
          );
          out.push(info.lastInsertRowid);
        }
        return out;
      });

      const rows = [];
      for (const id of ids) {
        rows.push(await db.get('SELECT * FROM photos WHERE id = ?', [id]));
      }
      res.status(201).json(rows.map((p) => withPhotoUrl(ctx.store, p)));
    })
  );

  router.put(
    '/photos/:id/primary',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const photo = await getOwnedChildOr404(db, 'photos', req.params.id, req.user.id, 'Photo not found');
      await db.tx(async (t) => {
        await t.run('UPDATE photos SET is_primary = 0 WHERE vehicle_id = ?', [photo.vehicle_id]);
        await t.run('UPDATE photos SET is_primary = 1 WHERE id = ?', [photo.id]);
      });
      res.json(withPhotoUrl(ctx.store, await db.get('SELECT * FROM photos WHERE id = ?', [photo.id])));
    })
  );

  router.delete(
    '/photos/:id',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const photo = await getOwnedChildOr404(db, 'photos', req.params.id, req.user.id, 'Photo not found');
      // Commit the delete + primary promotion in ONE transaction first, then remove
      // the file best-effort: a failed delete must never 500 nor skip the promotion.
      await db.tx(async (t) => {
        await t.run('DELETE FROM photos WHERE id = ?', [photo.id]);
        if (photo.is_primary) {
          const oldest = await t.get(
            'SELECT id FROM photos WHERE vehicle_id = ? ORDER BY uploaded_at ASC, id ASC LIMIT 1',
            [photo.vehicle_id]
          );
          if (oldest) await t.run('UPDATE photos SET is_primary = 1 WHERE id = ?', [oldest.id]);
        }
      });
      await ctx.store.delete(photo.filename);
      res.status(204).end();
    })
  );

  return router;
}
