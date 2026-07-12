import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, makeVehicle, addRecord, addReminder } from './helpers.js';

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/vehicles/:id/stats', () => {
  it('computes totals, cost_by_type (total DESC) and cost_by_year (year ASC); null cost counts as 0', async () => {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { type: 'oil_change', date: '2023-05-01', cost: 50 });
    await addRecord(app, v.id, { type: 'oil_change', date: '2024-02-01', cost: 30 });
    await addRecord(app, v.id, { type: 'brake_service', date: '2024-03-01', cost: 200 });
    await addRecord(app, v.id, { type: 'inspection', date: '2023-08-01' }); // null cost

    const res = await request(app).get(`/api/vehicles/${v.id}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.total_cost).toBe(280);
    expect(res.body.record_count).toBe(4);

    expect(res.body.cost_by_type).toEqual([
      { type: 'brake_service', label: 'Brake Service', total: 200, count: 1 },
      { type: 'oil_change', label: 'Oil Change', total: 80, count: 2 },
      { type: 'inspection', label: 'Inspection', total: 0, count: 1 },
    ]);

    const byYear = res.body.cost_by_year;
    expect(byYear).toHaveLength(2);
    expect(Number(byYear[0].year)).toBe(2023);
    expect(byYear[0].total).toBe(50);
    expect(Number(byYear[1].year)).toBe(2024);
    expect(byYear[1].total).toBe(230);
  });

  it('returns zeros/empty arrays for a vehicle with no records', async () => {
    const v = await makeVehicle(app);
    const res = await request(app).get(`/api/vehicles/${v.id}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.total_cost).toBe(0);
    expect(res.body.record_count).toBe(0);
    expect(res.body.cost_by_type).toEqual([]);
    expect(res.body.cost_by_year).toEqual([]);
  });
});

describe('GET /api/dashboard', () => {
  it('reports counts, total cost, recent records (max 10) and due reminders', async () => {
    const v1 = await makeVehicle(app, { name: 'Truck', make: 'Ford', model: 'F-150', year: 2021 });
    const v2 = await makeVehicle(app, { make: 'Mazda', model: '3', year: 2017 }); // no name -> fallback

    // 12 records, unique ascending dates, cost 10 each, alternating vehicles
    // (odd day -> v1, even day -> v2).
    for (let i = 1; i <= 12; i++) {
      const day = String(i).padStart(2, '0');
      await addRecord(app, i % 2 ? v1.id : v2.id, { date: `2024-01-${day}`, cost: 10 });
    }
    // oil_change last done Jan 2024 with a 6-month interval -> overdue
    await addReminder(app, v1.id, { interval_months: 6 });

    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.vehicle_count).toBe(2);
    expect(res.body.record_count).toBe(12);
    expect(res.body.total_cost).toBe(120);

    const recent = res.body.recent_records;
    expect(recent).toHaveLength(10);
    expect(recent.map((r) => r.date)).toEqual([
      '2024-01-12', '2024-01-11', '2024-01-10', '2024-01-09', '2024-01-08',
      '2024-01-07', '2024-01-06', '2024-01-05', '2024-01-04', '2024-01-03',
    ]);
    // vehicle_name: nickname when set, else "<year> <make> <model>"
    expect(recent[0].vehicle_name).toBe('2017 Mazda 3'); // day 12 -> v2
    expect(recent[1].vehicle_name).toBe('Truck'); // day 11 -> v1

    expect(Array.isArray(res.body.due_reminders)).toBe(true);
    expect(res.body.due_reminders).toHaveLength(1);
    expect(res.body.due_reminders[0].status).toBe('overdue');
    expect(res.body.due_reminders[0].vehicle_name).toBe('Truck');
  });

  it('returns an empty dashboard shape with no data', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.vehicle_count).toBe(0);
    expect(res.body.record_count).toBe(0);
    expect(res.body.total_cost).toBe(0);
    expect(res.body.recent_records).toEqual([]);
    expect(res.body.due_reminders).toEqual([]);
  });
});

describe('GET /api/service-types', () => {
  it('returns the 17 service types in the specified order', async () => {
    const res = await request(app).get('/api/service-types');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(17);
    expect(res.body[0]).toEqual({ value: 'oil_change', label: 'Oil Change' });
    expect(res.body[16].value).toBe('other');
    expect(res.body.map((t) => t.value)).toEqual([
      'oil_change',
      'tire_rotation',
      'new_tires',
      'brake_service',
      'battery',
      'air_filter',
      'cabin_filter',
      'spark_plugs',
      'coolant_flush',
      'transmission',
      'alignment',
      'wiper_blades',
      'inspection',
      'registration',
      'detailing',
      'repair',
      'other',
    ]);
    expect(res.body.every((t) => typeof t.label === 'string' && t.label.length > 0)).toBe(true);
  });
});
