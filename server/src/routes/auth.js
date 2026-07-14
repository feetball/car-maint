import { Router } from 'express';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { asyncHandler, badRequest, HttpError } from '../helpers.js';
import { hashPassword, MAX_MFA_ATTEMPTS } from '../auth.js';
import {
  loginMethods,
  hasActiveMFA,
  verifyTotp,
  sha256hex,
  normalizeBackupCode,
  webauthnRelyingParty,
  storeAuthChallenge,
  takeAuthChallenge,
  webauthnCredentials,
  parseTransports,
} from '../mfa.js';

// A fixed, valid scrypt hash used only to spend equal CPU on the user-miss path of
// login, so a nonexistent username can't be distinguished from a wrong password by
// response timing. Computed once per process (no per-request or per-app cost). Its
// plaintext is irrelevant — it never matches a submitted password.
const DUMMY_PASSWORD_HASH = hashPassword('carmaint-login-timing-dummy');

// Account + session endpoints. register/login/login-mfa/logout/status are exempt
// from (or handled specially by) the auth gate; calendar-url is guarded, so it runs
// with req.user attached.
export function authRouter(ctx) {
  const router = Router();
  const auth = ctx.auth;
  const db = ctx.db;

  // Open signup: anyone can register a username+password. MFA is OPTIONAL now, so
  // registration grants a FULL session immediately (a SINGLE Set-Cookie: the session).
  // The new account has no second factor yet — the client nudges them to set one up —
  // but they land straight in the app. mfa_enabled:false tells the client to show the
  // onboarding nudge + banner.
  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const username = req.body?.username;
      const password = req.body?.password;
      if (!auth.validateUsername(username)) {
        throw badRequest('username must be 3–32 characters of letters, numbers, _ . or -');
      }
      if (!auth.validatePassword(password)) {
        throw badRequest('password must be at least 8 characters');
      }

      const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (existing) throw new HttpError(409, 'username is already taken');

      const { n: userCount } = await db.get('SELECT COUNT(*) AS n FROM users');
      const isAdmin = userCount === 0 ? 1 : 0;

      let userId;
      try {
        const info = await db.run(
          'INSERT INTO users (username, password_hash, calendar_token, is_admin) VALUES (?, ?, ?, ?)',
          [username, auth.hashPassword(password), auth.newCalendarToken(), isAdmin]
        );
        userId = info.lastInsertRowid;
      } catch (err) {
        if (/UNIQUE/i.test(err?.message || '')) throw new HttpError(409, 'username is already taken');
        throw err;
      }

      // Full session immediately — a single Set-Cookie (the session).
      const token = await auth.createSession(userId);
      auth.setSessionCookie(req, res, token);
      res.status(201).json({ username, is_admin: !!isAdmin, mfa_enabled: false });
    })
  );

  // Login step 1: verify the password (constant-time, with the dummy-hash timing
  // defense). NEVER sets the real session cookie. Whether MFA exists is only ever
  // revealed AFTER a correct password, so account existence is not leaked pre-auth.
  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      // Brute-force mitigation on the password step (and thus pending-token minting):
      // an attacker who knows the password could otherwise loop login→5-MFA-guesses
      // unbounded. Best-effort per-account/per-IP fixed window; generic 429 when over.
      if (!auth.registerLoginAttempt(req)) {
        return res.status(429).json({ error: 'Too many login attempts, please try again later' });
      }
      const username = req.body?.username;
      const password = req.body?.password;
      const user =
        typeof username === 'string'
          ? await db.get('SELECT * FROM users WHERE username = ?', [username])
          : undefined;
      const ok = auth.verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
      if (!user || !ok) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      if (await hasActiveMFA(db, user.id)) {
        // Has a second factor → pending 'login' state, await the challenge. This path
        // (and its security-critical login-pending gate restriction) is UNCHANGED.
        const pending = await auth.createPending(user.id, 'login');
        auth.setMfaCookie(req, res, pending);
        return res.json({ mfa_required: true, methods: await loginMethods(db, user.id) });
      }
      // No active MFA (never enrolled, or admin-reset account) → MFA is optional, so
      // grant a FULL session immediately (a SINGLE Set-Cookie: the session). The client
      // shows the setup nudge because mfa_enabled is false.
      const token = await auth.createSession(user.id);
      auth.setSessionCookie(req, res, token);
      return res.json({ username: user.username, is_admin: !!user.is_admin, mfa_enabled: false });
    })
  );

  // Login step 2: consume the pending 'login' token (carmaint_mfa cookie) and verify
  // one second factor (totp | backup | email). The gate attaches req.mfa here. On
  // success the pending token is deleted and the REAL session is created. On failure
  // the attempt counter is bumped and, past the cap, the token is invalidated so the
  // user must re-enter their password.
  router.post(
    '/login/mfa',
    asyncHandler(async (req, res) => {
      const pending = req.mfa;
      if (!pending || pending.kind !== 'login') {
        // No valid pending-login token (expired/absent, or a setup-only token).
        return res.status(401).json({ error: 'MFA session expired, please log in again' });
      }
      const userId = pending.userId;
      const tokenHash = pending.tokenHash;
      const code = req.body?.code;
      const method = req.body?.method;
      if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
        return res.status(400).json({ error: 'code is required' });
      }

      const nowIso = new Date().toISOString();

      const tryTotp = async () => {
        const row = await db.get(
          'SELECT secret FROM mfa_totp WHERE user_id = ? AND confirmed_at IS NOT NULL',
          [userId]
        );
        return !!row && verifyTotp(row.secret, code);
      };
      // Single-use + concurrency-safe: only the matching, unused code row is updated,
      // so a code cannot be replayed or consumed twice (changes===1 wins exactly once).
      const tryBackup = async () => {
        const info = await db.run(
          'UPDATE mfa_backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
          [nowIso, userId, sha256hex(normalizeBackupCode(code))]
        );
        return info.changes === 1;
      };
      // Single-use + expiry-checked atomically against the pending challenge row.
      const tryEmail = async () => {
        const info = await db.run(
          `UPDATE mfa_challenges SET code_hash = NULL, code_expires_at = NULL
             WHERE token_hash = ? AND code_hash IS NOT NULL AND code_hash = ? AND code_expires_at > ?`,
          [tokenHash, sha256hex(code), nowIso]
        );
        return info.changes === 1;
      };

      let ok = false;
      if (method === 'totp') ok = await tryTotp();
      else if (method === 'backup') ok = await tryBackup();
      else if (method === 'email') ok = await tryEmail();
      // Unspecified method: try each. A given code matches at most one factor (the
      // consume-on-match UPDATEs never fire for a non-matching code), so this is safe.
      else ok = (await tryEmail()) || (await tryTotp()) || (await tryBackup());

      if (!ok) {
        await db.run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', [
          tokenHash,
        ]);
        const row = await db.get('SELECT attempts FROM mfa_challenges WHERE token_hash = ?', [
          tokenHash,
        ]);
        if ((row?.attempts ?? MAX_MFA_ATTEMPTS) >= MAX_MFA_ATTEMPTS) {
          await auth.deletePending(tokenHash);
          auth.clearMfaCookie(req, res);
          return res
            .status(401)
            .json({ error: 'Too many attempts, please log in again', mfa_pending: false });
        }
        return res.status(401).json({ error: 'Invalid code' });
      }

      // Success: burn the pending token from the DB and grant a full session. We emit
      // ONLY the session Set-Cookie (no clearMfaCookie) — Vercel's serverless response
      // path mangles/drops multiple Set-Cookie headers, so a session-granting response
      // must carry a SINGLE Set-Cookie or the browser never stores the session and the
      // next request 401s. Deleting the pending ROW makes the lingering carmaint_mfa
      // cookie INERT (resolvePending returns null for a missing row), and the gate calls
      // authenticate() BEFORE resolvePending, so the valid session always wins.
      await auth.deletePending(tokenHash);
      const token = await auth.createSession(userId);
      auth.setSessionCookie(req, res, token);
      const u = await db.get('SELECT username, is_admin FROM users WHERE id = ?', [userId]);
      res.json({ username: u.username, is_admin: !!u.is_admin });
    })
  );

  // --- WebAuthn login assertion (second factor via passkey) ----------------
  // The code path above (/login/mfa) handles totp/backup/email. A passkey needs a
  // challenge round-trip, so it gets its own two steps. Both require the pending
  // 'login' state (the gate attaches req.mfa and allows /api/login/mfa/*).

  // Shared failure handling: bump the pending-login token's attempt counter and, past
  // the cap, invalidate it (identical semantics to the /login/mfa code path so a passkey
  // assertion can't dodge the brute-force cap). Returns the Response already sent.
  async function failMfaAttempt(req, res, tokenHash, message) {
    await db.run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', [
      tokenHash,
    ]);
    const row = await db.get('SELECT attempts FROM mfa_challenges WHERE token_hash = ?', [
      tokenHash,
    ]);
    if ((row?.attempts ?? MAX_MFA_ATTEMPTS) >= MAX_MFA_ATTEMPTS) {
      await auth.deletePending(tokenHash);
      auth.clearMfaCookie(req, res);
      return res
        .status(401)
        .json({ error: 'Too many attempts, please log in again', mfa_pending: false });
    }
    return res.status(401).json({ error: message });
  }

  // POST /api/login/mfa/webauthn/options → PublicKeyCredentialRequestOptions JSON.
  router.post(
    '/login/mfa/webauthn/options',
    asyncHandler(async (req, res) => {
      const pending = req.mfa;
      if (!pending || pending.kind !== 'login') {
        return res.status(401).json({ error: 'MFA session expired, please log in again' });
      }
      const userId = pending.userId;
      const creds = await webauthnCredentials(db, userId);
      if (creds.length === 0) {
        return res.status(400).json({ error: 'passkey is not an enrolled method for this account' });
      }
      const { rpID } = webauthnRelyingParty(req);
      const options = await generateAuthenticationOptions({
        rpID,
        // Only THIS user's credentials — a global lookup would let one account assert
        // with another account's passkey.
        allowCredentials: creds.map((c) => ({
          id: c.credential_id,
          transports: parseTransports(c.transports),
        })),
        userVerification: 'preferred',
      });
      await storeAuthChallenge(db, userId, pending.tokenHash, options.challenge);
      res.json(options);
    })
  );

  // POST /api/login/mfa/webauthn/verify { response } → verify the assertion and, on
  // success, complete the SAME login state machine (burn pending token, create session).
  router.post(
    '/login/mfa/webauthn/verify',
    asyncHandler(async (req, res) => {
      const pending = req.mfa;
      if (!pending || pending.kind !== 'login') {
        return res.status(401).json({ error: 'MFA session expired, please log in again' });
      }
      const userId = pending.userId;
      const tokenHash = pending.tokenHash;
      const response = req.body?.response;
      if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
        return res.status(400).json({ error: 'assertion response is required' });
      }

      const expectedChallenge = await takeAuthChallenge(db, tokenHash);
      if (!expectedChallenge) {
        return failMfaAttempt(req, res, tokenHash, 'passkey challenge expired — try again');
      }

      // Look up the asserted credential SCOPED TO THE PENDING LOGIN'S USER. Cross-user
      // isolation: a credential registered under another account is invisible here even
      // if its id is echoed, so no one can log in as someone else with their own passkey.
      const cred = await db.get(
        'SELECT * FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?',
        [userId, response.id]
      );
      if (!cred) {
        return failMfaAttempt(req, res, tokenHash, 'Invalid passkey');
      }

      const { rpID, expectedOrigin } = webauthnRelyingParty(req);
      if (!expectedOrigin.length) {
        return res.status(400).json({ error: 'could not determine the relying-party origin' });
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin,
          expectedRPID: rpID,
          credential: {
            id: cred.credential_id,
            publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
            counter: cred.counter,
            transports: parseTransports(cred.transports),
          },
          requireUserVerification: false,
        });
      } catch {
        // Includes the library's counter-regression check (a decreasing counter signals
        // a cloned authenticator) — treated as a failed attempt.
        return failMfaAttempt(req, res, tokenHash, 'Invalid passkey');
      }
      if (!verification.verified) {
        return failMfaAttempt(req, res, tokenHash, 'Invalid passkey');
      }

      // Persist the advanced counter (many platform authenticators keep it at 0/0, which
      // the library allows) and stamp last-used.
      await db.run(
        'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
        [verification.authenticationInfo.newCounter, new Date().toISOString(), cred.id]
      );

      // Success: complete login exactly like the code path. SINGLE Set-Cookie (session
      // only) — see the note on /login/mfa above for why we do not also clear the inert
      // carmaint_mfa cookie here (Vercel multi-Set-Cookie mangling).
      await auth.deletePending(tokenHash);
      const token = await auth.createSession(userId);
      auth.setSessionCookie(req, res, token);
      const u = await db.get('SELECT username, is_admin FROM users WHERE id = ?', [userId]);
      res.json({ username: u.username, is_admin: !!u.is_admin });
    })
  );

  // Logout: drop the full session (if any) and the pending token row (if any). We emit
  // a SINGLE Set-Cookie — clearing the PRIMARY carmaint_session cookie — and delete the
  // pending row from the DB instead of also clearing carmaint_mfa. Once the row is gone
  // the lingering carmaint_mfa cookie is INERT (resolvePending returns null for a
  // missing row), so a second clear-cookie header is unnecessary. Keeping it to one
  // Set-Cookie avoids Vercel's serverless multi-Set-Cookie mangling. Idempotent.
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      await auth.destroySession(req);
      auth.clearSessionCookie(req, res);
      const pending = await auth.resolvePending(req);
      if (pending) await auth.deletePending(pending.tokenHash);
      res.json({ authenticated: false });
    })
  );

  // Always public: reports auth + MFA state so the client can route.
  //   full session      → { required, authenticated:true, username, is_admin, mfa_enabled }
  //   pending 'login'   → { required, authenticated:false, mfa_pending:true, username, methods }
  //   none              → { required, authenticated:false }
  // MFA is optional, so there is no longer a "setup required" state. A full session with
  // mfa_enabled:false is how the client knows to show the setup nudge + banner.
  router.get(
    '/auth/status',
    asyncHandler(async (req, res) => {
      const user = await auth.authenticate(req);
      if (user) {
        return res.json({
          required: true,
          authenticated: true,
          username: user.username,
          is_admin: user.is_admin,
          mfa_enabled: await hasActiveMFA(db, user.id),
        });
      }
      const pending = await auth.resolvePending(req);
      if (pending && pending.kind === 'login') {
        const u = await db.get('SELECT username FROM users WHERE id = ?', [pending.user_id]);
        return res.json({
          required: true,
          authenticated: false,
          username: u?.username,
          mfa_pending: true,
          methods: await loginMethods(db, pending.user_id),
        });
      }
      res.json({ required: true, authenticated: false });
    })
  );

  // Per-user calendar feed URL. Guarded, so req.user is set (full session only).
  router.get(
    '/calendar-url',
    asyncHandler(async (req, res) => {
      const row = await db.get('SELECT calendar_token FROM users WHERE id = ?', [req.user.id]);
      res.json({ url: `/calendar.ics?token=${row.calendar_token}` });
    })
  );

  return router;
}
