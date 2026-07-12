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
  it('shows the login view when auth is required and signs in with a password', async () => {
    const user = userEvent.setup();
    let authenticated = false;
    const fetchMock = vi.fn(async (url, options) => {
      if (url === '/api/auth/status') {
        return jsonResponse({ required: true, authenticated });
      }
      if (url === '/api/login') {
        const body = JSON.parse(options.body);
        if (body.password === 'correct-horse') {
          authenticated = true;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: 'Wrong password' }, { ok: false, status: 401 });
      }
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Login gate is shown, not the app shell.
    const passwordField = await screen.findByLabelText(/password/i);
    expect(passwordField).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();

    await user.type(passwordField, 'correct-horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // After a successful login + status refresh, the shell (with Log out) renders.
    expect(await screen.findByRole('button', { name: /log out/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows an inline error on a wrong password (401) without leaving the login view', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') return jsonResponse({ required: true, authenticated: false });
      if (url === '/api/login') {
        return jsonResponse({ error: 'Wrong password' }, { ok: false, status: 401 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    const passwordField = await screen.findByLabelText(/password/i);
    await user.type(passwordField, 'nope');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
    // Still on the login gate.
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });

  it('flips back to the login gate when a protected request returns 401', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') return jsonResponse({ required: true, authenticated: true });
      if (url === '/api/dashboard') {
        return jsonResponse({ error: 'Authentication required' }, { ok: false, status: 401 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Boot authenticates, dashboard 401 re-triggers the gate.
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });

  it('renders the app directly (no login) when auth is not required', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') return jsonResponse({ required: false, authenticated: true });
      if (url === '/api/dashboard') return jsonResponse(emptyDashboard);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Dashboard heading renders; no login field, no logout button.
    expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });
});
