import { Router } from 'express';
import { csvField, getVehicleOr404, vehicleName } from '../helpers.js';
import { SERVICE_TYPES, labelFor } from '../serviceTypes.js';
import { dueReminders } from '../reminderStatus.js';

const CSV_COLUMNS = ['date', 'type', 'mileage', 'cost', 'shop', 'description', 'notes'];

export function miscRouter(ctx) {
  const router = Router();

  router.get('/service-types', (req, res) => {
    res.json(SERVICE_TYPES);
  });

  router.get('/vehicles/:id/stats', (req, res) => {
    const db = ctx.db;
    const vehicle = getVehicleOr404(db, req.params.id);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS record_count, COALESCE(SUM(COALESCE(cost, 0)), 0) AS total_cost
         FROM records WHERE vehicle_id = ?`
      )
      .get(vehicle.id);
    const costByType = db
      .prepare(
        `SELECT type, COALESCE(SUM(COALESCE(cost, 0)), 0) AS total, COUNT(*) AS count
         FROM records WHERE vehicle_id = ? GROUP BY type ORDER BY total DESC`
      )
      .all(vehicle.id)
      .map((row) => ({ type: row.type, label: labelFor(row.type), total: row.total, count: row.count }));
    const costByYear = db
      .prepare(
        `SELECT CAST(substr(date, 1, 4) AS INTEGER) AS year, COALESCE(SUM(COALESCE(cost, 0)), 0) AS total
         FROM records WHERE vehicle_id = ? GROUP BY year ORDER BY year ASC`
      )
      .all(vehicle.id);
    res.json({
      total_cost: totals.total_cost,
      record_count: totals.record_count,
      cost_by_type: costByType,
      cost_by_year: costByYear,
    });
  });

  router.get('/dashboard', (req, res) => {
    const db = ctx.db;
    const { vehicle_count } = db.prepare('SELECT COUNT(*) AS vehicle_count FROM vehicles').get();
    const totals = db
      .prepare(
        'SELECT COUNT(*) AS record_count, COALESCE(SUM(COALESCE(cost, 0)), 0) AS total_cost FROM records'
      )
      .get();
    const recent = db
      .prepare(
        `SELECT r.*, v.name AS v_name, v.year AS v_year, v.make AS v_make, v.model AS v_model
         FROM records r JOIN vehicles v ON v.id = r.vehicle_id
         ORDER BY r.date DESC, r.id DESC LIMIT 10`
      )
      .all()
      .map(({ v_name, v_year, v_make, v_model, ...record }) => ({
        ...record,
        vehicle_name: vehicleName({ name: v_name, year: v_year, make: v_make, model: v_model }),
      }));
    res.json({
      vehicle_count,
      record_count: totals.record_count,
      total_cost: totals.total_cost,
      due_reminders: dueReminders(db),
      recent_records: recent,
    });
  });

  router.get('/vehicles/:id/export.csv', (req, res) => {
    const db = ctx.db;
    const vehicle = getVehicleOr404(db, req.params.id);
    const records = db
      .prepare('SELECT * FROM records WHERE vehicle_id = ? ORDER BY date ASC, id ASC')
      .all(vehicle.id);
    const lines = [CSV_COLUMNS.join(',')];
    for (const record of records) {
      lines.push(CSV_COLUMNS.map((col) => csvField(record[col])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="vehicle-${vehicle.id}-records.csv"`);
    res.send(lines.join('\n') + '\n');
  });

  return router;
}
