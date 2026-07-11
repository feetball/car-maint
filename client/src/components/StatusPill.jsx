const STATUSES = {
  no_history: { label: 'No history', modifier: 'no-history' },
  ok: { label: 'OK', modifier: 'ok' },
  due_soon: { label: 'Due soon', modifier: 'due-soon' },
  overdue: { label: 'Overdue', modifier: 'overdue' },
};

export default function StatusPill({ status }) {
  const info = STATUSES[status] || { label: status || 'Unknown', modifier: 'unknown' };
  return <span className={`status-pill status-pill--${info.modifier}`}>{info.label}</span>;
}
