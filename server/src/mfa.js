import crypto from 'node:crypto';

// ============================================================================
// MFA primitives (no new runtime dependency for TOTP/backup codes).
//
// Everything here is method-agnostic where it can be. The WebAuthn phase plugs
// into three seams, all centralized in this file / the mfa router:
//   1. activeMethods()  — add a 'webauthn' entry when a confirmed credential
//      exists. This single function decides has-any-MFA, the last-factor guard,
//      the login `methods` list, and /api/mfa/status. Nothing else recomputes it.
//   2. the login/mfa verify switch (routes/mfa.js) — add a 'webauthn' case.
//   3. loginMethods() — add 'webauthn' to what the client may attempt.
// ============================================================================

// --- base32 (RFC 4648, no padding) — used for the TOTP shared secret --------
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// --- HOTP / TOTP (RFC 4226 / 6238), SHA-1, 6 digits, 30s --------------------
const TOTP_STEP = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // ±1 step of clock skew

// One HOTP value for a specific counter, as a zero-padded 6-digit string.
function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

// Generate the code a client would show right now (used by the test helper).
export function totpCode(secretBase32, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / TOTP_STEP);
  return hotp(base32Decode(secretBase32), counter);
}

// Verify a submitted 6-digit code against the secret across the ±window. The
// comparison is timing-safe PER candidate and never early-returns, so the
// response time does not reveal which step matched.
export function verifyTotp(secretBase32, token, atMs = Date.now()) {
  const t = String(token ?? '');
  if (!/^\d{6}$/.test(t)) return false;
  let secret;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const counter = Math.floor(atMs / 1000 / TOTP_STEP);
  const submitted = Buffer.from(t);
  let ok = false;
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const cand = Buffer.from(hotp(secret, counter + i));
    if (cand.length === submitted.length && crypto.timingSafeEqual(cand, submitted)) ok = true;
  }
  return ok;
}

// New random shared secret (20 bytes = 160 bits, RFC-recommended) as base32.
export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// otpauth:// provisioning URI — the CLIENT renders the QR from this string, so
// no server QR dependency. Label + issuer are percent-encoded.
export function otpauthUri(secretBase32, username, issuer = 'CarMaint') {
  // Label is `Issuer:Account` with the separator colon kept literal (authenticator
  // convention); the issuer and account parts are individually percent-encoded.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- hashing helpers --------------------------------------------------------
export function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Timing-safe compare of two sha256 hex digests (equal length by construction).
export function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- backup / recovery codes ------------------------------------------------
export const BACKUP_CODE_COUNT = 10;

// Normalize before hashing/compare so display formatting (dashes, case) never
// affects matching: strip non-alphanumerics, lowercase.
export function normalizeBackupCode(code) {
  return String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Ten codes, each 10 hex chars shown grouped as xxxxx-xxxxx. Only the sha256 of
// the normalized value is ever stored.
export function generateBackupCodes(n = BACKUP_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

// --- email one-time codes ---------------------------------------------------
export function generateEmailCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

// ============================================================================
// active-method computation — THE single source of truth for "has any MFA".
// Compute-on-the-fly (no cached users.mfa_enabled flag) so it stays correct the
// moment the WebAuthn phase adds its factor: extend the array here only.
// Returns e.g. ['totp','email'] (order stable). Backup codes are NOT a factor
// on their own — they are recovery for TOTP — so they never appear here.
// ============================================================================
export async function activeMethods(db, userId) {
  const methods = [];
  const totp = await db.get(
    'SELECT 1 AS x FROM mfa_totp WHERE user_id = ? AND confirmed_at IS NOT NULL',
    [userId]
  );
  if (totp) methods.push('totp');
  const email = await db.get(
    'SELECT 1 AS x FROM mfa_email WHERE user_id = ? AND confirmed_at IS NOT NULL',
    [userId]
  );
  if (email) methods.push('email');
  // WebAuthn: active as soon as the user has ≥1 registered credential. A passkey
  // credential is "confirmed" the moment registration verifies (there is no separate
  // pending/confirm step like TOTP/email), so mere existence of a row is enough.
  const webauthn = await db.get(
    'SELECT 1 AS x FROM webauthn_credentials WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (webauthn) methods.push('webauthn');
  return methods;
}

export async function hasActiveMFA(db, userId) {
  return (await activeMethods(db, userId)).length > 0;
}

// The factor kinds the client may attempt at the login second-factor step. Includes
// every active method (totp | email | webauthn) plus 'backup' when recovery codes
// apply. Backup codes are issued alongside TOTP, and — since the WebAuthn phase — also
// on a passkey-only account's FIRST factor, so 'backup' is offered when TOTP is active
// (its codes always exist) OR when WebAuthn is active and unused codes remain. This
// keeps a passkey-only user able to recover with a backup code at login.
export async function loginMethods(db, userId) {
  const active = await activeMethods(db, userId);
  const methods = [...active];
  const offerBackup =
    active.includes('totp') ||
    (active.includes('webauthn') && (await backupCodesRemaining(db, userId)) > 0);
  if (offerBackup) methods.push('backup');
  return methods;
}

// Count of unused backup codes (for /api/mfa/status).
export async function backupCodesRemaining(db, userId) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM mfa_backup_codes WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  return row?.n ?? 0;
}

// ============================================================================
// WebAuthn / passkeys (second factor). The heavy crypto (attestation/assertion
// verification) lives in @simplewebauthn/server, imported by the routes. This file
// owns the method-agnostic seams: active-method detection (above), the relying-party
// config derivation, single-use challenge persistence, and credential lookups.
// ============================================================================

// Relying-Party config, derived PER REQUEST so the same build works on Vercel
// (behind its proxy), on a self-hosted reverse proxy, and on localhost — with env
// overrides that take precedence in production.
//
// Derivation (no env):
//   host  = x-forwarded-host || host header   (Vercel/most proxies set the former)
//   proto = x-forwarded-proto || (req.secure ? 'https' : 'http')
//   rpID  = host with any :port stripped       (e.g. 'localhost:3000' → 'localhost')
//   origin= `${proto}://${host}`               (port kept — the browser sends it)
//
// Overrides (take precedence, and when set are the ONLY accepted values):
//   WEBAUTHN_RP_ID   → rpID verbatim
//   WEBAUTHN_ORIGIN  → comma-separated list of allowed origins (expectedOrigin)
//
// TRUST ASSUMPTION: with no env override, rpID/origin come from request headers, so a
// front proxy that sets a TRUSTWORTHY x-forwarded-host/-proto is required. On Vercel
// that header is set by the platform and trustworthy. Behind an UNTRUSTED proxy (or
// directly exposed) a spoofed Host could shift the expected origin, so production
// self-hosters SHOULD pin WEBAUTHN_RP_ID + WEBAUTHN_ORIGIN explicitly. When they are
// set, headers are ignored for verification and a spoofed Host cannot pass.
export function webauthnRelyingParty(req) {
  const envRpId = process.env.WEBAUTHN_RP_ID?.trim();
  const envOrigin = process.env.WEBAUTHN_ORIGIN?.trim();
  const rawHost = req.headers['x-forwarded-host'] || req.headers['host'] || '';
  const host = String(rawHost).split(',')[0].trim();
  const rawProto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const proto = String(rawProto).split(',')[0].trim() || 'http';
  const derivedRpId = host.replace(/:\d+$/, '');
  const derivedOrigin = host ? `${proto}://${host}` : '';
  const expectedOrigin = envOrigin
    ? envOrigin.split(',').map((s) => s.trim()).filter(Boolean)
    : derivedOrigin
      ? [derivedOrigin]
      : [];
  return {
    rpID: envRpId || derivedRpId,
    rpName: 'CarMaint',
    // expectedOrigin: array passed straight to verify*Response (accepts string|string[]).
    expectedOrigin,
  };
}

// Challenge lifetime: single-use and short. A stale challenge is worthless to an
// attacker but we still cap it so the table self-prunes on the next options call.
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// --- registration challenge (kind='webauthn_reg', keyed by user) -------------
// Full-session (or setup/login-pending) enrollment has no dedicated token, so the
// challenge is keyed by user. delete-then-insert keeps at most one live reg challenge
// per user (the random token_hash only satisfies the PK — it is never handed out).
export async function storeRegChallenge(db, userId, challenge) {
  const tokenHash = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS).toISOString();
  await db.run("DELETE FROM mfa_challenges WHERE user_id = ? AND kind = 'webauthn_reg'", [userId]);
  await db.run(
    `INSERT INTO mfa_challenges (token_hash, user_id, kind, code_hash, code_expires_at, expires_at)
     VALUES (?, ?, 'webauthn_reg', ?, ?, ?)`,
    [tokenHash, userId, challenge, expiresAt, expiresAt]
  );
}

// Consume the reg challenge (single-use): read it, delete it, return the base64url
// challenge string, or null if absent/expired.
export async function takeRegChallenge(db, userId) {
  const row = await db.get(
    "SELECT code_hash, code_expires_at FROM mfa_challenges WHERE user_id = ? AND kind = 'webauthn_reg'",
    [userId]
  );
  await db.run("DELETE FROM mfa_challenges WHERE user_id = ? AND kind = 'webauthn_reg'", [userId]);
  if (!row || !row.code_hash) return null;
  if (!row.code_expires_at || row.code_expires_at <= new Date().toISOString()) return null;
  return row.code_hash;
}

// --- authentication challenge (kind='webauthn_auth', keyed PER pending login) --
// Derives a distinct row key from the pending-login token hash so two concurrent
// logins never clobber each other's challenge (per-token isolation, like the email
// login-code path). The challenge is thereby associated with exactly that pending
// login — completing the assertion completes the SAME login state machine.
function authChallengeKey(pendingTokenHash) {
  return crypto.createHash('sha256').update(`webauthn_auth:${pendingTokenHash}`).digest('hex');
}

export async function storeAuthChallenge(db, userId, pendingTokenHash, challenge) {
  const key = authChallengeKey(pendingTokenHash);
  const expiresAt = new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS).toISOString();
  await db.run('DELETE FROM mfa_challenges WHERE token_hash = ?', [key]);
  await db.run(
    `INSERT INTO mfa_challenges (token_hash, user_id, kind, code_hash, code_expires_at, expires_at)
     VALUES (?, ?, 'webauthn_auth', ?, ?, ?)`,
    [key, userId, challenge, expiresAt, expiresAt]
  );
}

export async function takeAuthChallenge(db, pendingTokenHash) {
  const key = authChallengeKey(pendingTokenHash);
  const row = await db.get(
    "SELECT code_hash, code_expires_at FROM mfa_challenges WHERE token_hash = ? AND kind = 'webauthn_auth'",
    [key]
  );
  await db.run('DELETE FROM mfa_challenges WHERE token_hash = ?', [key]);
  if (!row || !row.code_hash) return null;
  if (!row.code_expires_at || row.code_expires_at <= new Date().toISOString()) return null;
  return row.code_hash;
}

// --- credential storage helpers ---------------------------------------------
export async function webauthnCredentials(db, userId) {
  return db.all(
    'SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY id ASC',
    [userId]
  );
}

export async function webauthnCredentialCount(db, userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?', [
    userId,
  ]);
  return row?.n ?? 0;
}

// Public view of a credential for the settings UI (never leaks the public key).
export function publicCredential(row) {
  return {
    id: row.credential_id,
    name: row.name ?? null,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
  };
}

// Parse the stored transports (JSON array) back to an array for allow/exclude lists.
export function parseTransports(value) {
  if (!value) return undefined;
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) && arr.length ? arr : undefined;
  } catch {
    return undefined;
  }
}

// --- mailer factory (lazy + injectable) -------------------------------------
// createApp passes options.mailer in tests (a capturing stub) so the suite never
// sends real email and can read the code. In production this builds a nodemailer
// transport lazily on first send — so an unset SMTP_HOST never imports nodemailer
// and never crashes boot; email is simply reported as unavailable.
export function createMailer(smtp = {}) {
  const configured = !!smtp.host;
  let transporter = null;
  return {
    configured,
    async send({ to, subject, text }) {
      if (!configured) throw new Error('email MFA not configured');
      if (!transporter) {
        const { default: nodemailer } = await import('nodemailer');
        transporter = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port ?? 587,
          secure: smtp.secure ?? false,
          auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
        });
      }
      await transporter.sendMail({ from: smtp.from ?? smtp.user, to, subject, text });
    },
  };
}
