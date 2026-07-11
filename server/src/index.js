import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { createBackupZip } from './backup.js';

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

async function runAutoBackup() {
  const dir = path.join(ctx.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `carmaint-backup-${stamp}.zip`);
  await createBackupZip(ctx.db, ctx.dataDir, dest);

  const keep = Number.isFinite(AUTO_BACKUP_KEEP) ? AUTO_BACKUP_KEEP : 14;
  const zips = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.zip'))
    .sort(); // ISO-ish timestamps sort chronologically
  if (keep >= 0 && zips.length > keep) {
    for (const name of zips.slice(0, zips.length - keep)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

let backupTimer = null;
if (AUTO_BACKUP_HOURS !== '0') {
  const hours = Number.parseFloat(AUTO_BACKUP_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    backupTimer = setInterval(() => {
      runAutoBackup().catch((err) => console.error('Auto-backup failed:', err));
    }, hours * 60 * 60 * 1000);
    backupTimer.unref();
  }
}

// --- Graceful shutdown ---------------------------------------------------
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (backupTimer) clearInterval(backupTimer);
  server.close(() => {
    try {
      ctx.db.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
