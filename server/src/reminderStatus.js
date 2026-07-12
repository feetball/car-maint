import { addDays, addMonths, today } from './dates.js';
import { vehicleName } from './helpers.js';

const LAST_RECORD_SQL =
  'SELECT date, mileage FROM records WHERE vehicle_id = ? AND type = ? ORDER BY date DESC, id DESC LIMIT 1';

export async function augmentReminder(db, vehicle, reminder, todayStr = today()) {
  const last = await db.get(LAST_RECORD_SQL, [vehicle.id, reminder.type]);
  const last_date = last ? last.date : null;
  const last_mileage = last ? last.mileage ?? null : null;

  const next_due_date =
    last_date && reminder.interval_months ? addMonths(last_date, reminder.interval_months) : null;
  const next_due_mileage =
    last_mileage != null && reminder.interval_miles ? last_mileage + reminder.interval_miles : null;

  let status;
  if (!last) {
    status = 'no_history';
  } else if (
    (next_due_date !== null && next_due_date < todayStr) ||
    (next_due_mileage !== null && next_due_mileage < vehicle.current_mileage)
  ) {
    status = 'overdue';
  } else if (
    (next_due_date !== null && next_due_date <= addDays(todayStr, 30)) ||
    (next_due_mileage !== null && next_due_mileage - vehicle.current_mileage <= 500)
  ) {
    status = 'due_soon';
  } else {
    status = 'ok';
  }

  return { ...reminder, last_date, last_mileage, next_due_date, next_due_mileage, status };
}

export async function vehicleReminders(db, vehicle, todayStr = today()) {
  const rows = await db.all('SELECT * FROM reminders WHERE vehicle_id = ? ORDER BY id ASC', [
    vehicle.id,
  ]);
  const out = [];
  for (const r of rows) {
    out.push(await augmentReminder(db, vehicle, r, todayStr));
  }
  return out;
}

export async function alertCount(db, vehicle, todayStr = today()) {
  const reminders = await vehicleReminders(db, vehicle, todayStr);
  return reminders.filter((r) => r.status === 'overdue' || r.status === 'due_soon').length;
}

export async function dueReminders(db, todayStr = today()) {
  const due = [];
  const vehicles = await db.all('SELECT * FROM vehicles ORDER BY id ASC');
  for (const vehicle of vehicles) {
    for (const reminder of await vehicleReminders(db, vehicle, todayStr)) {
      if (reminder.status === 'overdue' || reminder.status === 'due_soon') {
        due.push({ ...reminder, vehicle_name: vehicleName(vehicle) });
      }
    }
  }
  due.sort((a, b) => (a.status === 'overdue' ? 0 : 1) - (b.status === 'overdue' ? 0 : 1));
  return due;
}
