import { createApp } from './app.js';
import { runAutoBackup } from './backup.js';
import { runNotify } from './notify.js';

const dataDir = process.env.DATA_DIR || './data';
const app = createApp({ dataDir });
const ctx = app.locals.ctx;
const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  console.log(`CarMaint server listening on port ${port}`);
});

// --- Auto-backup ---------------------------------------------------------
const AUTO_BACKUP_HOURS = process.env.AUTO_BACKUP_HOURS ?? '24';
const AUTO_BACKUP_KEEP = Number.parseInt(process.env.AUTO_BACKUP_KEEP ?? '14', 10);
const keep = Number.isFinite(AUTO_BACKUP_KEEP) ? AUTO_BACKUP_KEEP : 14;

let backupTimer = null;
if (AUTO_BACKUP_HOURS !== '0') {
  const hours = Number.parseFloat(AUTO_BACKUP_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    backupTimer = setInterval(() => {
      runAutoBackup(ctx, keep).catch((err) =>
        console.error(
          `Auto-backup failed: ${err?.message || err} — is the backup location writable? See README.`
        )
      );
    }, hours * 60 * 60 * 1000);
    backupTimer.unref();
  }
}

// --- Notifications timer -------------------------------------------------
// Periodically dispatch due-reminder notifications. NOTIFY_CHECK_HOURS defaults
// to 24; "0" disables it. It is a no-op (never armed) unless at least one target
// — NTFY_URL or NOTIFY_WEBHOOK_URL — is configured. Failures are logged but never
// crash the process, mirroring the auto-backup timer. Unref'd so it never keeps
// the event loop alive on its own.
let notifyTimer = null;
const NOTIFY_CHECK_HOURS = process.env.NOTIFY_CHECK_HOURS ?? '24';
const hasNotifyTarget = Boolean(process.env.NTFY_URL || process.env.NOTIFY_WEBHOOK_URL);
if (NOTIFY_CHECK_HOURS !== '0' && hasNotifyTarget) {
  const notifyHours = Number.parseFloat(NOTIFY_CHECK_HOURS);
  if (Number.isFinite(notifyHours) && notifyHours > 0) {
    notifyTimer = setInterval(() => {
      runNotify(ctx).catch((err) =>
        console.error(
          `Notification check failed: ${err?.message || err} — check NTFY_URL/NOTIFY_WEBHOOK_URL. See README.`
        )
      );
    }, notifyHours * 60 * 60 * 1000);
    notifyTimer.unref();
  }
}

// --- Graceful shutdown ---------------------------------------------------
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (backupTimer) clearInterval(backupTimer);
  if (notifyTimer) clearInterval(notifyTimer);
  server.close(async () => {
    try {
      await ctx.db.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
