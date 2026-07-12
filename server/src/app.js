import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createDataFacade } from './data/facade.js';
import { createPhotoStore } from './photostore/index.js';
import { createAuth } from './auth.js';
import { HttpError } from './helpers.js';
import { authRouter } from './routes/auth.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { photosRouter } from './routes/photos.js';
import { recordsRouter } from './routes/records.js';
import { remindersRouter } from './routes/reminders.js';
import { miscRouter } from './routes/misc.js';
import { exportRouter } from './routes/export.js';
import { backupRouter } from './routes/backup.js';
import { vinRouter } from './routes/vin.js';
import { recallsRouter } from './routes/recalls.js';
import { cronRouter } from './routes/cron.js';
import { calendarHandler } from './routes/calendar.js';

const DEFAULT_NHTSA_VPIC_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const DEFAULT_NHTSA_RECALLS_BASE = 'https://api.nhtsa.gov';

// Returns a configured Express app (does NOT listen). Stays synchronous: the data
// facade created here schedules its own async schema init behind a ready promise
// that every facade method awaits, so existing tests can keep calling createApp
// synchronously. Driver/store/auth are all selected from options → env defaults.
export function createApp(options = {}) {
  const { dataDir } = options;
  const photosDir = path.join(dataDir, 'photos');

  const dbDriver = options.dbDriver ?? process.env.DB_DRIVER ?? 'sqlite';
  // libsql target: explicit option → env → a per-dataDir local file. The file
  // fallback keeps each createApp({ dataDir }) isolated (matching the sqlite
  // driver) so the test suite can run unchanged under DB_DRIVER=libsql.
  let dbUrl = options.dbUrl ?? process.env.TURSO_DATABASE_URL;
  if (dbDriver === 'libsql' && !dbUrl) {
    dbUrl = `file:${path.join(dataDir, 'carmaint.db')}`;
  }
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  const db = createDataFacade({
    driver: dbDriver,
    dataDir,
    url: dbUrl,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const store = createPhotoStore({ dataDir, blobToken });

  const auth = createAuth({
    appPassword: process.env.APP_PASSWORD,
    authSecret: process.env.AUTH_SECRET,
    cronSecret: process.env.CRON_SECRET,
  });

  // Shared context handed to every router. Feature config (NHTSA bases, notify
  // targets) is carried here so the routers added by the features agent can read
  // it without re-parsing env.
  const ctx = {
    dataDir,
    photosDir,
    db,
    store,
    auth,
    config: {
      nhtsaVpicBase: options.nhtsaVpicBase ?? process.env.NHTSA_VPIC_BASE ?? DEFAULT_NHTSA_VPIC_BASE,
      nhtsaRecallsBase:
        options.nhtsaRecallsBase ?? process.env.NHTSA_RECALLS_BASE ?? DEFAULT_NHTSA_RECALLS_BASE,
      ntfyUrl: process.env.NTFY_URL,
      notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL,
    },
  };

  const app = express();
  app.locals.ctx = ctx;

  app.use(express.json({ limit: '1mb' }));

  // Auth gate over /api and /photos (no-op when APP_PASSWORD is unset). Runs
  // before the static photo mount and every router so nothing leaks past it.
  app.use(auth.middleware());

  // Photo files (disk mode). In blob mode photo URLs are absolute and this mount
  // simply serves nothing.
  app.use('/photos', express.static(photosDir));

  // Auth endpoints (login/logout/status/calendar-url) — always mounted.
  app.use('/api', authRouter(ctx));

  // Core v2 API.
  app.use('/api', miscRouter(ctx));
  app.use('/api', exportRouter(ctx));
  app.use('/api', backupRouter(ctx));
  app.use('/api', vehiclesRouter(ctx));
  app.use('/api', photosRouter(ctx));
  app.use('/api', recordsRouter(ctx));
  app.use('/api', remindersRouter(ctx));

  // === V3 feature routers ===
  // VIN decode, per-vehicle recalls, and the Vercel cron endpoints. Mounted
  // before the /api 404 so they are reachable and still covered by the shared
  // error handler.
  app.use('/api', vinRouter(ctx));
  app.use('/api', recallsRouter(ctx));
  app.use('/api', cronRouter(ctx));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // === App-level feature routes (before the SPA fallback) ===
  // GET /calendar.ics is not under /api, so it is registered here — ahead of the
  // static/SPA fallback so that fallback does not swallow it. Token-gated when
  // auth is enabled (see calendar handler).
  app.get('/calendar.ics', calendarHandler(ctx));

  const staticDir = process.env.STATIC_DIR;
  if (staticDir && fs.existsSync(staticDir)) {
    const staticRoot = path.resolve(staticDir);
    app.use(express.static(staticRoot));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/photos')) return next();
      res.sendFile(path.join(staticRoot, 'index.html'));
    });
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = 500;
    if (err instanceof HttpError) status = err.status;
    else if (err.name === 'MulterError') status = 400;
    else if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') status = 400;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
  });

  return app;
}
