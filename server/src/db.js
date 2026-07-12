import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// One CREATE TABLE per statement. Kept as an array so both drivers can init the
// same schema: better-sqlite3 runs them joined via exec(), libsql runs each one
// individually (its execute() takes a single statement). Same SQL dialect for both.
//
// users/sessions come first so the vehicles.user_id → users(id) reference resolves
// on a fresh database (SQLite tolerates a forward reference, but ordering keeps it
// clean). vehicles carries user_id here for FRESH databases; an EXISTING production
// database (whose vehicles predate accounts) gets the column added by the
// idempotent migration in MIGRATIONS below, since CREATE TABLE IF NOT EXISTS is a
// no-op once the table exists and never adds columns.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  calendar_token TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  name TEXT,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  vin TEXT,
  license_plate TEXT,
  color TEXT,
  current_mileage INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT,
  date TEXT NOT NULL,
  mileage INTEGER,
  cost REAL,
  shop TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT,
  interval_months INTEGER,
  interval_miles INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  // V3: NHTSA recalls response cache. Populated by the recalls route (added by a
  // later agent); present here so both drivers' schema init and backup snapshots
  // include it. Keyed by vehicle; one cached payload + fetch timestamp per vehicle.
  `CREATE TABLE IF NOT EXISTS recalls_cache (
  vehicle_id INTEGER PRIMARY KEY,
  fetched_at TEXT,
  payload TEXT
)`,
];

export const SCHEMA_SQL = SCHEMA_STATEMENTS.join(';\n') + ';';

// Idempotent column additions applied AFTER the CREATE TABLE statements, for
// databases that predate a column (production data created before accounts).
// Each entry is guarded by a PRAGMA table_info existence check, so re-running is a
// no-op on an already-migrated database. ALTER TABLE ADD COLUMN can legally add a
// nullable column with a REFERENCES clause, so both drivers run the exact same SQL.
export const MIGRATIONS = [
  {
    table: 'vehicles',
    column: 'user_id',
    sql: 'ALTER TABLE vehicles ADD COLUMN user_id INTEGER REFERENCES users(id)',
  },
  {
    // Multi-user admin: existing production DBs (users created before roles) get the
    // column added here. NOT NULL DEFAULT 0 is a legal ADD COLUMN in SQLite/libsql
    // because the default is a constant, so every driver runs the same SQL.
    table: 'users',
    column: 'is_admin',
    sql: 'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
  },
];

// Data migrations applied AFTER the column MIGRATIONS above (they may reference the
// just-added columns). Each statement MUST be idempotent and concurrency-safe on its
// own, because two cold-start instances can run them simultaneously.
//
// Admin bootstrap for EXISTING databases: promote the earliest account (lowest id) to
// admin, but ONLY when no admin exists yet. The single atomic UPDATE encodes both the
// "no admin yet" guard (NOT EXISTS) and the target selection (MIN(id)), so it is:
//   - idempotent: once any admin exists the NOT EXISTS predicate is false → no-op, so
//     re-running never clobbers an already-chosen admin;
//   - concurrency-safe: the statement is atomic; racing instances converge on the same
//     lowest-id row;
//   - safe on a FRESH db: MIN(id) over an empty users table is NULL, matching no row
//     (fresh databases instead get their admin from the register path — first user).
export const POST_MIGRATIONS = [
  `UPDATE users SET is_admin = 1
     WHERE id = (SELECT MIN(id) FROM users)
       AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`,
];

// Runs the idempotent MIGRATIONS against a synchronous better-sqlite3 handle. The
// libsql driver runs the equivalent via PRAGMA table_info in facade.js (its
// execute() is async), sharing this same MIGRATIONS list.
export function runMigrations(db) {
  const columnNames = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const m of MIGRATIONS) {
    if (columnNames(m.table).includes(m.column)) continue;
    // Idempotent even if the column was added concurrently (single-process here, so
    // lower risk than the libsql path, but kept consistent): swallow a benign
    // "duplicate column name" only after re-confirming the column now exists.
    try {
      db.exec(m.sql);
    } catch (err) {
      if (!/duplicate column name/i.test(err?.message || '')) throw err;
      if (!columnNames(m.table).includes(m.column)) throw err;
    }
  }
  // Data migrations run once the columns they touch are guaranteed present.
  for (const sql of POST_MIGRATIONS) db.exec(sql);
}

// Opens/creates <dataDir>/carmaint.db as a better-sqlite3 instance with WAL and
// foreign keys on, creates the schema, applies idempotent migrations, and ensures
// <dataDir>/photos exists. This remains the sqlite driver's internal handle and is
// also used to build snapshot .db files (backup) and read extracted .db files
// (restore).
export function createDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  const db = new Database(path.join(dataDir, 'carmaint.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}
