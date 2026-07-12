import { createApp } from '../server/src/app.js';

// Vercel serverless entrypoint. Persistent state lives in Turso (DB_DRIVER=libsql)
// and Vercel Blob (BLOB_READ_WRITE_TOKEN); /tmp is only multer/backup scratch space.
const app = createApp({ dataDir: process.env.DATA_DIR || '/tmp/carmaint' });

export default app;
