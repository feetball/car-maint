import { Router } from 'express';
import { csvField, vehicleName } from '../helpers.js';

const CSV_HEADER = ['vehicle', 'date', 'type', 'mileage', 'cost', 'shop', 'description', 'notes'];

export function exportRouter(ctx) {
  const router = Router();

  // All-vehicle CSV, rows date ASC then id ASC.
  router.get('/export.csv', (req, res) => {
    const db = ctx.db;
    const rows = db
      .prepare(
        `SELECT r.date, r.type, r.mileage, r.cost, r.shop, r.description, r.notes,
                v.name AS v_name, v.year AS v_year, v.make AS v_make, v.model AS v_model
         FROM records r JOIN vehicles v ON v.id = r.vehicle_id
         ORDER BY r.date ASC, r.id ASC`
      )
      .all();
    const lines = [CSV_HEADER.join(',')];
    for (const row of rows) {
      const vehicle = vehicleName({
        name: row.v_name,
        year: row.v_year,
        make: row.v_make,
        model: row.v_model,
      });
      lines.push(
        [vehicle, row.date, row.type, row.mileage, row.cost, row.shop, row.description, row.notes]
          .map(csvField)
          .join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="carmaint-records.csv"');
    res.send(lines.join('\n') + '\n');
  });

  // Full JSON bundle: vehicles with nested records (date ASC), reminders, photo metadata.
  router.get('/export.json', (req, res) => {
    const db = ctx.db;
    const vehicles = db
      .prepare('SELECT * FROM vehicles ORDER BY created_at DESC, id DESC')
      .all();
    const recordsStmt = db.prepare(
      'SELECT * FROM records WHERE vehicle_id = ? ORDER BY date ASC, id ASC'
    );
    const remindersStmt = db.prepare(
      'SELECT * FROM reminders WHERE vehicle_id = ? ORDER BY id ASC'
    );
    const photosStmt = db.prepare(
      `SELECT filename, original_name, is_primary FROM photos WHERE vehicle_id = ?
       ORDER BY is_primary DESC, uploaded_at ASC, id ASC`
    );

    const payload = {
      app: 'carmaint',
      version: 1,
      exported_at: new Date().toISOString(),
      vehicles: vehicles.map((vehicle) => ({
        ...vehicle,
        records: recordsStmt.all(vehicle.id),
        reminders: remindersStmt.all(vehicle.id),
        photos: photosStmt.all(vehicle.id),
      })),
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="carmaint-export.json"');
    res.send(JSON.stringify(payload));
  });

  return router;
}
