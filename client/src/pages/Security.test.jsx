import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Security from './Security.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const baseStatus = {
  methods: { totp: true, email: false, webauthn: true },
  backup_codes_remaining: 7,
  webauthn: {
    count: 1,
    credentials: [
      { id: 'cred-1', name: 'MacBook Touch ID', created_at: '2026-01-01T00:00:00Z', last_used_at: null },
    ],
  },
  mfa_enabled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Security (two-factor settings)', () => {
  it('renders the enrolled methods from /api/mfa/status', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/mfa/status') return jsonResponse(baseStatus);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Security />);

    // Authenticator + passkey panels show enabled state; the passkey is listed by name.
    expect(await screen.findByText('MacBook Touch ID')).toBeInTheDocument();
    expect(screen.getAllByText('Enabled').length).toBeGreaterThanOrEqual(1);
    // Backup codes remaining count is surfaced.
    expect(screen.getByText('7')).toBeInTheDocument();
    // Email is off → an "Add email code" affordance is offered.
    expect(screen.getByRole('button', { name: /add email code/i })).toBeInTheDocument();
  });

  it('shows "Not enabled" with setup affordances when mfa_enabled is false', async () => {
    const offStatus = {
      methods: { totp: false, email: false, webauthn: false },
      backup_codes_remaining: 0,
      webauthn: { count: 0, credentials: [] },
      mfa_enabled: false,
    };
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/mfa/status') return jsonResponse(offStatus);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Security />);

    // The permanent "profile entry": a clear Not-enabled state.
    expect(await screen.findByText('Not enabled')).toBeInTheDocument();
    // Prominent set-up actions for each method.
    expect(screen.getByRole('button', { name: /add authenticator app/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a passkey/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add email code/i })).toBeInTheDocument();
    // No "Enabled" badge anywhere.
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
  });

  it('flips to enabled after enrolling TOTP from the not-enabled state', async () => {
    const user = userEvent.setup();
    let enabled = false;
    const offStatus = {
      methods: { totp: false, email: false, webauthn: false },
      backup_codes_remaining: 0,
      webauthn: { count: 0, credentials: [] },
      mfa_enabled: false,
    };
    const onStatus = {
      ...offStatus,
      methods: { totp: true, email: false, webauthn: false },
      backup_codes_remaining: 10,
      mfa_enabled: true,
    };
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (url === '/api/mfa/status') return jsonResponse(enabled ? onStatus : offStatus);
      if (url === '/api/mfa/totp/setup') {
        return jsonResponse({ secret_base32: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/x' });
      }
      if (url === '/api/mfa/totp/confirm' && options.method === 'POST') {
        enabled = true;
        return jsonResponse({ confirmed: true, mfa_enabled: true, backup_codes: ['aaaaa-11111'] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Security />);

    expect(await screen.findByText('Not enabled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add authenticator app/i }));
    // The inline TotpEnroll widget then needs its own "Set up" click to fetch the secret.
    await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));
    await user.type(await screen.findByLabelText('Authenticator code'), '654321');
    await user.click(screen.getByRole('button', { name: /verify & enable/i }));

    // Backup codes are shown, then status reflects Enabled.
    expect(await screen.findByText('aaaaa-11111')).toBeInTheDocument();
    expect((await screen.findAllByText('Enabled')).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Not enabled')).not.toBeInTheDocument();
  });

  it('shows the last-factor 409 message inline when removing the only remaining factor', async () => {
    // Only TOTP active — removing it is the last factor.
    const soloStatus = {
      ...baseStatus,
      methods: { totp: true, email: false, webauthn: false },
      webauthn: { count: 0, credentials: [] },
    };
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (url === '/api/mfa/status') return jsonResponse(soloStatus);
      if (url === '/api/mfa/totp' && options.method === 'DELETE') {
        return jsonResponse(
          { error: 'at least one MFA method is required — add another before removing this one' },
          { ok: false, status: 409 }
        );
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<Security />);

    // Remove the authenticator (the confirm dialog then the real DELETE).
    const removeBtn = await screen.findByRole('button', { name: /remove/i });
    await user.click(removeBtn);
    // Confirm inside the dialog (disambiguate from the panel's Remove button).
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));

    expect(await screen.findByText(/at least one MFA method is required/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/mfa/totp', expect.objectContaining({ method: 'DELETE' }))
    );
  });

  it('regenerates backup codes and displays them for acknowledgement', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (url === '/api/mfa/status') return jsonResponse(baseStatus);
      if (url === '/api/mfa/backup/regenerate' && options.method === 'POST') {
        return jsonResponse({ backup_codes: ['ccccc-33333', 'ddddd-44444'] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<Security />);

    await user.click(await screen.findByRole('button', { name: /regenerate backup codes/i }));

    expect(await screen.findByText('ccccc-33333')).toBeInTheDocument();
    expect(screen.getByText('ddddd-44444')).toBeInTheDocument();
  });
});
