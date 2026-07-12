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
