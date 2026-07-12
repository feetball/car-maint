import { useState } from 'react';
import Icon from './Icon.jsx';
import BackupCodesPanel from './mfa/BackupCodesPanel.jsx';
import { TotpEnroll, PasskeyEnroll, EmailEnroll } from './mfa/enroll.jsx';

// Forced two-factor enrollment gate. Shown whenever the server reports the
// setup-required state (a fresh registration, or an admin MFA reset). MFA is
// mandatory for everyone, so the only way out is to enroll a factor (or log out).
// On the FIRST factor the server issues backup codes once; we make the user
// acknowledge saving them before completing.
const METHODS = [
  { id: 'totp', label: 'Authenticator app', icon: 'clipboard', hint: 'Recommended' },
  { id: 'passkey', label: 'Passkey', icon: 'user', hint: 'Face, fingerprint, or key' },
  { id: 'email', label: 'Email code', icon: 'bell', hint: 'If enabled on this server' },
];

export default function EnrollView({ username, onDone, onLogout }) {
  const [method, setMethod] = useState('totp');
  const [backupCodes, setBackupCodes] = useState(null);

  function handleComplete(result) {
    if (result && Array.isArray(result.backup_codes) && result.backup_codes.length > 0) {
      setBackupCodes(result.backup_codes);
    } else {
      onDone();
    }
  }

  return (
    <div className="login-view">
      <div className="login-card login-card--wide">
        <span className="login-card__mark" aria-hidden="true">
          <Icon name="wrench" size={22} />
        </span>
        <h1 className="login-card__title">Set up two-factor authentication</h1>
        <p className="login-card__sub">
          {username ? (
            <>
              Welcome, <strong>{username}</strong>. To keep your garage secure, you must set up a
              second factor before continuing.
            </>
          ) : (
            'You must set up a second factor before continuing.'
          )}
        </p>

        {backupCodes ? (
          <BackupCodesPanel
            codes={backupCodes}
            onAcknowledge={onDone}
            acknowledgeLabel="I saved them — continue"
          />
        ) : (
          <>
            <div className="mfa-methods" role="tablist" aria-label="Choose a two-factor method">
              {METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={method === m.id}
                  className={`mfa-method${method === m.id ? ' mfa-method--active' : ''}`}
                  onClick={() => setMethod(m.id)}
                >
                  <span className="mfa-method__icon">
                    <Icon name={m.icon} size={18} />
                  </span>
                  <span className="mfa-method__text">
                    <span className="mfa-method__label">{m.label}</span>
                    <span className="mfa-method__hint">{m.hint}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="mfa-panel">
              {method === 'totp' && <TotpEnroll onComplete={handleComplete} />}
              {method === 'passkey' && <PasskeyEnroll onComplete={handleComplete} />}
              {method === 'email' && <EmailEnroll onComplete={handleComplete} />}
            </div>
          </>
        )}

        <p className="login-card__switch">
          Wrong account?{' '}
          <button type="button" className="login-card__link" onClick={onLogout}>
            Log out
          </button>
        </p>
      </div>
    </div>
  );
}
