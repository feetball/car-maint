import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  makeApp,
  authAgent,
  adminAndUserAgents,
  makeVehicle,
  addRecord,
  addReminder,
  uploadPhoto,
} from './helpers.js';
import { createDataFacade } from '../src/data/facade.js';
import { SCHEMA_STATEMENTS } from '../src/db.js';

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-admin-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- Registration / bootstrap admin -----------------------------------------

describe('bootstrap admin on registration', () => {
  it('first-ever user is admin, second is not (via /api/auth/status)', async () => {
    const admin = await authAgent(app);
    const user = await authAgent(app);

    expect(admin.is_admin).toBe(true);
    expect(user.is_admin).toBe(false);

    const s1 = await admin.get('/api/auth/status');
    expect(s1.body).toMatchObject({ authenticated: true, is_admin: true });
    const s2 = await user.get('/api/auth/status');
    expect(s2.body).toMatchObject({ authenticated: true, is_admin: false });
  });

  it('register response echoes is_admin', async () => {
    const first = await request(app).post('/api/register').send({ username: 'first_one', password: 'password12345' });
    // Registration grants a full session (MFA optional) and echoes is_admin so the client
    // knows the first user is the bootstrap admin; mfa_enabled:false drives the setup nudge.
    expect(first.body).toEqual({ username: 'first_one', is_admin: true, mfa_enabled: false });
    const second = await request(app).post('/api/register').send({ username: 'second_one', password: 'password12345' });
    expect(second.body).toEqual({ username: 'second_one', is_admin: false, mfa_enabled: false });
  });
});

// --- Admin guard ------------------------------------------------------------

describe('admin guard on /api/admin/*', () => {
  const endpoints = [
    ['get', '/api/admin/users'],
    ['post', '/api/admin/users/1/admin'],
    ['delete', '/api/admin/users/1'],
    ['get', '/api/admin/vehicles'],
    ['post', '/api/admin/vehicles/1/owner'],
    ['post', '/api/admin/vehicles/adopt-orphans'],
  ];

  it('non-admin session → 403 on every endpoint', async () => {
    const { user } = await adminAndUserAgents(app);
    for (const [method, url] of endpoints) {
      const res = await user[method](url).send({});
      expect(res.status, `${method} ${url}`).toBe(403);
    }
  });

  it('unauthenticated → 401 on every endpoint', async () => {
    for (const [method, url] of endpoints) {
      const res = await request(app)[method](url).send({});
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });
});

// --- User management --------------------------------------------------------

describe('GET /api/admin/users', () => {
  it('lists all users with correct vehicle_count', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    await makeVehicle(admin);
    await makeVehicle(admin);
    await makeVehicle(user);

    const res = await admin.get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const byName = Object.fromEntries(res.body.map((u) => [u.username, u]));
    expect(byName[admin.username]).toMatchObject({ is_admin: true, vehicle_count: 2 });
    expect(byName[user.username]).toMatchObject({ is_admin: false, vehicle_count: 1 });
    expect(typeof byName[admin.username].created_at).toBe('string');
  });
});

describe('POST /api/admin/users/:id/admin', () => {
  it('promotes and demotes another user', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const users = (await admin.get('/api/admin/users')).body;
    const targetId = users.find((u) => u.username === user.username).id;

    const promote = await admin.post(`/api/admin/users/${targetId}/admin`).send({ is_admin: true });
    expect(promote.status).toBe(200);
    expect(promote.body).toMatchObject({ id: targetId, is_admin: true });
    // Now that the target sees admin, its own status reflects it.
    expect((await user.get('/api/auth/status')).body.is_admin).toBe(true);

    const demote = await admin.post(`/api/admin/users/${targetId}/admin`).send({ is_admin: false });
    expect(demote.status).toBe(200);
    expect((await user.get('/api/auth/status')).body.is_admin).toBe(false);
  });

  it('404 for a nonexistent user', async () => {
    const admin = await authAgent(app);
    const res = await admin.post('/api/admin/users/99999/admin').send({ is_admin: true });
    expect(res.status).toBe(404);
  });

  it('400 when is_admin is not a boolean', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const targetId = (await admin.get('/api/admin/users')).body.find((u) => u.username === user.username).id;
    const res = await admin.post(`/api/admin/users/${targetId}/admin`).send({ is_admin: 'yes' });
    expect(res.status).toBe(400);
  });

  it('409 when demoting the last remaining admin (self)', async () => {
    const admin = await authAgent(app);
    const selfId = (await admin.get('/api/admin/users')).body.find((u) => u.username === admin.username).id;
    const res = await admin.post(`/api/admin/users/${selfId}/admin`).send({ is_admin: false });
    expect(res.status).toBe(409);
    // Still admin.
    expect((await admin.get('/api/auth/status')).body.is_admin).toBe(true);
  });

  it('allows self-demote when another admin exists', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const list = (await admin.get('/api/admin/users')).body;
    const userId = list.find((u) => u.username === user.username).id;
    const selfId = list.find((u) => u.username === admin.username).id;

    await admin.post(`/api/admin/users/${userId}/admin`).send({ is_admin: true }); // now two admins
    const res = await admin.post(`/api/admin/users/${selfId}/admin`).send({ is_admin: false });
    expect(res.status).toBe(200);
    expect((await admin.get('/api/auth/status')).body.is_admin).toBe(false);
  });

  it('demoting an already-non-admin is a 200 no-op even when only one admin exists', async () => {
    // The atomic demote guard blocks the write while <=1 admin remains; a target that is
    // ALREADY non-admin must still report success (desired state already holds), not 409.
    const { admin, user } = await adminAndUserAgents(app);
    const userId = (await admin.get('/api/admin/users')).body.find((u) => u.username === user.username).id;
    const res = await admin.post(`/api/admin/users/${userId}/admin`).send({ is_admin: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: userId, is_admin: false });
  });

  it('atomic demote guard: concurrent cross-demotes of the two last admins keep >=1 admin', async () => {
    // Two admins, A and B. Fire A-demotes-B and B-demotes-A concurrently. The single
    // guarded UPDATE (…AND (SELECT COUNT(*) WHERE is_admin=1) > 1) makes the count+write
    // atomic, so the invariant "an admin always remains" holds no matter the interleave.
    // In-process the driver serializes the two writes; we assert exactly one 200 / one
    // 409 (the loser sees only one admin left) and that admins never reached zero.
    const { admin, user } = await adminAndUserAgents(app);
    const list = (await admin.get('/api/admin/users')).body;
    const adminId = list.find((u) => u.username === admin.username).id;
    const userId = list.find((u) => u.username === user.username).id;
    // Promote the second user so there are exactly two admins.
    await admin.post(`/api/admin/users/${userId}/admin`).send({ is_admin: true });

    const ctx = app.locals.ctx;
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')).n).toBe(2);

    // A demotes B and B demotes A, concurrently.
    const [r1, r2] = await Promise.all([
      admin.post(`/api/admin/users/${userId}/admin`).send({ is_admin: false }),
      user.post(`/api/admin/users/${adminId}/admin`).send({ is_admin: false }),
    ]);

    // Exactly one demote wins (200). The loser is rejected — either by the atomic guard
    // (409, its UPDATE ran but only one admin remained) or by the admin gate (403, it was
    // demoted before its own request re-read is_admin). Both outcomes uphold the invariant;
    // what must NEVER happen is two 200s (which would be the zero-admin TOCTOU). The
    // deterministic 409 guard path is covered by the single-admin self-demote test above.
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    // The invariant: at least one admin still remains (never dropped to zero).
    const remaining = (await ctx.db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')).n;
    expect(remaining).toBe(1);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  it('cascades vehicles/records/reminders/photos, invalidates sessions, removes photo files', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const ctx = app.locals.ctx;

    const v = await makeVehicle(user, { name: 'Doomed Car' });
    await addRecord(user, v.id);
    await addReminder(user, v.id, { interval_months: 6 });
    const photo = (await uploadPhoto(user, v.id)).body[0];
    const photoOnDisk = path.join(dataDir, 'photos', photo.filename);
    expect(fs.existsSync(photoOnDisk)).toBe(true);

    const userId = (await admin.get('/api/admin/users')).body.find((u) => u.username === user.username).id;

    const del = await admin.delete(`/api/admin/users/${userId}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, id: userId });

    // Rows gone.
    expect(await ctx.db.get('SELECT * FROM users WHERE id = ?', [userId])).toBeUndefined();
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?', [userId])).n).toBe(0);
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM records WHERE vehicle_id = ?', [v.id])).n).toBe(0);
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM reminders WHERE vehicle_id = ?', [v.id])).n).toBe(0);
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM photos WHERE vehicle_id = ?', [v.id])).n).toBe(0);
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId])).n).toBe(0);

    // Session invalidated: the deleted user's cookie no longer works.
    expect((await user.get('/api/vehicles')).status).toBe(401);
    // Photo file removed from the store (disk).
    expect(fs.existsSync(photoOnDisk)).toBe(false);
  });

  it('409 when deleting the last remaining admin', async () => {
    const admin = await authAgent(app);
    const selfId = (await admin.get('/api/admin/users')).body.find((u) => u.username === admin.username).id;
    const res = await admin.delete(`/api/admin/users/${selfId}`);
    expect(res.status).toBe(409);
  });

  it('404 for a nonexistent user', async () => {
    const admin = await authAgent(app);
    expect((await admin.delete('/api/admin/users/99999')).status).toBe(404);
  });

  it('atomic guard allows deleting a non-last admin (>=1 admin remains)', async () => {
    // The delete guard is NOT (is_admin=1 AND count<=1): a promoted second admin can be
    // deleted while the first remains. Confirms the atomic guard permits the write when
    // more than one admin exists, and never drops admins to zero.
    const { admin, user } = await adminAndUserAgents(app);
    const ctx = app.locals.ctx;
    const userId = (await admin.get('/api/admin/users')).body.find((u) => u.username === user.username).id;
    await admin.post(`/api/admin/users/${userId}/admin`).send({ is_admin: true }); // two admins
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')).n).toBe(2);

    const del = await admin.delete(`/api/admin/users/${userId}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, id: userId });
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')).n).toBe(1);
    expect(await ctx.db.get('SELECT * FROM users WHERE id = ?', [userId])).toBeUndefined();
  });
});

// --- Cross-account vehicle view ---------------------------------------------

describe('GET /api/admin/vehicles', () => {
  it('shows vehicles across users incl. NULL-owned, with owner_username', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const ctx = app.locals.ctx;
    const av = await makeVehicle(admin, { name: 'Admin Car' });
    const uv = await makeVehicle(user, { name: 'User Car' });
    const orphan = await ctx.db.run(
      'INSERT INTO vehicles (user_id, make, model, year) VALUES (NULL, ?, ?, ?)',
      ['Legacy', 'Ghost', 2000]
    );

    const res = await admin.get('/api/admin/vehicles');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((v) => [v.id, v]));
    expect(byId[av.id].owner_username).toBe(admin.username);
    expect(byId[uv.id].owner_username).toBe(user.username);
    expect(byId[orphan.lastInsertRowid].owner_username).toBeNull();
  });

  it('403 for non-admin', async () => {
    const { user } = await adminAndUserAgents(app);
    expect((await user.get('/api/admin/vehicles')).status).toBe(403);
  });
});

// --- Adopt orphans ----------------------------------------------------------

describe('POST /api/admin/vehicles/:id/owner', () => {
  it('reassigns a NULL-owned vehicle to a user, who then sees it via /api/vehicles', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const ctx = app.locals.ctx;
    const orphan = await ctx.db.run(
      'INSERT INTO vehicles (user_id, make, model, year) VALUES (NULL, ?, ?, ?)',
      ['Legacy', 'Ghost', 2001]
    );
    const orphanId = orphan.lastInsertRowid;

    // Invisible to the user beforehand.
    expect((await user.get('/api/vehicles')).body).toEqual([]);

    const userId = (await admin.get('/api/admin/users')).body.find((u) => u.username === user.username).id;
    const res = await admin.post(`/api/admin/vehicles/${orphanId}/owner`).send({ user_id: userId });
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(userId);

    const list = await user.get('/api/vehicles');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(orphanId);
  });

  it('404 when reassigning to a nonexistent user', async () => {
    const { admin } = await adminAndUserAgents(app);
    const ctx = app.locals.ctx;
    const orphan = await ctx.db.run(
      'INSERT INTO vehicles (user_id, make, model, year) VALUES (NULL, ?, ?, ?)',
      ['Legacy', 'Ghost', 2002]
    );
    const res = await admin.post(`/api/admin/vehicles/${orphan.lastInsertRowid}/owner`).send({ user_id: 99999 });
    expect(res.status).toBe(404);
  });

  it('404 for a nonexistent vehicle', async () => {
    const admin = await authAgent(app);
    const selfId = (await admin.get('/api/admin/users')).body[0].id;
    expect((await admin.post('/api/admin/vehicles/99999/owner').send({ user_id: selfId })).status).toBe(404);
  });

  it('can unassign a vehicle back to unowned with user_id:null', async () => {
    const { admin } = await adminAndUserAgents(app);
    const v = await makeVehicle(admin, { name: 'Releasable' });
    const res = await admin.post(`/api/admin/vehicles/${v.id}/owner`).send({ user_id: null });
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBeNull();
    // Now invisible to the (former owner) admin's per-user list.
    expect((await admin.get('/api/vehicles')).body.map((x) => x.id)).not.toContain(v.id);
  });
});

describe('POST /api/admin/vehicles/adopt-orphans', () => {
  it('bulk-assigns all NULL-owned vehicles to a user', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const ctx = app.locals.ctx;
    for (let i = 0; i < 3; i++) {
      await ctx.db.run('INSERT INTO vehicles (user_id, make, model, year) VALUES (NULL, ?, ?, ?)', ['L', 'G', 2000 + i]);
    }
    const userId = (await admin.get('/api/admin/users')).body.find((u) => u.username === user.username).id;

    const res = await admin.post('/api/admin/vehicles/adopt-orphans').send({ user_id: userId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ adopted: 3, user_id: userId });

    expect((await user.get('/api/vehicles')).body).toHaveLength(3);
    // No orphans remain.
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM vehicles WHERE user_id IS NULL')).n).toBe(0);
  });

  it('404 when the target user does not exist', async () => {
    const admin = await authAgent(app);
    expect((await admin.post('/api/admin/vehicles/adopt-orphans').send({ user_id: 99999 })).status).toBe(404);
  });
});

// --- Isolation preserved (admin powers don't leak into per-user routes) ------

describe('isolation preserved', () => {
  it("admin's own /api/vehicles shows only the admin's vehicles", async () => {
    const { admin, user } = await adminAndUserAgents(app);
    await makeVehicle(admin, { name: 'Admin Only' });
    await makeVehicle(user, { name: 'User Only' });

    const list = await admin.get('/api/vehicles');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Admin Only');
  });
});

// --- Migration on an EXISTING (pre-roles) database ---------------------------

describe('migration promotes the earliest user on an existing DB', () => {
  // Simulate a production DB created before is_admin existed: build the OLD schema
  // (users table without is_admin), insert users, then open the app (which runs the
  // migration) and assert the lowest-id user became admin, idempotently.
  function oldUsersStatement() {
    // The current users CREATE TABLE minus the is_admin column.
    return SCHEMA_STATEMENTS.find((s) => /CREATE TABLE IF NOT EXISTS users/.test(s)).replace(
      /\n\s*is_admin INTEGER NOT NULL DEFAULT 0,/,
      ''
    );
  }

  async function seedLegacyDb(dir) {
    // Use a raw libsql/better-sqlite3-independent path: write via a facade pointed at
    // the OLD schema is hard, so instead insert users through a temporary better-sqlite3
    // handle in sqlite mode. For driver-agnostic coverage we seed with the app's own
    // facade AFTER stripping is_admin is not possible; so we craft the file directly.
    const Database = (await import('better-sqlite3')).default;
    fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
    const db = new Database(path.join(dir, 'carmaint.db'));
    db.exec(oldUsersStatement());
    const insert = db.prepare(
      'INSERT INTO users (username, password_hash, calendar_token) VALUES (?, ?, ?)'
    );
    insert.run('legacy_first', 'scrypt:1:1:1:00:00', 'tok-first');
    insert.run('legacy_second', 'scrypt:1:1:1:00:00', 'tok-second');
    const ids = db.prepare('SELECT id FROM users ORDER BY id ASC').all().map((r) => r.id);
    db.close();
    return ids;
  }

  it('lowest id promoted to admin; idempotent on re-open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-legacy-'));
    try {
      const [firstId, secondId] = await seedLegacyDb(dir);

      // Open the app → runs the migration (adds is_admin + promotes lowest id).
      const app1 = makeApp(dir);
      const ctx1 = app1.locals.ctx;
      await ctx1.db.ready;
      const admins1 = await ctx1.db.all('SELECT id, is_admin FROM users ORDER BY id ASC');
      expect(admins1.find((u) => u.id === firstId).is_admin).toBe(1);
      expect(admins1.find((u) => u.id === secondId).is_admin).toBe(0);
      await ctx1.db.close();

      // Re-open: migration re-runs but must NOT clobber / add a second admin.
      const app2 = makeApp(dir);
      const ctx2 = app2.locals.ctx;
      await ctx2.db.ready;
      const count = (await ctx2.db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')).n;
      expect(count).toBe(1);
      const stillFirst = (await ctx2.db.get('SELECT is_admin FROM users WHERE id = ?', [firstId])).is_admin;
      expect(stillFirst).toBe(1);
      await ctx2.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not re-promote after the admin was deliberately demoted-and-reassigned', async () => {
    // Existing DB where an admin already exists (not the lowest id): migration must be
    // a no-op and leave the chosen admin alone.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-legacy2-'));
    try {
      const app1 = makeApp(dir);
      const ctx1 = app1.locals.ctx;
      await ctx1.db.ready;
      // Register two users (first is admin by the register path), then move admin to #2.
      await request(app1).post('/api/register').send({ username: 'boot_admin', password: 'password12345' });
      await request(app1).post('/api/register').send({ username: 'other_user', password: 'password12345' });
      const ids = await ctx1.db.all('SELECT id FROM users ORDER BY id ASC');
      await ctx1.db.run('UPDATE users SET is_admin = 0 WHERE id = ?', [ids[0].id]);
      await ctx1.db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [ids[1].id]);
      await ctx1.db.close();

      // Re-open → POST_MIGRATIONS must NOT promote the lowest id (an admin exists).
      const app2 = makeApp(dir);
      const ctx2 = app2.locals.ctx;
      await ctx2.db.ready;
      const rows = await ctx2.db.all('SELECT id, is_admin FROM users ORDER BY id ASC');
      expect(rows[0].is_admin).toBe(0);
      expect(rows[1].is_admin).toBe(1);
      expect(rows.filter((r) => r.is_admin === 1)).toHaveLength(1);
      await ctx2.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concurrent init on the same file is safe (both ready; single admin)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-legacy3-'));
    try {
      await seedLegacyDb(dir);
      const url = `file:${path.join(dir, 'carmaint.db')}`;
      const f1 = createDataFacade({ driver: 'libsql', url });
      const f2 = createDataFacade({ driver: 'libsql', url });
      await expect(Promise.all([f1.ready, f2.ready])).resolves.toBeDefined();
      const count = (await f1.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')).n;
      expect(count).toBe(1);
      await f1.close();
      await f2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
