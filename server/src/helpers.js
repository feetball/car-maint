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

// Loads a vehicle owned by userId, or throws 404. Scoping the lookup by user_id
// means another user's vehicle — and any NULL-owned (unadopted legacy) vehicle —
// is indistinguishable from a nonexistent one (404, not 403: no existence leak).
export async function getVehicleOr404(db, id, userId) {
  const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ? AND user_id = ?', [id, userId]);
  if (!vehicle) throw notFound('Vehicle not found');
  return vehicle;
}

// Loads a child row (record/reminder/photo) by id only when its parent vehicle is
// owned by userId, or throws 404. `table` is a trusted constant, never user input.
export async function getOwnedChildOr404(db, table, id, userId, label) {
  const row = await db.get(
    `SELECT c.* FROM ${table} c JOIN vehicles v ON v.id = c.vehicle_id
      WHERE c.id = ? AND v.user_id = ?`,
    [id, userId]
  );
  if (!row) throw notFound(label);
  return row;
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
