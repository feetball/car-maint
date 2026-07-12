import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the browser WebAuthn helpers so no real authenticator is needed. startRegistration/
// startAuthentication normally do the base64url<->ArrayBuffer dance with the platform
// authenticator; here they just echo a canned response object.
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: vi.fn(async () => ({ id: 'new-cred', type: 'public-key' })),
  startAuthentication: vi.fn(async () => ({ id: 'assert-cred', type: 'public-key' })),
}));

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { PasskeyEnroll } from './enroll.jsx';
import SecondFactorView from '../SecondFactorView.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Passkey enrollment (PasskeyEnroll)', () => {
  it('calls startRegistration and posts the response, then reports completion', async () => {
    const onComplete = vi.fn();
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/mfa/webauthn/register/options') {
        return jsonResponse({ challenge: 'abc', rp: { id: 'localhost' } });
      }
      if (url === '/api/mfa/webauthn/register/verify') {
        return jsonResponse({ verified: true, credential: { id: 'new-cred' }, backup_codes: null });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<PasskeyEnroll onComplete={onComplete} />);
    await user.click(screen.getByRole('button', { name: /create passkey/i }));

    await waitFor(() => expect(startRegistration).toHaveBeenCalledTimes(1));
    // The server options JSON is handed to the browser helper under optionsJSON.
    expect(startRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ optionsJSON: expect.objectContaining({ challenge: 'abc' }) })
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const verifyCall = fetchMock.mock.calls.find((c) => c[0] === '/api/mfa/webauthn/register/verify');
    expect(JSON.parse(verifyCall[1].body).response).toEqual({ id: 'new-cred', type: 'public-key' });
  });
});

describe('Passkey login (SecondFactorView)', () => {
  it('calls startAuthentication and completes login', async () => {
    const onDone = vi.fn();
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/login/mfa/webauthn/options') {
        return jsonResponse({ challenge: 'xyz', allowCredentials: [] });
      }
      if (url === '/api/login/mfa/webauthn/verify') {
        return jsonResponse({ username: 'daniel', is_admin: false });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <SecondFactorView
        username="daniel"
        methods={['webauthn']}
        onDone={onDone}
        onExpired={vi.fn()}
        onLogout={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /use a passkey/i }));

    await waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1));
    expect(startAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ optionsJSON: expect.objectContaining({ challenge: 'xyz' }) })
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
