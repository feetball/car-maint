import { Router } from 'express';
import { runAutoBackup } from '../backup.js';
import { collectDue, sendNotifications } from '../notify.js';

// Same keep-count the index.js auto-backup timer uses.
function autoBackupKeep() {
  const n = Number.parseInt(process.env.AUTO_BACKUP_KEEP ?? '14', 10);
  return Number.isFinite(n) ? n : 14;
}

// Cron routes (invoked by Vercel's scheduler). They are exempt from the cookie
// auth middleware and instead enforce the CRON_SECRET bearer here — open when
// CRON_SECRET is unset, since Vercel only sends the header when it is set. Both
// routes always answer with a { ok, ... } JSON summary.
export function cronRouter(ctx) {
  const router = Router();

  // Scope the bearer gate to /cron/* only, so an unmatched /api/* request that
  // falls through to this router is not turned into a 401 (it must still 404).
  router.use('/cron', (req, res, next) => {
    if (!ctx.auth.cronAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
  });

  router.get('/cron/backup', async (req, res) => {
    try {
      const filename = await runAutoBackup(ctx, autoBackupKeep());
      res.json({ ok: true, filename });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || 'backup failed' });
    }
  });

  router.get('/cron/notify', async (req, res) => {
    try {
      const due = await collectDue(ctx.db);
      const summary = await sendNotifications(ctx.config, due, fetch);
      res.json({ ok: true, ...summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || 'notify failed' });
    }
  });

  return router;
}
