import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import Modal from '../components/Modal.jsx';
import VehicleForm from '../components/VehicleForm.jsx';
import { EmptyState, ErrorBanner, Loading } from '../components/ui.jsx';
import { formatCurrency, formatMileage, vehicleTitle } from '../utils/format.js';

function monogram(vehicle) {
  const first = (vehicle.make || '?').charAt(0);
  const second = (vehicle.model || '').charAt(0);
  return `${first}${second}`.toUpperCase();
}

export default function Vehicles() {
  const navigate = useNavigate();
  const [vehicles, setVehicles] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setVehicles(await api.vehicles());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(payload) {
    setSaving(true);
    setSaveError(null);
    try {
      const created = await api.createVehicle(payload);
      setAdding(false);
      navigate(`/vehicles/${created.id}`);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Vehicles</h1>
          <p className="page-header__sub">
            {vehicles ? `${vehicles.length} in the garage` : 'Loading the garage…'}
          </p>
        </div>
        <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Add vehicle
        </button>
      </header>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && !vehicles && <Loading />}

      {vehicles && vehicles.length === 0 && (
        <EmptyState
          icon="car"
          title="No vehicles yet"
          message="Add your first car, truck, or bike to start tracking maintenance."
        >
          <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add your first vehicle
          </button>
        </EmptyState>
      )}

      {vehicles && vehicles.length > 0 && (
        <ul className="vehicle-grid">
          {vehicles.map((vehicle) => (
            <li key={vehicle.id}>
              <Link to={`/vehicles/${vehicle.id}`} className="vehicle-card">
                <div className="vehicle-card__media">
                  {vehicle.primary_photo ? (
                    <img
                      src={`/photos/${vehicle.primary_photo}`}
                      alt={vehicleTitle(vehicle)}
                      loading="lazy"
                    />
                  ) : (
                    <span className="vehicle-card__monogram" aria-hidden="true">
                      {monogram(vehicle)}
                    </span>
                  )}
                  {vehicle.alert_count > 0 && (
                    <span
                      className="vehicle-card__alert"
                      title={`${vehicle.alert_count} reminder${vehicle.alert_count === 1 ? '' : 's'} need attention`}
                    >
                      <Icon name="bell" size={12} /> {vehicle.alert_count}
                    </span>
                  )}
                </div>
                <div className="vehicle-card__body">
                  <h3 className="vehicle-card__title">{vehicleTitle(vehicle)}</h3>
                  {vehicle.name && (
                    <p className="vehicle-card__sub">
                      {vehicle.year} {vehicle.make} {vehicle.model}
                    </p>
                  )}
                  <dl className="vehicle-card__stats">
                    <div>
                      <dt>Mileage</dt>
                      <dd className="num">{formatMileage(vehicle.current_mileage)}</dd>
                    </div>
                    <div>
                      <dt>Total spent</dt>
                      <dd className="num">{formatCurrency(vehicle.total_cost)}</dd>
                    </div>
                    <div>
                      <dt>Records</dt>
                      <dd className="num">{vehicle.record_count}</dd>
                    </div>
                  </dl>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <Modal title="Add vehicle" onClose={() => setAdding(false)}>
          <VehicleForm
            onSubmit={handleCreate}
            onCancel={() => setAdding(false)}
            submitLabel="Add vehicle"
            busy={saving}
            error={saveError}
          />
        </Modal>
      )}
    </div>
  );
}
