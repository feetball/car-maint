import { useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

// Login step 2. Reached when the server reports the pending-login state (a correct
// password on an MFA-enabled account). The user picks one of their enrolled methods
// and submits a second factor:
//   totp     → 6-digit authenticator code
//   backup   → one of the saved recovery codes
//   email    → send a code to the confirmed address, then enter it
//   webauthn → assert with a passkey (startAuthentication via api.webauthnLogin)
// Success completes the login (server sets the session cookie) → onDone(). After the
// server burns the pending token (5 failures / expiry) the error says "log in again"
// and we bounce back to the password screen via onExpired().
const META = {
  totp: { label: 'Authenticator', icon: 'clipboard' },
  webauthn: { label: 'Passkey', icon: 'user' },
  email: { label: 'Email code', icon: 'bell' },
  backup: { label: 'Backup code', icon: 'copy' },
};
const ORDER = ['totp', 'webauthn', 'email', 'backup'];

function isExpired(message) {
  return /log in again/i.test(message || '');
}

export default function SecondFactorView({ username, methods, onDone, onExpired, onLogout }) {
  const available = ORDER.filter((m) => (methods || []).includes(m));
  const initial = available[0] || 'totp';
  const [method, setMethod] = useState(initial);

  const [code, setCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function fail(err) {
    if (isExpired(err.message)) {
      onExpired(err.message);
    } else {
      setError(err.message);
    }
  }

  function switchMethod(next) {
    setMethod(next);
    setError(null);
    setCode('');
    setEmailSent(false);
  }

  async function submitCode(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.loginMfa(code.trim(), method);
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail() {
    setBusy(true);
    setError(null);
    try {
      await api.emailSendCode();
      setEmailSent(true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function usePasskey() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.webauthnLogin();
      onDone();
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        setError('Passkey prompt was cancelled. Try again or pick another method.');
      } else {
        fail(err);
      }
    } finally {
      setBusy(false);
    }
  }

  const isCodeMethod = method === 'totp' || method === 'backup' || method === 'email';
  const codeLabel = method === 'backup' ? 'Backup code' : 'Verification code';

  return (
    <div className="login-view">
      <div className="login-card">
        <span className="login-card__mark" aria-hidden="true">
          <Icon name="wrench" size={22} />
        </span>
        <h1 className="login-card__title">Two-factor authentication</h1>
        <p className="login-card__sub">
          {username ? (
            <>
              Signed in as <strong>{username}</strong>. Confirm it&apos;s you with a second factor.
            </>
          ) : (
            'Confirm it&apos;s you with a second factor.'
          )}
        </p>

        {available.length > 1 && (
          <div className="mfa-methods mfa-methods--row" role="tablist" aria-label="Choose a method">
            {available.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                className={`mfa-chip${method === m ? ' mfa-chip--active' : ''}`}
                onClick={() => switchMethod(m)}
              >
                <Icon name={META[m].icon} size={15} />
                <span>{META[m].label}</span>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            <span className="error-banner__message">{error}</span>
          </div>
        )}

        {method === 'webauthn' && (
          <div className="mfa-enroll">
            <p className="backup-note">Use your registered passkey to finish signing in.</p>
            <button type="button" className="button button--primary" onClick={usePasskey} disabled={busy}>
              <Icon name="user" size={16} />
              {busy ? 'Waiting for passkey…' : 'Use a passkey'}
            </button>
          </div>
        )}

        {method === 'email' && !emailSent && (
          <div className="mfa-enroll">
            <p className="backup-note">
              We&apos;ll email a one-time code to the address on your account.
            </p>
            <button type="button" className="button button--primary" onClick={sendEmail} disabled={busy}>
              <Icon name="bell" size={16} />
              {busy ? 'Sending…' : 'Email me a code'}
            </button>
          </div>
        )}

        {isCodeMethod && (method !== 'email' || emailSent) && (
          <form className="mfa-enroll" onSubmit={submitCode}>
            <label className="field field--full">
              <span className="field__label">{codeLabel}</span>
              <input
                type="text"
                inputMode={method === 'backup' ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={method === 'backup' ? 'xxxxx-xxxxx' : '123456'}
                aria-label={codeLabel}
                autoFocus
              />
            </label>
            <button type="submit" className="button button--primary" disabled={busy || !code.trim()}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </form>
        )}

        <p className="login-card__switch">
          <button type="button" className="login-card__link" onClick={onLogout}>
            Back to login
          </button>
        </p>
      </div>
    </div>
  );
}
