import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';

// Single shared app-construction helper used by every server test file. Keeps the
// whole suite driver-agnostic: when env DB_DRIVER=libsql it builds the app on the
// libsql driver backed by a per-dataDir local `file:` database (so each test stays
// isolated exactly like the default sqlite driver); otherwise it uses the default
// sqlite driver. Extra createApp options (NHTSA stub bases, etc.) merge in via the
// second argument.
export function makeApp(dataDir, options = {}) {
  const base = { dataDir, ...options };
  if (process.env.DB_DRIVER === 'libsql') {
    return createApp({
      ...base,
      dbDriver: 'libsql',
      dbUrl: `file:${path.join(dataDir, 'carmaint.db')}`,
    });
  }
  return createApp(base);
}

// Minimal valid 1x1 transparent PNG (67 bytes).
export const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a' + // PNG signature
    '0000000d49484452000000010000000108060000001f15c489' + // IHDR: 1x1, 8-bit RGBA
    '0000000a49444154789c63000100000500010d0a2db4' + // IDAT
    '0000000049454e44ae426082', // IEND
  'hex'
);

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

// Today's local calendar date as YYYY-MM-DD.
export function today() {
  const n = new Date();
  return fmt(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())));
}

// iso ('YYYY-MM-DD') + months, UTC math (rolls over month-end like JS Date / SQLite).
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  return fmt(new Date(Date.UTC(y, m - 1 + months, d)));
}

// iso ('YYYY-MM-DD') + days, UTC math.
export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return fmt(new Date(Date.UTC(y, m - 1, d + days)));
}

export async function makeVehicle(app, overrides = {}) {
  const res = await request(app)
    .post('/api/vehicles')
    .send({ make: 'Toyota', model: 'Corolla', year: 2020, ...overrides });
  if (res.status !== 201) {
    throw new Error(`makeVehicle failed: ${res.status} ${res.text}`);
  }
  return res.body;
}

export async function addRecord(app, vehicleId, overrides = {}) {
  const res = await request(app)
    .post(`/api/vehicles/${vehicleId}/records`)
    .send({ type: 'oil_change', date: today(), ...overrides });
  if (res.status !== 201) {
    throw new Error(`addRecord failed: ${res.status} ${res.text}`);
  }
  return res.body;
}

// No default intervals: callers pass interval_months and/or interval_miles explicitly.
export async function addReminder(app, vehicleId, body = {}) {
  const res = await request(app)
    .post(`/api/vehicles/${vehicleId}/reminders`)
    .send({ type: 'oil_change', ...body });
  if (res.status !== 201) {
    throw new Error(`addReminder failed: ${res.status} ${res.text}`);
  }
  return res.body;
}

export function uploadPhoto(app, vehicleId, { buf = PNG_1x1, filename = 'a.png', contentType = 'image/png' } = {}) {
  return request(app)
    .post(`/api/vehicles/${vehicleId}/photos`)
    .attach('photos', buf, { filename, contentType });
}
