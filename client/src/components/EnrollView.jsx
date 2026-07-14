import { useState } from 'react';
import Icon from './Icon.jsx';
import BackupCodesPanel from './mfa/BackupCodesPanel.jsx';
import { TotpEnroll, PasskeyEnroll, EmailEnroll } from './mfa/enroll.jsx';

// Skippable two-factor onboarding interstitial. Shown right after registration (or a
// no-MFA login) when the account has no second factor yet. MFA is OPTIONAL, so this is
// a nudge, NOT a blocking gate: the user can enroll a factor now or hit "Skip for now"
// to enter the app (a persistent banner + the Security page keep offering setup later).
// On the FIRST factor the server issues backup codes once; we make the user acknowledge
// saving them before completing.
const METHODS = [
  { id: 'totp', label: 'Authenticator app', icon: 'clipboard', hint: 'Recommended' },
  { id: 'passkey', label: 'Passkey', icon: 'user', hint: 'Face, fingerprint, or key' },
  { id: 'email', label: 'Email code', icon: 'bell', hint: 'If enabled on this server' },
];

export default function EnrollView({ username, onDone, onSkip }) {
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
        <h1 className="login-card__title">Secure your account</h1>
        <p className="login-card__sub">
          {username ? (
            <>
              Welcome, <strong>{username}</strong>. Add two-factor authentication to protect your
              garage — or skip for now and set it up later.
            </>
          ) : (
            'Add two-factor authentication to protect your garage — or skip for now.'
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

            {onSkip && (
              <button
                type="button"
                className="button button--ghost login-card__skip"
                onClick={onSkip}
              >
                Skip for now
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
