import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { HttpError, badRequest, getVehicleOr404, notFound } from '../helpers.js';

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
    (req, res, next) => {
      req.vehicle = getVehicleOr404(ctx.db, req.params.id);
      next();
    },
    upload.array('photos', 10),
    (req, res) => {
      const db = ctx.db;
      const files = req.files ?? [];
      if (files.length === 0) throw badRequest('At least one file is required');
      const existing = db
        .prepare('SELECT COUNT(*) AS n FROM photos WHERE vehicle_id = ?')
        .get(req.vehicle.id).n;

      // Write every file to disk first; if any write fails, unlink this batch's
      // already-written files and 500 so no orphan files or rows are left behind.
      const written = [];
      const planned = [];
      let isFirstEver = existing === 0;
      try {
        for (const file of files) {
          const filename = `${crypto.randomUUID()}.${EXT_BY_MIMETYPE[file.mimetype]}`;
          const full = path.join(ctx.photosDir, filename);
          fs.writeFileSync(full, file.buffer);
          written.push(full);
          planned.push({
            filename,
            original_name: file.originalname ?? null,
            is_primary: isFirstEver ? 1 : 0,
          });
          isFirstEver = false;
        }
      } catch {
        for (const p of written) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* best-effort */
          }
        }
        throw new HttpError(500, 'Failed to store uploaded files');
      }

      // Insert all rows for the batch in a single transaction.
      const insert = db.prepare(
        'INSERT INTO photos (vehicle_id, filename, original_name, is_primary) VALUES (?, ?, ?, ?)'
      );
      const ids = db.transaction(() =>
        planned.map(
          (p) => insert.run(req.vehicle.id, p.filename, p.original_name, p.is_primary).lastInsertRowid
        )
      )();
      const getPhoto = db.prepare('SELECT * FROM photos WHERE id = ?');
      res.status(201).json(ids.map((id) => getPhoto.get(id)));
    }
  );

  router.put('/photos/:id/primary', (req, res) => {
    const db = ctx.db;
    const getPhoto = db.prepare('SELECT * FROM photos WHERE id = ?');
    const photo = getPhoto.get(req.params.id);
    if (!photo) throw notFound('Photo not found');
    db.transaction(() => {
      db.prepare('UPDATE photos SET is_primary = 0 WHERE vehicle_id = ?').run(photo.vehicle_id);
      db.prepare('UPDATE photos SET is_primary = 1 WHERE id = ?').run(photo.id);
    })();
    res.json(getPhoto.get(photo.id));
  });

  router.delete('/photos/:id', (req, res) => {
    const db = ctx.db;
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!photo) throw notFound('Photo not found');
    // Commit the delete + primary promotion in ONE transaction first, then unlink
    // best-effort: a failed unlink must never 500 nor skip the promotion.
    db.transaction(() => {
      db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
      if (photo.is_primary) {
        const oldest = db
          .prepare(
            'SELECT id FROM photos WHERE vehicle_id = ? ORDER BY uploaded_at ASC, id ASC LIMIT 1'
          )
          .get(photo.vehicle_id);
        if (oldest) db.prepare('UPDATE photos SET is_primary = 1 WHERE id = ?').run(oldest.id);
      }
    })();
    try {
      fs.unlinkSync(path.join(ctx.photosDir, photo.filename));
    } catch {
      /* best-effort: file already gone or unlink failed */
    }
    res.status(204).end();
  });

  return router;
}
