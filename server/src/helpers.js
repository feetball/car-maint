export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message) => new HttpError(404, message);

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function getVehicleOr404(db, id) {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  if (!vehicle) throw notFound('Vehicle not found');
  return vehicle;
}

export function vehicleName(vehicle) {
  return vehicle.name || `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
}

// CSV field escaping: quote fields containing " , or newlines; double embedded ".
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
