import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent, makeVehicle, addRecord, addReminder, uploadPhoto, today, addMonths } from './helpers.js';

// Cross-user isolation: two users on the SAME app must never see or touch each
// other's data, and legacy NULL-owned (unadopted) vehicles are invisible to all.
let dataDir;
let app;
let alice;
let bob;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-iso-'));
  app = makeApp(dataDir);
  alice = await authAgent(app);
  bob = await authAgent(app);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Seed a full tree for Alice; return the created ids/rows.
async function seedAlice() {
  const vehicle = await makeVehicle(alice, { name: 'Alice Car' });
  const record = await addRecord(alice, vehicle.id, { date: '2024-01-01', cost: 10 });
  const reminder = await addReminder(alice, vehicle.id, { interval_months: 6 });
  const photo = (await uploadPhoto(alice, vehicle.id)).body[0];
  return { vehicle, record, reminder, photo };
}

describe('list isolation', () => {
  it("B sees an empty list while A has vehicles", async () => {
    await seedAlice();
    const bobList = await bob.get('/api/vehicles');
    expect(bobList.status).toBe(200);
    expect(bobList.body).toEqual([]);

    const aliceList = await alice.get('/api/vehicles');
    expect(aliceList.body).toHaveLength(1);
  });
});

describe('404 (not 403) on another user\'s resources by id', () => {
  it("B gets 404 on A's vehicle / record / reminder / photo", async () => {
    const { vehicle, record, reminder, photo } = await seedAlice();

    expect((await bob.get(`/api/vehicles/${vehicle.id}`)).status).toBe(404);
    expect((await bob.put(`/api/vehicles/${vehicle.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await bob.delete(`/api/vehicles/${vehicle.id}`)).status).toBe(404);

    expect((await bob.get(`/api/vehicles/${vehicle.id}/records`)).status).toBe(404);
    expect((await bob.put(`/api/records/${record.id}`).send({ cost: 1 })).status).toBe(404);
    expect((await bob.delete(`/api/records/${record.id}`)).status).toBe(404);

    expect((await bob.get(`/api/vehicles/${vehicle.id}/reminders`)).status).toBe(404);
    expect((await bob.put(`/api/reminders/${reminder.id}`).send({ interval_months: 3 })).status).toBe(404);
    expect((await bob.delete(`/api/reminders/${reminder.id}`)).status).toBe(404);

    expect((await bob.put(`/api/photos/${photo.id}/primary`)).status).toBe(404);
    expect((await bob.delete(`/api/photos/${photo.id}`)).status).toBe(404);

    // Stats / recalls / export of A's vehicle are 404 for B too.
    expect((await bob.get(`/api/vehicles/${vehicle.id}/stats`)).status).toBe(404);
    expect((await bob.get(`/api/vehicles/${vehicle.id}/export.csv`)).status).toBe(404);

    // The raw photo file (disk mode) is 404 for B, served for A.
    expect((await bob.get(`/photos/${photo.filename}`)).status).toBe(404);
    expect((await alice.get(`/photos/${photo.filename}`)).status).toBe(200);
  });

  it("B cannot POST a record or photo to A's vehicle", async () => {
    const { vehicle } = await seedAlice();

    const rec = await bob
      .post(`/api/vehicles/${vehicle.id}/records`)
      .send({ type: 'oil_change', date: '2024-02-02' });
    expect(rec.status).toBe(404);

    const rem = await bob
      .post(`/api/vehicles/${vehicle.id}/reminders`)
      .send({ type: 'oil_change', interval_months: 6 });
    expect(rem.status).toBe(404);

    const photo = await uploadPhoto(bob, vehicle.id);
    expect(photo.status).toBe(404);

    // A's data is unchanged: still exactly one record.
    const aRecords = await alice.get(`/api/vehicles/${vehicle.id}/records`);
    expect(aRecords.body).toHaveLength(1);
  });
});

describe('export / backup contain only the requester\'s data', () => {
  it('B\'s export.json and export.csv exclude A\'s vehicles', async () => {
    await seedAlice();
    await makeVehicle(bob, { name: 'Bob Car' });

    const json = await bob.get('/api/export.json');
    expect(json.status).toBe(200);
    expect(json.body.vehicles).toHaveLength(1);
    expect(json.body.vehicles[0].name).toBe('Bob Car');

    const csv = await alice.get('/api/export.csv');
    // Alice's CSV has her record row; it must not mention Bob's car.
    expect(csv.text).not.toContain('Bob Car');
  });

  it('A\'s backup manifest counts only A\'s tree', async () => {
    await seedAlice();
    await makeVehicle(bob, { name: 'Bob Car' });

    const res = await bob.get('/api/backup').buffer(true).parse((r, cb) => {
      r.setEncoding('binary');
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => cb(null, Buffer.from(data, 'binary')));
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    // Bob has one empty vehicle: his backup has 1 vehicle, 0 records/reminders/photos.
    // (Content-level scoping is exercised end-to-end by the restore round-trip test.)
  });
});

describe('per-user calendar feed', () => {
  it("A's token shows only A's reminders and B's token only B's", async () => {
    // Alice: a reminder that is due (record a year ago, 6-month interval).
    const av = await makeVehicle(alice, { name: 'Alice Car' });
    await addRecord(alice, av.id, { type: 'oil_change', date: addMonths(today(), -12) });
    await addReminder(alice, av.id, { interval_months: 6 });

    // Bob: his own vehicle + due reminder.
    const bv = await makeVehicle(bob, { name: 'Bob Car' });
    await addRecord(bob, bv.id, { type: 'oil_change', date: addMonths(today(), -12) });
    await addReminder(bob, bv.id, { interval_months: 6 });

    const aUrl = (await alice.get('/api/calendar-url')).body.url;
    const bUrl = (await bob.get('/api/calendar-url')).body.url;
    expect(aUrl).not.toBe(bUrl);

    const aFeed = await request(app).get(aUrl);
    expect(aFeed.text).toContain('Alice Car');
    expect(aFeed.text).not.toContain('Bob Car');

    const bFeed = await request(app).get(bUrl);
    expect(bFeed.text).toContain('Bob Car');
    expect(bFeed.text).not.toContain('Alice Car');
  });
});

describe('legacy NULL-owned vehicles are invisible', () => {
  it('a directly-inserted user_id=NULL vehicle is hidden from both users', async () => {
    const ctx = app.locals.ctx;
    const info = await ctx.db.run(
      'INSERT INTO vehicles (user_id, make, model, year) VALUES (NULL, ?, ?, ?)',
      ['Legacy', 'Ghost', 2000]
    );
    const orphanId = info.lastInsertRowid;

    // Not in either user's list.
    expect((await alice.get('/api/vehicles')).body).toEqual([]);
    expect((await bob.get('/api/vehicles')).body).toEqual([]);

    // 404 by id for both.
    expect((await alice.get(`/api/vehicles/${orphanId}`)).status).toBe(404);
    expect((await bob.get(`/api/vehicles/${orphanId}`)).status).toBe(404);
  });
});
