import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { EmptyState, ErrorBanner, Loading } from '../../components/ui.jsx';
import { formatDate } from '../../utils/format.js';

function RecallCard({ recall }) {
  return (
    <article className="recall-card">
      <header className="recall-card__head">
        <span className="recall-card__campaign num">{recall.campaign_number || '—'}</span>
        {recall.report_date && (
          <span className="recall-card__date num">{formatDate(recall.report_date)}</span>
        )}
      </header>
      {recall.component && <h3 className="recall-card__component">{recall.component}</h3>}
      <dl className="recall-card__facts">
        {recall.summary && (
          <div>
            <dt>Summary</dt>
            <dd>{recall.summary}</dd>
          </div>
        )}
        {recall.consequence && (
          <div>
            <dt>Risk</dt>
            <dd>{recall.consequence}</dd>
          </div>
        )}
        {recall.remedy && (
          <div>
            <dt>Remedy</dt>
            <dd>{recall.remedy}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

export default function RecallsTab({ vehicleId, onCount }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh) => {
      setError(null);
      if (refresh) setRefreshing(true);
      try {
        const result = await api.recalls(vehicleId, refresh);
        setData(result);
        if (onCount) onCount(result.recalls ? result.recalls.length : 0);
      } catch (err) {
        setError(err.message);
      } finally {
        setRefreshing(false);
      }
    },
    [vehicleId, onCount]
  );

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .recalls(vehicleId)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        if (onCount) onCount(result.recalls ? result.recalls.length : 0);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [vehicleId, onCount]);

  const recalls = data && data.recalls ? data.recalls : [];

  return (
    <section aria-label="Recalls" className="recalls-tab">
      <div className="recalls-tab__toolbar">
        <p className="recalls-tab__meta">
          {data && data.fetched_at
            ? `Checked ${formatDate(data.fetched_at)} · NHTSA`
            : 'Open safety recalls from NHTSA.'}
        </p>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => load(true)}
          disabled={refreshing}
        >
          {refreshing ? (
            <span className="spinner spinner--inline" aria-hidden="true" />
          ) : (
            <Icon name="refresh" size={15} />
          )}
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <ErrorBanner message={`NHTSA unreachable — ${error}`} onRetry={() => load(false)} />}
      {!error && !data && <Loading label="Checking for recalls…" />}

      {!error && data && recalls.length === 0 && (
        <EmptyState icon="check" title="No open recalls" message="No open recalls — nice." />
      )}

      {!error && recalls.length > 0 && (
        <ul className="recall-list">
          {recalls.map((recall, index) => (
            <li key={recall.campaign_number || index}>
              <RecallCard recall={recall} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
