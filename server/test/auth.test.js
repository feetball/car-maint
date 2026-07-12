import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent, totpCode } from './helpers.js';
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
    // First-ever user is the bootstrap admin, so is_admin is true here.
    expect(res.body).toEqual({ required: true, authenticated: true, username: 'alice_1', is_admin: true });
  });

  it('is reachable without a session (never 401)', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/register', () => {
  it('creates a user, returns 201 setup-required and sets the pending MFA cookie (no session yet)', async () => {
    const res = await request(app).post('/api/register').send({ username: 'bob_2', password: 'password12345' });
    expect(res.status).toBe(201);
    // MFA is required for everyone: registration yields the limited setup-required
    // state, NOT a full session. First-ever user is still the bootstrap admin.
    expect(res.body).toEqual({ username: 'bob_2', is_admin: true, mfa_setup_required: true });
    const setCookie = res.headers['set-cookie'];
    expect(Array.isArray(setCookie)).toBe(true);
    // The pending MFA cookie is set; the real session cookie is NOT.
    expect(setCookie.join(';')).toMatch(/carmaint_mfa=/);
    expect(setCookie.join(';')).not.toMatch(/carmaint_session=/);
    expect(setCookie.join(';')).toMatch(/HttpOnly/i);

    // The setup state cannot reach the data API.
    const agent = request.agent(app);
    await agent.post('/api/register').send({ username: 'bob_2b', password: 'password12345' });
    const blocked = await agent.get('/api/vehicles');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ mfa_setup_required: true });
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
  it('with MFA enrolled: correct password returns mfa_required (no session yet), then TOTP grants access', async () => {
    // authAgent enrolls TOTP; log a fresh agent through the two-step flow.
    const enrolled = await authAgent(app, { username: 'dave_4', password: 'password12345' });

    const agent = request.agent(app);
    const step1 = await agent.post('/api/login').send({ username: 'dave_4', password: 'password12345' });
    expect(step1.status).toBe(200);
    expect(step1.body.mfa_required).toBe(true);
    expect(step1.body.methods).toEqual(expect.arrayContaining(['totp', 'backup']));
    // No full session yet — data API blocked.
    expect((await agent.get('/api/vehicles')).status).toBe(403);

    const step2 = await agent.post('/api/login/mfa').send({ code: totpCode(enrolled.totpSecret) });
    expect(step2.status).toBe(200);
    expect(step2.body).toEqual({ username: 'dave_4', is_admin: true });

    const guarded = await agent.get('/api/vehicles');
    expect(guarded.status).toBe(200);
    expect(Array.isArray(guarded.body)).toBe(true);
  });

  it('is case-insensitive on the username at the password step', async () => {
    await authAgent(app, { username: 'Eve_5', password: 'password12345' });
    const res = await request(app).post('/api/login').send({ username: 'eve_5', password: 'password12345' });
    expect(res.status).toBe(200);
    expect(res.body.mfa_required).toBe(true);
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
