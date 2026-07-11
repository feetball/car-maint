import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { EmptyState, ErrorBanner, Loading, StatTile } from '../../components/ui.jsx';
import { formatCurrency } from '../../utils/format.js';

function TypeBars({ rows }) {
  if (!rows.length) return <p className="muted">No cost data yet.</p>;
  const width = 680;
  const rowHeight = 46;
  const max = Math.max(...rows.map((r) => r.total), 1);
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${rows.length * rowHeight}`}
      width="100%"
      role="img"
      aria-label="Cost by service type"
    >
      {rows.map((row, index) => {
        const y = index * rowHeight;
        const barWidth = row.total > 0 ? Math.max((row.total / max) * width, 6) : 0;
        return (
          <g key={row.type}>
            <text className="chart__label" x="0" y={y + 14}>
              {row.label} · {row.count}
            </text>
            <text className="chart__value" x={width} y={y + 14} textAnchor="end">
              {formatCurrency(row.total)}
            </text>
            <rect className="chart__track" x="0" y={y + 22} width={width} height="10" rx="5" />
            <rect className="chart__bar" x="0" y={y + 22} width={barWidth} height="10" rx="5" />
          </g>
        );
      })}
    </svg>
  );
}

function YearBars({ rows }) {
  if (!rows.length) return <p className="muted">No cost data yet.</p>;
  const width = 680;
  const height = 200;
  const topZone = 20;
  const labelZone = 26;
  const max = Math.max(...rows.map((r) => r.total), 1);
  const slot = width / rows.length;
  const barWidth = Math.min(64, slot * 0.6);
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label="Cost by year"
    >
      {rows.map((row, index) => {
        const barHeight = row.total > 0 ? Math.max((row.total / max) * (height - topZone - labelZone), 3) : 0;
        const x = index * slot + (slot - barWidth) / 2;
        const y = height - labelZone - barHeight;
        return (
          <g key={row.year}>
            <rect className="chart__bar" x={x} y={y} width={barWidth} height={barHeight} rx="4" />
            <text className="chart__value" x={x + barWidth / 2} y={y - 7} textAnchor="middle">
              {formatCurrency(row.total)}
            </text>
            <text className="chart__label" x={x + barWidth / 2} y={height - 8} textAnchor="middle">
              {row.year}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function StatsTab({ vehicleId }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStats(await api.stats(vehicleId));
    } catch (err) {
      setError(err.message);
    }
  }, [vehicleId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!stats) return <Loading />;

  if (stats.record_count === 0) {
    return (
      <EmptyState
        icon="chart"
        title="No stats yet"
        message="Add service records with costs and the charts will build themselves."
      />
    );
  }

  const average = stats.record_count > 0 ? stats.total_cost / stats.record_count : 0;

  return (
    <section aria-label="Stats" className="stats-tab">
      <div className="stat-tiles">
        <StatTile icon="chart" label="Total spent" value={formatCurrency(stats.total_cost)} />
        <StatTile icon="wrench" label="Service records" value={stats.record_count} />
        <StatTile icon="gauge" label="Average per record" value={formatCurrency(average)} />
      </div>

      <div className="panel">
        <h2 className="panel__title">Cost by service type</h2>
        <TypeBars rows={stats.cost_by_type || []} />
      </div>

      <div className="panel">
        <h2 className="panel__title">Cost by year</h2>
        <YearBars rows={stats.cost_by_year || []} />
      </div>
    </section>
  );
}
