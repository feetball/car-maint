import { useState } from 'react';
import Icon from '../Icon.jsx';

// Displays a freshly-generated set of backup codes ONCE and forces the user to
// acknowledge they have saved them before continuing. Used by the forced-enrollment
// flow (first factor) and the Security page's "regenerate" action.
export default function BackupCodesPanel({
  codes,
  title = 'Save your backup codes',
  onAcknowledge,
  acknowledgeLabel = 'I have saved these codes',
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(codes.join('\n'));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* clipboard blocked — codes are visible for manual copy */
    }
  }

  return (
    <div className="backup-codes" role="group" aria-label={title}>
      <h2 className="panel__title">
        <Icon name="clipboard" size={16} /> {title}
      </h2>
      <p className="backup-note">
        Store these one-time backup codes somewhere safe. Each works once if you lose access to
        your other methods. <strong className="danger-text">They are shown only now.</strong>
      </p>
      <ul className="backup-codes__list num">
        {codes.map((code) => (
          <li key={code} className="backup-codes__code">
            {code}
          </li>
        ))}
      </ul>
      <div className="backup-actions">
        <button type="button" className="button button--ghost button--small" onClick={handleCopy}>
          <Icon name={copied ? 'check' : 'copy'} size={15} />
          {copied ? 'Copied' : 'Copy all'}
        </button>
        {onAcknowledge && (
          <button type="button" className="button button--primary" onClick={onAcknowledge}>
            {acknowledgeLabel}
          </button>
        )}
      </div>
    </div>
  );
}
