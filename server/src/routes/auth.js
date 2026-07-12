import { Router } from 'express';

// Auth endpoints. Always mounted so the client can query /api/auth/status even
// when auth is disabled; the actual gating lives in the auth middleware. When
// APP_PASSWORD is unset these behave as harmless no-ops (v2 never called them).
export function authRouter(ctx) {
  const router = Router();
  const auth = ctx.auth;

  router.get('/auth/status', (req, res) => {
    res.json({ required: auth.required, authenticated: auth.isAuthenticated(req) });
  });

  router.post('/login', (req, res) => {
    if (!auth.required) {
      // No password configured: nothing to authenticate against.
      return res.json({ authenticated: true, required: false });
    }
    const password = req.body?.password;
    if (!auth.passwordMatches(password)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    auth.setSession(req, res);
    res.json({ authenticated: true, required: true });
  });

  router.post('/logout', (req, res) => {
    auth.clearSession(req, res);
    res.json({ authenticated: false, required: auth.required });
  });

  // Tokened calendar feed URL for subscribing calendar apps. Authed (reached only
  // when the session cookie is valid, or when auth is disabled).
  router.get('/calendar-url', (req, res) => {
    const token = auth.calendarToken();
    const url = token ? `/calendar.ics?token=${token}` : '/calendar.ics';
    res.json({ url });
  });

  return router;
}
