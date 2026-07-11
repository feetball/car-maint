import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { makeVehicle, addRecord } from './helpers.js';

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-'));
  app = createApp({ dataDir });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/vehicles/:id/records validation', () => {
  it('rejects an invalid service type', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/records`)
      .send({ type: 'oil', date: '2024-05-01' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects a missing date', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/records`)
      .send({ type: 'oil_change' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects negative mileage', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/records`)
      .send({ type: 'oil_change', date: '2024-05-01', mileage: -1 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects negative cost', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/records`)
      .send({ type: 'oil_change', date: '2024-05-01', cost: -0.01 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects a well-formed but non-calendar date (2025-02-31)', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/records`)
      .send({ type: 'oil_change', date: '2025-02-31' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects an impossible month (2025-13-01)', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/records`)
      .send({ type: 'oil_change', date: '2025-13-01' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 404 for an unknown vehicle', async () => {
    const res = await request(app)
      .post('/api/vehicles/99999/records')
      .send({ type: 'oil_change', date: '2024-05-01' });
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('POST /api/vehicles/:id/records', () => {
  it('creates a record and returns 201', async () => {
    const v = await makeVehicle(app);
    const res = await request(app).post(`/api/vehicles/${v.id}/records`).send({
      type: 'oil_change',
      date: '2024-05-01',
      description: 'Full synthetic',
      mileage: 32000,
      cost: 49.99,
      shop: 'QuickLube',
      notes: 'next one in 5k',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      vehicle_id: v.id,
      type: 'oil_change',
      date: '2024-05-01',
      description: 'Full synthetic',
      mileage: 32000,
      cost: 49.99,
      shop: 'QuickLube',
      notes: 'next one in 5k',
    });
    expect(res.body.id).toBeTruthy();
  });
});

describe('GET /api/vehicles/:id/records', () => {
  it('sorts by date DESC then id DESC (same-date tiebreak)', async () => {
    const v = await makeVehicle(app);
    const r1 = await addRecord(app, v.id, { date: '2024-05-01' });
    const r2 = await addRecord(app, v.id, { date: '2024-03-01' });
    const r3 = await addRecord(app, v.id, { type: 'tire_rotation', date: '2024-05-01' });

    const res = await request(app).get(`/api/vehicles/${v.id}/records`);
    expect(res.status).toBe(200);
    // r3 shares r1's date but has a higher id, so it comes first.
    expect(res.body.map((r) => r.id)).toEqual([r3.id, r1.id, r2.id]);
  });

  it('filters by ?type=', async () => {
    const v = await makeVehicle(app);
    const oil1 = await addRecord(app, v.id, { type: 'oil_change', date: '2024-01-01' });
    await addRecord(app, v.id, { type: 'brake_service', date: '2024-02-01' });
    const oil2 = await addRecord(app, v.id, { type: 'oil_change', date: '2024-03-01' });

    const res = await request(app).get(`/api/vehicles/${v.id}/records?type=oil_change`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((r) => r.type === 'oil_change')).toBe(true);
    expect(res.body.map((r) => r.id)).toEqual([oil2.id, oil1.id]);
  });
});

describe('mileage side effect', () => {
  it('bumps vehicle.current_mileage when the record mileage is higher', async () => {
    const v = await makeVehicle(app); // current_mileage 0
    await addRecord(app, v.id, { mileage: 5000, date: '2024-01-01' });

    const after = await request(app).get(`/api/vehicles/${v.id}`);
    expect(after.body.current_mileage).toBe(5000);
  });

  it('does not lower vehicle.current_mileage for an older record', async () => {
    const v = await makeVehicle(app, { current_mileage: 5000 });
    await addRecord(app, v.id, { mileage: 3000, date: '2023-01-01' });

    const after = await request(app).get(`/api/vehicles/${v.id}`);
    expect(after.body.current_mileage).toBe(5000);
  });

  it('applies the same side effect on PUT', async () => {
    const v = await makeVehicle(app);
    const rec = await addRecord(app, v.id, { mileage: 1000, date: '2024-01-01' });

    const res = await request(app).put(`/api/records/${rec.id}`).send({ mileage: 9000 });
    expect(res.status).toBe(200);
    expect(res.body.mileage).toBe(9000);

    const after = await request(app).get(`/api/vehicles/${v.id}`);
    expect(after.body.current_mileage).toBe(9000);
  });
});

describe('PUT /api/records/:id', () => {
  it('partially updates a record', async () => {
    const v = await makeVehicle(app);
    const rec = await addRecord(app, v.id, { date: '2024-05-01', cost: 20 });

    const res = await request(app)
      .put(`/api/records/${rec.id}`)
      .send({ cost: 35.5, shop: 'New Shop' });
    expect(res.status).toBe(200);
    expect(res.body.cost).toBeCloseTo(35.5);
    expect(res.body.shop).toBe('New Shop');
    expect(res.body.type).toBe('oil_change');
    expect(res.body.date).toBe('2024-05-01');
  });

  it('validates on update', async () => {
    const v = await makeVehicle(app);
    const rec = await addRecord(app, v.id, { date: '2024-05-01' });

    const res = await request(app).put(`/api/records/${rec.id}`).send({ type: 'nonsense' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 404 for an unknown record id', async () => {
    const res = await request(app).put('/api/records/99999').send({ cost: 1 });
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('DELETE /api/records/:id', () => {
  it('returns 204 and the record disappears from the list', async () => {
    const v = await makeVehicle(app);
    const rec = await addRecord(app, v.id, { date: '2024-05-01' });
    const keep = await addRecord(app, v.id, { date: '2024-06-01' });

    const del = await request(app).delete(`/api/records/${rec.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get(`/api/vehicles/${v.id}/records`);
    expect(list.body.map((r) => r.id)).toEqual([keep.id]);
  });

  it('returns 404 for an unknown record id', async () => {
    const res = await request(app).delete('/api/records/99999');
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });
});
