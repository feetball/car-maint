import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import Icon from '../components/Icon.jsx';
import Modal from '../components/Modal.jsx';
import VehicleForm from '../components/VehicleForm.jsx';
import { ErrorBanner, Loading } from '../components/ui.jsx';
import { formatMileage, vehicleTitle } from '../utils/format.js';
import ServiceLogTab from './vehicle/ServiceLogTab.jsx';
import RemindersTab from './vehicle/RemindersTab.jsx';
import PhotosTab from './vehicle/PhotosTab.jsx';
import StatsTab from './vehicle/StatsTab.jsx';
import RecallsTab from './vehicle/RecallsTab.jsx';

const TABS = [
  { id: 'service', label: 'Service Log' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'photos', label: 'Photos' },
  { id: 'stats', label: 'Stats' },
  { id: 'recalls', label: 'Recalls' },
];

export default function VehicleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [vehicle, setVehicle] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('service');
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [recallCount, setRecallCount] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setVehicle(await api.vehicle(id));
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setVehicle(null);
    setTab('service');
    setError(null);
    setRecallCount(null);
    api
      .vehicle(id)
      .then((data) => {
        if (!cancelled) setVehicle(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleEdit(payload) {
    setSaving(true);
    setEditError(null);
    try {
      await api.updateVehicle(id, payload);
      setEditing(false);
      await load();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteVehicle(id);
      navigate('/vehicles');
    } catch (err) {
      setDeleting(false);
      setConfirmingDelete(false);
      setError(err.message);
    }
  }

  if (error) {
    return (
      <div className="page">
        <ErrorBanner message={error} onRetry={load} />
        <p>
          <Link className="subtle-link" to="/vehicles">
            Back to all vehicles
          </Link>
        </p>
      </div>
    );
  }
  if (!vehicle) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }

  const photos = vehicle.photos || [];
  const primary = photos.find((p) => p.is_primary) || photos[0] || null;
  const subParts = [];
  if (vehicle.name) subParts.push(`${vehicle.year} ${vehicle.make} ${vehicle.model}`);
  if (vehicle.color) subParts.push(vehicle.color);

  return (
    <div className="page page--detail">
      <header className={`vehicle-hero${primary ? ' vehicle-hero--photo' : ''}`}>
        {primary && (
          <div
            className="vehicle-hero__backdrop"
            style={{ backgroundImage: `url("${primary.url}")` }}
            aria-hidden="true"
          />
        )}
        <div className="vehicle-hero__scrim" aria-hidden="true" />
        <div className="vehicle-hero__content">
          <Link className="back-link" to="/vehicles">
            <Icon name="chevron-left" size={15} /> All vehicles
          </Link>
          <div className="vehicle-hero__row">
            <div>
              <h1 className="vehicle-hero__title">{vehicleTitle(vehicle)}</h1>
              {subParts.length > 0 && <p className="vehicle-hero__sub">{subParts.join(' · ')}</p>}
              <div className="vehicle-hero__meta">
                <span>
                  <Icon name="gauge" size={14} />{' '}
                  <span className="num">{formatMileage(vehicle.current_mileage)}</span>
                </span>
                {vehicle.license_plate && (
                  <span>
                    Plate <span className="num">{vehicle.license_plate}</span>
                  </span>
                )}
                {vehicle.vin && (
                  <span>
                    VIN <span className="num">{vehicle.vin}</span>
                  </span>
                )}
              </div>
            </div>
            <div className="vehicle-hero__actions">
              <a
                className="button button--ghost"
                href={`/api/vehicles/${vehicle.id}/export.csv`}
                download
              >
                <Icon name="download" size={15} /> Export CSV
              </a>
              <button type="button" className="button button--ghost" onClick={() => setEditing(true)}>
                <Icon name="edit" size={15} /> Edit
              </button>
              <button
                type="button"
                className="button button--danger-ghost"
                onClick={() => setConfirmingDelete(true)}
              >
                <Icon name="trash" size={15} /> Delete
              </button>
            </div>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Vehicle sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'recalls' && recallCount != null && (
              <span
                className={`tab__badge${recallCount > 0 ? ' tab__badge--alert' : ''}`}
                aria-label={`${recallCount} open recall${recallCount === 1 ? '' : 's'}`}
              >
                {recallCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="tab-panel">
        {tab === 'service' && <ServiceLogTab vehicleId={vehicle.id} onChanged={load} />}
        {tab === 'reminders' && (
          <RemindersTab vehicleId={vehicle.id} currentMileage={vehicle.current_mileage} />
        )}
        {tab === 'photos' && <PhotosTab vehicle={vehicle} onChanged={load} />}
        {tab === 'stats' && <StatsTab vehicleId={vehicle.id} />}
        {tab === 'recalls' && <RecallsTab vehicleId={vehicle.id} onCount={setRecallCount} />}
      </div>

      {editing && (
        <Modal title="Edit vehicle" onClose={() => setEditing(false)}>
          <VehicleForm
            initial={vehicle}
            onSubmit={handleEdit}
            onCancel={() => setEditing(false)}
            submitLabel="Save changes"
            busy={saving}
            error={editError}
          />
        </Modal>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete vehicle"
          message={`Delete ${vehicleTitle(vehicle)}? Its service history, reminders, and photos will be permanently removed.`}
          confirmLabel="Delete vehicle"
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
