import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import Icon, { serviceIcon } from '../../components/Icon.jsx';
import Modal from '../../components/Modal.jsx';
import ReminderForm from '../../components/ReminderForm.jsx';
import StatusPill from '../../components/StatusPill.jsx';
import { EmptyState, ErrorBanner, Loading } from '../../components/ui.jsx';
import { formatDate, formatMileage, parseDateString } from '../../utils/format.js';
import { FALLBACK_SERVICE_TYPES, typeLabel } from '../../utils/serviceTypes.js';

const numberFormat = new Intl.NumberFormat('en-US');

function intervalText(reminder) {
  const parts = [];
  if (reminder.interval_months) {
    parts.push(`${reminder.interval_months} month${reminder.interval_months === 1 ? '' : 's'}`);
  }
  if (reminder.interval_miles) {
    parts.push(`${numberFormat.format(reminder.interval_miles)} miles`);
  }
  return parts.length ? `Every ${parts.join(' or ')}` : '';
}

function lastText(reminder) {
  if (!reminder.last_date) return 'Never';
  let text = formatDate(reminder.last_date);
  if (reminder.last_mileage != null) text += ` · ${formatMileage(reminder.last_mileage)}`;
  return text;
}

function nextText(reminder) {
  const parts = [];
  if (reminder.next_due_date) parts.push(formatDate(reminder.next_due_date));
  if (reminder.next_due_mileage != null) parts.push(formatMileage(reminder.next_due_mileage));
  return parts.length ? parts.join(' · ') : '—';
}

// Fraction of the way toward the next due point (0..1), using whichever of the
// date/mileage tracks is further along. Null when nothing is computable.
function progressFor(reminder, currentMileage) {
  const fractions = [];
  if (reminder.next_due_date && reminder.last_date) {
    const start = parseDateString(reminder.last_date);
    const end = parseDateString(reminder.next_due_date);
    if (start && end && end > start) {
      fractions.push((Date.now() - start.getTime()) / (end.getTime() - start.getTime()));
    }
  }
  if (
    reminder.next_due_mileage != null &&
    reminder.last_mileage != null &&
    reminder.interval_miles &&
    currentMileage != null
  ) {
    fractions.push((currentMileage - reminder.last_mileage) / reminder.interval_miles);
  }
  if (!fractions.length) return null;
  return Math.max(0, Math.min(1, Math.max(...fractions)));
}

export default function RemindersTab({ vehicleId, currentMileage }) {
  const [reminders, setReminders] = useState(null);
  const [serviceTypes, setServiceTypes] = useState(FALLBACK_SERVICE_TYPES);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // null | { reminder: object | null }
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .serviceTypes()
      .then((types) => {
        if (!cancelled && Array.isArray(types) && types.length) setServiceTypes(types);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReminders(await api.reminders(vehicleId));
    } catch (err) {
      setError(err.message);
    }
  }, [vehicleId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(payload) {
    setBusy(true);
    setFormError(null);
    try {
      if (modal?.reminder) {
        await api.updateReminder(modal.reminder.id, payload);
      } else {
        await api.createReminder(vehicleId, payload);
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await api.deleteReminder(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setError(err.message);
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Reminders">
      <div className="toolbar toolbar--end">
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            setFormError(null);
            setModal({ reminder: null });
          }}
        >
          <Icon name="plus" size={16} /> Add reminder
        </button>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && !reminders && <Loading />}

      {reminders && reminders.length === 0 && (
        <EmptyState
          icon="bell"
          title="No reminders yet"
          message="Set an interval — every 6 months, every 5,000 miles, or both — and CarMaint will tell you when it's due."
        >
          <button
            type="button"
            className="button button--primary"
            onClick={() => setModal({ reminder: null })}
          >
            <Icon name="plus" size={16} /> Create a reminder
          </button>
        </EmptyState>
      )}

      {reminders && reminders.length > 0 && (
        <ul className="reminder-grid">
          {reminders.map((reminder) => {
            const progress = progressFor(reminder, currentMileage);
            return (
              <li key={reminder.id} className="reminder-card">
                <div className="reminder-card__head">
                  <span className="reminder-card__icon">
                    <Icon name={serviceIcon(reminder.type)} size={17} />
                  </span>
                  <div className="reminder-card__heading">
                    <h3 className="reminder-card__title">{typeLabel(reminder.type)}</h3>
                    <p className="reminder-card__interval">{intervalText(reminder)}</p>
                  </div>
                  <StatusPill status={reminder.status} />
                </div>
                {reminder.description && (
                  <p className="reminder-card__description">{reminder.description}</p>
                )}
                <dl className="reminder-card__facts">
                  <div>
                    <dt>Last done</dt>
                    <dd className="num">{lastText(reminder)}</dd>
                  </div>
                  <div>
                    <dt>Next due</dt>
                    <dd className="num">{nextText(reminder)}</dd>
                  </div>
                </dl>
                {progress != null && (
                  <div
                    className="progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress * 100)}
                    aria-label="Progress toward next due"
                  >
                    <div
                      className={`progress__fill progress__fill--${reminder.status}`}
                      style={{ width: `${progress * 100}%` }}
                    />
                  </div>
                )}
                <div className="reminder-card__actions row-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Edit ${typeLabel(reminder.type)} reminder`}
                    onClick={() => {
                      setFormError(null);
                      setModal({ reminder });
                    }}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--danger"
                    aria-label={`Delete ${typeLabel(reminder.type)} reminder`}
                    onClick={() => setPendingDelete(reminder)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {modal && (
        <Modal
          title={modal.reminder ? 'Edit reminder' : 'Add reminder'}
          onClose={() => setModal(null)}
        >
          <ReminderForm
            initial={modal.reminder}
            serviceTypes={serviceTypes}
            onSubmit={handleSave}
            onCancel={() => setModal(null)}
            submitLabel={modal.reminder ? 'Save changes' : 'Add reminder'}
            busy={busy}
            error={formError}
          />
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete reminder"
          message={`Delete the ${typeLabel(pendingDelete.type)} reminder? You'll no longer be alerted when it's due.`}
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
