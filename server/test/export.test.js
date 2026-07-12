import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, makeVehicle, addRecord } from './helpers.js';

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const HEADER = 'date,type,mileage,cost,shop,description,notes';

describe('GET /api/vehicles/:id/export.csv', () => {
  it('exports records as CSV, date ASC, with the right headers', async () => {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, {
      type: 'oil_change',
      date: '2024-05-01',
      mileage: 12000,
      cost: 49.99,
      shop: "Joe's Garage",
      description: 'Standard oil change',
    });
    await addRecord(app, v.id, { type: 'repair', date: '2024-01-15' });

    const res = await request(app).get(`/api/vehicles/${v.id}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);

    const text = res.text;
    expect(text.split(/\r?\n/)[0]).toBe(HEADER);

    // Plain values need no quoting.
    expect(text).toContain(
      "2024-05-01,oil_change,12000,49.99,Joe's Garage,Standard oil change,"
    );

    // date ASC: the January record comes before the May record.
    const idxJan = text.indexOf('2024-01-15');
    const idxMay = text.indexOf('2024-05-01');
    expect(idxJan).toBeGreaterThan(-1);
    expect(idxMay).toBeGreaterThan(-1);
    expect(idxJan).toBeLessThan(idxMay);
  });

  it('quotes fields containing quotes, commas and newlines, doubling embedded quotes', async () => {
    const v = await makeVehicle(app);
    await addRecord(app, v.id, {
      type: 'repair',
      date: '2024-01-15',
      notes: 'he said "hi", ok\nsecond line',
    });

    const res = await request(app).get(`/api/vehicles/${v.id}/export.csv`);
    expect(res.status).toBe(200);

    // Whole quoted field, with " doubled and the newline preserved inside the quotes.
    expect(res.text).toContain('"he said ""hi"", ok\nsecond line"');
    // Null optional fields render as empty columns before the quoted notes field.
    expect(res.text).toContain('2024-01-15,repair,,,,,"he said ""hi"", ok\nsecond line"');
  });

  it('exports just the header row for a vehicle with no records', async () => {
    const v = await makeVehicle(app);
    const res = await request(app).get(`/api/vehicles/${v.id}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split(/\r?\n/)[0]).toBe(HEADER);
    expect(res.text.trim()).toBe(HEADER);
  });
});
