import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent } from './helpers.js';
import { createApp } from '../src/app.js';
import { createDataFacade } from '../src/data/facade.js';

// Regression coverage for the adversarial-review CRITICAL/IMPORTANT findings:
//   C2  case-insensitive routing dodging the auth gate
//   C1/I1 fail-closed cron/backup gate + backups-require-session
//   C3  concurrency-safe migration ALTER
//   I2  login user-enumeration timing side channel

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-secfix-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Build an app with specific env (CRON_SECRET / VERCEL / NODE_ENV) applied only for
// the duration of construction, since createAuth reads them via app.js at build time.
function makeAppWithEnv(dir, env) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return makeApp(dir);
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('C2: case-insensitive routing does not bypass the auth gate', () => {
  it('GET /API/vehicles without a session → 401 (not 200/500)', async () => {
    const res = await request(app).get('/API/vehicles');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('GET /API/backups without a session → 401 (was proven to serve 200)', async () => {
    const res = await request(app).get('/API/backups');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('GET /Photos/x without a session → 401', async () => {
    const res = await request(app).get('/Photos/anything.png');
    expect(res.status).toBe(401);
  });

  it('a valid session still reaches the mixed-case route (routing unchanged)', async () => {
    const agent = await authAgent(app);
    const res = await agent.get('/API/vehicles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('C1/I1: /api/backups requires a session even with a valid cron bearer', () => {
  it('correct CRON bearer but NO session cookie → 401', async () => {
    const secret = 'test-cron-secret-123';
    const appS = makeAppWithEnv(dataDir, { CRON_SECRET: secret });
    const res = await request(appS)
      .get('/api/backups')
      .set('Authorization', `Bearer ${secret}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('session + correct CRON bearer → 200 (works)', async () => {
    const secret = 'test-cron-secret-123';
    const appS = makeAppWithEnv(dataDir, { CRON_SECRET: secret });
    const agent = await authAgent(appS);
    const res = await agent.get('/api/backups').set('Authorization', `Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('session but WRONG/absent bearer with CRON_SECRET set → 401', async () => {
    const secret = 'test-cron-secret-123';
    const appS = makeAppWithEnv(dataDir, { CRON_SECRET: secret });
    const agent = await authAgent(appS);
    const res = await agent.get('/api/backups'); // no bearer
    expect(res.status).toBe(401);
  });
});

describe('C1/I1: production fail-closed when CRON_SECRET is unset', () => {
  it('VERCEL=1 + no CRON_SECRET: /api/cron/backup → 401 (fail-closed)', async () => {
    const appP = makeAppWithEnv(dataDir, { VERCEL: '1', CRON_SECRET: undefined });
    const res = await request(appP).get('/api/cron/backup');
    expect(res.status).toBe(401);
  });

  it('VERCEL=1 + no CRON_SECRET: /api/backups (even with session) → 401', async () => {
    const appP = makeAppWithEnv(dataDir, { VERCEL: '1', CRON_SECRET: undefined });
    const agent = await authAgent(appP);
    const res = await agent.get('/api/backups');
    expect(res.status).toBe(401);
  });

  it('NODE_ENV=production + no CRON_SECRET: /api/cron/notify → 401', async () => {
    const appP = makeAppWithEnv(dataDir, { NODE_ENV: 'production', CRON_SECRET: undefined });
    const res = await request(appP).get('/api/cron/notify');
    expect(res.status).toBe(401);
  });

  it('dev (no env) + no CRON_SECRET: /api/cron/backup stays open → not 401', async () => {
    const res = await request(app).get('/api/cron/backup');
    expect(res.status).not.toBe(401);
  });
});

describe('C3: concurrent migration ALTER does not brick the facade', () => {
  it('two libsql facades on the same file both become ready; column present; no reject', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-migrace-'));
    const url = `file:${path.join(dir, 'carmaint.db')}`;
    try {
      // Two facades over the SAME file, initialized concurrently — mirrors two cold
      // starts racing the ALTER. Neither `ready` must reject.
      const f1 = createDataFacade({ driver: 'libsql', url });
      const f2 = createDataFacade({ driver: 'libsql', url });
      await expect(Promise.all([f1.ready, f2.ready])).resolves.toBeDefined();

      const cols = await f1.all('PRAGMA table_info(vehicles)');
      expect(cols.some((c) => c.name === 'user_id')).toBe(true);

      // Both instances still serve queries (no permanent 500 state).
      await expect(f1.all('SELECT * FROM vehicles')).resolves.toEqual([]);
      await expect(f2.all('SELECT * FROM vehicles')).resolves.toEqual([]);
      await f1.close();
      await f2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-initializing an already-migrated sqlite db is idempotent (no throw)', async () => {
    // makeApp already created + migrated the db; a second app on the same dir runs
    // runMigrations again against the existing column and must not throw.
    const app2 = makeApp(dataDir);
    const res = await request(app2).get('/api/auth/status');
    expect(res.status).toBe(200);
  });
});

describe('I2: login user-miss path runs a scrypt verify (no timing oracle)', () => {
  it('unknown username → generic 401 and spends real verify time', async () => {
    // Register a real user so a dummy hash and a real hash exist to compare shapes.
    await request(app).post('/api/register').send({ username: 'timing_real', password: 'password12345' });

    const t0 = process.hrtime.bigint();
    const miss = await request(app).post('/api/login').send({ username: 'no_such_user', password: 'password12345' });
    const t1 = process.hrtime.bigint();
    expect(miss.status).toBe(401);
    expect(miss.body.error).toBe('Invalid username or password');

    // Coarse assertion: the miss path is not a trivial early return — it runs scrypt,
    // which costs real milliseconds (scryptSync with N=16384). This is intentionally
    // loose to avoid flakiness; the goal is proving scrypt runs, not exact parity.
    const missMs = Number(t1 - t0) / 1e6;
    expect(missMs).toBeGreaterThan(1);
  });

  it('wrong password for a real user still → generic 401', async () => {
    await request(app).post('/api/register').send({ username: 'timing_real2', password: 'password12345' });
    const res = await request(app).post('/api/login').send({ username: 'timing_real2', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password');
  });
});
