import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Icon from '../components/Icon.jsx';
import { EmptyState, ErrorBanner, Loading } from '../components/ui.jsx';
import { formatBytes, formatDate, vehicleTitle } from '../utils/format.js';

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'backups', label: 'Backups' },
];

export default function Admin() {
  const [tab, setTab] = useState('users');

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Admin</h1>
          <p className="page-header__sub">
            Manage every account, reassign vehicles, and control global backups.
          </p>
        </div>
      </header>

      <nav className="tabs" aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-panel">
        {tab === 'users' && <UsersTab />}
        {tab === 'vehicles' && <VehiclesTab />}
        {tab === 'backups' && <BackupsTab />}
      </div>
    </div>
  );
}

// --- Users ------------------------------------------------------------------

function UsersTab() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  // Inline action errors (e.g. 409 last-admin lockout) keyed by user id.
  const [actionError, setActionError] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingRole, setPendingRole] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await api.adminUsers());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function noteError(id, message) {
    setActionError((prev) => ({ ...prev, [id]: message }));
  }
  function clearError(id) {
    setActionError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function handleToggleRole() {
    const user = pendingRole;
    if (!user) return;
    setBusyId(user.id);
    clearError(user.id);
    try {
      await api.setUserAdmin(user.id, !user.is_admin);
      setPendingRole(null);
      await load();
    } catch (err) {
      setPendingRole(null);
      noteError(user.id, err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    const user = pendingDelete;
    if (!user) return;
    setBusyId(user.id);
    clearError(user.id);
    try {
      await api.deleteUser(user.id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setPendingDelete(null);
      noteError(user.id, err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!users) return <Loading label="Loading users…" />;

  return (
    <section className="panel">
      <h2 className="panel__title">
        <Icon name="user" size={16} /> Accounts
      </h2>
      <div className="table-scroll">
        <table className="backup-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Vehicles</th>
              <th>Created</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>
                  {user.is_admin ? (
                    <span className="admin-badge">Admin</span>
                  ) : (
                    <span className="text-faint">User</span>
                  )}
                </td>
                <td className="num">{user.vehicle_count}</td>
                <td className="num">{formatDate(user.created_at)}</td>
                <td className="admin-row-actions">
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    disabled={busyId === user.id}
                    onClick={() => setPendingRole(user)}
                  >
                    {user.is_admin ? 'Demote' : 'Promote'}
                  </button>
                  <button
                    type="button"
                    className="button button--danger-ghost button--small"
                    disabled={busyId === user.id}
                    onClick={() => setPendingDelete(user)}
                  >
                    <Icon name="trash" size={15} /> Delete
                  </button>
                  {actionError[user.id] && (
                    <span className="field__error" role="alert">
                      {actionError[user.id]}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pendingRole && (
        <ConfirmDialog
          title={pendingRole.is_admin ? 'Demote admin' : 'Promote to admin'}
          message={
            pendingRole.is_admin
              ? `Remove admin powers from "${pendingRole.username}"? They keep their own vehicles but lose cross-account access.`
              : `Grant "${pendingRole.username}" full admin powers over every account, vehicle, and global backups?`
          }
          confirmLabel={pendingRole.is_admin ? 'Demote' : 'Promote'}
          busy={busyId === pendingRole.id}
          onConfirm={handleToggleRole}
          onCancel={() => setPendingRole(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete account"
          message={`Permanently delete "${pendingDelete.username}"? This removes the account and ALL of their vehicles, service history, reminders, and photos. This cannot be undone.`}
          confirmLabel="Delete account"
          busy={busyId === pendingDelete.id}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}

// --- Vehicles ---------------------------------------------------------------

function VehiclesTab() {
  const [vehicles, setVehicles] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  // Per-vehicle draft owner selection (value is '' for unowned or a user id string).
  const [draft, setDraft] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [rowError, setRowError] = useState({});

  const [adoptUser, setAdoptUser] = useState('');
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState(null);
  const [adoptResult, setAdoptResult] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, u] = await Promise.all([api.adminVehicles(), api.adminUsers()]);
      setVehicles(v);
      setUsers(u);
      const initial = {};
      for (const veh of v) initial[veh.id] = veh.user_id == null ? '' : String(veh.user_id);
      setDraft(initial);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveOwner(vehicle) {
    setSavingId(vehicle.id);
    setRowError((prev) => ({ ...prev, [vehicle.id]: null }));
    const raw = draft[vehicle.id];
    const userId = raw === '' ? null : Number(raw);
    try {
      await api.setVehicleOwner(vehicle.id, userId);
      await load();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [vehicle.id]: err.message }));
    } finally {
      setSavingId(null);
    }
  }

  async function handleAdopt() {
    setAdopting(true);
    setAdoptError(null);
    setAdoptResult(null);
    try {
      const res = await api.adoptOrphans(Number(adoptUser));
      setAdoptResult(res.adopted);
      await load();
    } catch (err) {
      setAdoptError(err.message);
    } finally {
      setAdopting(false);
    }
  }

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!vehicles || !users) return <Loading label="Loading vehicles…" />;

  const orphanCount = vehicles.filter((v) => v.user_id == null).length;

  return (
    <>
      <section className="panel">
        <h2 className="panel__title">
          <Icon name="alert-triangle" size={16} /> Unowned (legacy) vehicles
        </h2>
        <p className="backup-note">
          {orphanCount > 0 ? (
            <>
              <strong className="danger-text">{orphanCount}</strong> vehicle
              {orphanCount === 1 ? ' is' : 's are'} not tied to any account. Adopt them onto a
              real user so they show up in that user&apos;s garage.
            </>
          ) : (
            'Every vehicle currently belongs to an account. Nothing to adopt.'
          )}
        </p>
        <div className="admin-adopt">
          <label className="field">
            <span className="field__label">Adopt all unowned vehicles onto</span>
            <select
              value={adoptUser}
              onChange={(e) => setAdoptUser(e.target.value)}
              disabled={orphanCount === 0 || adopting}
              aria-label="Adopt unowned vehicles onto user"
            >
              <option value="">Choose a user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button button--primary"
            disabled={orphanCount === 0 || adopting || adoptUser === ''}
            onClick={handleAdopt}
          >
            <Icon name="download" size={16} />
            {adopting ? 'Adopting…' : 'Adopt all unowned vehicles'}
          </button>
        </div>
        {adoptResult != null && (
          <p className="success-note" role="status">
            Adopted {adoptResult} vehicle{adoptResult === 1 ? '' : 's'}.
          </p>
        )}
        {adoptError && <ErrorBanner message={adoptError} />}
      </section>

      <section className="panel">
        <h2 className="panel__title">
          <Icon name="car" size={16} /> All vehicles
        </h2>
        {vehicles.length === 0 ? (
          <EmptyState icon="car" title="No vehicles" message="No vehicles exist across any account yet." />
        ) : (
          <div className="table-scroll">
            <table className="backup-table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Current owner</th>
                  <th>Reassign owner</th>
                  <th>
                    <span className="visually-hidden">Save</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((vehicle) => {
                  const current = draft[vehicle.id] ?? '';
                  const original = vehicle.user_id == null ? '' : String(vehicle.user_id);
                  const dirty = current !== original;
                  return (
                    <tr key={vehicle.id}>
                      <td>{vehicleTitle(vehicle)}</td>
                      <td>
                        {vehicle.owner_username ? (
                          vehicle.owner_username
                        ) : (
                          <span className="admin-badge admin-badge--warn">Unowned</span>
                        )}
                      </td>
                      <td>
                        <select
                          value={current}
                          aria-label={`Owner for ${vehicleTitle(vehicle)}`}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [vehicle.id]: e.target.value }))
                          }
                        >
                          <option value="">Unowned</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.username}
                            </option>
                          ))}
                        </select>
                        {rowError[vehicle.id] && (
                          <span className="field__error" role="alert">
                            {rowError[vehicle.id]}
                          </span>
                        )}
                      </td>
                      <td className="backup-table__action">
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          disabled={!dirty || savingId === vehicle.id}
                          onClick={() => handleSaveOwner(vehicle)}
                        >
                          {savingId === vehicle.id ? 'Saving…' : 'Save'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// --- Global backups ---------------------------------------------------------

function BackupsTab() {
  const restoreInputRef = useRef(null);

  const [backups, setBackups] = useState(null);
  const [error, setError] = useState(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [pendingRestore, setPendingRestore] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [restored, setRestored] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setBackups(await api.listGlobalBackups());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      await api.createGlobalBackup();
      await load();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRestore() {
    setRestoring(true);
    setRestoreError(null);
    try {
      await api.restoreGlobalBackup(pendingRestore);
      setPendingRestore(null);
      setRestored(true);
      // The restore dropped every session (including ours) server-side. Reload so
      // the next /api/auth/status comes back unauthenticated and routes to login.
      window.location.assign('/');
    } catch (err) {
      setRestoreError(err.message);
      setPendingRestore(null);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <section className="panel">
        <h2 className="panel__title">
          <Icon name="archive" size={16} /> Global backups
        </h2>
        <p className="backup-note">
          These are whole-database snapshots covering <strong>every user&apos;s</strong> data —
          separate from your personal backup on the Backup page.
        </p>
        <div className="backup-actions">
          <button
            type="button"
            className="button button--primary"
            onClick={handleCreate}
            disabled={creating}
          >
            <Icon name="cloud" size={16} />
            {creating ? 'Creating…' : 'Create backup now'}
          </button>
        </div>
        {createError && <ErrorBanner message={createError} />}

        {error && <ErrorBanner message={error} onRetry={load} />}
        {!error && !backups && <Loading label="Loading backups…" />}
        {backups && backups.length === 0 && (
          <EmptyState
            icon="archive"
            title="No global backups yet"
            message="Create one now, or wait for the scheduled auto-backup to write the first snapshot."
          />
        )}
        {backups && backups.length > 0 && (
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
                        href={api.downloadGlobalBackupUrl(backup.filename)}
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
                        href={api.downloadGlobalBackupUrl(backup.filename)}
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
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">
          <Icon name="restore" size={16} /> Restore global backup
        </h2>
        <p className="backup-note">
          <strong className="danger-text">
            This replaces the ENTIRE database for ALL users and logs everyone out.
          </strong>{' '}
          Upload a global backup .zip to roll the whole system back to that snapshot.
        </p>
        {restored ? (
          <p className="success-note" role="status">
            Database restored — signing you out…
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
              {restoring ? 'Restoring…' : 'Restore entire database…'}
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

      {pendingRestore && (
        <ConfirmDialog
          title="Restore ENTIRE database"
          message={`Restore from "${pendingRestore.name}"? This REPLACES the entire database for ALL users — every account, vehicle, record, reminder, and photo is overwritten with the snapshot's contents, and everyone (including you) is logged out. This cannot be undone.`}
          confirmLabel="Replace everything"
          busy={restoring}
          onConfirm={handleRestore}
          onCancel={() => setPendingRestore(null)}
        />
      )}
    </>
  );
}
