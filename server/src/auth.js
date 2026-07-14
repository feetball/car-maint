import crypto from 'node:crypto';

const COOKIE_NAME = 'carmaint_session';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// MFA login state machine. The pending-login/setup token lives in its own
// short-lived HttpOnly cookie (separate from the real session) so the client can
// simply POST the second-factor code back without echoing tokens.
const MFA_COOKIE_NAME = 'carmaint_mfa';
const MFA_PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Attempts allowed against a single pending-login token before it is invalidated
// (forcing a fresh password login). Caps brute force of the 6-digit codes.
export const MAX_MFA_ATTEMPTS = 5;

// Login (password step) rate limit. The per-pending-token MAX_MFA_ATTEMPTS cap only
// bounds guesses against ONE token; without this an attacker who knows the password
// could loop login→mint-token→5-guesses unbounded, brute-forcing the second factor.
// Best-effort in-memory FIXED WINDOW keyed by lowercased username + client IP, so
// distinct accounts (and distinct test users) never throttle each other. Serverless
// caveat: state is per-instance, so across N running instances the effective cap is
// ~N× this limit — acceptable as a mitigation (a DB-backed counter would be stronger
// but heavier). Only the PASSWORD step is limited here; the MFA step keeps its own
// per-token cap.
export const LOGIN_RATELIMIT_MAX = 10; // attempts per window per key
export const LOGIN_RATELIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// scrypt parameters. Kept in the stored hash string (scrypt:N:r:p:salthex:hashhex)
// so they can be raised later without invalidating existing hashes — verify reads
// the params from the stored value, not from these constants.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

// Minimal input rules (product decision): usernames are 3–32 chars of
// [a-zA-Z0-9_.-]; passwords are at least 8 chars. Uniqueness (case-insensitive) is
// enforced by the users.username UNIQUE COLLATE NOCASE index, not here.
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LEN = 8;

export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}
export function validatePassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LEN;
}

// scrypt password hashing via node:crypto (no new dependency). Format:
// scrypt:N:r:p:salthex:hashhex.
export function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Constant-time password verification. Re-derives the hash using the params/salt
// stored alongside it and timing-safe-compares the digests. Any malformed stored
// value or derive error returns false rather than throwing.
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Session tokens: 32 random bytes hex handed to the client in the cookie; only the
// sha256 hex of the token is ever stored (sessions.token_hash), so a leaked DB
// cannot be replayed as a cookie.
export function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Per-user calendar feed token: high-entropy random hex, looked up directly by the
// indexed users.calendar_token UNIQUE column.
export function newCalendarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Pending-login/setup token: 32 random bytes hex handed to the client in the
// carmaint_mfa cookie; only its sha256 is stored (mfa_challenges.token_hash), same
// leaked-DB-can't-be-replayed property as session tokens.
export function newPendingToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Minimal cookie header parse (no cookie-parser dependency).
export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// Builds the auth helper. Auth is ALWAYS required now (multi-user accounts fully
// replace the old shared APP_PASSWORD). Sessions are DB-backed (stateless
// instances / serverless), so the helper needs the data facade. cronSecret guards
// /api/cron/* via a bearer header. `production` (VERCEL/NODE_ENV, computed in
// app.js) decides fail-open vs fail-closed when cronSecret is unset.
export function createAuth({ cronSecret, db, production = false } = {}) {
  // Set-Cookie attributes. Secure is added when the request arrived over https
  // (behind Vercel/other TLS proxies) so the cookie still works over plain http in
  // Docker/local while staying Secure in production.
  function cookieAttrs(req, value, maxAgeSeconds) {
    const attrs = [
      `${COOKIE_NAME}=${value}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    if (proto === 'https') attrs.push('Secure');
    return attrs.join('; ');
  }

  // Creates a session row for a user and returns the raw token (to put in the
  // cookie). Fixed 30-day expiry.
  async function createSession(userId) {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
      hashToken(token),
      userId,
      expiresAt,
    ]);
    return token;
  }

  function setSessionCookie(req, res, token) {
    res.append('Set-Cookie', cookieAttrs(req, token, Math.floor(THIRTY_DAYS_MS / 1000)));
  }
  function clearSessionCookie(req, res) {
    res.append('Set-Cookie', cookieAttrs(req, '', 0));
  }

  // Deletes the session backing the request's cookie (logout). Best-effort: an
  // absent/expired session is a no-op.
  async function destroySession(req) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) return;
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  }

  // --- MFA pending-token / cookie helpers ----------------------------------
  // The carmaint_mfa cookie mirrors the session cookie's attributes but with the
  // MFA name and a short (10 min) Max-Age.
  function mfaCookieAttrs(req, value, maxAgeSeconds) {
    const attrs = [
      `${MFA_COOKIE_NAME}=${value}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    if (proto === 'https') attrs.push('Secure');
    return attrs.join('; ');
  }
  function setMfaCookie(req, res, token) {
    res.append('Set-Cookie', mfaCookieAttrs(req, token, Math.floor(MFA_PENDING_TTL_MS / 1000)));
  }
  function clearMfaCookie(req, res) {
    res.append('Set-Cookie', mfaCookieAttrs(req, '', 0));
  }

  // Creates a pending-login/setup challenge row for a user and returns the raw
  // token (to put in the carmaint_mfa cookie). kind is 'login' or 'setup'.
  async function createPending(userId, kind) {
    const token = newPendingToken();
    const expiresAt = new Date(Date.now() + MFA_PENDING_TTL_MS).toISOString();
    await db.run(
      'INSERT INTO mfa_challenges (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
      [hashToken(token), userId, kind, expiresAt]
    );
    return token;
  }

  // Resolves the request's carmaint_mfa cookie to the pending row, or null.
  // Expired rows are opportunistically deleted so the table self-prunes on access.
  async function resolvePending(req) {
    const token = readCookie(req, MFA_COOKIE_NAME);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const row = await db.get('SELECT * FROM mfa_challenges WHERE token_hash = ?', [tokenHash]);
    if (!row) return null;
    if (row.expires_at <= new Date().toISOString()) {
      await db.run('DELETE FROM mfa_challenges WHERE token_hash = ?', [tokenHash]);
      return null;
    }
    return { ...row, tokenHash };
  }

  async function deletePending(tokenHash) {
    await db.run('DELETE FROM mfa_challenges WHERE token_hash = ?', [tokenHash]);
  }

  // --- Login (password step) rate limiter ----------------------------------
  // In-memory fixed-window counter, one map per app instance. key -> { count, resetAt }.
  const loginAttempts = new Map();

  // Best-effort client IP: first hop of x-forwarded-for (Vercel/proxy) else req.ip.
  function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  // Records one login attempt for (username, ip) and reports whether it is within the
  // per-window cap. Fixed window: the counter resets once the window elapses. Returns
  // true when the attempt is ALLOWED, false when the cap is exceeded (caller → 429).
  // Keyed on the lowercased username so it matches the case-insensitive account lookup
  // and so distinct accounts are isolated; IP is folded in as a second dimension.
  function registerLoginAttempt(req) {
    const username =
      typeof req.body?.username === 'string' ? req.body.username.toLowerCase() : '';
    const key = `${username} ${clientIp(req)}`;
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
      loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_RATELIMIT_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    // Opportunistic prune of expired keys so the map does not grow unbounded.
    if (loginAttempts.size > 10000) {
      for (const [k, v] of loginAttempts) if (v.resetAt <= now) loginAttempts.delete(k);
    }
    return entry.count <= LOGIN_RATELIMIT_MAX;
  }

  // Resolves the request's session cookie to { id, username } or null. Expired
  // rows are opportunistically deleted so the table self-prunes on access.
  async function authenticate(req) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) return null;
    const row = await db.get(
      `SELECT s.expires_at AS expires_at, u.id AS id, u.username AS username, u.is_admin AS is_admin
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      [hashToken(token)]
    );
    if (!row) return null;
    if (row.expires_at <= new Date().toISOString()) {
      await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
      return null;
    }
    // is_admin is stored as 0/1; expose a real boolean so callers (req.user.is_admin,
    // the status payload, the admin guard) never branch on a truthy number.
    return { id: row.id, username: row.username, is_admin: !!row.is_admin };
  }

  // Cron/admin routes accept Authorization: Bearer <CRON_SECRET>. When CRON_SECRET
  // is UNSET we fail CLOSED in production (VERCEL/NODE_ENV=production) — otherwise
  // open signup would expose the global whole-DB /api/backups and /api/cron/* to
  // anyone — but stay OPEN in non-production (local dev / Docker / the test suite,
  // which run with no CRON_SECRET) so those keep working. When CRON_SECRET is SET
  // the bearer is required in every environment.
  // STRICT bearer check: true only when CRON_SECRET is configured AND the request
  // carries a matching `Authorization: Bearer <secret>` (timing-safe). Unlike
  // cronAuthorized this has NO dev-open fallback, so it is the right primitive for
  // deciding real machine/DR access to the global-backup routes: a mere logged-in
  // (non-admin) user in dev must not be waved through just because CRON_SECRET is
  // unset. cronAuthorized (below) keeps its dev-open behavior for /api/cron/*.
  function bearerPresentAndValid(req) {
    if (!cronSecret) return false;
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return false;
    const a = crypto.createHash('sha256').update(m[1]).digest();
    const b = crypto.createHash('sha256').update(cronSecret).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function cronAuthorized(req) {
    if (!cronSecret) return !production;
    return bearerPresentAndValid(req);
  }

  // Session-based admin guard for /api/admin/*. The global auth gate already ran and
  // attached req.user for guarded paths, so a missing req.user means no valid session
  // (401) and a present-but-non-admin user means forbidden (403). is_admin gives NO
  // implicit access to per-user routes — it is only consulted here and by the
  // global-backup guard; per-user routers still scope every query by req.user.id.
  function requireAdminSession(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
  }

  // Express middleware enforcing a valid session over /api and /photos. Exempt:
  // the register/login/logout/status endpoints (needed to bootstrap a session) and
  // /api/cron/* (which enforces the cron bearer instead). On success req.user is
  // attached; otherwise a 401 is returned.
  //
  // Express routing is case-INSENSITIVE by default, so the routers below match
  // `/API/vehicles`, `/Photos/x`, etc. The guard must match whatever the router
  // will match, so every prefix/exempt decision is made against a lowercased copy
  // of the path (the real req.path / routing is left untouched). Without this,
  // `/API/backups` would dodge the gate entirely and serve unauthenticated.
  const EXEMPT = new Set(['/api/register', '/api/login', '/api/logout', '/api/auth/status']);
  // The LOGIN-state allowlist. A login-pending user (password verified, but they
  // ALREADY have a confirmed second factor) must PROVE that factor — never enroll or
  // mutate one. So they may reach ONLY: the second-factor submit (/api/login/mfa),
  // the passkey assertion round-trip (/api/login/mfa/webauthn/options|verify), a fresh
  // email login code to their CONFIRMED address (/api/mfa/email/send-code), and the
  // read-only status the second-factor screen needs (/api/mfa/status). Every other
  // /api/mfa/* endpoint (totp/setup+confirm, email/setup+confirm, webauthn/register/*,
  // backup/regenerate) ENROLLS or MUTATES a factor and is blocked (403) — otherwise an
  // attacker with only the password could overwrite the victim's factor and mint a full
  // session. (/api/logout is already exempt above, so it works in every state.)
  // Paths are compared against the same lowercased copy the gate uses for case safety.
  const LOGIN_PENDING_ALLOW = new Set([
    '/api/login/mfa',
    '/api/login/mfa/webauthn/options',
    '/api/login/mfa/webauthn/verify',
    '/api/mfa/email/send-code',
    '/api/mfa/status',
  ]);
  // The global whole-DB backup endpoints all live under /api/backups (list, download,
  // on-demand create, global restore). They accept EITHER an admin session OR the
  // CRON_SECRET bearer (cron/DR tooling). A bearer-only machine request has no session,
  // so the gate would otherwise 401 it before the route's own guard runs — allow it
  // through here (only when the bearer is actually valid) so DR tooling works without a
  // cookie. The per-user singular routes (/api/backup, /api/restore) are NOT under this
  // prefix and stay session-only.
  const isGlobalBackupPath = (p) => p === '/api/backups' || p.startsWith('/api/backups/');
  function middleware() {
    return (req, res, next) => {
      const p = req.path.toLowerCase();
      const guarded =
        p === '/photos' || p.startsWith('/photos/') || p === '/api' || p.startsWith('/api/');
      if (!guarded) return next();
      if (EXEMPT.has(p)) return next();
      if (p.startsWith('/api/cron/')) return next();
      authenticate(req)
        .then(async (user) => {
          if (user) {
            // Full session → full access (unchanged behavior).
            req.user = user;
            return next();
          }
          // No full session. The only remaining limited state is 'login' pending: the
          // password was verified but the user ALREADY has a confirmed second factor
          // they must PROVE. (MFA is optional, so there is no longer a "setup" pending
          // state — a user with no MFA gets a full session at /api/login directly.) A
          // login-pending user may ONLY submit their factor / read status / request an
          // email code (LOGIN_PENDING_ALLOW); enrollment + mutation + data endpoints are
          // BLOCKED so a password-only attacker cannot overwrite the victim's factor or
          // reach their data.
          const pending = await resolvePending(req);
          if (pending && pending.kind === 'login') {
            req.mfa = { userId: pending.user_id, kind: pending.kind, tokenHash: pending.tokenHash };
            if (LOGIN_PENDING_ALLOW.has(p)) return next();
            return res.status(403).json({ error: 'MFA required', mfa_pending: true });
          }
          if (isGlobalBackupPath(p) && bearerPresentAndValid(req)) return next();
          return res.status(401).json({ error: 'Authentication required' });
        })
        .catch(next);
    };
  }

  return {
    required: true,
    validateUsername,
    validatePassword,
    hashPassword,
    verifyPassword,
    newCalendarToken,
    createSession,
    destroySession,
    setSessionCookie,
    clearSessionCookie,
    authenticate,
    createPending,
    resolvePending,
    deletePending,
    setMfaCookie,
    clearMfaCookie,
    cronAuthorized,
    bearerPresentAndValid,
    requireAdminSession,
    registerLoginAttempt,
    middleware,
    COOKIE_NAME,
    MFA_COOKIE_NAME,
  };
}
