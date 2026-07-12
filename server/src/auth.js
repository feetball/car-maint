import crypto from 'node:crypto';

const COOKIE_NAME = 'carmaint_session';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Constant-time compare of two ASCII/hex strings without leaking length via early
// return: both sides are hashed to a fixed 32-byte digest first, then compared.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
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

// Builds the auth helper. Auth is enabled iff appPassword is a non-empty string.
// key = sha256(APP_PASSWORD + (AUTH_SECRET ?? '')); used to HMAC session cookies
// and the calendar token. cronSecret guards /api/cron/* via a bearer header.
export function createAuth({ appPassword, authSecret, cronSecret } = {}) {
  const required = typeof appPassword === 'string' && appPassword.length > 0;
  const key = required
    ? crypto.createHash('sha256').update(appPassword + (authSecret ?? '')).digest()
    : null;

  const hmacHex = (msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');

  function makeSessionValue() {
    const exp = String(Date.now() + THIRTY_DAYS_MS);
    return `${exp}.${hmacHex(exp)}`;
  }

  function sessionValid(value) {
    if (typeof value !== 'string') return false;
    const dot = value.lastIndexOf('.');
    if (dot < 0) return false;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const exp = Number(payload);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    return safeEqual(sig, hmacHex(payload));
  }

  function isAuthenticated(req) {
    if (!required) return true;
    return sessionValid(readCookie(req, COOKIE_NAME));
  }

  function passwordMatches(provided) {
    return required && safeEqual(provided, appPassword);
  }

  // Set-Cookie attributes. Secure is added when the request arrived over https
  // (behind Vercel/other TLS proxies) so the cookie still works over plain http
  // in Docker/local while staying Secure in production.
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

  function setSession(req, res) {
    res.append('Set-Cookie', cookieAttrs(req, makeSessionValue(), Math.floor(THIRTY_DAYS_MS / 1000)));
  }
  function clearSession(req, res) {
    res.append('Set-Cookie', cookieAttrs(req, '', 0));
  }

  // Calendar feed auth: a stable hex token instead of a cookie, so calendar apps
  // can subscribe. verifyCalendarToken accepts anything when auth is disabled.
  function calendarToken() {
    return required ? hmacHex('calendar') : '';
  }
  function verifyCalendarToken(token) {
    if (!required) return true;
    return safeEqual(token, calendarToken());
  }

  // Cron routes accept Authorization: Bearer <CRON_SECRET>. When CRON_SECRET is
  // unset the routes are open (Vercel only sends the header when the env is set).
  function cronAuthorized(req) {
    if (!cronSecret) return true;
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m ? safeEqual(m[1], cronSecret) : false;
  }

  // Express middleware enforcing the session cookie over /api and /photos.
  // Exempt: the auth endpoints themselves and /api/cron/* (which enforces the
  // cron bearer instead). No-op entirely when auth is disabled.
  const EXEMPT = new Set(['/api/login', '/api/logout', '/api/auth/status']);
  function middleware() {
    return (req, res, next) => {
      if (!required) return next();
      const p = req.path;
      const guarded = p === '/photos' || p.startsWith('/photos/') || p === '/api' || p.startsWith('/api/');
      if (!guarded) return next();
      if (EXEMPT.has(p)) return next();
      if (p.startsWith('/api/cron/')) return next();
      if (isAuthenticated(req)) return next();
      return res.status(401).json({ error: 'Authentication required' });
    };
  }

  return {
    required,
    isAuthenticated,
    passwordMatches,
    setSession,
    clearSession,
    calendarToken,
    verifyCalendarToken,
    cronAuthorized,
    middleware,
    COOKIE_NAME,
  };
}
