import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// One CREATE TABLE per statement. Kept as an array so both drivers can init the
// same schema: better-sqlite3 runs them joined via exec(), libsql runs each one
// individually (its execute() takes a single statement). Same SQL dialect for both.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

// Opens/creates <dataDir>/carmaint.db as a better-sqlite3 instance with WAL and
// foreign keys on, creates the schema, and ensures <dataDir>/photos exists.
// This remains the sqlite driver's internal handle and is also used to build
// snapshot .db files (backup) and to read extracted .db files (restore).
export function createDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  const db = new Database(path.join(dataDir, 'carmaint.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}
