import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import { createDb, MIGRATIONS, SCHEMA_SQL, SCHEMA_STATEMENTS } from '../db.js';

// Async data facade. app.js constructs this synchronously (createApp stays sync),
// but every method is async and awaits a `ready` promise first, so schema init can
// run asynchronously (required by the libsql driver, whose execute() is async) while
// callers uniformly `await db.all(...)` / `db.run(...)` / `db.tx(...)`.
//
// Two drivers present the SAME async surface:
//   - 'sqlite': wraps the synchronous better-sqlite3 handle from createDb().
//   - 'libsql': wraps @libsql/client (Turso in prod; a local file: db otherwise).
//
// Return-shape contract callers rely on (see routes/*, backup.js, reminderStatus.js):
//   all(sql, params)  -> plain object rows (array; [] when none)
//   get(sql, params)  -> a single plain object row, or `undefined` when no row
//   run(sql, params)  -> { lastInsertRowid: Number, changes: Number }
//   tx(fn)            -> resolves to fn's return value; fn receives a { run, get, all }
//                        handle whose methods share the transaction. On any throw the
//                        transaction is rolled back and the error re-thrown.
//   snapshot(dest)    -> writes a standalone carmaint.db to `dest` (for backup zips)
//   close()           -> releases the underlying handle/connection
//
// libsql integer normalization: @libsql/client returns lastInsertRowid as a BigInt
// and could return BigInt column values; every int is coerced to a JS Number so both
// drivers hand callers identical shapes (e.g. info.lastInsertRowid usable directly as
// a bind param, `row.n` a plain number). Missing rows are normalized to `undefined`
// to match better-sqlite3's get().

// Tables copied when building a snapshot from the libsql driver. Order is
// parent-before-child; foreign keys are not enforced on the fresh snapshot db so
// order only needs to be stable. `users` is included so a global (cron) snapshot
// captures accounts (the sqlite driver's native db.backup() already copies them).
const SNAPSHOT_TABLES = ['users', 'vehicles', 'photos', 'records', 'reminders', 'recalls_cache'];

// Callers pass bind params as an array (or omit them). Normalize to an array and
// coerce `undefined` (which better-sqlite3 rejects and libsql disallows) to null.
function normalizeArgs(params) {
  if (params == null) return [];
  const arr = Array.isArray(params) ? params : [params];
  return arr.map((v) => (v === undefined ? null : v));
}

export function createDataFacade({ driver, dataDir, url, authToken } = {}) {
  if (driver === 'libsql') return createLibsqlFacade({ url, authToken });
  return createSqliteFacade({ dataDir });
}

// --- sqlite (better-sqlite3) ------------------------------------------------
function createSqliteFacade({ dataDir }) {
  let db;
  // Deferred behind `ready` so a failure to open the file surfaces per-request
  // (as a 500) instead of throwing synchronously out of createApp.
  const ready = (async () => {
    db = createDb(dataDir);
  })();
  // Mark a pre-request init failure as handled so it can't fire unhandledRejection
  // and kill the process; awaiters still receive the rejection per-request.
  ready.catch(() => {});

  const bigToNum = (v) => (typeof v === 'bigint' ? Number(v) : v);

  const all = async (sql, params) => {
    await ready;
    return db.prepare(sql).all(...normalizeArgs(params));
  };
  const get = async (sql, params) => {
    await ready;
    return db.prepare(sql).get(...normalizeArgs(params));
  };
  const run = async (sql, params) => {
    await ready;
    const info = db.prepare(sql).run(...normalizeArgs(params));
    return { lastInsertRowid: bigToNum(info.lastInsertRowid), changes: info.changes };
  };

  // better-sqlite3 is fully synchronous, so a manual BEGIN/COMMIT is safe here: the
  // async callback only awaits these already-resolved facade methods (never real
  // I/O), and JS drains all microtasks before the event loop runs another request's
  // I/O callback — so no other request can interleave a query mid-transaction.
  const tx = async (fn) => {
    await ready;
    const handle = {
      run: async (sql, params) => {
        const info = db.prepare(sql).run(...normalizeArgs(params));
        return { lastInsertRowid: bigToNum(info.lastInsertRowid), changes: info.changes };
      },
      get: async (sql, params) => db.prepare(sql).get(...normalizeArgs(params)),
      all: async (sql, params) => db.prepare(sql).all(...normalizeArgs(params)),
    };
    db.exec('BEGIN');
    try {
      const result = await fn(handle);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* best-effort: leave the original error to propagate */
      }
      throw err;
    }
  };

  // Native SQLite online backup → a consistent standalone carmaint.db (handles WAL).
  const snapshot = async (destPath) => {
    await ready;
    await db.backup(destPath);
  };

  const close = async () => {
    await ready;
    db.close();
  };

  return { all, get, run, tx, snapshot, close, ready };
}

// --- libsql (@libsql/client) ------------------------------------------------
function createLibsqlFacade({ url, authToken }) {
  // A local `file:` libsql db can't be opened if its parent directory is missing
  // (SQLITE_CANTOPEN). The sqlite driver's createDb() creates its dir; mirror that
  // here for the file: fallback so a cold start with no Turso url still boots.
  // Remote urls (libsql://, https://) are left untouched.
  if (typeof url === 'string' && url.startsWith('file:')) {
    const filePath = url.slice('file:'.length).split('?')[0].replace(/^\/\//, '/');
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      /* let createClient surface the real open error */
    }
  }
  const client = createClient({ url, authToken });
  // libsql runs one statement per execute(), so init the schema statement-by-statement,
  // then apply the idempotent column migrations (equivalent to db.js runMigrations,
  // but async): PRAGMA table_info per table, ALTER only when the column is missing.
  const columnNames = async (table) => {
    const rs = await client.execute(`PRAGMA table_info(${table})`);
    const nameIdx = rs.columns.indexOf('name');
    return rs.rows.map((r) => r[nameIdx]);
  };
  const ready = (async () => {
    for (const stmt of SCHEMA_STATEMENTS) await client.execute(stmt);
    for (const m of MIGRATIONS) {
      if ((await columnNames(m.table)).includes(m.column)) continue;
      // Concurrency-safe: two cold-start instances can both see the column missing
      // and both ALTER; the loser gets "duplicate column name". Swallow that ONLY
      // after re-confirming the column now exists — `ready` must not reject for a
      // benign lost race (which would 500 every request for this instance's life).
      try {
        await client.execute(m.sql);
      } catch (err) {
        if (!/duplicate column name/i.test(err?.message || '')) throw err;
        if (!(await columnNames(m.table)).includes(m.column)) throw err;
      }
    }
  })();
  // Mark a pre-request init failure (e.g. Turso auth/network) as handled so it can't
  // fire unhandledRejection and kill the process; awaiters still get the rejection.
  ready.catch(() => {});

  const rowToObject = (row, columns) => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) {
      const v = row[i];
      obj[columns[i]] = typeof v === 'bigint' ? Number(v) : v;
    }
    return obj;
  };

  const exec = (sql, params) => client.execute({ sql, args: normalizeArgs(params) });

  const all = async (sql, params) => {
    await ready;
    const rs = await exec(sql, params);
    return rs.rows.map((r) => rowToObject(r, rs.columns));
  };
  const get = async (sql, params) => {
    await ready;
    const rs = await exec(sql, params);
    return rs.rows.length ? rowToObject(rs.rows[0], rs.columns) : undefined;
  };
  const toRunResult = (rs) => ({
    lastInsertRowid: rs.lastInsertRowid == null ? undefined : Number(rs.lastInsertRowid),
    changes: Number(rs.rowsAffected),
  });
  const run = async (sql, params) => {
    await ready;
    return toRunResult(await exec(sql, params));
  };

  // Interactive write transaction: proper isolation across awaited I/O.
  const tx = async (fn) => {
    await ready;
    const t = await client.transaction('write');
    const texec = (sql, params) => t.execute({ sql, args: normalizeArgs(params) });
    const handle = {
      run: async (sql, params) => toRunResult(await texec(sql, params)),
      get: async (sql, params) => {
        const rs = await texec(sql, params);
        return rs.rows.length ? rowToObject(rs.rows[0], rs.columns) : undefined;
      },
      all: async (sql, params) => {
        const rs = await texec(sql, params);
        return rs.rows.map((r) => rowToObject(r, rs.columns));
      },
    };
    try {
      const result = await fn(handle);
      await t.commit();
      return result;
    } catch (err) {
      try {
        await t.rollback();
      } catch {
        /* best-effort */
      }
      throw err;
    }
  };

  // Snapshot: materialize a standalone better-sqlite3 carmaint.db from the current
  // libsql contents (the backup zip's "copied better-sqlite3 file" path). Works for
  // both a local file: db and a remote Turso db (rows are pulled over the client).
  const snapshot = async (destPath) => {
    await ready;
    const out = new Database(destPath);
    try {
      out.exec(SCHEMA_SQL); // rollback-journal (default) → all data lands in one file
      for (const table of SNAPSHOT_TABLES) {
        const rs = await client.execute(`SELECT * FROM ${table}`);
        if (rs.rows.length === 0) continue;
        const cols = rs.columns;
        const insert = out.prepare(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        );
        const writeAll = out.transaction((rows) => {
          for (const row of rows) {
            insert.run(...cols.map((_, i) => (typeof row[i] === 'bigint' ? Number(row[i]) : row[i])));
          }
        });
        writeAll(rs.rows);
      }
    } finally {
      out.close();
    }
  };

  const close = async () => {
    await ready;
    client.close();
  };

  return { all, get, run, tx, snapshot, close, ready };
}
