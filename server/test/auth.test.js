import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp } from './helpers.js';

// Auth is enabled purely by the APP_PASSWORD env var (createApp reads it from the
// environment; there is no explicit option), so each test sets/unsets it around
// building the app and restores whatever was there before.
const PASSWORD = 'open-sesame-01234';

let dataDir;
let savedPassword;
let savedSecret;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-auth-'));
  savedPassword = process.env.APP_PASSWORD;
  savedSecret = process.env.AUTH_SECRET;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (savedPassword === undefined) delete process.env.APP_PASSWORD;
  else process.env.APP_PASSWORD = savedPassword;
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

function enableAuth() {
  process.env.APP_PASSWORD = PASSWORD;
  delete process.env.AUTH_SECRET;
  return makeApp(dataDir);
}

function disableAuth() {
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  return makeApp(dataDir);
}

describe('GET /api/auth/status', () => {
  it('reports required:true, authenticated:false when enabled and no cookie', async () => {
    const app = enableAuth();
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ required: true, authenticated: false });
  });

  it('reports required:false, authenticated:true when auth is disabled', async () => {
    const app = disableAuth();
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ required: false, authenticated: true });
  });

  it('is reachable without a cookie even when auth is enabled', async () => {
    const app = enableAuth();
    const res = await request(app).get('/api/auth/status');
    // Not a 401 — status is always public.
    expect(res.status).toBe(200);
  });
});

describe('POST /api/login', () => {
  it('rejects a wrong password with 401 and no working session', async () => {
    const app = enableAuth();
    const agent = request.agent(app);
    const res = await agent.post('/api/login').send({ password: 'not-the-password' });
    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe('string');

    // The failed login must not have granted access.
    const guarded = await agent.get('/api/vehicles');
    expect(guarded.status).toBe(401);
  });

  it('accepts the right password, returns the auth shape and sets a cookie', async () => {
    const app = enableAuth();
    const res = await request(app).post('/api/login').send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true, required: true });
    const setCookie = res.headers['set-cookie'];
    expect(Array.isArray(setCookie)).toBe(true);
    expect(setCookie.join(';')).toMatch(/carmaint_session=/);
    expect(setCookie.join(';')).toMatch(/HttpOnly/i);
  });
});

describe('cookie-gated access', () => {
  it('401s without a cookie on /api/vehicles and /photos/x', async () => {
    const app = enableAuth();

    const api = await request(app).get('/api/vehicles');
    expect(api.status).toBe(401);
    expect(api.body.error).toBe('Authentication required');

    const photo = await request(app).get('/photos/anything.png');
    expect(photo.status).toBe(401);
    expect(photo.body.error).toBe('Authentication required');
  });

  it('grants access once the login cookie is held', async () => {
    const app = enableAuth();
    const agent = request.agent(app);
    const login = await agent.post('/api/login').send({ password: PASSWORD });
    expect(login.status).toBe(200);

    const res = await agent.get('/api/vehicles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('logout revokes the session', async () => {
    const app = enableAuth();
    const agent = request.agent(app);
    await agent.post('/api/login').send({ password: PASSWORD });
    expect((await agent.get('/api/vehicles')).status).toBe(200);

    const logout = await agent.post('/api/logout');
    expect(logout.status).toBe(200);
    expect(logout.body).toMatchObject({ authenticated: false });

    const after = await agent.get('/api/vehicles');
    expect(after.status).toBe(401);
  });
});

describe('GET /calendar.ics token gating', () => {
  it('401s without a token, 200s with the token from /api/calendar-url', async () => {
    const app = enableAuth();

    const noToken = await request(app).get('/calendar.ics');
    expect(noToken.status).toBe(401);

    const badToken = await request(app).get('/calendar.ics?token=deadbeef');
    expect(badToken.status).toBe(401);

    // The tokened URL is only obtainable while authenticated.
    const agent = request.agent(app);
    await agent.post('/api/login').send({ password: PASSWORD });
    const urlRes = await agent.get('/api/calendar-url');
    expect(urlRes.status).toBe(200);
    expect(urlRes.body.url).toMatch(/^\/calendar\.ics\?token=[0-9a-f]+$/);

    // Subscribing calendar apps present the token, not a cookie: a plain request
    // (no session cookie) with the token succeeds.
    const feed = await request(app).get(urlRes.body.url);
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toMatch(/text\/calendar/);
  });
});

describe('no-password mode leaves everything open', () => {
  it('serves /api and /calendar.ics without any credentials', async () => {
    const app = disableAuth();

    const status = await request(app).get('/api/auth/status');
    expect(status.body.required).toBe(false);

    const list = await request(app).get('/api/vehicles');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    const feed = await request(app).get('/calendar.ics');
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toMatch(/text\/calendar/);

    // calendar-url is reachable and returns the untokened path when auth is off.
    const urlRes = await request(app).get('/api/calendar-url');
    expect(urlRes.status).toBe(200);
    expect(urlRes.body.url).toBe('/calendar.ics');
  });
});
