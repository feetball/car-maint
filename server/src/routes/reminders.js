import { Router } from 'express';
import { asyncHandler, badRequest, getVehicleOr404, notFound } from '../helpers.js';
import { SERVICE_TYPE_VALUES } from '../serviceTypes.js';
import { dueReminders, vehicleReminders } from '../reminderStatus.js';

// Upper bounds guard the reminder date/mileage math: an unbounded interval_months
// overflows JS Date arithmetic and 500s every reminder-status endpoint.
const INTERVAL_LIMITS = {
  interval_months: 1200,
  interval_miles: 1000000,
};

function validateReminder(body, partial) {
  const out = {};
  if (!partial || 'type' in body) {
    if (!SERVICE_TYPE_VALUES.has(body.type)) throw badRequest('type must be a valid service type');
    out.type = body.type;
  }
  if ('description' in body) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw badRequest('description must be a string');
    }
    out.description = body.description;
  }
  for (const [field, max] of Object.entries(INTERVAL_LIMITS)) {
    if (field in body) {
      const value = body[field];
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > max)) {
        throw badRequest(`${field} must be an integer between 1 and ${max}`);
      }
      out[field] = value;
    }
  }
  return out;
}

export function remindersRouter(ctx) {
  const router = Router();

  router.get(
    '/reminders/due',
    asyncHandler(async (req, res) => {
      res.json(await dueReminders(ctx.db));
    })
  );

  router.get(
    '/vehicles/:id/reminders',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const vehicle = await getVehicleOr404(db, req.params.id);
      res.json(await vehicleReminders(db, vehicle));
    })
  );

  router.post(
    '/vehicles/:id/reminders',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const vehicle = await getVehicleOr404(db, req.params.id);
      const data = validateReminder(req.body ?? {}, false);
      if (data.interval_months == null && data.interval_miles == null) {
        throw badRequest('at least one of interval_months or interval_miles is required');
      }
      const info = await db.run(
        `INSERT INTO reminders (vehicle_id, type, description, interval_months, interval_miles)
         VALUES (?, ?, ?, ?, ?)`,
        [
          vehicle.id,
          data.type,
          data.description ?? null,
          data.interval_months ?? null,
          data.interval_miles ?? null,
        ]
      );
      res
        .status(201)
        .json(await db.get('SELECT * FROM reminders WHERE id = ?', [info.lastInsertRowid]));
    })
  );

  router.put(
    '/reminders/:id',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const reminder = await db.get('SELECT * FROM reminders WHERE id = ?', [req.params.id]);
      if (!reminder) throw notFound('Reminder not found');
      const data = validateReminder(req.body ?? {}, true);
      const months = 'interval_months' in data ? data.interval_months : reminder.interval_months;
      const miles = 'interval_miles' in data ? data.interval_miles : reminder.interval_miles;
      if (months == null && miles == null) {
        throw badRequest('at least one of interval_months or interval_miles is required');
      }
      const keys = Object.keys(data);
      if (keys.length > 0) {
        const set = keys.map((k) => `${k} = ?`).join(', ');
        await db.run(`UPDATE reminders SET ${set} WHERE id = ?`, [
          ...keys.map((k) => data[k]),
          reminder.id,
        ]);
      }
      res.json(await db.get('SELECT * FROM reminders WHERE id = ?', [reminder.id]));
    })
  );

  router.delete(
    '/reminders/:id',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const reminder = await db.get('SELECT * FROM reminders WHERE id = ?', [req.params.id]);
      if (!reminder) throw notFound('Reminder not found');
      await db.run('DELETE FROM reminders WHERE id = ?', [reminder.id]);
      res.status(204).end();
    })
  );

  return router;
}
