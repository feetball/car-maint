import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { badRequest, getVehicleOr404, isNonEmptyString } from '../helpers.js';
import { alertCount } from '../reminderStatus.js';
import { today } from '../dates.js';

const OPTIONAL_TEXT_FIELDS = ['name', 'vin', 'license_plate', 'color', 'notes'];

function validateVehicle(body, partial) {
  const out = {};
  if (!partial || 'make' in body) {
    if (!isNonEmptyString(body.make)) throw badRequest('make must be a non-empty string');
    out.make = body.make;
  }
  if (!partial || 'model' in body) {
    if (!isNonEmptyString(body.model)) throw badRequest('model must be a non-empty string');
    out.model = body.model;
  }
  if (!partial || 'year' in body) {
    if (!Number.isInteger(body.year) || body.year < 1900 || body.year > 2100) {
      throw badRequest('year must be an integer between 1900 and 2100');
    }
    out.year = body.year;
  }
  if ('current_mileage' in body) {
    if (!Number.isInteger(body.current_mileage) || body.current_mileage < 0) {
      throw badRequest('current_mileage must be a non-negative integer');
    }
    out.current_mileage = body.current_mileage;
  }
  for (const field of OPTIONAL_TEXT_FIELDS) {
    if (field in body) {
      if (body[field] !== null && typeof body[field] !== 'string') {
        throw badRequest(`${field} must be a string`);
      }
      out[field] = body[field];
    }
  }
  return out;
}

export function vehiclesRouter(ctx) {
  const router = Router();

  router.get('/vehicles', (req, res) => {
    const db = ctx.db;
    const rows = db
      .prepare(
        `SELECT v.*,
          (SELECT p.filename FROM photos p WHERE p.vehicle_id = v.id
             ORDER BY p.is_primary DESC, p.uploaded_at ASC, p.id ASC LIMIT 1) AS primary_photo,
          (SELECT COUNT(*) FROM photos p WHERE p.vehicle_id = v.id) AS photo_count,
          (SELECT COUNT(*) FROM records r WHERE r.vehicle_id = v.id) AS record_count,
          (SELECT COALESCE(SUM(COALESCE(r.cost, 0)), 0) FROM records r WHERE r.vehicle_id = v.id) AS total_cost,
          (SELECT MAX(r.date) FROM records r WHERE r.vehicle_id = v.id) AS last_service_date
        FROM vehicles v
        ORDER BY v.created_at DESC, v.id DESC`
      )
      .all();
    const todayStr = today();
    res.json(rows.map((v) => ({ ...v, alert_count: alertCount(db, v, todayStr) })));
  });

  router.post('/vehicles', (req, res) => {
    const db = ctx.db;
    const data = validateVehicle(req.body ?? {}, false);
    const info = db
      .prepare(
        `INSERT INTO vehicles (name, make, model, year, vin, license_plate, color, current_mileage, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.name ?? null,
        data.make,
        data.model,
        data.year,
        data.vin ?? null,
        data.license_plate ?? null,
        data.color ?? null,
        data.current_mileage ?? 0,
        data.notes ?? null
      );
    res.status(201).json(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(info.lastInsertRowid));
  });

  router.get('/vehicles/:id', (req, res) => {
    const db = ctx.db;
    const vehicle = getVehicleOr404(db, req.params.id);
    const photos = db
      .prepare(
        'SELECT * FROM photos WHERE vehicle_id = ? ORDER BY is_primary DESC, uploaded_at ASC, id ASC'
      )
      .all(vehicle.id);
    res.json({ ...vehicle, photos });
  });

  router.put('/vehicles/:id', (req, res) => {
    const db = ctx.db;
    const vehicle = getVehicleOr404(db, req.params.id);
    const data = validateVehicle(req.body ?? {}, true);
    const keys = Object.keys(data);
    if (keys.length > 0) {
      const set = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE vehicles SET ${set} WHERE id = ?`).run(
        ...keys.map((k) => data[k]),
        vehicle.id
      );
    }
    res.json(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicle.id));
  });

  router.delete('/vehicles/:id', (req, res) => {
    const db = ctx.db;
    const vehicle = getVehicleOr404(db, req.params.id);
    const photos = db.prepare('SELECT filename FROM photos WHERE vehicle_id = ?').all(vehicle.id);
    // Commit the DB mutation (cascades to photo/record/reminder rows) first, then
    // remove files best-effort. A failed unlink must never 500 after the row is gone.
    db.transaction(() => {
      db.prepare('DELETE FROM vehicles WHERE id = ?').run(vehicle.id);
    })();
    for (const photo of photos) {
      try {
        fs.unlinkSync(path.join(ctx.photosDir, photo.filename));
      } catch {
        /* best-effort: file already gone or unlink failed */
      }
    }
    res.status(204).end();
  });

  return router;
}
