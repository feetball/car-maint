import crypto from 'node:crypto';

const COOKIE_NAME = 'carmaint_session';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

  // Resolves the request's session cookie to { id, username } or null. Expired
  // rows are opportunistically deleted so the table self-prunes on access.
  async function authenticate(req) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) return null;
    const row = await db.get(
      `SELECT s.expires_at AS expires_at, u.id AS id, u.username AS username
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      [hashToken(token)]
    );
    if (!row) return null;
    if (row.expires_at <= new Date().toISOString()) {
      await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
      return null;
    }
    return { id: row.id, username: row.username };
  }

  // Cron/admin routes accept Authorization: Bearer <CRON_SECRET>. When CRON_SECRET
  // is UNSET we fail CLOSED in production (VERCEL/NODE_ENV=production) — otherwise
  // open signup would expose the global whole-DB /api/backups and /api/cron/* to
  // anyone — but stay OPEN in non-production (local dev / Docker / the test suite,
  // which run with no CRON_SECRET) so those keep working. When CRON_SECRET is SET
  // the bearer is required in every environment.
  function cronAuthorized(req) {
    if (!cronSecret) return !production;
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return false;
    const a = crypto.createHash('sha256').update(m[1]).digest();
    const b = crypto.createHash('sha256').update(cronSecret).digest();
    return crypto.timingSafeEqual(a, b);
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
  function middleware() {
    return (req, res, next) => {
      const p = req.path.toLowerCase();
      const guarded =
        p === '/photos' || p.startsWith('/photos/') || p === '/api' || p.startsWith('/api/');
      if (!guarded) return next();
      if (EXEMPT.has(p)) return next();
      if (p.startsWith('/api/cron/')) return next();
      authenticate(req)
        .then((user) => {
          if (!user) return res.status(401).json({ error: 'Authentication required' });
          req.user = user;
          next();
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
    cronAuthorized,
    middleware,
    COOKIE_NAME,
  };
}
