export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message) => new HttpError(404, message);

// Wraps an async route handler so a rejected promise is forwarded to Express's
// error middleware. Express 4 does not catch async rejections on its own, so
// every async handler must go through this to preserve the {error} contract.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export async function getVehicleOr404(db, id) {
  const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ?', [id]);
  if (!vehicle) throw notFound('Vehicle not found');
  return vehicle;
}

// Attaches the store-resolved `url` to a photo row for API responses.
export function withPhotoUrl(store, photo) {
  return { ...photo, url: store.urlFor(photo.filename) };
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
