import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Icon from '../components/Icon.jsx';
import { ErrorBanner, Loading } from '../components/ui.jsx';
import BackupCodesPanel from '../components/mfa/BackupCodesPanel.jsx';
import { TotpEnroll, PasskeyEnroll, EmailEnroll } from '../components/mfa/enroll.jsx';
import { formatDate } from '../utils/format.js';

// Two-Factor settings for a fully-logged-in user. Reads /api/mfa/status and lets the
// user add/remove each factor, list + name + remove passkeys, and regenerate backup
// codes. The last-factor guard is a server 409 ("add another before removing this
// one") which we surface inline per action.
// `onStatusChange` (optional) notifies the parent (App) when the MFA-enabled state may
// have changed — after enrolling or removing a factor — so the app-level setup nudge
// banner re-syncs with /api/auth/status. Enrollment/removal happen from a full session.
export default function Security({ onStatusChange } = {}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  // Which method is being added inline: null | 'totp' | 'passkey' | 'email'.
  const [adding, setAdding] = useState(null);
  // Freshly-issued backup codes to display once (regenerate, or first-factor add).
  const [newCodes, setNewCodes] = useState(null);
  // Inline action errors keyed by a stable action key.
  const [actionError, setActionError] = useState({});
  const [pendingRemove, setPendingRemove] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api.mfaStatus());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function noteError(key, message) {
    setActionError((prev) => ({ ...prev, [key]: message }));
  }
  function clearError(key) {
    setActionError((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // An enroll widget finished. On a first factor the server returns backup_codes;
  // otherwise just refresh. Always close the inline "add" form.
  async function handleEnrolled(result) {
    setAdding(null);
    if (result && Array.isArray(result.backup_codes) && result.backup_codes.length > 0) {
      setNewCodes(result.backup_codes);
    }
    await load();
    onStatusChange?.();
  }

  async function handleRegenerate() {
    setBusy(true);
    clearError('backup');
    try {
      const res = await api.backupRegenerate();
      setNewCodes(res.backup_codes);
      await load();
    } catch (err) {
      noteError('backup', err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    const target = pendingRemove;
    if (!target) return;
    setBusy(true);
    clearError(target.key);
    try {
      if (target.kind === 'totp') await api.deleteTotp();
      else if (target.kind === 'email') await api.deleteEmail();
      else if (target.kind === 'passkey') await api.deletePasskey(target.id);
      setPendingRemove(null);
      await load();
      onStatusChange?.();
    } catch (err) {
      setPendingRemove(null);
      noteError(target.key, err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return wrap(<ErrorBanner message={error} onRetry={load} />);
  if (!status) return wrap(<Loading label="Loading security settings…" />);

  const { methods, webauthn } = status;
  const passkeys = webauthn?.credentials || [];
  const mfaEnabled = Boolean(status.mfa_enabled);

  return wrap(
    <>
      <section className="panel">
        <h2 className="panel__title">
          <Icon name="check" size={16} /> Two-factor authentication
        </h2>
        <p className={`mfa-state ${mfaEnabled ? 'mfa-state--on' : 'mfa-state--off'}`}>
          <Icon name={mfaEnabled ? 'check' : 'x'} size={16} />
          <strong>{mfaEnabled ? 'Enabled' : 'Not enabled'}</strong>
          <span>
            {mfaEnabled
              ? 'Your account is protected by a second factor. Add another before removing your last one.'
              : 'Your account is protected by your password only. Add a method below to secure it.'}
          </span>
        </p>
        <ul className="mfa-summary">
          <li className={methods.totp ? 'is-on' : ''}>
            <Icon name={methods.totp ? 'check' : 'x'} size={15} /> Authenticator app
          </li>
          <li className={methods.webauthn ? 'is-on' : ''}>
            <Icon name={methods.webauthn ? 'check' : 'x'} size={15} /> Passkey
            {passkeys.length > 0 ? ` (${passkeys.length})` : ''}
          </li>
          <li className={methods.email ? 'is-on' : ''}>
            <Icon name={methods.email ? 'check' : 'x'} size={15} /> Email code
          </li>
        </ul>
      </section>

      {/* --- Authenticator app --- */}
      <section className="panel">
        <h2 className="panel__title">
          <Icon name="clipboard" size={16} /> Authenticator app
        </h2>
        {methods.totp ? (
          <div className="mfa-row">
            <span className="admin-badge">Enabled</span>
            <button
              type="button"
              className="button button--danger-ghost button--small"
              disabled={busy}
              onClick={() =>
                setPendingRemove({ kind: 'totp', key: 'totp', label: 'the authenticator app' })
              }
            >
              <Icon name="trash" size={15} /> Remove
            </button>
          </div>
        ) : adding === 'totp' ? (
          <TotpEnroll onComplete={handleEnrolled} onCancel={() => setAdding(null)} />
        ) : (
          <button type="button" className="button button--ghost" onClick={() => setAdding('totp')}>
            <Icon name="plus" size={16} /> Add authenticator app
          </button>
        )}
        {actionError.totp && (
          <span className="field__error field__error--standalone" role="alert">
            {actionError.totp}
          </span>
        )}
      </section>

      {/* --- Passkeys --- */}
      <section className="panel">
        <h2 className="panel__title">
          <Icon name="user" size={16} /> Passkeys
        </h2>
        {passkeys.length > 0 ? (
          <div className="table-scroll">
            <table className="backup-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Added</th>
                  <th>Last used</th>
                  <th>
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {passkeys.map((cred) => (
                  <tr key={cred.id}>
                    <td>{cred.name || 'Unnamed passkey'}</td>
                    <td className="num">{cred.created_at ? formatDate(cred.created_at) : '—'}</td>
                    <td className="num">{cred.last_used_at ? formatDate(cred.last_used_at) : 'Never'}</td>
                    <td className="backup-table__action">
                      <button
                        type="button"
                        className="button button--danger-ghost button--small"
                        disabled={busy}
                        onClick={() =>
                          setPendingRemove({
                            kind: 'passkey',
                            id: cred.id,
                            key: `pk:${cred.id}`,
                            label: cred.name ? `passkey "${cred.name}"` : 'this passkey',
                          })
                        }
                      >
                        <Icon name="trash" size={15} /> Remove
                      </button>
                      {actionError[`pk:${cred.id}`] && (
                        <span className="field__error" role="alert">
                          {actionError[`pk:${cred.id}`]}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="backup-note">No passkeys registered yet.</p>
        )}
        <div className="mfa-row">
          {adding === 'passkey' ? (
            <PasskeyEnroll onComplete={handleEnrolled} onCancel={() => setAdding(null)} />
          ) : (
            <button type="button" className="button button--ghost" onClick={() => setAdding('passkey')}>
              <Icon name="plus" size={16} /> Add a passkey
            </button>
          )}
        </div>
      </section>

      {/* --- Email --- */}
      <section className="panel">
        <h2 className="panel__title">
          <Icon name="bell" size={16} /> Email code
        </h2>
        {methods.email ? (
          <div className="mfa-row">
            <span className="admin-badge">Enabled</span>
            <button
              type="button"
              className="button button--danger-ghost button--small"
              disabled={busy}
              onClick={() =>
                setPendingRemove({ kind: 'email', key: 'email', label: 'email codes' })
              }
            >
              <Icon name="trash" size={15} /> Remove
            </button>
          </div>
        ) : adding === 'email' ? (
          <EmailEnroll onComplete={handleEnrolled} onCancel={() => setAdding(null)} />
        ) : (
          <button type="button" className="button button--ghost" onClick={() => setAdding('email')}>
            <Icon name="plus" size={16} /> Add email code
          </button>
        )}
        {actionError.email && (
          <span className="field__error field__error--standalone" role="alert">
            {actionError.email}
          </span>
        )}
      </section>

      {/* --- Backup codes --- */}
      <section className="panel">
        <h2 className="panel__title">
          <Icon name="copy" size={16} /> Backup codes
        </h2>
        <p className="backup-note">
          You have <strong>{status.backup_codes_remaining}</strong> unused backup code
          {status.backup_codes_remaining === 1 ? '' : 's'}. Regenerating replaces any old codes.
        </p>
        <button type="button" className="button button--ghost" onClick={handleRegenerate} disabled={busy}>
          <Icon name="refresh" size={16} /> Regenerate backup codes
        </button>
        {actionError.backup && (
          <span className="field__error field__error--standalone" role="alert">
            {actionError.backup}
          </span>
        )}
      </section>

      {newCodes && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setNewCodes(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Backup codes">
            <div className="modal__body">
              <BackupCodesPanel
                codes={newCodes}
                onAcknowledge={() => setNewCodes(null)}
                acknowledgeLabel="Done"
              />
            </div>
          </div>
        </div>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title="Remove factor"
          message={`Remove ${pendingRemove.label}? If this is your only remaining factor you'll need to add another one first.`}
          confirmLabel="Remove"
          busy={busy}
          onConfirm={handleRemove}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </>
  );
}

function wrap(children) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Two-Factor</h1>
          <p className="page-header__sub">Manage the second factors that protect your account.</p>
        </div>
      </header>
      {children}
    </div>
  );
}
