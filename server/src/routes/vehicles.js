import { Router } from 'express';
import { asyncHandler, badRequest, getVehicleOr404, isNonEmptyString, withPhotoUrl } from '../helpers.js';
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

  router.get(
    '/vehicles',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const rows = await db.all(
        `SELECT v.*,
          (SELECT p.filename FROM photos p WHERE p.vehicle_id = v.id
             ORDER BY p.is_primary DESC, p.uploaded_at ASC, p.id ASC LIMIT 1) AS primary_photo,
          (SELECT COUNT(*) FROM photos p WHERE p.vehicle_id = v.id) AS photo_count,
          (SELECT COUNT(*) FROM records r WHERE r.vehicle_id = v.id) AS record_count,
          (SELECT COALESCE(SUM(COALESCE(r.cost, 0)), 0) FROM records r WHERE r.vehicle_id = v.id) AS total_cost,
          (SELECT MAX(r.date) FROM records r WHERE r.vehicle_id = v.id) AS last_service_date
        FROM vehicles v
        ORDER BY v.created_at DESC, v.id DESC`
      );
      const todayStr = today();
      const out = [];
      for (const v of rows) {
        out.push({
          ...v,
          primary_photo_url: v.primary_photo ? ctx.store.urlFor(v.primary_photo) : null,
          alert_count: await alertCount(db, v, todayStr),
        });
      }
      res.json(out);
    })
  );

  router.post(
    '/vehicles',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const data = validateVehicle(req.body ?? {}, false);
      const info = await db.run(
        `INSERT INTO vehicles (name, make, model, year, vin, license_plate, color, current_mileage, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.name ?? null,
          data.make,
          data.model,
          data.year,
          data.vin ?? null,
          data.license_plate ?? null,
          data.color ?? null,
          data.current_mileage ?? 0,
          data.notes ?? null,
        ]
      );
      res
        .status(201)
        .json(await db.get('SELECT * FROM vehicles WHERE id = ?', [info.lastInsertRowid]));
    })
  );

  router.get(
    '/vehicles/:id',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const vehicle = await getVehicleOr404(db, req.params.id);
      const photos = await db.all(
        'SELECT * FROM photos WHERE vehicle_id = ? ORDER BY is_primary DESC, uploaded_at ASC, id ASC',
        [vehicle.id]
      );
      res.json({ ...vehicle, photos: photos.map((p) => withPhotoUrl(ctx.store, p)) });
    })
  );

  router.put(
    '/vehicles/:id',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const vehicle = await getVehicleOr404(db, req.params.id);
      const data = validateVehicle(req.body ?? {}, true);
      const keys = Object.keys(data);
      if (keys.length > 0) {
        const set = keys.map((k) => `${k} = ?`).join(', ');
        await db.run(`UPDATE vehicles SET ${set} WHERE id = ?`, [
          ...keys.map((k) => data[k]),
          vehicle.id,
        ]);
      }
      res.json(await db.get('SELECT * FROM vehicles WHERE id = ?', [vehicle.id]));
    })
  );

  router.delete(
    '/vehicles/:id',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const vehicle = await getVehicleOr404(db, req.params.id);
      const photos = await db.all('SELECT filename FROM photos WHERE vehicle_id = ?', [vehicle.id]);
      // Delete children then the parent explicitly (not via FK cascade) so the
      // behavior is identical under both drivers regardless of FK enforcement.
      // Commit the DB mutation first, then remove files best-effort: a failed
      // delete must never 500 after the rows are gone.
      await db.tx(async (t) => {
        await t.run('DELETE FROM photos WHERE vehicle_id = ?', [vehicle.id]);
        await t.run('DELETE FROM records WHERE vehicle_id = ?', [vehicle.id]);
        await t.run('DELETE FROM reminders WHERE vehicle_id = ?', [vehicle.id]);
        await t.run('DELETE FROM vehicles WHERE id = ?', [vehicle.id]);
      });
      for (const photo of photos) {
        await ctx.store.delete(photo.filename);
      }
      res.status(204).end();
    })
  );

  return router;
}
