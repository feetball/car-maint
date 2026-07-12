// Optional callback invoked on any 401 so the app can flip to the login view.
// Kept module-level so every request goes through the same gate.
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

// Tiny fetch helper: JSON in/out, throws Error(message) on !ok using the
// server's { error } payload when present. A 401 additionally triggers the
// unauthorized handler (unless `suppressAuthGate` is set — e.g. the login call
// itself, whose 401 means "wrong password", not "session expired").
async function request(path, options = {}) {
  const { suppressAuthGate, ...rest } = options;
  const opts = { ...rest };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('Network error — could not reach the server.');
  }
  if (res.status === 401 && !suppressAuthGate && unauthorizedHandler) {
    unauthorizedHandler();
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed with status ${res.status}`);
  }
  return data;
}

export const api = {
  // Auth
  authStatus: () => request('/api/auth/status'),
  login: (password) => request('/api/login', { method: 'POST', body: { password }, suppressAuthGate: true }),
  logout: () => request('/api/logout', { method: 'POST' }),

  // Dashboard & shared
  dashboard: () => request('/api/dashboard'),
  serviceTypes: () => request('/api/service-types'),

  // VIN decode, recalls, calendar (V3)
  decodeVin: (vin) => request(`/api/vin/${encodeURIComponent(vin)}`),
  recalls: (vehicleId, refresh = false) =>
    request(`/api/vehicles/${vehicleId}/recalls${refresh ? '?refresh=1' : ''}`),
  calendarUrl: () => request('/api/calendar-url'),

  // Vehicles
  vehicles: () => request('/api/vehicles'),
  vehicle: (id) => request(`/api/vehicles/${id}`),
  createVehicle: (body) => request('/api/vehicles', { method: 'POST', body }),
  updateVehicle: (id, body) => request(`/api/vehicles/${id}`, { method: 'PUT', body }),
  deleteVehicle: (id) => request(`/api/vehicles/${id}`, { method: 'DELETE' }),

  // Service records
  records: (vehicleId, type) =>
    request(`/api/vehicles/${vehicleId}/records${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  createRecord: (vehicleId, body) => request(`/api/vehicles/${vehicleId}/records`, { method: 'POST', body }),
  updateRecord: (id, body) => request(`/api/records/${id}`, { method: 'PUT', body }),
  deleteRecord: (id) => request(`/api/records/${id}`, { method: 'DELETE' }),

  // Reminders
  reminders: (vehicleId) => request(`/api/vehicles/${vehicleId}/reminders`),
  createReminder: (vehicleId, body) => request(`/api/vehicles/${vehicleId}/reminders`, { method: 'POST', body }),
  updateReminder: (id, body) => request(`/api/reminders/${id}`, { method: 'PUT', body }),
  deleteReminder: (id) => request(`/api/reminders/${id}`, { method: 'DELETE' }),

  // Photos
  uploadPhotos: (vehicleId, files) => {
    const form = new FormData();
    for (const file of files) form.append('photos', file);
    return request(`/api/vehicles/${vehicleId}/photos`, { method: 'POST', body: form });
  },
  setPrimaryPhoto: (photoId) => request(`/api/photos/${photoId}/primary`, { method: 'PUT' }),
  deletePhoto: (photoId) => request(`/api/photos/${photoId}`, { method: 'DELETE' }),

  // Stats
  stats: (vehicleId) => request(`/api/vehicles/${vehicleId}/stats`),

  // Export & backup
  backups: () => request('/api/backups'),
  restore: (file) => {
    const form = new FormData();
    form.append('backup', file);
    return request('/api/restore', { method: 'POST', body: form });
  },
};
