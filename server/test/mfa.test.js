import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent } from './helpers.js';
import { totpCode as totp } from '../src/mfa.js';

// Capturing mailer stub: no real email is sent; the last-sent code is parsed from
// the message text (a realistic capture point the client-visible body already has).
function makeMailer() {
  const sent = [];
  const mailer = {
    configured: true,
    async send(msg) {
      const code = (msg.text.match(/\b(\d{6})\b/) || [])[1];
      sent.push({ ...msg, code });
    },
  };
  return { mailer, sent, lastCode: () => sent[sent.length - 1]?.code };
}

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-mfa-'));
  app = makeApp(dataDir);
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Register a user WITHOUT enrolling (leaves the agent in setup-required state).
async function registerOnly(a, username = 'user_setup', password = 'password12345') {
  const res = await a.post('/api/register').send({ username, password });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ mfa_setup_required: true });
  return { username, password };
}

describe('TOTP enrollment', () => {
  it('setup returns secret + otpauth uri; wrong code 400; right code 200 + backup codes; activates MFA', async () => {
    const agent = request.agent(app);
    await registerOnly(agent);

    const setup = await agent.post('/api/mfa/totp/setup').send({});
    expect(setup.status).toBe(200);
    expect(setup.body.secret_base32).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/CarMaint:/);
    expect(setup.body.otpauth_uri).toContain(`secret=${setup.body.secret_base32}`);

    const bad = await agent.post('/api/mfa/totp/confirm').send({ code: '000000' });
    expect(bad.status).toBe(400);

    const good = await agent.post('/api/mfa/totp/confirm').send({ code: totp(setup.body.secret_base32) });
    expect(good.status).toBe(200);
    expect(good.body.mfa_enabled).toBe(true);
    expect(Array.isArray(good.body.backup_codes)).toBe(true);
    expect(good.body.backup_codes).toHaveLength(10);
    // Completing setup upgrades to a full session (data API reachable).
    expect(good.body.authenticated).toBe(true);
    expect((await agent.get('/api/vehicles')).status).toBe(200);

    const status = await agent.get('/api/mfa/status');
    expect(status.body).toMatchObject({
      methods: { totp: true, email: false },
      backup_codes_remaining: 10,
      mfa_enabled: true,
    });
  });

  it('confirm without setup → 400', async () => {
    const agent = request.agent(app);
    await registerOnly(agent);
    const res = await agent.post('/api/mfa/totp/confirm').send({ code: '123456' });
    expect(res.status).toBe(400);
  });
});

describe('login state machine (TOTP)', () => {
  it('register→setup blocked; enroll→full; logout; login→mfa_required blocked; wrong code caps out; right code→full', async () => {
    // register → setup-required, data blocked
    const agent = await authAgent(app, { username: 'sm_user', password: 'password12345' });
    // authAgent already enrolled + full session
    expect((await agent.get('/api/vehicles')).status).toBe(200);

    // logout
    await agent.post('/api/logout');
    expect((await agent.get('/api/vehicles')).status).toBe(401);

    // login step 1 → mfa_required, still no session
    const fresh = request.agent(app);
    const step1 = await fresh.post('/api/login').send({ username: 'sm_user', password: 'password12345' });
    expect(step1.status).toBe(200);
    expect(step1.body.mfa_required).toBe(true);
    expect((await fresh.get('/api/vehicles')).status).toBe(403);

    // wrong code → 401 generic, pending stays valid (attempts 1..4)
    for (let i = 0; i < 4; i++) {
      const bad = await fresh.post('/api/login/mfa').send({ code: '000000' });
      expect(bad.status).toBe(401);
      expect(bad.body.error).toBe('Invalid code');
    }
    // 5th failure invalidates the pending token
    const capped = await fresh.post('/api/login/mfa').send({ code: '000000' });
    expect(capped.status).toBe(401);
    expect(capped.body.error).toMatch(/too many attempts/i);

    // pending token now gone → must re-login
    const afterCap = await fresh.post('/api/login/mfa').send({ code: totp(agent.totpSecret) });
    expect(afterCap.status).toBe(401);

    // re-login and pass the real code → full session
    const fresh2 = request.agent(app);
    await fresh2.post('/api/login').send({ username: 'sm_user', password: 'password12345' });
    const ok = await fresh2.post('/api/login/mfa').send({ code: totp(agent.totpSecret) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ username: 'sm_user' });
    expect((await fresh2.get('/api/vehicles')).status).toBe(200);
  });
});

describe('backup codes', () => {
  it('login with a backup code works; same code twice fails; remaining count decrements', async () => {
    const agent = await authAgent(app, { username: 'bk_user' });
    const codes = agent.backupCodes;
    await agent.post('/api/logout');

    const a = request.agent(app);
    await a.post('/api/login').send({ username: 'bk_user', password: agent.password });
    const use1 = await a.post('/api/login/mfa').send({ code: codes[0], method: 'backup' });
    expect(use1.status).toBe(200);
    expect((await a.get('/api/vehicles')).status).toBe(200);

    // remaining dropped to 9
    expect((await a.get('/api/mfa/status')).body.backup_codes_remaining).toBe(9);

    // reusing the same code fails
    const b = request.agent(app);
    await b.post('/api/login').send({ username: 'bk_user', password: agent.password });
    const reuse = await b.post('/api/login/mfa').send({ code: codes[0], method: 'backup' });
    expect(reuse.status).toBe(401);
  });

  it('concurrent use of one backup code → exactly one succeeds', async () => {
    const agent = await authAgent(app, { username: 'bk_race' });
    const code = agent.backupCodes[0];
    await agent.post('/api/logout');

    // Two independent pending-login sessions racing the SAME code.
    const a = request.agent(app);
    const b = request.agent(app);
    await a.post('/api/login').send({ username: 'bk_race', password: agent.password });
    await b.post('/api/login').send({ username: 'bk_race', password: agent.password });

    const [ra, rb] = await Promise.all([
      a.post('/api/login/mfa').send({ code, method: 'backup' }),
      b.post('/api/login/mfa').send({ code, method: 'backup' }),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('regenerate invalidates old codes and issues 10 new', async () => {
    const agent = await authAgent(app, { username: 'bk_regen' });
    const old = agent.backupCodes[0];

    const regen = await agent.post('/api/mfa/backup/regenerate').send({});
    expect(regen.status).toBe(200);
    expect(regen.body.backup_codes).toHaveLength(10);
    expect(regen.body.backup_codes).not.toContain(old);

    await agent.post('/api/logout');
    const a = request.agent(app);
    await a.post('/api/login').send({ username: 'bk_regen', password: agent.password });
    // old code no longer valid
    const stale = await a.post('/api/login/mfa').send({ code: old, method: 'backup' });
    expect(stale.status).toBe(401);
    // a new code works
    const b = request.agent(app);
    await b.post('/api/login').send({ username: 'bk_regen', password: agent.password });
    const ok = await b.post('/api/login/mfa').send({ code: regen.body.backup_codes[0], method: 'backup' });
    expect(ok.status).toBe(200);
  });
});

describe('email method', () => {
  it('setup sends+captures code, confirm activates; login via email code works', async () => {
    const { mailer, lastCode } = makeMailer();
    const appM = makeApp(dataDir, { mailer });
    const agent = await authAgent(appM, { username: 'em_user' });

    const setup = await agent.post('/api/mfa/email/setup').send({ email: 'a@b.com' });
    expect(setup.status).toBe(200);
    expect(setup.body.sent).toBe(true);
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);

    const confirm = await agent.post('/api/mfa/email/confirm').send({ code });
    expect(confirm.status).toBe(200);
    expect(confirm.body.mfa_enabled).toBe(true);

    const status = await agent.get('/api/mfa/status');
    expect(status.body.methods.email).toBe(true);

    // login via email: password → send-code → verify
    await agent.post('/api/logout');
    const a = request.agent(appM);
    const step1 = await a.post('/api/login').send({ username: 'em_user', password: agent.password });
    expect(step1.body.methods).toEqual(expect.arrayContaining(['email']));
    const send = await a.post('/api/mfa/email/send-code').send({});
    expect(send.status).toBe(200);
    const loginCode = lastCode();
    const verify = await a.post('/api/login/mfa').send({ code: loginCode, method: 'email' });
    expect(verify.status).toBe(200);
    expect((await a.get('/api/vehicles')).status).toBe(200);
  });

  it('SMTP unconfigured → email setup 400 (email is an unavailable method)', async () => {
    // Default app has no mailer configured.
    const agent = await authAgent(app, { username: 'em_noconf' });
    const res = await agent.post('/api/mfa/email/setup').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('wrong and expired email codes are rejected', async () => {
    const { mailer, lastCode } = makeMailer();
    const appM = makeApp(dataDir, { mailer });
    const agent = await authAgent(appM, { username: 'em_bad' });

    await agent.post('/api/mfa/email/setup').send({ email: 'a@b.com' });
    const wrong = await agent.post('/api/mfa/email/confirm').send({ code: '000000' });
    expect(wrong.status).toBe(400);

    // Force-expire the pending code directly, then confirm with the real code → rejected.
    const ctx = appM.locals.ctx;
    const u = await ctx.db.get('SELECT id FROM users WHERE username = ?', ['em_bad']);
    await ctx.db.run('UPDATE mfa_email SET code_expires_at = ? WHERE user_id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      u.id,
    ]);
    const expired = await agent.post('/api/mfa/email/confirm').send({ code: lastCode() });
    expect(expired.status).toBe(400);
    expect(expired.body.error).toMatch(/expired/i);
  });

  it('send-code during login is refused when email is not enrolled', async () => {
    const { mailer } = makeMailer();
    const appM = makeApp(dataDir, { mailer });
    const agent = await authAgent(appM, { username: 'em_notenrolled' });
    await agent.post('/api/logout');
    const a = request.agent(appM);
    await a.post('/api/login').send({ username: 'em_notenrolled', password: agent.password });
    const res = await a.post('/api/mfa/email/send-code').send({});
    expect(res.status).toBe(400);
  });
});

describe('last-factor guard', () => {
  it('cannot delete the only method (409); can delete one when two exist', async () => {
    const { mailer, lastCode } = makeMailer();
    const appM = makeApp(dataDir, { mailer });
    const agent = await authAgent(appM, { username: 'lf_user' });

    // Only TOTP active → cannot delete it.
    const del1 = await agent.delete('/api/mfa/totp');
    expect(del1.status).toBe(409);

    // Add email as a second factor.
    await agent.post('/api/mfa/email/setup').send({ email: 'a@b.com' });
    await agent.post('/api/mfa/email/confirm').send({ code: lastCode() });

    // Now TOTP can be removed (email remains).
    const del2 = await agent.delete('/api/mfa/totp');
    expect(del2.status).toBe(200);
    expect(del2.body.methods).toEqual({ totp: false, email: true, webauthn: false });

    // But now email is the last factor → cannot delete it.
    const del3 = await agent.delete('/api/mfa/email');
    expect(del3.status).toBe(409);
  });
});

describe('admin MFA reset', () => {
  it('admin clears a user MFA → user drops to setup_required', async () => {
    const admin = await authAgent(app, { username: 'reset_admin' });
    const user = await authAgent(app, { username: 'reset_target' });
    const uid = (await app.locals.ctx.db.get('SELECT id FROM users WHERE username = ?', ['reset_target'])).id;

    const reset = await admin.delete(`/api/admin/users/${uid}/mfa`);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ reset: true, mfa_setup_required: true });

    // The target's live session was invalidated.
    expect((await user.get('/api/vehicles')).status).toBe(401);

    // On re-login, the account is in setup-required (no active MFA).
    const a = request.agent(app);
    const login = await a.post('/api/login').send({ username: 'reset_target', password: user.password });
    expect(login.body).toMatchObject({ mfa_setup_required: true });
    expect((await a.get('/api/vehicles')).status).toBe(403);

    // A non-admin cannot reset anyone's MFA.
    const forbidden = await user.delete(`/api/admin/users/${uid}/mfa`);
    expect([401, 403]).toContain(forbidden.status);
  });
});

describe('gate enforcement in pending states', () => {
  it('setup-pending and login-pending states cannot reach data/photo/export routes', async () => {
    // setup-pending
    const s = request.agent(app);
    await s.post('/api/register').send({ username: 'gate_setup', password: 'password12345' });
    for (const p of ['/api/vehicles', '/photos/x.png', '/api/export/vehicles.csv', '/api/stats']) {
      const r = await s.get(p);
      expect(r.status).toBe(403);
    }
    // but MFA + status endpoints are reachable
    expect((await s.get('/api/mfa/status')).status).toBe(200);
    expect((await s.post('/api/mfa/totp/setup').send({})).status).toBe(200);

    // login-pending
    const enrolled = await authAgent(app, { username: 'gate_login' });
    await enrolled.post('/api/logout');
    const l = request.agent(app);
    await l.post('/api/login').send({ username: 'gate_login', password: enrolled.password });
    expect((await l.get('/api/vehicles')).status).toBe(403);
    expect((await l.get('/api/mfa/status')).status).toBe(200);
  });

  it('/api/auth/status reflects each state', async () => {
    // none
    expect((await request(app).get('/api/auth/status')).body).toEqual({
      required: true,
      authenticated: false,
    });

    // setup-pending
    const s = request.agent(app);
    await s.post('/api/register').send({ username: 'st_setup', password: 'password12345' });
    const setupStatus = await s.get('/api/auth/status');
    expect(setupStatus.body).toMatchObject({
      authenticated: false,
      mfa_setup_required: true,
      username: 'st_setup',
    });

    // full session
    const full = await authAgent(app, { username: 'st_full' });
    const fullStatus = await full.get('/api/auth/status');
    expect(fullStatus.body).toMatchObject({ authenticated: true, username: 'st_full' });

    // login-pending
    await full.post('/api/logout');
    const l = request.agent(app);
    await l.post('/api/login').send({ username: 'st_full', password: full.password });
    const pendingStatus = await l.get('/api/auth/status');
    expect(pendingStatus.body).toMatchObject({ authenticated: false, mfa_pending: true, username: 'st_full' });
  });
});

describe('no account-existence leak before password', () => {
  it('unknown username never reveals MFA state (generic 401, no mfa fields)', async () => {
    await authAgent(app, { username: 'known_user' });
    const res = await request(app).post('/api/login').send({ username: 'no_such_user', password: 'password12345' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid username or password' });
    expect(res.body.mfa_required).toBeUndefined();
    expect(res.body.mfa_setup_required).toBeUndefined();
  });
});
