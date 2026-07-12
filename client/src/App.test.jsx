import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const emptyDashboard = {
  vehicle_count: 0,
  record_count: 0,
  total_cost: 0,
  due_reminders: [],
  recent_records: [],
};

function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App auth gate', () => {
  it('shows the auth screen and signs in with a username + password', async () => {
    const user = userEvent.setup();
    let authenticated = false;
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/auth/status') {
        return jsonResponse(
          authenticated
            ? { required: true, authenticated: true, username: 'daniel' }
            : { required: true, authenticated: false }
        );
      }
      if (url === '/api/login') {
        const body = JSON.parse(options.body);
        if (body.username === 'daniel' && body.password === 'correct-horse') {
          authenticated = true;
          return jsonResponse({ username: 'daniel' });
        }
        return jsonResponse({ error: 'Invalid username or password' }, { ok: false, status: 401 });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Auth gate is shown, not the app shell.
    const usernameField = await screen.findByLabelText('Username');
    const passwordField = screen.getByLabelText('Password');
    expect(passwordField).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();

    await user.type(usernameField, 'daniel');
    await user.type(passwordField, 'correct-horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // After a successful login + status refresh, the shell (with Log out) renders
    // and the username is visible.
    expect(await screen.findByRole('button', { name: /log out/i })).toBeInTheDocument();
    expect(screen.getByText('daniel')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows an inline error on invalid credentials (401) without leaving the gate', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') return jsonResponse({ required: true, authenticated: false });
      if (url === '/api/login') {
        return jsonResponse({ error: 'Invalid username or password' }, { ok: false, status: 401 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    await user.type(await screen.findByLabelText('Username'), 'daniel');
    await user.type(screen.getByLabelText('Password'), 'wrongpass1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
    // Still on the auth gate.
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });

  it('flips back to the auth gate when a protected request returns 401', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') {
        return jsonResponse({ required: true, authenticated: true, username: 'daniel' });
      }
      if (url === '/api/dashboard') {
        return jsonResponse({ error: 'Authentication required' }, { ok: false, status: 401 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Boot authenticates, dashboard 401 re-triggers the gate.
    await waitFor(() => expect(screen.getByLabelText('Username')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });

  it('renders the app with the username shown when already authenticated', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') {
        return jsonResponse({ required: true, authenticated: true, username: 'daniel' });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Dashboard heading renders, no auth fields, username + logout visible.
    expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(screen.getByText('daniel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log out/i })).toBeInTheDocument();
  });

  it('hides the Admin nav link for a non-admin user', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') {
        return jsonResponse({ required: true, authenticated: true, username: 'sam', is_admin: false });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    expect(await screen.findByRole('button', { name: /log out/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows the Admin nav link for an admin user', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') {
        return jsonResponse({ required: true, authenticated: true, username: 'daniel', is_admin: true });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    expect(await screen.findByRole('link', { name: /admin/i })).toHaveAttribute('href', '/admin');
  });

  it('shows the second-factor screen (mfa_pending) and completes login with a TOTP code', async () => {
    const user = userEvent.setup();
    let authenticated = false;
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/auth/status') {
        return jsonResponse(
          authenticated
            ? { required: true, authenticated: true, username: 'daniel' }
            : {
                required: true,
                authenticated: false,
                mfa_pending: true,
                username: 'daniel',
                methods: ['totp', 'backup'],
              }
        );
      }
      if (url === '/api/login/mfa') {
        const body = JSON.parse(options.body);
        if (body.code === '123456') {
          authenticated = true;
          return jsonResponse({ username: 'daniel', is_admin: false });
        }
        return jsonResponse({ error: 'Invalid code' }, { ok: false, status: 401 });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Second-factor screen, not the app shell.
    expect(await screen.findByRole('heading', { name: /two-factor authentication/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: /^verify$/i }));

    // Into the app.
    expect(await screen.findByRole('button', { name: /log out/i })).toBeInTheDocument();
    const mfaCall = fetchMock.mock.calls.find((c) => c[0] === '/api/login/mfa');
    expect(JSON.parse(mfaCall[1].body)).toEqual({ code: '123456', method: 'totp' });
  });

  it('shows an inline error on a wrong second-factor code and stays on the screen', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') {
        return jsonResponse({
          required: true,
          authenticated: false,
          mfa_pending: true,
          username: 'daniel',
          methods: ['totp'],
        });
      }
      if (url === '/api/login/mfa') {
        return jsonResponse({ error: 'Invalid code' }, { ok: false, status: 401 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    await user.type(await screen.findByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: /^verify$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid code');
    // Still on the second-factor screen (not bounced to login, not into the app).
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });

  it('renders forced enrollment (mfa_setup_required), confirms TOTP, shows backup codes, then enters the app', async () => {
    const user = userEvent.setup();
    let enrolled = false;
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/auth/status') {
        return jsonResponse(
          enrolled
            ? { required: true, authenticated: true, username: 'newuser' }
            : { required: true, authenticated: false, mfa_setup_required: true, username: 'newuser' }
        );
      }
      if (url === '/api/mfa/totp/setup') {
        return jsonResponse({ secret_base32: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/x' });
      }
      if (url === '/api/mfa/totp/confirm') {
        const body = JSON.parse(options.body);
        expect(body.code).toBe('654321');
        enrolled = true;
        return jsonResponse({
          confirmed: true,
          mfa_enabled: true,
          backup_codes: ['aaaaa-11111', 'bbbbb-22222'],
          authenticated: true,
          username: 'newuser',
          is_admin: false,
        });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Forced enrollment gate.
    expect(
      await screen.findByRole('heading', { name: /set up two-factor authentication/i })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /set up authenticator app/i }));

    // Secret shown for manual entry.
    expect(await screen.findByTestId('totp-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');

    await user.type(screen.getByLabelText('Authenticator code'), '654321');
    await user.click(screen.getByRole('button', { name: /verify & enable/i }));

    // Backup codes must be acknowledged before entering the app.
    expect(await screen.findByText('aaaaa-11111')).toBeInTheDocument();
    expect(screen.getByText('bbbbb-22222')).toBeInTheDocument();
    // Not in the app yet — the acknowledge gate is showing.
    const ackButton = screen.getByRole('button', { name: /i saved them/i });
    expect(screen.queryByRole('navigation', { name: /primary/i })).not.toBeInTheDocument();

    await user.click(ackButton);

    // Now in the app.
    expect(await screen.findByRole('button', { name: /log out/i })).toBeInTheDocument();
  });

  it('logs out and returns to the auth gate', async () => {
    const user = userEvent.setup();
    let authenticated = true;
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') {
        return jsonResponse(
          authenticated
            ? { required: true, authenticated: true, username: 'daniel' }
            : { required: true, authenticated: false }
        );
      }
      if (url === '/api/logout') {
        authenticated = false;
        return jsonResponse({ authenticated: false });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    await user.click(await screen.findByRole('button', { name: /log out/i }));

    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/logout', expect.objectContaining({ method: 'POST' }));
  });
});
