import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Icon, { serviceIcon } from '../components/Icon.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { EmptyState, ErrorBanner, Loading, StatTile } from '../components/ui.jsx';
import { formatCurrency, formatDate, formatMileage } from '../utils/format.js';
import { typeLabel } from '../utils/serviceTypes.js';

function dueText(reminder) {
  const parts = [];
  if (reminder.next_due_date) parts.push(formatDate(reminder.next_due_date));
  if (reminder.next_due_mileage != null) parts.push(formatMileage(reminder.next_due_mileage));
  return parts.length ? parts.join(' · ') : '—';
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.dashboard());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="page">
        <ErrorBanner message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }

  const due = data.due_reminders || [];
  const recent = data.recent_records || [];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="page-header__sub">Your garage at a glance.</p>
        </div>
      </header>

      <div className="stat-tiles">
        <StatTile icon="car" label="Vehicles" value={data.vehicle_count} />
        <StatTile icon="wrench" label="Service records" value={data.record_count} />
        <StatTile icon="chart" label="Total spent" value={formatCurrency(data.total_cost)} />
      </div>

      <div className="dashboard-columns">
        <section className="panel">
          <h2 className="panel__title">
            <Icon name="bell" size={16} /> Needs attention
          </h2>
          {due.length === 0 ? (
            <EmptyState
              icon="bell"
              title="All caught up"
              message="Nothing is overdue or coming up soon. Nice garage-keeping."
            />
          ) : (
            <ul className="attention-list">
              {due.map((reminder) => (
                <li key={reminder.id}>
                  <Link to={`/vehicles/${reminder.vehicle_id}`} className="attention-item">
                    <span className="attention-item__icon">
                      <Icon name={serviceIcon(reminder.type)} size={17} />
                    </span>
                    <span className="attention-item__body">
                      <span className="attention-item__type">{typeLabel(reminder.type)}</span>
                      <span className="attention-item__vehicle">{reminder.vehicle_name}</span>
                    </span>
                    <span className="attention-item__due num">{dueText(reminder)}</span>
                    <StatusPill status={reminder.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2 className="panel__title">
            <Icon name="clipboard" size={16} /> Recent activity
          </h2>
          {recent.length === 0 ? (
            <EmptyState
              icon="wrench"
              title="No service history yet"
              message="Log your first oil change or repair from a vehicle's service log."
            />
          ) : (
            <ul className="activity-list">
              {recent.map((record) => (
                <li key={record.id} className="activity-item">
                  <span className="activity-item__icon">
                    <Icon name={serviceIcon(record.type)} size={16} />
                  </span>
                  <div className="activity-item__body">
                    <span className="activity-item__title">
                      {typeLabel(record.type)}
                      {' — '}
                      <Link to={`/vehicles/${record.vehicle_id}`} className="subtle-link">
                        {record.vehicle_name}
                      </Link>
                    </span>
                    <span className="activity-item__meta num">
                      {formatDate(record.date)}
                      {record.mileage != null && ` · ${formatMileage(record.mileage)}`}
                    </span>
                  </div>
                  {record.cost != null && (
                    <span className="activity-item__cost num">{formatCurrency(record.cost)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
