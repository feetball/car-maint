import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent } from './helpers.js';
import { hashToken } from '../src/auth.js';

// Auth is always required now (multi-user accounts replaced the shared password).
let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-auth-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/auth/status', () => {
  it('reports required:true, authenticated:false without a session', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ required: true, authenticated: false });
  });

  it('reports authenticated:true and the username with a valid session', async () => {
    const agent = await authAgent(app, { username: 'alice_1', password: 'password12345' });
    const res = await agent.get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ required: true, authenticated: true, username: 'alice_1' });
  });

  it('is reachable without a session (never 401)', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/register', () => {
  it('creates a user, returns 201 {username} and sets a session cookie (auto-login)', async () => {
    const res = await request(app).post('/api/register').send({ username: 'bob_2', password: 'password12345' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ username: 'bob_2' });
    const setCookie = res.headers['set-cookie'];
    expect(Array.isArray(setCookie)).toBe(true);
    expect(setCookie.join(';')).toMatch(/carmaint_session=/);
    expect(setCookie.join(';')).toMatch(/HttpOnly/i);
  });

  it('rejects a too-short username and a too-short password with 400', async () => {
    const shortUser = await request(app).post('/api/register').send({ username: 'ab', password: 'password12345' });
    expect(shortUser.status).toBe(400);

    const shortPass = await request(app).post('/api/register').send({ username: 'valid_user', password: 'short' });
    expect(shortPass.status).toBe(400);

    const badChars = await request(app).post('/api/register').send({ username: 'bad name!', password: 'password12345' });
    expect(badChars.status).toBe(400);
  });

  it('rejects a duplicate username (case-insensitive) with 409', async () => {
    await request(app).post('/api/register').send({ username: 'Carol_3', password: 'password12345' });

    const dup = await request(app).post('/api/register').send({ username: 'Carol_3', password: 'otherpass123' });
    expect(dup.status).toBe(409);

    const dupCase = await request(app).post('/api/register').send({ username: 'carol_3', password: 'otherpass123' });
    expect(dupCase.status).toBe(409);
  });
});

describe('POST /api/login', () => {
  it('logs in with correct credentials and grants access', async () => {
    await request(app).post('/api/register').send({ username: 'dave_4', password: 'password12345' });

    const agent = request.agent(app);
    const res = await agent.post('/api/login').send({ username: 'dave_4', password: 'password12345' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'dave_4' });

    const guarded = await agent.get('/api/vehicles');
    expect(guarded.status).toBe(200);
    expect(Array.isArray(guarded.body)).toBe(true);
  });

  it('is case-insensitive on the username', async () => {
    await request(app).post('/api/register').send({ username: 'Eve_5', password: 'password12345' });
    const res = await request(app).post('/api/login').send({ username: 'eve_5', password: 'password12345' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('Eve_5');
  });

  it('rejects a wrong password with a generic 401 and no working session', async () => {
    await request(app).post('/api/register').send({ username: 'frank_6', password: 'password12345' });

    const agent = request.agent(app);
    const res = await agent.post('/api/login').send({ username: 'frank_6', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password');

    const guarded = await agent.get('/api/vehicles');
    expect(guarded.status).toBe(401);
  });

  it('rejects an unknown username with the same generic 401', async () => {
    const res = await request(app).post('/api/login').send({ username: 'nobody_here', password: 'password12345' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password');
  });
});

describe('cookie-gated access', () => {
  it('401s without a session on /api/vehicles and /photos/x', async () => {
    const api = await request(app).get('/api/vehicles');
    expect(api.status).toBe(401);
    expect(api.body.error).toBe('Authentication required');

    const photo = await request(app).get('/photos/anything.png');
    expect(photo.status).toBe(401);
    expect(photo.body.error).toBe('Authentication required');
  });

  it('logout deletes the session row and revokes access', async () => {
    const agent = await authAgent(app);
    expect((await agent.get('/api/vehicles')).status).toBe(200);

    const logout = await agent.post('/api/logout');
    expect(logout.status).toBe(200);
    expect(logout.body).toMatchObject({ authenticated: false });

    const after = await agent.get('/api/vehicles');
    expect(after.status).toBe(401);
  });
});

describe('session expiry', () => {
  it('rejects and prunes an expired session row', async () => {
    // Register to obtain a real user id, then insert a session that is already
    // expired and present it directly as the cookie.
    await request(app).post('/api/register').send({ username: 'grace_7', password: 'password12345' });
    const ctx = app.locals.ctx;
    const user = await ctx.db.get('SELECT id FROM users WHERE username = ?', ['grace_7']);

    const rawToken = 'a'.repeat(64); // any high-entropy-shaped value works for the test
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    await ctx.db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
      hashToken(rawToken),
      user.id,
      pastIso,
    ]);

    const res = await request(app).get('/api/vehicles').set('Cookie', `carmaint_session=${rawToken}`);
    expect(res.status).toBe(401);

    // The expired row is opportunistically deleted on access.
    const remaining = await ctx.db.get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', [
      hashToken(rawToken),
    ]);
    expect(remaining.n).toBe(0);
  });
});

describe('GET /api/calendar-url', () => {
  it('returns a per-user tokened feed URL, only when authenticated', async () => {
    const noAuth = await request(app).get('/api/calendar-url');
    expect(noAuth.status).toBe(401);

    const agent = await authAgent(app);
    const res = await agent.get('/api/calendar-url');
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/calendar\.ics\?token=[0-9a-f]+$/);

    // Calendar apps present the token (no cookie) — the feed still serves.
    const feed = await request(app).get(res.body.url);
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toMatch(/text\/calendar/);
  });
});
