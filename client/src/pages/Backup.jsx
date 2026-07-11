import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Icon from '../components/Icon.jsx';
import { EmptyState, ErrorBanner, Loading } from '../components/ui.jsx';
import { formatBytes, formatDate, todayString } from '../utils/format.js';

// Web Share API with file support (iOS Safari, Android Chrome). Desktop
// browsers and jsdom fail one of these checks, and the button is not shown.
function shareSupported() {
  try {
    return Boolean(
      typeof navigator !== 'undefined' &&
        typeof navigator.canShare === 'function' &&
        typeof navigator.share === 'function' &&
        navigator.canShare({ files: [new File([], 'x.zip', { type: 'application/zip' })] })
    );
  } catch {
    return false;
  }
}

export default function Backup() {
  const restoreInputRef = useRef(null);
  const canShareFiles = shareSupported();

  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);

  const [pendingRestore, setPendingRestore] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [restored, setRestored] = useState(false);

  const [backups, setBackups] = useState(null);
  const [backupsError, setBackupsError] = useState(null);

  const loadBackups = useCallback(async () => {
    setBackupsError(null);
    try {
      setBackups(await api.backups());
    } catch (err) {
      setBackupsError(err.message);
    }
  }, []);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  async function handleShare() {
    setSharing(true);
    setShareError(null);
    try {
      const res = await fetch('/api/backup');
      if (!res.ok) {
        let message = `Request failed with status ${res.status}`;
        try {
          const data = await res.json();
          if (data && data.error) message = data.error;
        } catch {
          /* body was not JSON */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const file = new File([blob], `carmaint-backup-${todayString()}.zip`, {
        type: 'application/zip',
      });
      await navigator.share({ files: [file], title: 'CarMaint backup' });
    } catch (err) {
      // AbortError = the user dismissed the share sheet; that's not an error.
      if (err && err.name === 'AbortError') return;
      setShareError(err.message || 'Sharing failed');
    } finally {
      setSharing(false);
    }
  }

  async function handleRestore() {
    setRestoring(true);
    setRestoreError(null);
    try {
      await api.restore(pendingRestore);
      setPendingRestore(null);
      setRestored(true);
      window.location.assign('/');
    } catch (err) {
      setRestoreError(err.message);
      setPendingRestore(null);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Backup</h1>
          <p className="page-header__sub">Export, back up, and restore your garage.</p>
        </div>
      </header>

      <section className="panel">
        <h2 className="panel__title">
          <Icon name="cloud" size={16} /> Back up now
        </h2>
        <p className="backup-note">
          A backup is a single .zip containing your database and every photo — everything needed
          to rebuild CarMaint from scratch.
        </p>
        <div className="backup-actions">
          <a className="button button--primary" href="/api/backup" download>
            <Icon name="download" size={16} /> Download backup (.zip)
          </a>
          {canShareFiles && (
            <button
              type="button"
              className="button button--ghost"
              onClick={handleShare}
              disabled={sharing}
            >
              {sharing ? (
                <span className="spinner spinner--inline" aria-hidden="true" />
              ) : (
                <Icon name="upload" size={16} />
              )}
              {sharing ? 'Preparing backup…' : 'Save to iCloud or Google Drive…'}
            </button>
          )}
        </div>
        {canShareFiles && (
          <p className="backup-note">
            On iPhone or iPad, pick <strong>Save to Files</strong> in the share sheet to drop the
            backup into iCloud Drive — or share it straight to the Google Drive app.
          </p>
        )}
        {shareError && <ErrorBanner message={shareError} />}
      </section>

      <section className="panel">
        <h2 className="panel__title">
          <Icon name="clipboard" size={16} /> Export history
        </h2>
        <p className="backup-note">Take your data anywhere, in open formats.</p>
        <div className="backup-actions">
          <a className="button button--ghost" href="/api/export.csv" download>
            <Icon name="download" size={16} /> All service history (CSV)
          </a>
          <a className="button button--ghost" href="/api/export.json" download>
            <Icon name="download" size={16} /> Complete data export (JSON)
          </a>
        </div>
        <p className="backup-note">
          Need a single vehicle? Each vehicle page has its own CSV export.
        </p>
      </section>

      <section className="panel">
        <h2 className="panel__title">
          <Icon name="restore" size={16} /> Restore
        </h2>
        <p className="backup-note">
          Restore CarMaint from a backup .zip.{' '}
          <strong className="danger-text">
            This replaces ALL current vehicles, history, and photos.
          </strong>
        </p>
        {restored ? (
          <p className="success-note" role="status">
            Backup restored — reloading…
          </p>
        ) : (
          <div className="backup-actions">
            <button
              type="button"
              className="button button--danger-ghost"
              onClick={() => restoreInputRef.current?.click()}
              disabled={restoring}
            >
              <Icon name="upload" size={16} />
              {restoring ? 'Restoring…' : 'Restore from backup…'}
            </button>
            <input
              ref={restoreInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(event) => {
                const file = event.target.files && event.target.files[0];
                if (file) {
                  setRestoreError(null);
                  setPendingRestore(file);
                }
                event.target.value = '';
              }}
            />
          </div>
        )}
        {restoreError && <ErrorBanner message={restoreError} />}
      </section>

      <section className="panel">
        <h2 className="panel__title">
          <Icon name="archive" size={16} /> Automatic backups
        </h2>
        {backupsError && <ErrorBanner message={backupsError} onRetry={loadBackups} />}
        {!backupsError && !backups && <Loading />}
        {backups && backups.length === 0 && (
          <EmptyState
            icon="archive"
            title="No automatic backups yet"
            message="CarMaint writes a daily backup .zip into ./data/backups (tune the schedule with the AUTO_BACKUP_HOURS and AUTO_BACKUP_KEEP environment variables). Point that folder at a cloud-sync client — an iCloud Drive folder on a Mac, or Google Drive for desktop — and your backups upload themselves."
          />
        )}
        {backups && backups.length > 0 && (
          <>
            <div className="table-scroll">
              <table className="backup-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Size</th>
                    <th>Created</th>
                    <th>
                      <span className="visually-hidden">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((backup) => (
                    <tr key={backup.filename}>
                      <td className="backup-table__name">
                        <a
                          className="subtle-link num"
                          href={`/api/backups/${encodeURIComponent(backup.filename)}`}
                          download
                        >
                          {backup.filename}
                        </a>
                      </td>
                      <td className="num">{formatBytes(backup.size)}</td>
                      <td className="num">{formatDate(backup.created_at)}</td>
                      <td className="backup-table__action">
                        <a
                          className="icon-button"
                          href={`/api/backups/${encodeURIComponent(backup.filename)}`}
                          download
                          aria-label={`Download ${backup.filename}`}
                        >
                          <Icon name="download" size={15} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="backup-note">
              These land in <code>./data/backups</code> on the server. Sync that folder with an
              iCloud Drive folder (Mac) or Google Drive for desktop and every automatic backup is
              in the cloud, hands-free.
            </p>
          </>
        )}
      </section>

      {pendingRestore && (
        <ConfirmDialog
          title="Restore from backup"
          message={`Restore from "${pendingRestore.name}"? This replaces ALL current vehicles, service history, reminders, and photos with the backup's contents. This cannot be undone.`}
          confirmLabel="Replace everything"
          busy={restoring}
          onConfirm={handleRestore}
          onCancel={() => setPendingRestore(null)}
        />
      )}
    </div>
  );
}
