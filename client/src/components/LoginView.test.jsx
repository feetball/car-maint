import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginView from './LoginView.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginView auth screen', () => {
  it('renders the login mode by default (no confirm field)', () => {
    render(<LoginView onAuthenticated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /register/i })).toBeInTheDocument();
  });

  it('toggles to register mode and back', async () => {
    const user = userEvent.setup();
    render(<LoginView onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /register/i }));
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
  });

  it('shows a client-side validation message for a short username without calling fetch', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginView onAuthenticated={vi.fn()} />);

    await user.type(screen.getByLabelText('Username'), 'ab');
    await user.type(screen.getByLabelText('Password'), 'longenough1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/3.*32 characters/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates password length and confirmation in register mode', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginView onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /register/i }));
    await user.type(screen.getByLabelText('Username'), 'daniel');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'short');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8 characters/i);
    expect(fetchMock).not.toHaveBeenCalled();

    // Fix length but mismatch the confirmation.
    await user.type(screen.getByLabelText('Password'), 'enough');
    await user.type(screen.getByLabelText('Confirm password'), 'different1');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits login to POST /api/login and calls onAuthenticated on success', async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    const fetchMock = vi.fn(async () => jsonResponse({ username: 'daniel' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginView onAuthenticated={onAuthenticated} />);

    await user.type(screen.getByLabelText('Username'), 'daniel');
    await user.type(screen.getByLabelText('Password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(fetchMock).toHaveBeenCalledWith('/api/login', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ username: 'daniel', password: 'correct-horse' });
    expect(onAuthenticated).toHaveBeenCalled();
  });

  it('submits registration to POST /api/register', async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    const fetchMock = vi.fn(async () => jsonResponse({ username: 'newuser' }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginView onAuthenticated={onAuthenticated} />);

    await user.click(screen.getByRole('button', { name: /register/i }));
    await user.type(screen.getByLabelText('Username'), 'newuser');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.type(screen.getByLabelText('Confirm password'), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/register',
      expect.objectContaining({ method: 'POST' })
    );
    expect(onAuthenticated).toHaveBeenCalled();
  });

  it('shows the server error on a 401 login', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'Invalid username or password' }, { ok: false, status: 401 })
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginView onAuthenticated={vi.fn()} />);

    await user.type(screen.getByLabelText('Username'), 'daniel');
    await user.type(screen.getByLabelText('Password'), 'wrongpass1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
  });

  it('shows the server error on a 409 duplicate registration', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'username is already taken' }, { ok: false, status: 409 })
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginView onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /register/i }));
    await user.type(screen.getByLabelText('Username'), 'daniel');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.type(screen.getByLabelText('Confirm password'), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('username is already taken');
  });
});
