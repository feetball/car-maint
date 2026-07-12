import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent } from './helpers.js';

// WebAuthn is impossible to exercise end-to-end without a real browser authenticator,
// so this suite splits into REAL and MOCKED parts:
//
//   REAL (not mocked):
//     - generateRegistrationOptions / generateAuthenticationOptions run for real, so
//       the options endpoints produce a genuine challenge which our handlers persist
//       in mfa_challenges and read back — the challenge persistence/lookup, RP/origin
//       derivation, and cold-start (no env) paths are all real.
//     - ALL of our own handler logic: credential storage, first-factor backup-code
//       issuance, session upgrade, counter update, cross-user credential isolation
//       (a pure DB scoping check that never reaches the library), attempt-cap, the
//       last-factor guard, admin reset, and backup/restore carry-through.
//
//   MOCKED:
//     - verifyRegistrationResponse / verifyAuthenticationResponse (the attestation /
//       assertion crypto) are replaced so we can drive verified:true / verified:false /
//       throw without a hardware authenticator. Their INPUTS still come from our real
//       challenge round-trip; only their cryptographic verdict is simulated.
const h = vi.hoisted(() => ({
  reg: { verified: true, registrationInfo: null },
  auth: { verified: true, authenticationInfo: { newCounter: 0 } },
  regThrow: false,
  authThrow: false,
}));

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // real generateRegistrationOptions / generateAuthenticationOptions
    verifyRegistrationResponse: async () => {
      if (h.regThrow) throw new Error('attestation failed');
      return h.reg;
    },
    verifyAuthenticationResponse: async () => {
      if (h.authThrow) throw new Error('assertion failed');
      return h.auth;
    },
  };
});

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-webauthn-'));
  app = makeApp(dataDir);
  h.reg = { verified: true, registrationInfo: null };
  h.auth = { verified: true, authenticationInfo: { newCounter: 0 } };
  h.regThrow = false;
  h.authThrow = false;
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const b64u = (s) => Buffer.from(s).toString('base64url');

// Point the registration mock at a specific credential.
function setRegCredential(credId, { counter = 0, transports } = {}) {
  h.reg = {
    verified: true,
    registrationInfo: {
      credential: {
        id: credId,
        publicKey: new Uint8Array([1, 2, 3, 4, 5]),
        counter,
        transports,
      },
    },
  };
}

// Full round-trip enrollment for an authenticated (or pending) agent: real options
// call (persists a real challenge), then verify (mock verdict). Returns the response.
async function enrollPasskey(agent, credId, { name, transports } = {}) {
  const opts = await agent.post('/api/mfa/webauthn/register/options').send({});
  expect(opts.status).toBe(200);
  expect(opts.body.challenge).toBeTruthy();
  expect(opts.body.rp?.id).toBeTruthy();
  setRegCredential(credId, { transports });
  return agent
    .post('/api/mfa/webauthn/register/verify')
    .send({ response: { id: credId, type: 'public-key', response: {} }, name });
}

describe('WebAuthn registration', () => {
  it('options returns real options + persists a challenge (cold start, no env)', async () => {
    const agent = await authAgent(app, { username: 'wa_opts' });
    const opts = await agent.post('/api/mfa/webauthn/register/options').send({});
    expect(opts.status).toBe(200);
    expect(opts.body.challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(opts.body.rp.name).toBe('CarMaint');

    // The challenge was persisted server-side (kind='webauthn_reg'), never trusted
    // from the client echo.
    const ctx = app.locals.ctx;
    const u = await ctx.db.get('SELECT id FROM users WHERE username = ?', ['wa_opts']);
    const row = await ctx.db.get(
      "SELECT code_hash FROM mfa_challenges WHERE user_id = ? AND kind = 'webauthn_reg'",
      [u.id]
    );
    expect(row.code_hash).toBe(opts.body.challenge);
  });

  it('verify stores the credential and appears in status + credentials list', async () => {
    const agent = await authAgent(app, { username: 'wa_reg' }); // already has TOTP
    const credId = b64u('cred-wa_reg');
    const res = await enrollPasskey(agent, credId, { name: 'YubiKey', transports: ['usb'] });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.credential).toMatchObject({ id: credId, name: 'YubiKey' });
    // Second factor (TOTP already active) → NO new backup codes.
    expect(res.body.backup_codes).toBeNull();

    const status = await agent.get('/api/mfa/status');
    expect(status.body.methods.webauthn).toBe(true);
    expect(status.body.webauthn.count).toBe(1);
    expect(status.body.webauthn.credentials[0]).toMatchObject({ id: credId, name: 'YubiKey' });

    const list = await agent.get('/api/mfa/webauthn/credentials');
    expect(list.body.credentials).toHaveLength(1);
    expect(list.body.credentials[0].id).toBe(credId);
  });

  it('verify without prior options → 400 (challenge must be server-persisted)', async () => {
    const agent = await authAgent(app, { username: 'wa_nochal' });
    setRegCredential(b64u('cred-nochal'));
    const res = await agent
      .post('/api/mfa/webauthn/register/verify')
      .send({ response: { id: b64u('cred-nochal'), type: 'public-key' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no pending passkey/i);
  });

  it('verified:false → 400 and no credential stored', async () => {
    const agent = await authAgent(app, { username: 'wa_false' });
    await agent.post('/api/mfa/webauthn/register/options').send({});
    h.reg = { verified: false };
    const res = await agent
      .post('/api/mfa/webauthn/register/verify')
      .send({ response: { id: b64u('cred-false'), type: 'public-key' } });
    expect(res.status).toBe(400);
    const status = await agent.get('/api/mfa/status');
    expect(status.body.webauthn.count).toBe(0);
  });

  it('a passkey enrolled as the FIRST factor issues backup codes once + upgrades the session', async () => {
    // Register only (setup-pending state, zero active MFA).
    const agent = request.agent(app);
    const reg = await agent.post('/api/register').send({ username: 'wa_first', password: 'password12345' });
    expect(reg.body).toMatchObject({ mfa_setup_required: true });
    // Data API blocked in the pending state.
    expect((await agent.get('/api/vehicles')).status).toBe(403);

    const res = await enrollPasskey(agent, b64u('cred-first'), { name: 'Phone' });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(Array.isArray(res.body.backup_codes)).toBe(true);
    expect(res.body.backup_codes).toHaveLength(10);
    // Enrollment upgraded the pending state to a full session.
    expect(res.body.authenticated).toBe(true);
    expect((await agent.get('/api/vehicles')).status).toBe(200);
  });

  it('duplicate credential_id is rejected (409, prevents cross-user takeover)', async () => {
    const a = await authAgent(app, { username: 'wa_dup_a' });
    const b = await authAgent(app, { username: 'wa_dup_b' });
    const credId = b64u('shared-cred');
    expect((await enrollPasskey(a, credId)).status).toBe(200);
    // Same credential id under a different account → UNIQUE violation → 409.
    const res = await enrollPasskey(b, credId);
    expect(res.status).toBe(409);
  });
});

describe('WebAuthn login assertion', () => {
  async function enrolledUser(username) {
    const agent = await authAgent(app, { username });
    await enrollPasskey(agent, b64u(`cred-${username}`));
    return agent;
  }

  it('advertises webauthn at login, completes the state machine, updates counter', async () => {
    const agent = await enrolledUser('wa_login');
    const credId = b64u('cred-wa_login');
    await agent.post('/api/logout');

    const a = request.agent(app);
    const step1 = await a.post('/api/login').send({ username: 'wa_login', password: agent.password });
    expect(step1.body.mfa_required).toBe(true);
    expect(step1.body.methods).toEqual(expect.arrayContaining(['webauthn']));
    // Still no session.
    expect((await a.get('/api/vehicles')).status).toBe(403);

    const opts = await a.post('/api/login/mfa/webauthn/options').send({});
    expect(opts.status).toBe(200);
    expect(opts.body.challenge).toBeTruthy();

    h.auth = { verified: true, authenticationInfo: { newCounter: 7 } };
    const verify = await a
      .post('/api/login/mfa/webauthn/verify')
      .send({ response: { id: credId, type: 'public-key', response: {} } });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ username: 'wa_login' });
    // Full session now works.
    expect((await a.get('/api/vehicles')).status).toBe(200);

    // Counter advanced + last_used stamped.
    const ctx = app.locals.ctx;
    const row = await ctx.db.get('SELECT counter, last_used_at FROM webauthn_credentials WHERE credential_id = ?', [credId]);
    expect(row.counter).toBe(7);
    expect(row.last_used_at).toBeTruthy();
  });

  it('login options require the pending-login state / an enrolled passkey', async () => {
    // No pending login at all → 401.
    const anon = request.agent(app);
    expect((await anon.post('/api/login/mfa/webauthn/options').send({})).status).toBe(401);

    // Pending login but the account has no passkey → 400.
    const totpOnly = await authAgent(app, { username: 'wa_nopk' });
    await totpOnly.post('/api/logout');
    const a = request.agent(app);
    await a.post('/api/login').send({ username: 'wa_nopk', password: totpOnly.password });
    const opts = await a.post('/api/login/mfa/webauthn/options').send({});
    expect(opts.status).toBe(400);
  });

  it('cross-user isolation: cannot assert with another user’s credential id', async () => {
    const victim = await enrolledUser('wa_victim');
    const victimCred = b64u('cred-wa_victim');
    const attacker = await enrolledUser('wa_attacker');
    await attacker.post('/api/logout');

    const a = request.agent(app);
    await a.post('/api/login').send({ username: 'wa_attacker', password: attacker.password });
    await a.post('/api/login/mfa/webauthn/options').send({});
    // Attacker echoes the VICTIM's credential id; the lookup is scoped to the attacker's
    // user, so it is not found → rejected. The verify library is never even reached.
    const res = await a
      .post('/api/login/mfa/webauthn/verify')
      .send({ response: { id: victimCred, type: 'public-key', response: {} } });
    expect(res.status).toBe(401);
    expect((await a.get('/api/vehicles')).status).toBe(403);
  });

  it('verified:false counts toward the attempt cap and invalidates the token', async () => {
    const agent = await enrolledUser('wa_cap');
    const credId = b64u('cred-wa_cap');
    await agent.post('/api/logout');

    const a = request.agent(app);
    await a.post('/api/login').send({ username: 'wa_cap', password: agent.password });

    // 4 failed assertions keep the token alive.
    for (let i = 0; i < 4; i++) {
      await a.post('/api/login/mfa/webauthn/options').send({});
      h.auth = { verified: false };
      const bad = await a
        .post('/api/login/mfa/webauthn/verify')
        .send({ response: { id: credId, type: 'public-key', response: {} } });
      expect(bad.status).toBe(401);
      expect(bad.body.error).toMatch(/invalid passkey/i);
    }
    // 5th failure caps out and burns the pending token.
    await a.post('/api/login/mfa/webauthn/options').send({});
    h.auth = { verified: false };
    const capped = await a
      .post('/api/login/mfa/webauthn/verify')
      .send({ response: { id: credId, type: 'public-key', response: {} } });
    expect(capped.status).toBe(401);
    expect(capped.body.error).toMatch(/too many attempts/i);

    // Even a now-valid assertion fails: the token is gone.
    h.auth = { verified: true, authenticationInfo: { newCounter: 1 } };
    const after = await a
      .post('/api/login/mfa/webauthn/verify')
      .send({ response: { id: credId, type: 'public-key', response: {} } });
    expect(after.status).toBe(401);
  });
});

describe('WebAuthn management + guards', () => {
  it('last-factor guard: cannot delete the only passkey (409); can when another factor exists', async () => {
    // Passkey-only account (first factor).
    const agent = request.agent(app);
    await agent.post('/api/register').send({ username: 'wa_only', password: 'password12345' });
    await enrollPasskey(agent, b64u('cred-only'));

    // WebAuthn is the sole active method → cannot remove it.
    const del1 = await agent.delete(`/api/mfa/webauthn/${b64u('cred-only')}`);
    expect(del1.status).toBe(409);

    // Enroll a second passkey → two credentials, deleting one leaves webauthn active.
    await enrollPasskey(agent, b64u('cred-only-2'));
    const del2 = await agent.delete(`/api/mfa/webauthn/${b64u('cred-only-2')}`);
    expect(del2.status).toBe(200);
    expect(del2.body.methods.webauthn).toBe(true);
    expect(del2.body.webauthn.count).toBe(1);

    // Back to one passkey (still the only method) → guarded again.
    const del3 = await agent.delete(`/api/mfa/webauthn/${b64u('cred-only')}`);
    expect(del3.status).toBe(409);
  });

  it('can delete a passkey when TOTP also protects the account', async () => {
    const agent = await authAgent(app, { username: 'wa_plus_totp' }); // TOTP active
    await enrollPasskey(agent, b64u('cred-plus'));
    const del = await agent.delete(`/api/mfa/webauthn/${b64u('cred-plus')}`);
    expect(del.status).toBe(200);
    expect(del.body.methods).toMatchObject({ totp: true, webauthn: false });
  });

  it('deleting an unknown passkey → 404', async () => {
    const agent = await authAgent(app, { username: 'wa_404' });
    const res = await agent.delete(`/api/mfa/webauthn/${b64u('nope')}`);
    expect(res.status).toBe(404);
  });

  it('admin MFA reset clears passkeys too', async () => {
    const admin = await authAgent(app, { username: 'wa_admin' });
    const user = await authAgent(app, { username: 'wa_reset_target' });
    await enrollPasskey(user, b64u('cred-reset'));
    const uid = (await app.locals.ctx.db.get('SELECT id FROM users WHERE username = ?', ['wa_reset_target'])).id;

    const reset = await admin.delete(`/api/admin/users/${uid}/mfa`);
    expect(reset.status).toBe(200);

    const count = await app.locals.ctx.db.get(
      'SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?',
      [uid]
    );
    expect(count.n).toBe(0);
  });

  it('passkeys survive a global backup + restore', async () => {
    const admin = await authAgent(app, { username: 'wa_bk_admin' });
    await enrollPasskey(admin, b64u('cred-backup'), { name: 'Backed up key', transports: ['internal'] });

    // Create a global backup, then wipe the passkey and restore it.
    const create = await admin.post('/api/backups').send({});
    expect(create.status).toBe(201);
    const filename = create.body.filename;

    const ctx = app.locals.ctx;
    const uid = (await ctx.db.get('SELECT id FROM users WHERE username = ?', ['wa_bk_admin'])).id;
    await ctx.db.run('DELETE FROM webauthn_credentials WHERE user_id = ?', [uid]);
    expect((await ctx.db.get('SELECT COUNT(*) AS n FROM webauthn_credentials', [])).n).toBe(0);

    // Download the stored backup and restore it globally.
    const dl = await admin.get(`/api/backups/${filename}`).buffer().parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    const restore = await admin
      .post('/api/backups/restore')
      .attach('backup', dl.body, { filename, contentType: 'application/zip' });
    expect(restore.status).toBe(200);

    const restored = await ctx.db.get('SELECT * FROM webauthn_credentials WHERE credential_id = ?', [b64u('cred-backup')]);
    expect(restored).toBeTruthy();
    expect(restored.name).toBe('Backed up key');
    expect(restored.public_key).toBeTruthy();
  });
});
