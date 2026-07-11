import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createDb } from './db.js';
import { HttpError } from './helpers.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { photosRouter } from './routes/photos.js';
import { recordsRouter } from './routes/records.js';
import { remindersRouter } from './routes/reminders.js';
import { miscRouter } from './routes/misc.js';
import { exportRouter } from './routes/export.js';
import { backupRouter } from './routes/backup.js';

export function createApp({ dataDir }) {
  const photosDir = path.join(dataDir, 'photos');

  // Live db context. Routes read `ctx.db` through this getter on every request
  // so restore can close, replace, and reopen the database without leaving any
  // route holding a stale handle or a prepared statement bound to the old db.
  const ctx = {
    dataDir,
    photosDir,
    _db: createDb(dataDir),
    get db() {
      return this._db;
    },
    set db(next) {
      this._db = next;
    },
  };

  const app = express();
  app.locals.ctx = ctx;

  app.use(express.json({ limit: '1mb' }));
  app.use('/photos', express.static(photosDir));

  app.use('/api', miscRouter(ctx));
  app.use('/api', exportRouter(ctx));
  app.use('/api', backupRouter(ctx));
  app.use('/api', vehiclesRouter(ctx));
  app.use('/api', photosRouter(ctx));
  app.use('/api', recordsRouter(ctx));
  app.use('/api', remindersRouter(ctx));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

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
