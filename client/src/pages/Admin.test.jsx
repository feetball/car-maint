import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Admin from './Admin.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const sampleUsers = [
  { id: 1, username: 'daniel', is_admin: true, created_at: '2026-01-01 12:00:00', vehicle_count: 2 },
  { id: 2, username: 'sam', is_admin: false, created_at: '2026-02-02 09:00:00', vehicle_count: 0 },
];

const sampleVehicles = [
  {
    id: 10, user_id: 1, name: 'Daily Driver', make: 'Honda', model: 'Civic', year: 2020,
    owner_username: 'daniel',
  },
  {
    id: 11, user_id: null, name: null, make: 'Toyota', model: 'Corolla', year: 2019,
    owner_username: null,
  },
];

const sampleBackups = [
  { filename: 'carmaint-backup-2026-07-10T03-00-00.zip', size: 4096, created_at: '2026-07-10 03:00:00' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

// Routes fetch by URL + method so tests can assert exact endpoints hit.
function installFetch(overrides = {}) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    const key = `${method} ${url}`;
    if (overrides[key]) return overrides[key](url, options);
    if (url === '/api/admin/users' && method === 'GET') return jsonResponse(sampleUsers);
    if (url === '/api/admin/vehicles' && method === 'GET') return jsonResponse(sampleVehicles);
    if (url === '/api/backups' && method === 'GET') return jsonResponse(sampleBackups);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Admin — Users tab', () => {
  it('renders the users table from the mocked fetch', async () => {
    installFetch();
    render(<Admin />);

    expect(await screen.findByText('daniel')).toBeInTheDocument();
    expect(screen.getByText('sam')).toBeInTheDocument();
    // Admin badge for daniel, "User" for sam.
    const danielRow = screen.getByText('daniel').closest('tr');
    expect(within(danielRow).getByText('Admin')).toBeInTheDocument();
    const samRow = screen.getByText('sam').closest('tr');
    expect(within(samRow).getByText('User')).toBeInTheDocument();
    // Vehicle counts.
    expect(within(danielRow).getByText('2')).toBeInTheDocument();
    expect(within(samRow).getByText('0')).toBeInTheDocument();
  });

  it('promotes a non-admin via the correct endpoint after confirming', async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<Admin />);

    await screen.findByText('sam');
    // sam's row has a "Promote" button.
    const samRow = screen.getByText('sam').closest('tr');
    await user.click(within(samRow).getByRole('button', { name: /promote/i }));

    // Confirm dialog then confirm.
    const dialog = await screen.findByRole('dialog', { name: /promote to admin/i });
    await user.click(within(dialog).getByRole('button', { name: /^promote$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/users/2/admin',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/admin/users/2/admin');
    expect(JSON.parse(call[1].body)).toEqual({ is_admin: true });
  });

  it('demotes an admin via the correct endpoint', async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<Admin />);

    await screen.findByText('daniel');
    const danielRow = screen.getByText('daniel').closest('tr');
    await user.click(within(danielRow).getByRole('button', { name: /demote/i }));

    const dialog = await screen.findByRole('dialog', { name: /demote admin/i });
    await user.click(within(dialog).getByRole('button', { name: /^demote$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/users/1/admin',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/admin/users/1/admin');
    expect(JSON.parse(call[1].body)).toEqual({ is_admin: false });
  });

  it('shows the 409 last-admin lockout error inline', async () => {
    const user = userEvent.setup();
    installFetch({
      'POST /api/admin/users/1/admin': async () =>
        jsonResponse({ error: 'cannot demote the last remaining admin' }, { ok: false, status: 409 }),
    });
    render(<Admin />);

    await screen.findByText('daniel');
    const danielRow = screen.getByText('daniel').closest('tr');
    await user.click(within(danielRow).getByRole('button', { name: /demote/i }));
    const dialog = await screen.findByRole('dialog', { name: /demote admin/i });
    await user.click(within(dialog).getByRole('button', { name: /^demote$/i }));

    expect(await screen.findByText(/cannot demote the last remaining admin/i)).toBeInTheDocument();
  });

  it('deletes a user after a strong confirm, hitting DELETE', async () => {
    const fetchMock = installFetch({
      'DELETE /api/admin/users/2': async () => jsonResponse({ deleted: true, id: 2 }),
    });
    const user = userEvent.setup();
    render(<Admin />);

    await screen.findByText('sam');
    const samRow = screen.getByText('sam').closest('tr');
    await user.click(within(samRow).getByRole('button', { name: /delete/i }));

    const dialog = await screen.findByRole('dialog', { name: /delete account/i });
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/all of their vehicles/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /delete account/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/users/2',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
  });

  it('shows a 409 error inline when deleting the last admin fails', async () => {
    const user = userEvent.setup();
    installFetch({
      'DELETE /api/admin/users/1': async () =>
        jsonResponse({ error: 'cannot delete the last remaining admin' }, { ok: false, status: 409 }),
    });
    render(<Admin />);

    await screen.findByText('daniel');
    const danielRow = screen.getByText('daniel').closest('tr');
    await user.click(within(danielRow).getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete account/i });
    await user.click(within(dialog).getByRole('button', { name: /delete account/i }));

    expect(await screen.findByText(/cannot delete the last remaining admin/i)).toBeInTheDocument();
  });
});

describe('Admin — Vehicles tab', () => {
  async function openVehicles(user) {
    render(<Admin />);
    await user.click(screen.getByRole('button', { name: /^vehicles$/i }));
    await screen.findByText('All vehicles');
  }

  it('lists all vehicles with owners and "Unowned" for null', async () => {
    installFetch();
    const user = userEvent.setup();
    await openVehicles(user);

    expect(screen.getByText('Daily Driver')).toBeInTheDocument();
    expect(screen.getByText('2019 Toyota Corolla')).toBeInTheDocument();
    // The null-owned vehicle shows an "Unowned" badge (also referenced in adopt copy).
    expect(screen.getAllByText(/unowned/i).length).toBeGreaterThan(0);
  });

  it('reassigns an owner via setVehicleOwner with the chosen user id', async () => {
    const fetchMock = installFetch({
      'POST /api/admin/vehicles/11/owner': async () =>
        jsonResponse({ id: 11, user_id: 2 }),
    });
    const user = userEvent.setup();
    await openVehicles(user);

    const select = screen.getByLabelText('Owner for 2019 Toyota Corolla');
    await user.selectOptions(select, '2');
    const saveRow = select.closest('tr');
    await user.click(within(saveRow).getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/vehicles/11/owner',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/admin/vehicles/11/owner');
    expect(JSON.parse(call[1].body)).toEqual({ user_id: 2 });
  });

  it('adopts all orphans onto the chosen user', async () => {
    const fetchMock = installFetch({
      'POST /api/admin/vehicles/adopt-orphans': async () =>
        jsonResponse({ adopted: 1, user_id: 2 }),
    });
    const user = userEvent.setup();
    await openVehicles(user);

    const adoptSelect = screen.getByLabelText('Adopt unowned vehicles onto user');
    await user.selectOptions(adoptSelect, '2');
    await user.click(screen.getByRole('button', { name: /adopt all unowned vehicles/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/vehicles/adopt-orphans',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/admin/vehicles/adopt-orphans');
    expect(JSON.parse(call[1].body)).toEqual({ user_id: 2 });
    expect(await screen.findByText(/adopted 1 vehicle/i)).toBeInTheDocument();
  });
});

describe('Admin — Backups tab', () => {
  async function openBackups(user) {
    render(<Admin />);
    await user.click(screen.getByRole('button', { name: /^backups$/i }));
    await screen.findByRole('heading', { name: /global backups/i });
  }

  it('lists stored global backups with size and date and a download link', async () => {
    installFetch();
    const user = userEvent.setup();
    await openBackups(user);

    const link = await screen.findByText('carmaint-backup-2026-07-10T03-00-00.zip');
    expect(link.closest('a')).toHaveAttribute(
      'href',
      '/api/backups/carmaint-backup-2026-07-10T03-00-00.zip'
    );
    expect(screen.getByText('4.0 KB')).toBeInTheDocument();
    expect(screen.getByText('Jul 10, 2026')).toBeInTheDocument();
  });

  it('creates a global backup via POST /api/backups', async () => {
    const fetchMock = installFetch({
      'POST /api/backups': async () => jsonResponse({ ok: true, filename: 'new.zip' }, { status: 201 }),
    });
    const user = userEvent.setup();
    await openBackups(user);

    await user.click(screen.getByRole('button', { name: /create backup now/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/backups',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  it('warns severely before restoring the entire database', async () => {
    installFetch();
    const user = userEvent.setup();
    await openBackups(user);

    const file = new File(['zip'], 'global.zip', { type: 'application/zip' });
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = await screen.findByRole('dialog', { name: /restore entire database/i });
    expect(within(dialog).getByText(/ALL users/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/logged out/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/global\.zip/)).toBeInTheDocument();
  });
});
