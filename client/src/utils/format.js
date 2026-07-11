const currencyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const numberFormat = new Intl.NumberFormat('en-US');
const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

export function formatCurrency(value) {
  if (isBlank(value) || Number.isNaN(Number(value))) return '—';
  return currencyFormat.format(Number(value));
}

export function formatMileage(value) {
  if (isBlank(value) || Number.isNaN(Number(value))) return '—';
  return `${numberFormat.format(Number(value))} mi`;
}

// Parses "YYYY-MM-DD" as a LOCAL date (new Date("YYYY-MM-DD") would be UTC and
// can render as the previous day in western timezones).
export function parseDateString(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const parsed = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value) {
  const parsed = parseDateString(value);
  return parsed ? dateFormat.format(parsed) : '—';
}

// Today as "YYYY-MM-DD" in local time (for date input defaults).
export function todayString() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function vehicleTitle(vehicle) {
  if (!vehicle) return '';
  return vehicle.name || `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
}

// Human-readable file size: bytes → B / KB / MB / GB.
export function formatBytes(value) {
  const n = Number(value);
  if (isBlank(value) || Number.isNaN(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
