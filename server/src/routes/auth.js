import { Router } from 'express';
import { asyncHandler, badRequest, HttpError } from '../helpers.js';
import { hashPassword } from '../auth.js';

// A fixed, valid scrypt hash used only to spend equal CPU on the user-miss path of
// login, so a nonexistent username can't be distinguished from a wrong password by
// response timing. Computed once per process (no per-request or per-app cost). Its
// plaintext is irrelevant — it never matches a submitted password.
const DUMMY_PASSWORD_HASH = hashPassword('carmaint-login-timing-dummy');

// Account + session endpoints. register/login/logout/status are exempt from the
// auth gate (they bootstrap or report a session); calendar-url is guarded, so it
// runs with req.user attached.
export function authRouter(ctx) {
  const router = Router();
  const auth = ctx.auth;
  const db = ctx.db;

  // Open signup: anyone can register a username+password. Creates the user and an
  // auto-login session in one transaction, then sets the session cookie.
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

      // Case-insensitive pre-check for a clean 409; the UNIQUE index is the real
      // guard (a concurrent insert is caught below).
      const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (existing) throw new HttpError(409, 'username is already taken');

      // First-ever account bootstraps the admin (product decision). Everyone after is
      // a normal user; admins promote others via /api/admin. The COUNT==0 check and the
      // INSERT are close enough that a true concurrent first-signup race is negligible
      // for a self-hosted app; the UNIQUE username index still guarantees correctness of
      // the accounts themselves, and an operator can re-assign admin if two truly-
      // simultaneous first signups ever both saw an empty table.
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

      const token = await auth.createSession(userId);
      auth.setSessionCookie(req, res, token);
      res.status(201).json({ username, is_admin: !!isAdmin });
    })
  );

  // Login: verify credentials (constant-time), issue a session cookie. The error
  // is generic on failure so neither field is revealed as the wrong one.
  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const username = req.body?.username;
      const password = req.body?.password;
      const user =
        typeof username === 'string'
          ? await db.get('SELECT * FROM users WHERE username = ?', [username])
          : undefined;
      // Always run one scrypt verify — against the real hash, or a fixed dummy hash
      // when the username doesn't exist — so both paths take ~equal time and don't
      // leak account existence via timing. The result is generic 401 either way.
      const ok = auth.verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
      if (!user || !ok) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const token = await auth.createSession(user.id);
      auth.setSessionCookie(req, res, token);
      res.json({ username: user.username });
    })
  );

  // Logout: drop the session row and clear the cookie. Idempotent.
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      await auth.destroySession(req);
      auth.clearSessionCookie(req, res);
      res.json({ authenticated: false });
    })
  );

  // Always public: reports whether auth is required and, if a valid session is
  // present, the logged-in username. Exempt from the gate, so it looks up the
  // session itself.
  router.get(
    '/auth/status',
    asyncHandler(async (req, res) => {
      const user = await auth.authenticate(req);
      if (user)
        res.json({
          required: true,
          authenticated: true,
          username: user.username,
          is_admin: user.is_admin,
        });
      else res.json({ required: true, authenticated: false });
    })
  );

  // Per-user calendar feed URL for subscribing calendar apps (cookies aren't usable
  // by calendar clients). Guarded, so req.user is set; returns this user's token.
  router.get(
    '/calendar-url',
    asyncHandler(async (req, res) => {
      const row = await db.get('SELECT calendar_token FROM users WHERE id = ?', [req.user.id]);
      res.json({ url: `/calendar.ics?token=${row.calendar_token}` });
    })
  );

  return router;
}
