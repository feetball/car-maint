import { useState } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api } from '../../api.js';
import Icon from '../Icon.jsx';
import QrCode from './QrCode.jsx';

// Enrollment widgets shared by the forced-setup screen (EnrollView) and the
// Security settings page. Each calls onComplete(result) with the server's confirm/
// verify payload — which, on a first factor, carries backup_codes and the upgraded
// session — and leaves the parent to decide what to show next (backup codes, refresh).

// --- TOTP (authenticator app) ------------------------------------------------
export function TotpEnroll({ onComplete, onCancel }) {
  const [setup, setSetup] = useState(null); // { secret_base32, otpauth_uri }
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      setSetup(await api.totpSetup());
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function confirm(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.totpConfirm(code.trim());
      onComplete(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!setup) {
    return (
      <div className="mfa-enroll">
        <p className="backup-note">
          Use an authenticator app (Google Authenticator, 1Password, Authy…) to generate a
          6-digit code that changes every 30 seconds.
        </p>
        {error && (
          <div className="error-banner" role="alert">
            <span className="error-banner__message">{error}</span>
          </div>
        )}
        <div className="backup-actions">
          <button type="button" className="button button--primary" onClick={start} disabled={starting}>
            {starting ? 'Preparing…' : 'Set up authenticator app'}
          </button>
          {onCancel && (
            <button type="button" className="button button--ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form className="mfa-enroll" onSubmit={confirm}>
      <p className="backup-note">
        Scan this QR code with your authenticator app, or enter the secret key manually, then
        type the 6-digit code it shows.
      </p>
      <div className="mfa-enroll__qr">
        <QrCode value={setup.otpauth_uri} />
      </div>
      <div className="mfa-secret">
        <span className="field__label">Secret key</span>
        <code className="mfa-secret__value num" data-testid="totp-secret">
          {setup.secret_base32}
        </code>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner__message">{error}</span>
        </div>
      )}
      <label className="field field--full">
        <span className="field__label">6-digit code</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="123456"
          aria-label="Authenticator code"
          autoFocus
        />
      </label>
      <div className="backup-actions">
        <button type="submit" className="button button--primary" disabled={busy || code.length < 6}>
          {busy ? 'Verifying…' : 'Verify & enable'}
        </button>
        {onCancel && (
          <button type="button" className="button button--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// --- Passkey (WebAuthn) ------------------------------------------------------
export function PasskeyEnroll({ onComplete, onCancel }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const supported = browserSupportsWebAuthn();

  async function register() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.webauthnRegister(name.trim());
      onComplete(result);
    } catch (err) {
      // The user cancelling the browser prompt throws NotAllowedError/AbortError;
      // treat that as a soft cancel, not a hard failure.
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        setError('Passkey setup was cancelled. You can try again or pick another method.');
      } else {
        setError(err.message || 'Could not register a passkey.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!supported) {
    return (
      <div className="mfa-enroll">
        <p className="backup-note">
          This browser or device doesn&apos;t support passkeys. Please choose another method.
        </p>
        {onCancel && (
          <button type="button" className="button button--ghost" onClick={onCancel}>
            Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mfa-enroll">
      <p className="backup-note">
        Register a passkey — a fingerprint, face, device PIN, or hardware security key — as your
        second factor. Give it a name so you can recognise it later.
      </p>
      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner__message">{error}</span>
        </div>
      )}
      <label className="field field--full">
        <span className="field__label">
          Passkey name <span className="field__hint">(optional)</span>
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. MacBook Touch ID"
          aria-label="Passkey name"
          maxLength={100}
        />
      </label>
      <div className="backup-actions">
        <button type="button" className="button button--primary" onClick={register} disabled={busy}>
          <Icon name="user" size={16} />
          {busy ? 'Waiting for passkey…' : 'Create passkey'}
        </button>
        {onCancel && (
          <button type="button" className="button button--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// --- Email one-time code -----------------------------------------------------
export function EmailEnroll({ onComplete, onCancel }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function sendCode(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.emailSetup(email.trim());
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.emailConfirm(code.trim());
      onComplete(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!sent) {
    return (
      <form className="mfa-enroll" onSubmit={sendCode}>
        <p className="backup-note">
          We&apos;ll email a 6-digit code to confirm the address. Email 2FA must be enabled on this
          server.
        </p>
        {error && (
          <div className="error-banner" role="alert">
            <span className="error-banner__message">{error}</span>
          </div>
        )}
        <label className="field field--full">
          <span className="field__label">Email address</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Email address"
            autoFocus
          />
        </label>
        <div className="backup-actions">
          <button type="submit" className="button button--primary" disabled={busy || !email}>
            {busy ? 'Sending…' : 'Send verification code'}
          </button>
          {onCancel && (
            <button type="button" className="button button--ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <form className="mfa-enroll" onSubmit={confirm}>
      <p className="backup-note">
        Enter the 6-digit code we sent to <strong>{email}</strong>.
      </p>
      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner__message">{error}</span>
        </div>
      )}
      <label className="field field--full">
        <span className="field__label">Verification code</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="123456"
          aria-label="Email verification code"
          autoFocus
        />
      </label>
      <div className="backup-actions">
        <button type="submit" className="button button--primary" disabled={busy || code.length < 6}>
          {busy ? 'Verifying…' : 'Verify & enable'}
        </button>
        <button type="button" className="button button--ghost" onClick={() => setSent(false)}>
          Use a different email
        </button>
      </div>
    </form>
  );
}
