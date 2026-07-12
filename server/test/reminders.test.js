import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, makeVehicle, addRecord, addReminder, today, addMonths, addDays } from './helpers.js';

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function getReminders(vehicleId) {
  const res = await request(app).get(`/api/vehicles/${vehicleId}/reminders`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('POST /api/vehicles/:id/reminders validation', () => {
  it('rejects an invalid service type', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/reminders`)
      .send({ type: 'nonsense', interval_months: 6 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects when neither interval is given', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/reminders`)
      .send({ type: 'oil_change' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects interval_months below 1 with no other interval', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/reminders`)
      .send({ type: 'oil_change', interval_months: 0 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects interval_months above the 1200 upper bound', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/reminders`)
      .send({ type: 'oil_change', interval_months: 100000 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('creates a reminder with 201', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/reminders`)
      .send({ type: 'oil_change', interval_months: 6, interval_miles: 5000, description: 'synthetic' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      vehicle_id: v.id,
      type: 'oil_change',
      interval_months: 6,
      interval_miles: 5000,
      description: 'synthetic',
    });
    expect(res.body.id).toBeTruthy();
  });
});

describe('status branches', () => {
  it('no_history when no matching record exists', async () => {
    const v = await makeVehicle(app);
    await addReminder(app, v.id, { interval_months: 6 });
    // a record of a DIFFERENT type must not count as history
    await addRecord(app, v.id, { type: 'brake_service', date: today() });

    const [r] = await getReminders(v.id);
    expect(r.status).toBe('no_history');
    expect(r.last_date).toBeNull();
    expect(r.last_mileage).toBeNull();
    expect(r.next_due_date).toBeNull();
    expect(r.next_due_mileage).toBeNull();
  });

  it('ok when serviced today with a 6-month interval', async () => {
    const t = today();
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: t });
    await addReminder(app, v.id, { interval_months: 6 });

    const [r] = await getReminders(v.id);
    expect(r.status).toBe('ok');
    expect(r.last_date).toBe(t);
    expect(r.next_due_date).toBe(addMonths(t, 6));
  });

  it('due_soon by date when next due lands ~10 days from now', async () => {
    // record date such that last_date + 6 months == today + 10 days
    const recordDate = addDays(addMonths(today(), -6), 10);
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: recordDate });
    await addReminder(app, v.id, { interval_months: 6 });

    const [r] = await getReminders(v.id);
    expect(r.last_date).toBe(recordDate);
    expect(r.status).toBe('due_soon');
  });

  it('overdue by date when last service was 7 months ago with a 6-month interval', async () => {
    const recordDate = addMonths(today(), -7);
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: recordDate });
    await addReminder(app, v.id, { interval_months: 6 });

    const [r] = await getReminders(v.id);
    expect(r.status).toBe('overdue');
  });

  // Mileage-based statuses: record at 10,000 mi + 5,000-mile interval => next due 15,000.
  async function mileageReminder(currentMileage) {
    const v = await makeVehicle(app, { current_mileage: currentMileage });
    await addRecord(app, v.id, { mileage: 10000, date: '2024-01-01' });
    await addReminder(app, v.id, { interval_miles: 5000 });
    const [r] = await getReminders(v.id);
    return r;
  }

  it('due_soon by mileage (current 14,700, within 500 of 15,000)', async () => {
    const r = await mileageReminder(14700);
    expect(r.last_mileage).toBe(10000);
    expect(r.next_due_mileage).toBe(15000);
    expect(r.next_due_date).toBeNull(); // miles-only reminder
    expect(r.status).toBe('due_soon');
  });

  it('ok by mileage (current 13,000, 2,000 miles to go)', async () => {
    const r = await mileageReminder(13000);
    expect(r.next_due_mileage).toBe(15000);
    expect(r.status).toBe('ok');
  });

  it('overdue by mileage (current 15,100 past 15,000)', async () => {
    const r = await mileageReminder(15100);
    expect(r.next_due_mileage).toBe(15000);
    expect(r.status).toBe('overdue');
  });

  it('months-only reminder yields null next_due_mileage even when the record has mileage', async () => {
    const t = today();
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: t, mileage: 5000 });
    await addReminder(app, v.id, { interval_months: 12 });

    const [r] = await getReminders(v.id);
    expect(r.last_mileage).toBe(5000);
    expect(r.next_due_mileage).toBeNull();
    expect(r.next_due_date).toBe(addMonths(t, 12));
    expect(r.status).toBe('ok');
  });

  it('miles-only reminder with a mileage-less record yields null next_due_mileage and ok', async () => {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: today() }); // no mileage on the record
    await addReminder(app, v.id, { interval_miles: 5000 });

    const [r] = await getReminders(v.id);
    expect(r.last_mileage).toBeNull();
    expect(r.next_due_mileage).toBeNull();
    expect(r.next_due_date).toBeNull();
    expect(r.status).toBe('ok');
  });

  it('last_date/last_mileage come from the latest matching record only (max date, then max id)', async () => {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: '2024-01-01', mileage: 50000 });
    await addRecord(app, v.id, { date: '2024-06-01', mileage: 55000 });
    // same date, created later => higher id wins the tiebreak
    await addRecord(app, v.id, { date: '2024-06-01', mileage: 56000 });
    // later record of a different type must be ignored
    await addRecord(app, v.id, { type: 'brake_service', date: '2025-01-01', mileage: 60000 });
    await addReminder(app, v.id, { interval_months: 6, interval_miles: 5000 });

    const [r] = await getReminders(v.id);
    expect(r.last_date).toBe('2024-06-01');
    expect(r.last_mileage).toBe(56000);
    expect(r.next_due_date).toBe('2024-12-01');
    expect(r.next_due_mileage).toBe(61000);
    expect(r.status).toBe('overdue'); // 2024-12-01 is well in the past
  });
});

describe('status boundaries', () => {
  // interval_months 12 makes next_due_date == addMonths(last_date, 12), which round-trips
  // the day/month exactly, so we can place next_due_date on precise day boundaries.
  async function dateReminder(nextDueDate) {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: addMonths(nextDueDate, -12) });
    await addReminder(app, v.id, { interval_months: 12 });
    const [r] = await getReminders(v.id);
    return r;
  }

  it('next_due_date exactly today => due_soon (not overdue)', async () => {
    const r = await dateReminder(today());
    expect(r.next_due_date).toBe(today());
    expect(r.status).toBe('due_soon');
    expect(r.status).not.toBe('overdue');
  });

  it('next_due_date exactly 30 days out => due_soon', async () => {
    const target = addDays(today(), 30);
    const r = await dateReminder(target);
    expect(r.next_due_date).toBe(target);
    expect(r.status).toBe('due_soon');
  });

  it('next_due_date 31 days out => ok', async () => {
    const target = addDays(today(), 31);
    const r = await dateReminder(target);
    expect(r.next_due_date).toBe(target);
    expect(r.status).toBe('ok');
  });

  // Miles-only reminder: record at 10,000 mi + 5,000-mile interval => next due 15,000.
  async function mileageReminder(currentMileage) {
    const v = await makeVehicle(app, { current_mileage: currentMileage });
    await addRecord(app, v.id, { mileage: 10000, date: '2024-01-01' });
    await addReminder(app, v.id, { interval_miles: 5000 });
    const [r] = await getReminders(v.id);
    return r;
  }

  it('next_due_mileage exactly equal to current_mileage => due_soon (not overdue)', async () => {
    const r = await mileageReminder(15000);
    expect(r.next_due_mileage).toBe(15000);
    expect(r.status).toBe('due_soon');
    expect(r.status).not.toBe('overdue');
  });

  it('current_mileage exactly 500 below next_due => due_soon', async () => {
    const r = await mileageReminder(14500);
    expect(r.next_due_mileage).toBe(15000);
    expect(r.status).toBe('due_soon');
  });

  it('current_mileage 501 below next_due => ok', async () => {
    const r = await mileageReminder(14499);
    expect(r.next_due_mileage).toBe(15000);
    expect(r.status).toBe('ok');
  });
});

describe('PUT / DELETE /api/reminders/:id', () => {
  it('updates a reminder', async () => {
    const v = await makeVehicle(app);
    const rem = await addReminder(app, v.id, { interval_months: 6 });

    const res = await request(app)
      .put(`/api/reminders/${rem.id}`)
      .send({ interval_months: 12, description: 'yearly now' });
    expect(res.status).toBe(200);
    expect(res.body.interval_months).toBe(12);
    expect(res.body.description).toBe('yearly now');
  });

  it('rejects clearing the only remaining interval on a miles-only reminder', async () => {
    const v = await makeVehicle(app);
    const rem = await addReminder(app, v.id, { interval_miles: 5000 });

    const res = await request(app)
      .put(`/api/reminders/${rem.id}`)
      .send({ interval_miles: null });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');

    // The reminder is unchanged: its interval_miles is still set.
    const [after] = await getReminders(v.id);
    expect(after.interval_miles).toBe(5000);
  });

  it('deletes a reminder with 204', async () => {
    const v = await makeVehicle(app);
    const rem = await addReminder(app, v.id, { interval_months: 6 });

    const del = await request(app).delete(`/api/reminders/${rem.id}`);
    expect(del.status).toBe(204);

    const list = await getReminders(v.id);
    expect(list).toEqual([]);
  });

  it('returns 404 for unknown reminder ids', async () => {
    const p = await request(app).put('/api/reminders/99999').send({ interval_months: 3 });
    expect(p.status).toBe(404);
    expect(typeof p.body.error).toBe('string');

    const d = await request(app).delete('/api/reminders/99999');
    expect(d.status).toBe(404);
    expect(typeof d.body.error).toBe('string');
  });
});

describe('GET /api/reminders/due', () => {
  it('returns only overdue/due_soon across vehicles, overdue first, with vehicle_name fallback', async () => {
    // Seed the DUE_SOON vehicle FIRST (lower id) so the vehicles iterate in
    // [due_soon, overdue] order; a correct overdue-first sort must reorder them,
    // which a missing sort (relying on pre-sorted data) could not.
    const v2 = await makeVehicle(app, { name: 'Daily Driver', make: 'Honda', model: 'Civic', year: 2018 });
    await addRecord(app, v2.id, { date: addDays(addMonths(today(), -6), 10) });
    await addReminder(app, v2.id, { interval_months: 6 }); // due_soon
    await addRecord(app, v2.id, { type: 'brake_service', date: today() });
    await addReminder(app, v2.id, { type: 'brake_service', interval_months: 6 }); // ok -> excluded

    // Overdue vehicle created SECOND (higher id): no nickname -> fallback name.
    const v1 = await makeVehicle(app, { make: 'Toyota', model: 'Corolla', year: 2020 });
    await addRecord(app, v1.id, { date: addMonths(today(), -7) });
    await addReminder(app, v1.id, { interval_months: 6 });

    const res = await request(app).get('/api/reminders/due');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    expect(res.body[0].status).toBe('overdue');
    expect(res.body[0].vehicle_id).toBe(v1.id);
    expect(res.body[0].vehicle_name).toBe('2020 Toyota Corolla');

    expect(res.body[1].status).toBe('due_soon');
    expect(res.body[1].vehicle_id).toBe(v2.id);
    expect(res.body[1].vehicle_name).toBe('Daily Driver');
  });

  it('returns an empty array when nothing is due', async () => {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: today() });
    await addReminder(app, v.id, { interval_months: 6 });

    const res = await request(app).get('/api/reminders/due');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
