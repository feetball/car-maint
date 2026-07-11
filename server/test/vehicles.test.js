import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { makeVehicle, addRecord, addReminder, uploadPhoto } from './helpers.js';

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-'));
  app = createApp({ dataDir });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/vehicles validation', () => {
  it('rejects missing make', async () => {
    const res = await request(app).post('/api/vehicles').send({ model: 'Corolla', year: 2020 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects empty-string make', async () => {
    const res = await request(app).post('/api/vehicles').send({ make: '', model: 'Corolla', year: 2020 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects missing model', async () => {
    const res = await request(app).post('/api/vehicles').send({ make: 'Toyota', year: 2020 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects missing year', async () => {
    const res = await request(app).post('/api/vehicles').send({ make: 'Toyota', model: 'Corolla' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects out-of-range year (1800)', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .send({ make: 'Toyota', model: 'Corolla', year: 1800 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects non-integer year ("abc")', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .send({ make: 'Toyota', model: 'Corolla', year: 'abc' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects negative current_mileage', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .send({ make: 'Toyota', model: 'Corolla', year: 2020, current_mileage: -5 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('POST /api/vehicles', () => {
  it('creates a vehicle with defaults and returns 201', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .send({ make: 'Honda', model: 'Civic', year: 2019 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      make: 'Honda',
      model: 'Civic',
      year: 2019,
      current_mileage: 0,
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body.created_at).toBeTruthy();
  });

  it('accepts optional fields', async () => {
    const res = await request(app).post('/api/vehicles').send({
      name: 'Daily Driver',
      make: 'Mazda',
      model: '3',
      year: 2017,
      vin: 'JM1BK32F781234567',
      license_plate: 'ABC-123',
      color: 'Red',
      current_mileage: 42000,
      notes: 'Bought used',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Daily Driver',
      make: 'Mazda',
      model: '3',
      year: 2017,
      vin: 'JM1BK32F781234567',
      license_plate: 'ABC-123',
      color: 'Red',
      current_mileage: 42000,
      notes: 'Bought used',
    });
  });
});

describe('GET /api/vehicles', () => {
  it('returns an empty array when there are no vehicles', async () => {
    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns computed fields with defaults for a bare vehicle', async () => {
    await makeVehicle(app);
    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const v = res.body[0];
    expect(v.primary_photo).toBeNull();
    expect(v.photo_count).toBe(0);
    expect(v.record_count).toBe(0);
    expect(v.total_cost).toBe(0);
    expect(v.last_service_date).toBeNull();
    expect(v.alert_count).toBe(0);
  });

  it('computes record aggregates and alert_count', async () => {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, { date: '2024-03-01', cost: 50 });
    await addRecord(app, v.id, { type: 'brake_service', date: '2024-06-15', cost: 25.5 });
    // oil_change last done 2024-03-01, 6-month interval => long overdue => 1 alert
    await addReminder(app, v.id, { interval_months: 6 });

    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(200);
    const item = res.body[0];
    expect(item.record_count).toBe(2);
    expect(item.total_cost).toBeCloseTo(75.5);
    expect(item.last_service_date).toBe('2024-06-15');
    expect(item.alert_count).toBe(1);
  });

  it('lists newest-first, breaking same-second created_at ties by id DESC', async () => {
    // Three vehicles created back-to-back share a created_at second, so the
    // ORDER BY created_at DESC, id DESC tiebreak must return them id-descending.
    const first = await makeVehicle(app, { make: 'First' });
    const second = await makeVehicle(app, { make: 'Second' });
    const third = await makeVehicle(app, { make: 'Third' });

    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((v) => v.id)).toEqual([third.id, second.id, first.id]);
    expect(res.body.map((v) => v.make)).toEqual(['Third', 'Second', 'First']);
  });

  it('surfaces primary_photo and photo_count for vehicles with photos', async () => {
    const v = await makeVehicle(app);
    const primary = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    await uploadPhoto(app, v.id, { filename: 'b.png' });

    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(200);
    const item = res.body.find((x) => x.id === v.id);
    expect(item.photo_count).toBe(2);
    // primary_photo is the is_primary filename (the first-ever upload).
    expect(item.primary_photo).toBe(primary.filename);
  });
});

describe('GET /api/vehicles/:id', () => {
  it('returns the vehicle with a photos array', async () => {
    const v = await makeVehicle(app);
    const res = await request(app).get(`/api/vehicles/${v.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(v.id);
    expect(res.body.make).toBe('Toyota');
    expect(res.body.model).toBe('Corolla');
    expect(res.body.year).toBe(2020);
    expect(res.body.photos).toEqual([]);
  });

  it('returns 404 for an unknown id on GET, PUT and DELETE', async () => {
    const g = await request(app).get('/api/vehicles/99999');
    expect(g.status).toBe(404);
    expect(typeof g.body.error).toBe('string');

    const p = await request(app).put('/api/vehicles/99999').send({ name: 'x' });
    expect(p.status).toBe(404);
    expect(typeof p.body.error).toBe('string');

    const d = await request(app).delete('/api/vehicles/99999');
    expect(d.status).toBe(404);
    expect(typeof d.body.error).toBe('string');
  });
});

describe('PUT /api/vehicles/:id', () => {
  it('partially updates fields and leaves the rest untouched', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .put(`/api/vehicles/${v.id}`)
      .send({ name: 'Commuter', current_mileage: 12345 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Commuter');
    expect(res.body.current_mileage).toBe(12345);
    expect(res.body.make).toBe('Toyota');
    expect(res.body.model).toBe('Corolla');
    expect(res.body.year).toBe(2020);
  });

  it('validates updated fields', async () => {
    const v = await makeVehicle(app);

    const badYearLow = await request(app).put(`/api/vehicles/${v.id}`).send({ year: 1800 });
    expect(badYearLow.status).toBe(400);
    expect(typeof badYearLow.body.error).toBe('string');

    const badYearType = await request(app).put(`/api/vehicles/${v.id}`).send({ year: 'abc' });
    expect(badYearType.status).toBe(400);
    expect(typeof badYearType.body.error).toBe('string');

    const badMake = await request(app).put(`/api/vehicles/${v.id}`).send({ make: '' });
    expect(badMake.status).toBe(400);
    expect(typeof badMake.body.error).toBe('string');
  });
});

describe('DELETE /api/vehicles/:id', () => {
  it('returns 204 and the vehicle is gone afterwards', async () => {
    const v = await makeVehicle(app);
    const del = await request(app).delete(`/api/vehicles/${v.id}`);
    expect(del.status).toBe(204);

    const after = await request(app).get(`/api/vehicles/${v.id}`);
    expect(after.status).toBe(404);

    const list = await request(app).get('/api/vehicles');
    expect(list.body).toEqual([]);
  });
});
