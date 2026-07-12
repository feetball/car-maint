import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent, adminAndUserAgents } from './helpers.js';
import { totpCode as totp } from '../src/mfa.js';
import { LOGIN_RATELIMIT_MAX } from '../src/auth.js';

// Regression coverage for the adversarial-review findings:
//   CRITICAL — enrollment endpoints reachable in the login-pending state let a
//              password-only attacker overwrite the victim's factor and mint a full
//              session (account takeover + victim lockout).
//   IMPORTANT #2 — admin user-delete must remove all MFA rows explicitly (libsql has
//              no FK cascade), or they orphan.
//   IMPORTANT #3 — /api/login needs a per-account brute-force rate limit.

// Capturing mailer stub (same shape as mfa.test.js): parses the last-sent 6-digit code.
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-bypass-'));
  app = makeApp(dataDir);
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Puts a fresh, independent agent into the login-pending state for an already-enrolled
// user (password verified, second factor NOT yet passed) and returns it.
async function loginPending(theApp, username, password) {
  const a = request.agent(theApp);
  const step1 = await a.post('/api/login').send({ username, password });
  expect(step1.status).toBe(200);
  expect(step1.body.mfa_required).toBe(true);
  return a;
}

describe('CRITICAL: enrollment endpoints are blocked in the login-pending state', () => {
  it('every enroll/mutate MFA endpoint → 403 for kind=login', async () => {
    const victim = await authAgent(app, { username: 'victim1', password: 'password12345' });
    await victim.post('/api/logout');
    const attacker = await loginPending(app, 'victim1', 'password12345');

    // Data API is off-limits (baseline for the state).
    expect((await attacker.get('/api/vehicles')).status).toBe(403);

    // Enrollment / factor-mutation surface — all BLOCKED at the gate (403).
    expect((await attacker.post('/api/mfa/totp/setup').send({})).status).toBe(403);
    expect((await attacker.post('/api/mfa/totp/confirm').send({ code: '000000' })).status).toBe(403);
    expect((await attacker.post('/api/mfa/webauthn/register/options').send({})).status).toBe(403);
    expect((await attacker.post('/api/mfa/webauthn/register/verify').send({ response: {} })).status).toBe(403);
    expect((await attacker.post('/api/mfa/email/setup').send({ email: 'a@b.com' })).status).toBe(403);
    expect((await attacker.post('/api/mfa/email/confirm').send({ code: '000000' })).status).toBe(403);
    expect((await attacker.post('/api/mfa/backup/regenerate').send({})).status).toBe(403);
  });

  it('the allowed second-factor surface still works for kind=login', async () => {
    const { mailer, lastCode } = makeMailer();
    const appM = makeApp(dataDir, { mailer });
    const victim = await authAgent(appM, { username: 'victim2', password: 'password12345' });
    // Enroll email as a SECOND factor (via the full session) so send-code has a
    // confirmed address to target during the challenge.
    await victim.post('/api/mfa/email/setup').send({ email: 'v2@example.com' });
    await victim.post('/api/mfa/email/confirm').send({ code: lastCode() });
    await victim.post('/api/logout');

    const a = await loginPending(appM, 'victim2', 'password12345');

    // status is readable (the second-factor screen lists available methods).
    const status = await a.get('/api/mfa/status');
    expect(status.status).toBe(200);
    expect(status.body.methods).toMatchObject({ totp: true, email: true });

    // email/send-code is reachable (delivers a login code to the confirmed address).
    const send = await a.post('/api/mfa/email/send-code').send({});
    expect(send.status).toBe(200);
    expect(send.body.sent).toBe(true);

    // /api/login/mfa is reachable and completes the login with the REAL factor.
    const done = await a.post('/api/login/mfa').send({ code: totp(victim.totpSecret), method: 'totp' });
    expect(done.status).toBe(200);
    expect((await a.get('/api/vehicles')).status).toBe(200);
  });

  it('logout works in the login-pending state', async () => {
    const victim = await authAgent(app, { username: 'victim3', password: 'password12345' });
    await victim.post('/api/logout');
    const a = await loginPending(app, 'victim3', 'password12345');
    const out = await a.post('/api/logout');
    expect(out.status).toBe(200);
    // Pending token burned → back to unauthenticated.
    expect((await a.get('/api/auth/status')).body).toEqual({ required: true, authenticated: false });
  });

  it('exploit is DEAD: blocked totp/setup neither overwrites the victim secret nor mints a session', async () => {
    const victim = await authAgent(app, { username: 'victim4', password: 'password12345' });
    const originalSecret = victim.totpSecret;
    await victim.post('/api/logout');
    const ctx = app.locals.ctx;
    const uid = (await ctx.db.get('SELECT id FROM users WHERE username = ?', ['victim4'])).id;

    // Attacker with only username+password: run the exact exploit steps.
    const attacker = await loginPending(app, 'victim4', 'password12345');
    const setup = await attacker.post('/api/mfa/totp/setup').send({});
    expect(setup.status).toBe(403); // gate blocks BEFORE the route writes pending_secret

    // Victim's stored secret is untouched; no pending_secret was written.
    const row = await ctx.db.get('SELECT secret, pending_secret FROM mfa_totp WHERE user_id = ?', [uid]);
    expect(row.secret).toBe(originalSecret);
    expect(row.pending_secret == null).toBe(true);

    // No full session was minted for the attacker; the data API is still 403.
    expect((await attacker.get('/api/vehicles')).status).toBe(403);

    // And the victim can still complete a normal login with their ORIGINAL authenticator.
    const legit = request.agent(app);
    await legit.post('/api/login').send({ username: 'victim4', password: 'password12345' });
    const ok = await legit.post('/api/login/mfa').send({ code: totp(originalSecret), method: 'totp' });
    expect(ok.status).toBe(200);
    expect((await legit.get('/api/vehicles')).status).toBe(200);
  });

  it('the SETUP state can still enroll the first factor and upgrade to a full session', async () => {
    // Register only → setup-pending (no active factor yet).
    const s = request.agent(app);
    await s.post('/api/register').send({ username: 'setup_ok', password: 'password12345' });
    const setup = await s.post('/api/mfa/totp/setup').send({});
    expect(setup.status).toBe(200); // enrollment IS allowed in setup state
    const confirm = await s.post('/api/mfa/totp/confirm').send({ code: totp(setup.body.secret_base32) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.authenticated).toBe(true); // upgraded to a full session
    expect((await s.get('/api/vehicles')).status).toBe(200);
  });
});

describe('IMPORTANT #2: admin user-delete removes all MFA rows (no cascade reliance)', () => {
  it('mfa_totp / mfa_backup_codes / mfa_email / webauthn_credentials / mfa_challenges all gone', async () => {
    const { admin, user } = await adminAndUserAgents(app);
    const ctx = app.locals.ctx;
    const uid = (await ctx.db.get('SELECT id FROM users WHERE username = ?', [user.username])).id;

    // authAgent already created mfa_totp + 10 mfa_backup_codes. Add email, a passkey
    // credential, and a pending challenge row directly so all five tables are populated.
    await ctx.db.run('INSERT INTO mfa_email (user_id, email, confirmed_at) VALUES (?, ?, ?)', [
      uid, 'del@example.com', new Date().toISOString(),
    ]);
    await ctx.db.run(
      'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter) VALUES (?, ?, ?, ?)',
      [uid, `cred-${uid}`, 'cGs=', 0]
    );
    await ctx.db.run(
      'INSERT INTO mfa_challenges (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
      [`chal-${uid}`, uid, 'login', new Date(Date.now() + 600000).toISOString()]
    );

    // Sanity: rows exist before delete.
    for (const t of ['mfa_totp', 'mfa_backup_codes', 'mfa_email', 'webauthn_credentials', 'mfa_challenges']) {
      expect((await ctx.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [uid])).n).toBeGreaterThan(0);
    }

    const del = await admin.delete(`/api/admin/users/${uid}`);
    expect(del.status).toBe(200);

    // Every MFA table is clean for the deleted user regardless of FK cascade support.
    for (const t of ['mfa_totp', 'mfa_backup_codes', 'mfa_email', 'webauthn_credentials', 'mfa_challenges']) {
      expect((await ctx.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [uid])).n).toBe(0);
    }
  });
});

describe('IMPORTANT #3: /api/login is rate-limited per account', () => {
  it('after the cap one username gets 429; a different username is unaffected', async () => {
    // Register (via authAgent — uses /api/register, not /api/login, so the login
    // counter starts clean) both a target and an untouched control account.
    await authAgent(app, { username: 'rl_target', password: 'password12345' });
    await authAgent(app, { username: 'rl_other', password: 'password12345' });

    // Exhaust the window for rl_target with wrong-password attempts (each counts).
    for (let i = 0; i < LOGIN_RATELIMIT_MAX; i++) {
      const r = await request(app).post('/api/login').send({ username: 'rl_target', password: 'wrong-password' });
      expect(r.status).not.toBe(429);
    }
    // Next attempt is over the cap → generic 429.
    const capped = await request(app).post('/api/login').send({ username: 'rl_target', password: 'wrong-password' });
    expect(capped.status).toBe(429);
    expect(capped.body.error).toMatch(/too many login attempts/i);

    // A DIFFERENT account is not throttled by the target's traffic.
    const other = await request(app).post('/api/login').send({ username: 'rl_other', password: 'password12345' });
    expect(other.status).not.toBe(429);
    expect(other.body.mfa_required).toBe(true);
  });
});
