import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import Icon, { serviceIcon } from '../../components/Icon.jsx';
import Modal from '../../components/Modal.jsx';
import RecordForm from '../../components/RecordForm.jsx';
import { EmptyState, ErrorBanner, Loading } from '../../components/ui.jsx';
import { formatCurrency, formatDate, formatMileage } from '../../utils/format.js';
import { FALLBACK_SERVICE_TYPES, typeLabel } from '../../utils/serviceTypes.js';

export default function ServiceLogTab({ vehicleId, onChanged }) {
  const [records, setRecords] = useState(null);
  const [serviceTypes, setServiceTypes] = useState(FALLBACK_SERVICE_TYPES);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // null | { record: object | null }
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
      .catch(() => {
        /* fallback list already in place */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRecords(await api.records(vehicleId, filter));
    } catch (err) {
      setError(err.message);
    }
  }, [vehicleId, filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(payload) {
    setBusy(true);
    setFormError(null);
    try {
      if (modal?.record) {
        await api.updateRecord(modal.record.id, payload);
      } else {
        await api.createRecord(vehicleId, payload);
      }
      setModal(null);
      await load();
      onChanged?.();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await api.deleteRecord(pendingDelete.id);
      setPendingDelete(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Service log">
      <div className="toolbar">
        <label className="toolbar__filter">
          <span className="visually-hidden">Filter by service type</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All types</option>
            {serviceTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            setFormError(null);
            setModal({ record: null });
          }}
        >
          <Icon name="plus" size={16} /> Add record
        </button>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && !records && <Loading />}

      {records && records.length === 0 && (
        <EmptyState
          icon="wrench"
          title={filter ? `No ${typeLabel(filter)} records` : 'No service history yet'}
          message={
            filter
              ? 'Nothing logged for this type — try another filter or add a record.'
              : 'Log oil changes, repairs, and everything in between to build this timeline.'
          }
        >
          {!filter && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => setModal({ record: null })}
            >
              <Icon name="plus" size={16} /> Log first service
            </button>
          )}
        </EmptyState>
      )}

      {records && records.length > 0 && (
        <ol className="timeline">
          {records.map((record) => (
            <li key={record.id} className="timeline__item">
              <span className="timeline__icon">
                <Icon name={serviceIcon(record.type)} size={16} />
              </span>
              <div className="timeline__card">
                <div className="timeline__head">
                  <div className="timeline__text">
                    <h3 className="timeline__title">
                      {typeLabel(record.type)}
                      {record.description && (
                        <span className="timeline__description"> — {record.description}</span>
                      )}
                    </h3>
                    <p className="timeline__meta num">
                      {formatDate(record.date)}
                      {record.mileage != null && <> · {formatMileage(record.mileage)}</>}
                      {record.shop && <> · {record.shop}</>}
                    </p>
                  </div>
                  <div className="timeline__side">
                    {record.cost != null && (
                      <span className="timeline__cost num">{formatCurrency(record.cost)}</span>
                    )}
                    <div className="row-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${typeLabel(record.type)} record from ${formatDate(record.date)}`}
                        onClick={() => {
                          setFormError(null);
                          setModal({ record });
                        }}
                      >
                        <Icon name="edit" size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-button icon-button--danger"
                        aria-label={`Delete ${typeLabel(record.type)} record from ${formatDate(record.date)}`}
                        onClick={() => setPendingDelete(record)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </div>
                </div>
                {record.notes && <p className="timeline__notes">{record.notes}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {modal && (
        <Modal
          title={modal.record ? 'Edit service record' : 'Add service record'}
          onClose={() => setModal(null)}
        >
          <RecordForm
            initial={modal.record}
            serviceTypes={serviceTypes}
            onSubmit={handleSave}
            onCancel={() => setModal(null)}
            submitLabel={modal.record ? 'Save changes' : 'Add record'}
            busy={busy}
            error={formError}
          />
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete service record"
          message={`Delete the ${typeLabel(pendingDelete.type)} record from ${formatDate(pendingDelete.date)}? This can't be undone.`}
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
