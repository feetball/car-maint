import { Router } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { asyncHandler, badRequest, notFound, HttpError } from '../helpers.js';
import {
  newTotpSecret,
  otpauthUri,
  verifyTotp,
  generateBackupCodes,
  generateEmailCode,
  validateEmail,
  sha256hex,
  normalizeBackupCode,
  timingSafeHexEqual,
  activeMethods,
  hasActiveMFA,
  backupCodesRemaining,
  BACKUP_CODE_COUNT,
  webauthnRelyingParty,
  storeRegChallenge,
  takeRegChallenge,
  webauthnCredentials,
  publicCredential,
  parseTransports,
} from '../mfa.js';

// Enrollment / management endpoints. Reachable with EITHER a full session (req.user)
// OR the limited setup/login-pending state (req.mfa) — the gate lets /api/mfa/* and
// /api/login/mfa through in both. mfaUserId() reads whichever is present.
//
// WebAuthn extension point: add /api/mfa/webauthn/register + /verify here; the
// activeMethods()/hasActiveMFA()/last-factor-guard machinery already generalizes.
const EMAIL_RESEND_COOLDOWN_MS = 30 * 1000;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_EMAIL_ATTEMPTS = 5;

function mfaUserId(req) {
  return req.user?.id ?? req.mfa?.userId ?? null;
}

export function mfaRouter(ctx) {
  const router = Router();
  const db = ctx.db;
  const auth = ctx.auth;

  // Every route here needs a password-level identity (full session or pending).
  router.use('/mfa', (req, res, next) => {
    if (mfaUserId(req) == null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  });

  // If the requester is in a pending (setup/login) state and now has active MFA,
  // upgrade them to a real session: burn the pending token, set the session cookie.
  // Returns the session fields to fold into the response, or {} for a full session.
  async function maybeUpgradeSession(req, res) {
    if (!req.mfa) return {};
    // Defense in depth: ONLY the setup state (first enrollment) may be upgraded to a
    // full session by an enrollment endpoint. A login-pending request has an existing
    // factor it must PROVE via /api/login/mfa* — it must never be upgraded here, even
    // if an enrollment endpoint were somehow reached. (The auth gate already blocks
    // those endpoints for kind='login'; this is the belt-and-suspenders second layer.)
    if (req.mfa.kind !== 'setup') return {};
    if (!(await hasActiveMFA(db, req.mfa.userId))) return {};
    await auth.deletePending(req.mfa.tokenHash);
    auth.clearMfaCookie(req, res);
    const token = await auth.createSession(req.mfa.userId);
    auth.setSessionCookie(req, res, token);
    const u = await db.get('SELECT username, is_admin FROM users WHERE id = ?', [req.mfa.userId]);
    return { authenticated: true, username: u.username, is_admin: !!u.is_admin };
  }

  async function statusPayload(userId) {
    const active = await activeMethods(db, userId);
    const creds = await webauthnCredentials(db, userId);
    return {
      methods: {
        totp: active.includes('totp'),
        email: active.includes('email'),
        webauthn: active.includes('webauthn'),
      },
      backup_codes_remaining: await backupCodesRemaining(db, userId),
      webauthn: { count: creds.length, credentials: creds.map(publicCredential) },
      mfa_enabled: active.length > 0,
    };
  }

  // GET /api/mfa/status → current MFA state for the (full or pending) user.
  router.get(
    '/mfa/status',
    asyncHandler(async (req, res) => {
      res.json(await statusPayload(mfaUserId(req)));
    })
  );

  // --- TOTP ----------------------------------------------------------------

  // POST /api/mfa/totp/setup → generate a new UNCONFIRMED secret (stored as
  // pending_secret so any already-active secret keeps working) and return the
  // provisioning material. Not active until /confirm.
  router.post(
    '/mfa/totp/setup',
    asyncHandler(async (req, res) => {
      const userId = mfaUserId(req);
      const secret = newTotpSecret();
      const existing = await db.get('SELECT user_id FROM mfa_totp WHERE user_id = ?', [userId]);
      if (existing) {
        await db.run('UPDATE mfa_totp SET pending_secret = ? WHERE user_id = ?', [secret, userId]);
      } else {
        await db.run('INSERT INTO mfa_totp (user_id, pending_secret) VALUES (?, ?)', [
          userId,
          secret,
        ]);
      }
      const u = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
      res.json({ secret_base32: secret, otpauth_uri: otpauthUri(secret, u.username) });
    })
  );

  // POST /api/mfa/totp/confirm {code} → verify against the pending secret. On the
  // FIRST activation, generate + return 10 backup codes (once). Activating from a
  // pending state upgrades the caller to a full session.
  router.post(
    '/mfa/totp/confirm',
    asyncHandler(async (req, res) => {
      const userId = mfaUserId(req);
      const code = req.body?.code;
      const row = await db.get('SELECT * FROM mfa_totp WHERE user_id = ?', [userId]);
      if (!row || !row.pending_secret) {
        throw badRequest('no pending TOTP enrollment — call /api/mfa/totp/setup first');
      }
      if (!verifyTotp(row.pending_secret, code)) {
        throw badRequest('invalid code');
      }
      const wasConfirmed = row.confirmed_at != null;
      await db.run(
        `UPDATE mfa_totp
            SET secret = pending_secret, pending_secret = NULL,
                confirmed_at = COALESCE(confirmed_at, ?)
          WHERE user_id = ?`,
        [new Date().toISOString(), userId]
      );

      // Backup codes are issued only on first activation. Re-confirming (rotating the
      // secret) leaves existing backup codes intact; use /mfa/backup/regenerate to
      // rotate them.
      let backupCodes = null;
      if (!wasConfirmed) {
        backupCodes = await issueBackupCodes(userId);
      }

      const session = await maybeUpgradeSession(req, res);
      res.json({ confirmed: true, mfa_enabled: true, backup_codes: backupCodes, ...session });
    })
  );

  // Replace all of a user's backup codes with a fresh set (returned once). Atomic:
  // wipe-then-insert inside one transaction.
  async function issueBackupCodes(userId) {
    const codes = generateBackupCodes(BACKUP_CODE_COUNT);
    await db.tx(async (t) => {
      await t.run('DELETE FROM mfa_backup_codes WHERE user_id = ?', [userId]);
      for (const c of codes) {
        await t.run('INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES (?, ?)', [
          userId,
          sha256hex(normalizeBackupCode(c)),
        ]);
      }
    });
    return codes;
  }

  // POST /api/mfa/backup/regenerate → (full session) invalidate old codes, issue 10
  // new ones (returned once). Requires active MFA — backup codes are recovery for it.
  router.post(
    '/mfa/backup/regenerate',
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(403, 'a full session is required to regenerate backup codes');
      const userId = req.user.id;
      if (!(await hasActiveMFA(db, userId))) {
        throw badRequest('enroll a second factor before generating backup codes');
      }
      const codes = await issueBackupCodes(userId);
      res.json({ backup_codes: codes });
    })
  );

  // --- Email ---------------------------------------------------------------

  // POST /api/mfa/email/setup {email} → store the address (unconfirmed) and send a
  // verification code. 400 when SMTP is not configured (email is an unavailable
  // method); never crashes when unset.
  router.post(
    '/mfa/email/setup',
    asyncHandler(async (req, res) => {
      if (!ctx.mailer?.configured) {
        throw badRequest('email MFA not configured');
      }
      const userId = mfaUserId(req);
      const email = req.body?.email;
      if (!validateEmail(email)) throw badRequest('a valid email address is required');

      const existing = await db.get('SELECT * FROM mfa_email WHERE user_id = ?', [userId]);
      // Lightweight resend rate limit: reject a resend within the cooldown of a
      // still-live code (derived from code_expires_at = sent + TTL).
      if (existing?.code_expires_at) {
        const sentAtMs = new Date(existing.code_expires_at).getTime() - EMAIL_CODE_TTL_MS;
        if (Date.now() - sentAtMs < EMAIL_RESEND_COOLDOWN_MS) {
          throw new HttpError(429, 'a code was just sent — please wait before requesting another');
        }
      }

      const code = generateEmailCode();
      const codeExpires = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();
      // Changing to a different address resets confirmation; same address keeps it.
      const keepConfirmed = existing && existing.email === email ? existing.confirmed_at : null;
      if (existing) {
        await db.run(
          'UPDATE mfa_email SET email = ?, code_hash = ?, code_expires_at = ?, attempts = 0, confirmed_at = ? WHERE user_id = ?',
          [email, sha256hex(code), codeExpires, keepConfirmed, userId]
        );
      } else {
        await db.run(
          'INSERT INTO mfa_email (user_id, email, code_hash, code_expires_at) VALUES (?, ?, ?, ?)',
          [userId, email, sha256hex(code), codeExpires]
        );
      }
      await ctx.mailer.send({
        to: email,
        subject: 'Your CarMaint verification code',
        text: `Your CarMaint email verification code is ${code}. It expires in 10 minutes.`,
      });
      res.json({ sent: true });
    })
  );

  // POST /api/mfa/email/confirm {code} → verify the enrollment code; email becomes an
  // active method. Timing-safe hash compare; attempt-capped; expiry-checked.
  router.post(
    '/mfa/email/confirm',
    asyncHandler(async (req, res) => {
      const userId = mfaUserId(req);
      const code = req.body?.code;
      const row = await db.get('SELECT * FROM mfa_email WHERE user_id = ?', [userId]);
      if (!row || !row.code_hash) throw badRequest('no pending email verification');
      if (!row.code_expires_at || row.code_expires_at <= new Date().toISOString()) {
        throw badRequest('verification code expired — request a new one');
      }
      const match = typeof code === 'string' && timingSafeHexEqual(sha256hex(code), row.code_hash);
      if (!match) {
        await db.run('UPDATE mfa_email SET attempts = attempts + 1 WHERE user_id = ?', [userId]);
        const bumped = await db.get('SELECT attempts FROM mfa_email WHERE user_id = ?', [userId]);
        if ((bumped?.attempts ?? MAX_EMAIL_ATTEMPTS) >= MAX_EMAIL_ATTEMPTS) {
          // Burn the code after too many wrong guesses; a fresh setup is required.
          await db.run(
            'UPDATE mfa_email SET code_hash = NULL, code_expires_at = NULL, attempts = 0 WHERE user_id = ?',
            [userId]
          );
          throw badRequest('too many attempts — request a new code');
        }
        throw badRequest('invalid code');
      }
      await db.run(
        'UPDATE mfa_email SET confirmed_at = COALESCE(confirmed_at, ?), code_hash = NULL, code_expires_at = NULL, attempts = 0 WHERE user_id = ?',
        [new Date().toISOString(), userId]
      );
      const session = await maybeUpgradeSession(req, res);
      res.json({ confirmed: true, mfa_enabled: true, ...session });
    })
  );

  // POST /api/mfa/email/send-code → during a login challenge, email a fresh one-time
  // code to the user's CONFIRMED address and stash its hash on the pending-login
  // challenge row. Requires the pending 'login' state.
  router.post(
    '/mfa/email/send-code',
    asyncHandler(async (req, res) => {
      if (!ctx.mailer?.configured) throw badRequest('email MFA not configured');
      if (!req.mfa || req.mfa.kind !== 'login') {
        throw new HttpError(409, 'email codes are only available during a login challenge');
      }
      const userId = req.mfa.userId;
      const row = await db.get(
        'SELECT email FROM mfa_email WHERE user_id = ? AND confirmed_at IS NOT NULL',
        [userId]
      );
      if (!row) throw badRequest('email is not an enrolled method for this account');

      // Resend cooldown against the challenge row's live code.
      const chal = await db.get('SELECT code_expires_at FROM mfa_challenges WHERE token_hash = ?', [
        req.mfa.tokenHash,
      ]);
      if (chal?.code_expires_at) {
        const sentAtMs = new Date(chal.code_expires_at).getTime() - EMAIL_CODE_TTL_MS;
        if (Date.now() - sentAtMs < EMAIL_RESEND_COOLDOWN_MS) {
          throw new HttpError(429, 'a code was just sent — please wait before requesting another');
        }
      }

      const code = generateEmailCode();
      const codeExpires = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();
      await db.run(
        'UPDATE mfa_challenges SET code_hash = ?, code_expires_at = ? WHERE token_hash = ?',
        [sha256hex(code), codeExpires, req.mfa.tokenHash]
      );
      await ctx.mailer.send({
        to: row.email,
        subject: 'Your CarMaint login code',
        text: `Your CarMaint login code is ${code}. It expires in 10 minutes.`,
      });
      res.json({ sent: true });
    })
  );

  // --- Disable a method (last-factor guarded) ------------------------------

  // Refuses to remove the caller's LAST active factor (MFA is required for everyone).
  // `removing` is the method being disabled; 409 if nothing would remain active.
  async function assertNotLastFactor(userId, removing) {
    const remaining = (await activeMethods(db, userId)).filter((m) => m !== removing);
    if (remaining.length === 0) {
      throw new HttpError(409, 'at least one MFA method is required — add another before removing this one');
    }
  }

  // DELETE /api/mfa/totp → disable TOTP (and its backup codes). Full session only.
  router.delete(
    '/mfa/totp',
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(403, 'a full session is required to remove a factor');
      const userId = req.user.id;
      const active = await activeMethods(db, userId);
      if (active.includes('totp')) await assertNotLastFactor(userId, 'totp');
      await db.tx(async (t) => {
        await t.run('DELETE FROM mfa_backup_codes WHERE user_id = ?', [userId]);
        await t.run('DELETE FROM mfa_totp WHERE user_id = ?', [userId]);
      });
      res.json({ disabled: 'totp', ...(await statusPayload(userId)) });
    })
  );

  // DELETE /api/mfa/email → disable the email method. Full session only.
  router.delete(
    '/mfa/email',
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(403, 'a full session is required to remove a factor');
      const userId = req.user.id;
      const active = await activeMethods(db, userId);
      if (active.includes('email')) await assertNotLastFactor(userId, 'email');
      await db.run('DELETE FROM mfa_email WHERE user_id = ?', [userId]);
      res.json({ disabled: 'email', ...(await statusPayload(userId)) });
    })
  );

  // --- WebAuthn / passkeys (second factor) ---------------------------------
  // Enrollment is reachable in a full session OR the setup/login-pending state (the
  // gate lets /api/mfa/* through in both), same as TOTP/email. mfaUserId() resolves
  // whichever identity is present. Registration is a two-step challenge round-trip:
  // /register/options mints + persists a server-side challenge, /register/verify
  // checks the authenticator's attestation against it and stores the credential.

  // POST /api/mfa/webauthn/register/options → PublicKeyCredentialCreationOptions JSON.
  router.post(
    '/mfa/webauthn/register/options',
    asyncHandler(async (req, res) => {
      const userId = mfaUserId(req);
      const { rpID, rpName } = webauthnRelyingParty(req);
      const u = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
      const existing = await webauthnCredentials(db, userId);
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: u.username,
        // Stable per-user handle (bytes). Second factor, so it is not user-facing.
        userID: new TextEncoder().encode(String(userId)),
        attestationType: 'none',
        // Prevent re-registering an already-enrolled authenticator on this account.
        excludeCredentials: existing.map((c) => ({
          id: c.credential_id,
          transports: parseTransports(c.transports),
        })),
        // Second factor: no resident key needed; UV preferred but not required so a
        // security key without a PIN still enrolls.
        authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
      });
      await storeRegChallenge(db, userId, options.challenge);
      res.json(options);
    })
  );

  // POST /api/mfa/webauthn/register/verify { response, name? } → store the credential.
  // First factor on a zero-MFA account also issues 10 backup codes once (recovery for a
  // passkey-only user), reusing issueBackupCodes; activating from a pending state upgrades
  // to a full session (maybeUpgradeSession).
  router.post(
    '/mfa/webauthn/register/verify',
    asyncHandler(async (req, res) => {
      const userId = mfaUserId(req);
      const response = req.body?.response;
      if (!response || typeof response !== 'object') {
        throw badRequest('registration response is required');
      }
      const expectedChallenge = await takeRegChallenge(db, userId);
      if (!expectedChallenge) {
        throw badRequest('no pending passkey registration — request options first');
      }
      const { rpID, expectedOrigin } = webauthnRelyingParty(req);
      if (!expectedOrigin.length) throw badRequest('could not determine the relying-party origin');

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin,
          expectedRPID: rpID,
          requireUserVerification: false,
        });
      } catch {
        throw badRequest('passkey registration could not be verified');
      }
      if (!verification.verified || !verification.registrationInfo) {
        throw badRequest('passkey registration could not be verified');
      }

      const { credential } = verification.registrationInfo;
      const credentialId = credential.id; // already a base64url string in v13
      const publicKeyB64 = Buffer.from(credential.publicKey).toString('base64url');
      const transports = credential.transports?.length
        ? JSON.stringify(credential.transports)
        : null;
      const rawName = req.body?.name;
      const name =
        typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 100) : null;

      // Check BEFORE inserting so "zero factors → this is the first" is evaluated
      // against prior state.
      const hadMfaBefore = await hasActiveMFA(db, userId);
      try {
        await db.run(
          `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, credentialId, publicKeyB64, credential.counter ?? 0, transports, name]
        );
      } catch (err) {
        // credential_id is globally UNIQUE — a duplicate means this authenticator is
        // already registered (to this or another account); never overwrite it.
        if (/UNIQUE/i.test(err?.message || '')) {
          throw new HttpError(409, 'this passkey is already registered');
        }
        throw err;
      }

      let backupCodes = null;
      if (!hadMfaBefore) backupCodes = await issueBackupCodes(userId);

      const session = await maybeUpgradeSession(req, res);
      res.json({
        verified: true,
        credential: { id: credentialId, name },
        backup_codes: backupCodes,
        ...session,
      });
    })
  );

  // GET /api/mfa/webauthn/credentials → list the caller's passkeys for the settings UI.
  router.get(
    '/mfa/webauthn/credentials',
    asyncHandler(async (req, res) => {
      const creds = await webauthnCredentials(db, mfaUserId(req));
      res.json({ credentials: creds.map(publicCredential) });
    })
  );

  // DELETE /api/mfa/webauthn/:credentialId → remove one passkey. Full session only.
  // Removing the user's LAST passkey removes WebAuthn as a method entirely, so the
  // same cross-method last-factor guard applies (409 if nothing else would remain).
  router.delete(
    '/mfa/webauthn/:credentialId',
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(403, 'a full session is required to remove a factor');
      const userId = req.user.id;
      const credentialId = req.params.credentialId;
      const creds = await webauthnCredentials(db, userId);
      const target = creds.find((c) => c.credential_id === credentialId);
      if (!target) throw notFound('passkey not found');
      if (creds.length === 1) await assertNotLastFactor(userId, 'webauthn');
      await db.run('DELETE FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?', [
        userId,
        credentialId,
      ]);
      res.json({ disabled: 'webauthn', credential_id: credentialId, ...(await statusPayload(userId)) });
    })
  );

  return router;
}
