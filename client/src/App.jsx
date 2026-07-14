import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, setUnauthorizedHandler } from './api.js';
import Icon from './components/Icon.jsx';
import LoginView from './components/LoginView.jsx';
import EnrollView from './components/EnrollView.jsx';
import SecondFactorView from './components/SecondFactorView.jsx';
import { Loading } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Vehicles from './pages/Vehicles.jsx';
import VehicleDetail from './pages/VehicleDetail.jsx';
import Backup from './pages/Backup.jsx';
import Security from './pages/Security.jsx';
import Admin from './pages/Admin.jsx';

const navClass = ({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`;

function NotFound() {
  return (
    <div className="page">
      <div className="empty-state">
        <div className="empty-state__icon">
          <Icon name="crosshair" size={26} />
        </div>
        <h3 className="empty-state__title">Page not found</h3>
        <p className="empty-state__message">That route doesn&apos;t exist.</p>
        <Link className="button button--primary" to="/">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

// Per-username localStorage flag recording that the user dismissed the MFA setup
// interstitial ("Skip for now"). Keeps the onboarding nudge from re-appearing on every
// load, while the persistent banner + Security entry still advertise that MFA is off.
const skipKey = (username) => `carmaint.mfaSkip.${username || ''}`;
function readOnboardSkip(username) {
  try {
    return localStorage.getItem(skipKey(username)) === '1';
  } catch {
    return false;
  }
}
function writeOnboardSkip(username) {
  try {
    localStorage.setItem(skipKey(username), '1');
  } catch {
    /* ignore storage failures (private mode / disabled) */
  }
}

export default function App() {
  // null = still checking. Otherwise a normalized view of GET /api/auth/status. MFA is
  // OPTIONAL now, so there are three states:
  //   { authenticated:true, mfaEnabled, ... } → full app (nudge shown when !mfaEnabled)
  //   { mfaPending:true, methods, ... }        → login second-factor screen
  //   { authenticated:false }                  → login / register gate
  const [authState, setAuthState] = useState(null);
  // A short notice shown on the login gate (e.g. after a burned MFA challenge).
  const [loginNotice, setLoginNotice] = useState(null);
  // The onboarding interstitial (skippable MFA setup) has been dismissed for this user.
  const [onboardSkipped, setOnboardSkipped] = useState(false);
  // The persistent MFA nudge banner was dismissed for this session.
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.authStatus();
      setAuthState({
        authenticated: Boolean(status.authenticated),
        mfaPending: Boolean(status.mfa_pending),
        mfaEnabled: Boolean(status.mfa_enabled),
        methods: status.methods || [],
        username: status.username,
        is_admin: Boolean(status.is_admin),
      });
      setOnboardSkipped(readOnboardSkip(status.username));
    } catch {
      // Status endpoint unreachable — fail closed to the login gate.
      setAuthState({ authenticated: false });
    }
  }, []);

  useEffect(() => {
    // A 401 from the DATA api helper flips the whole app back to the login gate. MFA
    // and login endpoints suppress this gate (they legitimately 401 on wrong codes)
    // and handle those errors inline, so this only fires on a truly expired session.
    setUnauthorizedHandler(() => setAuthState({ authenticated: false }));
    refreshStatus();
    return () => setUnauthorizedHandler(null);
  }, [refreshStatus]);

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      /* clear locally regardless of the server's response */
    }
    setBannerDismissed(false);
    setAuthState({ authenticated: false });
  }

  // Leave a pending (login second-factor) state: drop the pending token server-side
  // and return to the login gate.
  async function handleCancelPending() {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    await refreshStatus();
  }

  // "Skip for now" on the onboarding interstitial: remember the dismissal for this user
  // (so it is not shown every load) and drop into the app. The banner + Security entry
  // still advertise that MFA is off.
  function handleSkipOnboarding() {
    writeOnboardSkip(authState?.username);
    setOnboardSkipped(true);
  }

  function toLoginWithNotice(message) {
    setLoginNotice(message);
    refreshStatus();
  }

  if (!authState) {
    return (
      <div className="app-boot">
        <Loading label="Starting CarMaint…" />
      </div>
    );
  }

  if (!authState.authenticated) {
    if (authState.mfaPending) {
      return (
        <SecondFactorView
          username={authState.username}
          methods={authState.methods}
          onDone={refreshStatus}
          onExpired={toLoginWithNotice}
          onLogout={handleCancelPending}
        />
      );
    }
    return <LoginView onAuthenticated={refreshStatus} notice={loginNotice} />;
  }

  // Authenticated but no second factor yet, and they have not skipped the nudge → show
  // the skippable onboarding interstitial (reuses EnrollView). Enrolling flips
  // mfaEnabled true (interstitial gone); "Skip for now" persists the dismissal.
  const needsMfaSetup = !authState.mfaEnabled;
  if (needsMfaSetup && !onboardSkipped) {
    return (
      <EnrollView
        username={authState.username}
        onDone={refreshStatus}
        onSkip={handleSkipOnboarding}
      />
    );
  }

  const showBanner = needsMfaSetup && !bannerDismissed;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand__mark">
            <Icon name="wrench" size={17} />
          </span>
          <span className="brand__name">CarMaint</span>
        </Link>
        <nav className="sidebar__nav" aria-label="Primary">
          <NavLink to="/" end className={navClass}>
            <Icon name="grid" size={17} />
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/vehicles" className={navClass}>
            <Icon name="car" size={17} />
            <span>Vehicles</span>
          </NavLink>
          <NavLink to="/backup" className={navClass}>
            <Icon name="cloud" size={17} />
            <span>Backup</span>
          </NavLink>
          <NavLink to="/security" className={navClass}>
            <Icon name="check" size={17} />
            <span>Two-Factor</span>
          </NavLink>
          {authState.is_admin && (
            <NavLink to="/admin" className={navClass}>
              <Icon name="gear" size={17} />
              <span>Admin</span>
            </NavLink>
          )}
        </nav>
        <div className="sidebar__account">
          {authState.username && (
            <div className="account-chip" title={`Signed in as ${authState.username}`}>
              <span className="account-chip__icon" aria-hidden="true">
                <Icon name="user" size={16} />
              </span>
              <span className="account-chip__text">
                <span className="account-chip__label">Signed in as</span>
                <span className="account-chip__name">{authState.username}</span>
              </span>
            </div>
          )}
          <button type="button" className="nav-link logout-button" onClick={handleLogout}>
            <Icon name="log-out" size={17} />
            <span>Log out</span>
          </button>
        </div>
        <p className="sidebar__footer">Every mile, accounted for.</p>
      </aside>
      <main className="app-main">
        {showBanner && (
          <div className="mfa-nudge" role="status">
            <span className="mfa-nudge__icon" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <span className="mfa-nudge__text">
              Two-factor authentication is not enabled. Set it up to secure your account.
            </span>
            <span className="mfa-nudge__actions">
              <Link to="/security" className="button button--primary button--small">
                Set up
              </Link>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setBannerDismissed(true)}
              >
                Dismiss
              </button>
            </span>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/vehicles" element={<Vehicles />} />
          <Route path="/vehicles/:id" element={<VehicleDetail />} />
          <Route path="/backup" element={<Backup />} />
          <Route path="/security" element={<Security onStatusChange={refreshStatus} />} />
          <Route
            path="/admin"
            element={authState.is_admin ? <Admin /> : <Navigate to="/" replace />}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
