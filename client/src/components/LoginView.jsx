import { useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

// Client-side mirror of the server's rules (server/src/auth.js): usernames are
// 3–32 chars of [a-zA-Z0-9_.-]; passwords are at least 8 chars. These give a
// friendly message before a round-trip; the server stays the source of truth.
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LEN = 8;

// Full-screen gate shown whenever the visitor is not signed in. Auth is always
// required now (multi-user accounts), so this offers both Login and Register.
// Submits to POST /api/login or /api/register; server errors ({error}) surface
// inline, and success asks the parent to reload auth/app state.
export default function LoginView({ onAuthenticated, notice = null }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [dismissedNotice, setDismissedNotice] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  function switchMode(next) {
    setMode(next);
    setError(null);
    setConfirm('');
  }

  // Returns a friendly message for the first client-side rule violation, or null
  // when the input passes. Mirrors the server so common mistakes never round-trip.
  function clientValidationError() {
    if (!username) return 'Enter a username.';
    if (!USERNAME_RE.test(username)) {
      return 'Username must be 3–32 characters using letters, numbers, _ . or -';
    }
    if (!password) return 'Enter a password.';
    if (isRegister) {
      if (password.length < MIN_PASSWORD_LEN) {
        return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
      }
      if (confirm !== password) return 'Passwords do not match.';
    }
    return null;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;

    const localError = clientValidationError();
    if (localError) {
      setError(localError);
      return;
    }

    setBusy(true);
    setError(null);
    setDismissedNotice(true);
    try {
      if (isRegister) await api.register(username, password);
      else await api.login(username, password);
      setPassword('');
      setConfirm('');
      await onAuthenticated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-view">
      <form className="login-card" onSubmit={handleSubmit} noValidate>
        <span className="login-card__mark" aria-hidden="true">
          <Icon name="wrench" size={22} />
        </span>
        <h1 className="login-card__title">CarMaint</h1>
        <p className="login-card__sub">
          {isRegister ? 'Create an account to start your garage.' : 'Sign in to open your garage.'}
        </p>
        {error && (
          <div className="error-banner" role="alert">
            <span className="error-banner__message">{error}</span>
          </div>
        )}
        {notice && !error && !dismissedNotice && (
          <div className="info-banner" role="status">
            <span>{notice}</span>
          </div>
        )}
        <label className="field field--full">
          <span className="field__label">Username</span>
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="yourname"
            aria-label="Username"
            autoFocus
          />
        </label>
        <label className="field field--full">
          <span className="field__label">Password</span>
          <input
            type="password"
            name="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            aria-label="Password"
          />
        </label>
        {isRegister && (
          <label className="field field--full">
            <span className="field__label">Confirm password</span>
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              aria-label="Confirm password"
            />
          </label>
        )}
        <button type="submit" className="button button--primary login-card__submit" disabled={busy}>
          {busy
            ? isRegister
              ? 'Creating account…'
              : 'Signing in…'
            : isRegister
              ? 'Create account'
              : 'Sign in'}
        </button>
        <p className="login-card__switch">
          {isRegister ? (
            <>
              Already have an account?{' '}
              <button type="button" className="login-card__link" onClick={() => switchMode('login')}>
                Sign in
              </button>
            </>
          ) : (
            <>
              Need an account?{' '}
              <button
                type="button"
                className="login-card__link"
                onClick={() => switchMode('register')}
              >
                Register
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
