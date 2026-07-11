import Icon from './Icon.jsx';

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBanner({ message, onRetry }) {
  return (
    <div className="error-banner" role="alert">
      <span className="error-banner__message">{message}</span>
      {onRetry && (
        <button type="button" className="button button--ghost button--small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon = 'car', title, message, children }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <Icon name={icon} size={26} />
      </div>
      <h3 className="empty-state__title">{title}</h3>
      {message && <p className="empty-state__message">{message}</p>}
      {children}
    </div>
  );
}

export function StatTile({ icon, label, value }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile__icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="stat-tile__text">
        <span className="stat-tile__value num">{value}</span>
        <span className="stat-tile__label">{label}</span>
      </div>
    </div>
  );
}
