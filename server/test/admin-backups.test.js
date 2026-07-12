import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent, adminAndUserAgents, makeVehicle, addRecord, uploadPhoto } from './helpers.js';

// Global whole-DB backup endpoints under /api/backups, exposed to ADMIN sessions (in
// addition to the existing CRON_SECRET bearer path). These are distinct from the
// per-user /api/backup + /api/restore, which must remain user-scoped and unaffected.
let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-gbackup-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function binaryParser(res, cb) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => cb(null, Buffer.from(data, 'binary')));
}
function downloadBuffer(req) {
  return req.buffer().parse(binaryParser);
}

describe('admin-session global backup: list / create / download', () => {
  it('admin can create, list, and download a global backup (no bearer)', async () => {
    const admin = await authAgent(app);
    await makeVehicle(admin, { name: 'Global Rig' });

    // Create on demand.
    const create = await admin.post('/api/backups');
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ ok: true });
    expect(typeof create.body.filename).toBe('string');

    // List shows it.
    const list = await admin.get('/api/backups');
    expect(list.status).toBe(200);
    expect(list.body.some((b) => b.filename === create.body.filename)).toBe(true);

    // Download it.
    const dl = await downloadBuffer(admin.get(`/api/backups/${create.body.filename}`));
    expect(dl.status).toBe(200);
    expect(dl.body.length).toBeGreaterThan(0);
  });

  it('non-admin gets 403 on list/create/download/restore', async () => {
    const { user } = await adminAndUserAgents(app);
    expect((await user.get('/api/backups')).status).toBe(403);
    expect((await user.post('/api/backups')).status).toBe(403);
    expect((await user.get('/api/backups/whatever.zip')).status).toBe(403);
    expect((await user.post('/api/backups/restore')).status).toBe(403);
  });
});

describe('existing CRON bearer path still works', () => {
  it('bearer (no session) can list and create when CRON_SECRET is set', async () => {
    const secret = 'bearer-secret-xyz';
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = secret;
    let appS;
    try {
      appS = makeApp(dataDir);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
    const list = await request(appS).get('/api/backups').set('Authorization', `Bearer ${secret}`);
    expect(list.status).toBe(200);
    const create = await request(appS).post('/api/backups').set('Authorization', `Bearer ${secret}`);
    expect(create.status).toBe(201);
  });
});

describe('global restore (admin-gated, whole-DB replace)', () => {
  it('replaces the entire DB from a global backup and is admin-gated', async () => {
    // Seed a two-user world and take a GLOBAL backup.
    const { admin, user } = await adminAndUserAgents(app);
    const av = await makeVehicle(admin, { name: 'Admin Car' });
    await addRecord(admin, av.id, { date: '2024-03-03', cost: 55 });
    await makeVehicle(user, { name: 'User Car' });

    const create = await admin.post('/api/backups');
    expect(create.status).toBe(201);
    const snapshot = await downloadBuffer(admin.get(`/api/backups/${create.body.filename}`));
    expect(snapshot.body.length).toBeGreaterThan(0);

    // Mutate the live DB AFTER the snapshot: add a vehicle that should disappear on restore.
    await makeVehicle(admin, { name: 'Post-Snapshot Car' });
    expect((await admin.get('/api/vehicles')).body.map((v) => v.name)).toContain('Post-Snapshot Car');

    // Non-admin cannot restore.
    const uRestore = await user
      .post('/api/backups/restore')
      .attach('backup', snapshot.body, { filename: 'g.zip', contentType: 'application/zip' });
    expect(uRestore.status).toBe(403);

    // Admin global restore: whole-DB replace back to the snapshot.
    const restore = await admin
      .post('/api/backups/restore')
      .attach('backup', snapshot.body, { filename: 'g.zip', contentType: 'application/zip' });
    expect(restore.status).toBe(200);
    expect(restore.body).toMatchObject({ restored: true, scope: 'global' });

    // Sessions were wiped by the restore → admin must re-login.
    expect((await admin.get('/api/vehicles')).status).toBe(401);
    const admin2 = request.agent(app);
    await admin2.post('/api/login').send({ username: admin.username, password: admin.password });

    // The post-snapshot vehicle is gone; the snapshot's world is back (both users).
    const names = (await admin2.get('/api/vehicles')).body.map((v) => v.name);
    expect(names).toContain('Admin Car');
    expect(names).not.toContain('Post-Snapshot Car');

    const user2 = request.agent(app);
    await user2.post('/api/login').send({ username: user.username, password: user.password });
    expect((await user2.get('/api/vehicles')).body.map((v) => v.name)).toContain('User Car');
  });

  it('prunes photo files that the restored snapshot no longer references', async () => {
    // Take a global snapshot, then upload a NEW photo that is absent from the snapshot.
    // After a global restore, the DB no longer references that photo — its file must be
    // removed from the store too, or it orphans (storage/cost leak).
    const admin = await authAgent(app);
    const v = await makeVehicle(admin, { name: 'Snap Car' });

    const create = await admin.post('/api/backups');
    expect(create.status).toBe(201);
    const snapshot = await downloadBuffer(admin.get(`/api/backups/${create.body.filename}`));

    // Upload a photo AFTER the snapshot → present in the store, absent from the snapshot.
    const photo = (await uploadPhoto(admin, v.id)).body[0];
    const orphanPath = path.join(dataDir, 'photos', photo.filename);
    expect(fs.existsSync(orphanPath)).toBe(true);

    const restore = await admin
      .post('/api/backups/restore')
      .attach('backup', snapshot.body, { filename: 'g.zip', contentType: 'application/zip' });
    expect(restore.status).toBe(200);
    expect(restore.body).toMatchObject({ restored: true, scope: 'global' });

    // The post-snapshot photo file is gone from the store (no longer referenced).
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  it('keeps photo files that the restored snapshot still references', async () => {
    // A photo captured IN the snapshot must survive the restore's cleanup (it is written
    // back to the store and remains referenced), so it must not be pruned.
    const admin = await authAgent(app);
    const v = await makeVehicle(admin, { name: 'Keeper Car' });
    const photo = (await uploadPhoto(admin, v.id)).body[0];
    const keptPath = path.join(dataDir, 'photos', photo.filename);

    const create = await admin.post('/api/backups');
    expect(create.status).toBe(201);
    const snapshot = await downloadBuffer(admin.get(`/api/backups/${create.body.filename}`));

    const restore = await admin
      .post('/api/backups/restore')
      .attach('backup', snapshot.body, { filename: 'g.zip', contentType: 'application/zip' });
    expect(restore.status).toBe(200);

    expect(fs.existsSync(keptPath)).toBe(true);
    // Still referenced by the restored DB (so it was correctly spared by the cleanup).
    const ctx = app.locals.ctx;
    const row = await ctx.db.get('SELECT * FROM photos WHERE filename = ?', [photo.filename]);
    expect(row).toBeTruthy();
  });

  it('rejects a per-user backup (no users in snapshot) with 400', async () => {
    const admin = await authAgent(app);
    const v = await makeVehicle(admin, { name: 'Solo' });
    await addRecord(admin, v.id);
    // /api/backup is the PER-USER backup (strips users) → not a valid global snapshot.
    const perUser = await downloadBuffer(admin.get('/api/backup'));
    const res = await admin
      .post('/api/backups/restore')
      .attach('backup', perUser.body, { filename: 'peruser.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
  });
});

describe('per-user backup/restore remain user-scoped and unaffected', () => {
  it('/api/backup is still per-user and /api/restore additive', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    await makeVehicle(admin, { name: 'A1' });
    await makeVehicle(admin, { name: 'A2' });
    await makeVehicle(user, { name: 'U1' });

    // Non-admin CAN take their own per-user backup (not an admin route).
    const uBackup = await downloadBuffer(user.get('/api/backup'));
    expect(uBackup.status).toBe(200);

    // Restoring the user's own backup into their account is additive (now 2 U1s).
    const restore = await user
      .post('/api/restore')
      .attach('backup', uBackup.body, { filename: 'u.zip', contentType: 'application/zip' });
    expect(restore.status).toBe(200);
    const names = (await user.get('/api/vehicles')).body.map((v) => v.name);
    expect(names.filter((n) => n === 'U1')).toHaveLength(2);
    // Admin's data untouched by the user's restore.
    expect((await admin.get('/api/vehicles')).body).toHaveLength(2);
  });
});
