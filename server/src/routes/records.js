import { Router } from 'express';
import { badRequest, getVehicleOr404, notFound } from '../helpers.js';
import { isValidDateString } from '../dates.js';
import { SERVICE_TYPE_VALUES } from '../serviceTypes.js';

const OPTIONAL_TEXT_FIELDS = ['description', 'shop', 'notes'];

function validateRecord(body, partial) {
  const out = {};
  if (!partial || 'type' in body) {
    if (!SERVICE_TYPE_VALUES.has(body.type)) throw badRequest('type must be a valid service type');
    out.type = body.type;
  }
  if (!partial || 'date' in body) {
    if (!isValidDateString(body.date)) {
      throw badRequest('date must be a valid YYYY-MM-DD calendar date');
    }
    out.date = body.date;
  }
  if ('mileage' in body) {
    if (body.mileage !== null && (!Number.isInteger(body.mileage) || body.mileage < 0)) {
      throw badRequest('mileage must be a non-negative integer');
    }
    out.mileage = body.mileage;
  }
  if ('cost' in body) {
    if (
      body.cost !== null &&
      (typeof body.cost !== 'number' || !Number.isFinite(body.cost) || body.cost < 0)
    ) {
      throw badRequest('cost must be a non-negative number');
    }
    out.cost = body.cost;
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

const BUMP_MILEAGE_SQL =
  'UPDATE vehicles SET current_mileage = ? WHERE id = ? AND current_mileage < ?';

export function recordsRouter(ctx) {
  const router = Router();

  router.get('/vehicles/:id/records', (req, res) => {
    const db = ctx.db;
    const vehicle = getVehicleOr404(db, req.params.id);
    const type = typeof req.query.type === 'string' && req.query.type !== '' ? req.query.type : null;
    const rows = type
      ? db
          .prepare(
            'SELECT * FROM records WHERE vehicle_id = ? AND type = ? ORDER BY date DESC, id DESC'
          )
          .all(vehicle.id, type)
      : db
          .prepare('SELECT * FROM records WHERE vehicle_id = ? ORDER BY date DESC, id DESC')
          .all(vehicle.id);
    res.json(rows);
  });

  router.post('/vehicles/:id/records', (req, res) => {
    const db = ctx.db;
    const vehicle = getVehicleOr404(db, req.params.id);
    const data = validateRecord(req.body ?? {}, false);
    const info = db
      .prepare(
        `INSERT INTO records (vehicle_id, type, description, date, mileage, cost, shop, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        vehicle.id,
        data.type,
        data.description ?? null,
        data.date,
        data.mileage ?? null,
        data.cost ?? null,
        data.shop ?? null,
        data.notes ?? null
      );
    if (data.mileage != null) db.prepare(BUMP_MILEAGE_SQL).run(data.mileage, vehicle.id, data.mileage);
    res.status(201).json(db.prepare('SELECT * FROM records WHERE id = ?').get(info.lastInsertRowid));
  });

  router.put('/records/:id', (req, res) => {
    const db = ctx.db;
    const getRecord = db.prepare('SELECT * FROM records WHERE id = ?');
    const record = getRecord.get(req.params.id);
    if (!record) throw notFound('Record not found');
    const data = validateRecord(req.body ?? {}, true);
    const keys = Object.keys(data);
    if (keys.length > 0) {
      const set = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE records SET ${set} WHERE id = ?`).run(
        ...keys.map((k) => data[k]),
        record.id
      );
    }
    const updated = getRecord.get(record.id);
    if (updated.mileage != null) {
      db.prepare(BUMP_MILEAGE_SQL).run(updated.mileage, updated.vehicle_id, updated.mileage);
    }
    res.json(updated);
  });

  router.delete('/records/:id', (req, res) => {
    const db = ctx.db;
    const record = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!record) throw notFound('Record not found');
    db.prepare('DELETE FROM records WHERE id = ?').run(record.id);
    res.status(204).end();
  });

  return router;
}
