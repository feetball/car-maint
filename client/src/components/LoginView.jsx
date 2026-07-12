import { useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

// Full-screen gate shown when auth is required and the visitor is not signed in.
// Submits to POST /api/login; a 401 surfaces an inline error, success asks the
// parent to reload auth/app state.
export default function LoginView({ onAuthenticated }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setPassword('');
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
        <p className="login-card__sub">Enter your password to open the garage.</p>
        {error && (
          <div className="error-banner" role="alert">
            <span className="error-banner__message">{error}</span>
          </div>
        )}
        <label className="field field--full">
          <span className="field__label">Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            aria-label="Password"
            autoFocus
          />
        </label>
        <button type="submit" className="button button--primary login-card__submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
