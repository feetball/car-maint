import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

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
  register: (username, password) =>
    request('/api/register', { method: 'POST', body: { username, password }, suppressAuthGate: true }),
  login: (username, password) =>
    request('/api/login', { method: 'POST', body: { username, password }, suppressAuthGate: true }),
  logout: () => request('/api/logout', { method: 'POST' }),

  // --- MFA: login second factor -----------------------------------------------
  // These legitimately return 401 for a wrong/expired code, so they suppress the
  // global auth gate and the caller handles the error inline. After 5 fails the
  // server burns the pending token (mfa_pending:false) → the caller bounces to login.
  loginMfa: (code, method) =>
    request('/api/login/mfa', {
      method: 'POST',
      body: method ? { code, method } : { code },
      suppressAuthGate: true,
    }),
  emailSendCode: () =>
    request('/api/mfa/email/send-code', { method: 'POST', suppressAuthGate: true }),

  // Passkey (WebAuthn) login: options → browser assertion → verify. @simplewebauthn/
  // browser handles all base64url/ArrayBuffer conversion for us.
  webauthnLogin: async () => {
    const optionsJSON = await request('/api/login/mfa/webauthn/options', {
      method: 'POST',
      suppressAuthGate: true,
    });
    const response = await startAuthentication({ optionsJSON });
    return request('/api/login/mfa/webauthn/verify', {
      method: 'POST',
      body: { response },
      suppressAuthGate: true,
    });
  },

  // --- MFA: enrollment + management (setup-required state OR full session) -----
  // All suppress the auth gate: in the pending setup/login states a 401 means the
  // pending token expired and is surfaced inline (the screen offers "back to login"),
  // never a premature silent redirect.
  mfaStatus: () => request('/api/mfa/status', { suppressAuthGate: true }),

  totpSetup: () => request('/api/mfa/totp/setup', { method: 'POST', suppressAuthGate: true }),
  totpConfirm: (code) =>
    request('/api/mfa/totp/confirm', { method: 'POST', body: { code }, suppressAuthGate: true }),
  deleteTotp: () => request('/api/mfa/totp', { method: 'DELETE', suppressAuthGate: true }),

  backupRegenerate: () =>
    request('/api/mfa/backup/regenerate', { method: 'POST', suppressAuthGate: true }),

  emailSetup: (email) =>
    request('/api/mfa/email/setup', { method: 'POST', body: { email }, suppressAuthGate: true }),
  emailConfirm: (code) =>
    request('/api/mfa/email/confirm', { method: 'POST', body: { code }, suppressAuthGate: true }),
  deleteEmail: () => request('/api/mfa/email', { method: 'DELETE', suppressAuthGate: true }),

  // Passkey enrollment: options → browser create → verify. Returns { verified,
  // credential, backup_codes?, ...session }. `name` labels the credential.
  webauthnRegister: async (name) => {
    const optionsJSON = await request('/api/mfa/webauthn/register/options', {
      method: 'POST',
      suppressAuthGate: true,
    });
    const response = await startRegistration({ optionsJSON });
    return request('/api/mfa/webauthn/register/verify', {
      method: 'POST',
      body: name ? { response, name } : { response },
      suppressAuthGate: true,
    });
  },
  listPasskeys: () => request('/api/mfa/webauthn/credentials', { suppressAuthGate: true }),
  deletePasskey: (credentialId) =>
    request(`/api/mfa/webauthn/${encodeURIComponent(credentialId)}`, {
      method: 'DELETE',
      suppressAuthGate: true,
    }),

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

  // --- Admin (require an admin session; a 401 still trips the auth gate, a 403
  // surfaces as a thrown Error the page shows inline) --------------------------
  adminUsers: () => request('/api/admin/users'),
  setUserAdmin: (id, isAdmin) =>
    request(`/api/admin/users/${id}/admin`, { method: 'POST', body: { is_admin: isAdmin } }),
  deleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
  adminResetMfa: (id) => request(`/api/admin/users/${id}/mfa`, { method: 'DELETE' }),

  adminVehicles: () => request('/api/admin/vehicles'),
  setVehicleOwner: (id, userId) =>
    request(`/api/admin/vehicles/${id}/owner`, { method: 'POST', body: { user_id: userId } }),
  adoptOrphans: (userId) =>
    request('/api/admin/vehicles/adopt-orphans', { method: 'POST', body: { user_id: userId } }),

  // Global (whole-DB) backups — distinct from the per-user backup() above.
  listGlobalBackups: () => request('/api/backups'),
  createGlobalBackup: () => request('/api/backups', { method: 'POST' }),
  downloadGlobalBackupUrl: (filename) => `/api/backups/${encodeURIComponent(filename)}`,
  restoreGlobalBackup: (file) => {
    const form = new FormData();
    form.append('backup', file);
    return request('/api/backups/restore', { method: 'POST', body: form });
  },
};
