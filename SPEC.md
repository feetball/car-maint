# CarMaint — Vehicle Maintenance Tracker: Build Spec

Single source of truth for all components. If code and spec disagree, the spec wins.

## Stack & layout

- `server/` — Node 20, Express 4, better-sqlite3, multer. **ES modules** (`"type": "module"`).
- `client/` — React 18 + Vite 5, plain CSS (no UI framework), react-router-dom v6.
- `server/test/` — Vitest + Supertest.
- Root: `Dockerfile` (multi-stage), `docker-compose.yml`, `README.md` (owned by orchestrator — do NOT create these in subagents).
- **No host Node available.** Never run `npm install` / `npm test` locally; just write files. No `package-lock.json` (Docker uses `npm install`).
- Keep dependencies minimal: server runtime deps = `express`, `better-sqlite3`, `multer` ONLY. Use `crypto.randomUUID()` for IDs of files; hand-roll CSV escaping.

## Server architecture (contract — tests depend on this)

- `server/src/db.js` — named export `createDb(dataDir)`: opens/creates `<dataDir>/carmaint.db`, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, creates tables if absent, returns the better-sqlite3 db instance. Also ensures `<dataDir>/photos/` exists.
- `server/src/app.js` — named export `createApp({ dataDir })`: returns a configured Express app (does NOT listen). Uses `createDb(dataDir)`. Serves photos statically at `/photos` from `<dataDir>/photos`. If env `STATIC_DIR` is set and exists, serve it statically at `/` with SPA fallback (GET non-/api routes → index.html).
- `server/src/index.js` — entrypoint: `createApp({ dataDir: process.env.DATA_DIR || './data' })`, listens on `process.env.PORT || 3000`.
- Route modules under `server/src/routes/` as the backend agent sees fit.
- All error responses: JSON `{ "error": "<message>" }` with status 400 (validation), 404 (not found), 500.
- JSON body limit 1mb. Multipart only on the photo route.

## Database schema (SQLite)

```sql
vehicles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,                        -- optional nickname
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  vin TEXT, license_plate TEXT, color TEXT,
  current_mileage INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
photos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,           -- generated: <uuid>.<ext>
  original_name TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
)
records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  mileage INTEGER,
  cost REAL,
  shop TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
reminders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT,
  interval_months INTEGER,          -- at least one of the two intervals required
  interval_miles INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

## Service types

`GET /api/service-types` → `[{ "value": "...", "label": "..." }]` in this exact order:

| value | label |
|---|---|
| oil_change | Oil Change |
| tire_rotation | Tire Rotation |
| new_tires | New Tires |
| brake_service | Brake Service |
| battery | Battery |
| air_filter | Engine Air Filter |
| cabin_filter | Cabin Air Filter |
| spark_plugs | Spark Plugs |
| coolant_flush | Coolant Flush |
| transmission | Transmission Service |
| alignment | Wheel Alignment |
| wiper_blades | Wiper Blades |
| inspection | Inspection |
| registration | Registration |
| detailing | Detailing |
| repair | Repair |
| other | Other |

Record/reminder `type` must be one of these values → else 400.

## API contract

### Vehicles
- `GET /api/vehicles` → 200, array sorted by created_at DESC. Each item: all vehicle columns **plus** `primary_photo` (filename or null — the is_primary photo, else oldest photo, else null), `photo_count`, `record_count`, `total_cost` (sum of record costs, 0 if none), `last_service_date` (max record date or null), `alert_count` (reminders with status overdue or due_soon).
- `POST /api/vehicles` — body requires `make` (non-empty string), `model` (non-empty string), `year` (integer 1900–2100). Optional: name, vin, license_plate, color, current_mileage (int ≥ 0), notes. → 201 with full vehicle row. Missing/invalid → 400.
- `GET /api/vehicles/:id` → 200 vehicle row plus `photos` (array of photo rows, primary first then uploaded_at ASC). Unknown id → 404.
- `PUT /api/vehicles/:id` — partial update of any POST-able field, same validation. → 200 updated row.
- `DELETE /api/vehicles/:id` → 204. Cascades DB rows AND deletes photo files from disk.

### Photos
- `POST /api/vehicles/:id/photos` — multipart/form-data, field name `photos`, 1–10 files, accept mimetypes image/jpeg|png|webp|gif, max 10 MB each. Stored as `<dataDir>/photos/<randomUUID>.<ext>`. First-ever photo for the vehicle gets `is_primary=1`. → 201, array of created photo rows. Bad mimetype → 400. Unknown vehicle → 404.
- `PUT /api/photos/:id/primary` → 200 photo row; clears is_primary on siblings.
- `DELETE /api/photos/:id` → 204; deletes file; if it was primary, oldest remaining photo (if any) becomes primary.
- Files served at `GET /photos/<filename>`.

### Records
- `GET /api/vehicles/:id/records` → 200 array, sorted date DESC then id DESC. Optional `?type=` filter.
- `POST /api/vehicles/:id/records` — requires `type` (valid service type), `date` (`YYYY-MM-DD` string). Optional: description, mileage (int ≥ 0), cost (number ≥ 0), shop, notes. → 201 row. **Side effect:** if mileage > vehicle.current_mileage, vehicle.current_mileage is updated to it.
- `PUT /api/records/:id` — partial update, same validation, same mileage side effect. → 200.
- `DELETE /api/records/:id` → 204.

### Reminders
- `POST /api/vehicles/:id/reminders` — requires `type` (valid service type) and at least one of `interval_months` (int ≥ 1) / `interval_miles` (int ≥ 1). Optional `description`. → 201.
- `PUT /api/reminders/:id`, `DELETE /api/reminders/:id` — standard.
- `GET /api/vehicles/:id/reminders` → 200 array; each row augmented with computed fields:
  - `last_date`, `last_mileage`: from the latest record (max date, then max id) of the same `type` for that vehicle; null if none.
  - `next_due_date` = last_date + interval_months (null if no interval_months or no last_date).
  - `next_due_mileage` = last_mileage + interval_miles (null likewise; if there IS history but the record has null mileage, null).
  - `status`:
    - `no_history` if no matching record exists.
    - `overdue` if next_due_date < today OR next_due_mileage < vehicle.current_mileage.
    - `due_soon` if next_due_date within 30 days from today OR next_due_mileage within 500 miles of current_mileage.
    - else `ok`.
- `GET /api/reminders/due` → 200 array of all reminders across vehicles with status overdue/due_soon (computed as above), each including `vehicle_id`, `vehicle_name` (vehicle.name, falling back to `"<year> <make> <model>"`), sorted overdue first.

### Export & backup (v2 addition)

- `GET /api/export.csv` — ALL vehicles' records. Header `vehicle,date,type,mileage,cost,shop,description,notes` (`vehicle` = vehicle.name fallback `"<year> <make> <model>"`), rows date ASC then id ASC. text/csv, attachment.
- `GET /api/export.json` — `{ app: "carmaint", version: 1, exported_at: <ISO>, vehicles: [<vehicle row> & { records: [...date ASC], reminders: [...], photos: [{filename, original_name, is_primary}] }] }`. attachment.
- `GET /api/backup` — application/zip, attachment `carmaint-backup-<YYYY-MM-DD>.zip` containing:
  - `manifest.json` — `{ app: "carmaint", version: 1, exported_at, counts: { vehicles, records, reminders, photos } }`
  - `carmaint.db` — **consistent snapshot** via better-sqlite3 `db.backup()` (WAL-safe), not a raw copy of the live file
  - `photos/<filename>` for each photo file on disk
- `POST /api/restore` — multipart field `backup`, single .zip, limit 500 MB. Validation BEFORE touching live data: zip parses, manifest.json has app "carmaint" + version 1, contains carmaint.db, extracted db opens and has the four tables → else 400 `{error}` with live data untouched. On success: swap in new db + photos directory, → 200 `{ restored: true, counts }`. Zip entry names must be sanitized (reject `..`/absolute; only extract carmaint.db and flat basenames under photos/).
- **DB handle swap architecture**: all route access to the db must go through a live getter (e.g. `ctx.db()`), so restore can close, replace, and reopen the database without stale closures. better-sqlite3 is synchronous, so no in-flight query races within the single process.
- **Auto-backup**: `createBackupZip(db, dataDir, destPath)` exported from the backup module (unit-testable). `src/index.js` (not app.js — keeps tests timer-free): if env `AUTO_BACKUP_HOURS` != "0" (default 24), setInterval writes `<dataDir>/backups/carmaint-backup-<timestamp>.zip` and prunes to the newest `AUTO_BACKUP_KEEP` (default 14). `/api/backups` GET lists them `[{filename, size, created_at}]`; `GET /api/backups/<filename>` downloads one (basename-sanitized).
- New server deps permitted for this: `yazl` (zip write) + `yauzl` (zip read) — nothing else.

### Stats, dashboard, export
- `GET /api/vehicles/:id/stats` → `{ total_cost, record_count, cost_by_type: [{type, label, total, count}] (total DESC), cost_by_year: [{year, total}] (year ASC) }`. Costs are numbers; null costs count as 0.
- `GET /api/dashboard` → `{ vehicle_count, record_count, total_cost, due_reminders: <same as /api/reminders/due>, recent_records: [last 10 records across vehicles, date DESC then id DESC, each with vehicle_name as above] }`.
- `GET /api/vehicles/:id/export.csv` → 200, `text/csv`, header row `date,type,mileage,cost,shop,description,notes`, rows date ASC. Proper CSV quoting (fields containing `"` `,` or newline get quoted, `"` doubled). `Content-Disposition: attachment`.

## V3: Vercel support, auth, VIN/recalls, calendar & notifications

### Data layer (dual driver)

All route DB access goes through an async facade created per app: `db.all(sql, params)`, `db.get(sql, params)`, `db.run(sql, params)` → `{ lastInsertRowid: number, changes: number }`, and `db.tx(async (t) => {...})` where `t` has the same methods and runs atomically.

- Driver `sqlite` (default): wraps better-sqlite3 (resolve-immediately promises). `tx` = manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` (safe: microtask-only awaits never yield to other requests).
- Driver `libsql`: `@libsql/client` (`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, or any `file:`/`http(s):` URL). `tx` = interactive `client.transaction("write")`. Normalize bigint `lastInsertRowid` to Number. Same SQL dialect — do not fork SQL strings.
- Selection: `createApp({ dataDir, dbDriver, dbUrl })`, defaulting from env `DB_DRIVER` (`sqlite`|`libsql`), `TURSO_DATABASE_URL`.
- Tests run the full suite under BOTH drivers (libsql via `file:` URL in the container).

### Photo storage (dual store)

`PhotoStore` interface: `put(filename, buffer, mimetype) → {url}`, `delete(filename)`, `read(filename) → buffer` (for backup bundling), `list()`.
- `disk` (default): current behavior, `<dataDir>/photos`, served at `/photos/<filename>`, url = `/photos/<filename>`.
- `blob`: `@vercel/blob` when `BLOB_READ_WRITE_TOKEN` is set; public access; url = absolute blob URL; photos stored under `photos/<filename>`.
- Every photo in API responses gains `url`; vehicle list `primary_photo` keeps the filename and adds `primary_photo_url`. The client must use `url`/`primary_photo_url` exclusively.

### Backup/restore v3 (driver-agnostic, atomic)

- Backup zip format unchanged (manifest.json + carmaint.db + photos/*). Snapshot construction: sqlite driver keeps native `db.backup()`; libsql driver builds a fresh better-sqlite3 file in tmp by copying all rows through the facade. In blob mode, photo bytes are fetched from the store.
- **Restore is now a data-level import, not a file swap**: validate the uploaded zip exactly as v2, open the extracted carmaint.db READ-ONLY via better-sqlite3, then inside ONE `db.tx`: delete all rows (children first), insert all rows preserving ids. Photo files: write all new files to the store first (UUID names can't collide), then run the tx, then best-effort delete orphaned old files. A failure before/inside the tx leaves live data fully intact (400/500 with {error}); no db handle swapping remains.
- Auto-backup zips: docker → `<dataDir>/backups` (unchanged); blob mode → blob `backups/` prefix; `GET /api/backups` lists from the active location; `GET /api/backups/:filename` streams/redirects.

### Auth (optional, required for public deploys)

Enabled iff env `APP_PASSWORD` is set. When enabled:
- `POST /api/login` `{password}` → constant-time compare → sets httpOnly signed cookie `carmaint_session` (HMAC-SHA256, key = sha256(APP_PASSWORD + AUTH_SECRET?), 30-day expiry embedded and verified). 401 `{error}` on wrong password. `POST /api/logout` clears. `GET /api/auth/status` → `{required, authenticated}` (always available unauthenticated).
- Everything else under `/api`, plus `/photos/*`, requires the cookie → else 401 `{error:"Authentication required"}`. Static SPA assets stay public.
- `/calendar.ics` uses `?token=<hex hmac of "calendar" with the same key>` instead of cookies; `GET /api/calendar-url` (authed) returns the tokened path.
- `/api/cron/*` accepts `Authorization: Bearer <CRON_SECRET>` (Vercel sends this automatically when the env var is set).
- Client: on `{required:true, authenticated:false}` (or any 401) show a full-screen login view; api helper retriggers it on 401s.

### VIN decode + recalls (NHTSA)

- `GET /api/vin/:vin` — VIN = 11–17 alphanumerics excluding I/O/Q else 400. Proxies vPIC `DecodeVinValues/<vin>?format=json` → 200 `{vin, year, make, model, trim, body_class, engine, plant}` (nulls for blanks). Upstream failure → 502 `{error}`.
- `GET /api/vehicles/:id/recalls` — proxies `recalls/recallsByVehicle?make=&model=&modelYear=` using the vehicle row → 200 `{fetched_at, recalls: [{campaign_number, component, summary, consequence, remedy, report_date}]}`. Cached in table `recalls_cache(vehicle_id INTEGER PRIMARY KEY, fetched_at TEXT, payload TEXT)`, TTL 24h, `?refresh=1` bypasses. Upstream failure with warm cache → serve cache; cold → 502.
- Base URLs from `createApp({ nhtsaVpicBase, nhtsaRecallsBase })` defaulting to env `NHTSA_VPIC_BASE`/`NHTSA_RECALLS_BASE` then the real endpoints — tests point these at a local stub; no test may hit the internet.
- Client: "Decode VIN" button in VehicleForm (fills year/make/model/trim→notes on success, inline error on failure); "Recalls" tab on vehicle detail (lazy fetch, count badge after load, refresh button, empty/error states).

### Calendar feed + notifications

- `GET /calendar.ics` — `text/calendar; charset=utf-8`. One all-day VEVENT per reminder with a computable `next_due_date`: `UID reminder-<id>@carmaint`, `DTSTART;VALUE=DATE`, `SUMMARY "<type label> due — <vehicle name>"`, `DESCRIPTION` incl. mileage due info, proper RFC 5545 escaping (`\\` `;` `,` newlines) and CRLF line endings. Registered before the SPA fallback; vite dev proxy includes it.
- `src/notify.js`: `collectDue(db)` → `{overdue, due_soon}` (reuse reminder status logic); `sendNotifications(cfg, due, fetchImpl)` posts to `NTFY_URL` (plain text, `Title` header) and/or `NOTIFY_WEBHOOK_URL` (JSON `{title, body, overdue, due_soon}`). No-op when nothing due.
- Docker: `index.js` timer `NOTIFY_CHECK_HOURS` (default 24, 0 disables, requires a target env). Vercel: `GET /api/cron/notify`. `GET /api/cron/backup` runs an auto-backup. Both cron routes require the CRON_SECRET bearer when set, always return `{ok, ...}` JSON.
- Client: "Calendar & notifications" section on the Backup page — shows the (tokened) calendar URL with copy button + Apple/Google subscribe hint, and documents NTFY_URL/NOTIFY_WEBHOOK_URL.

### Vercel packaging

- `api/index.js`: builds the Express app once (blob/libsql selected via env; `dataDir` = `/tmp/carmaint` for multer/backup scratch) and exports it as the default handler.
- Root `package.json`: server runtime deps (+ `@libsql/client`, `@vercel/blob`) so Vercel's tracer bundles them; api/index.js imports from `../server/src/app.js`.
- `vercel.json`: `buildCommand` builds the client, `outputDirectory client/dist`, rewrites `/api/(.*)`, `/photos/(.*)`, `/calendar.ics` → the function, SPA fallback otherwise; `crons`: daily `/api/cron/backup` and `/api/cron/notify`.
- README gains a "Deploy to Vercel" walkthrough: create Turso DB + Vercel Blob store, set env vars (`DB_DRIVER=libsql`, `TURSO_*`, `BLOB_READ_WRITE_TOKEN`, **`APP_PASSWORD` strongly recommended**, `CRON_SECRET`), deploy. Docker remains the primary, fully-offline path and its behavior must not change when the new env vars are absent.

### New/changed env summary

| Var | Default | Purpose |
|---|---|---|
| DB_DRIVER | sqlite | `sqlite` or `libsql` |
| TURSO_DATABASE_URL / TURSO_AUTH_TOKEN | — | libsql target |
| BLOB_READ_WRITE_TOKEN | — | enables Vercel Blob photo/backup store |
| APP_PASSWORD (+ optional AUTH_SECRET) | — | enables auth |
| CRON_SECRET | — | guards /api/cron/* |
| NHTSA_VPIC_BASE / NHTSA_RECALLS_BASE | real NHTSA | test stubbing |
| NOTIFY_CHECK_HOURS / NTFY_URL / NOTIFY_WEBHOOK_URL | 24 / — / — | notifications |
| RESTORE_MAX_BYTES | 2147483648 | zip-bomb ceiling |

## Frontend (client/)

Vite dev proxy: `/api`, `/photos` → `http://localhost:3000`. Production build served by the server (STATIC_DIR).

Design brief — **elegant, premium, garage-meets-showroom**:
- Dark theme default: near-black surfaces (#0d0f12 range), soft elevated cards, one warm accent (amber/gold ~#e8a33d) used sparingly for CTAs and highlights; status colors: red (overdue), amber (due soon), green (ok).
- Typography: system font stack with generous weight contrast; tabular numerals for mileage/cost.
- Layout: left sidebar nav (Dashboard, Vehicles) + content area; responsive down to mobile (sidebar collapses to top bar).
- Vehicle cards: photo hero (or elegant placeholder monogram if no photo), name, year/make/model, mileage, alert badge.
- Vehicle detail: hero header with primary photo backdrop, tab bar: **Service Log / Reminders / Photos / Stats**.
- Service log: timeline-style list with type icon, date, mileage, cost; add/edit via modal form.
- Photos tab: grid, drag-and-drop + click-to-browse upload, set-primary and delete on hover, lightbox on click.
- Reminders tab: cards with status pill and progress toward next due.
- Stats tab: cost-by-type horizontal bars and cost-by-year mini bar chart rendered with plain SVG (no chart lib).
- Dashboard: stat tiles (vehicles, total records, total spent), "Needs attention" reminder list, recent activity feed.
- Icons: inline SVG only (no icon package). Currency: USD formatting via `Intl.NumberFormat`. Dates via `Intl.DateTimeFormat`.
- Empty states with helpful copy. Loading skeletons or subtle spinners. Toast or inline error on failed API calls.
- CSV export button on vehicle detail (link to the endpoint).

### iOS mobile web app (required)

The app must be installable/usable as an iOS home-screen web app:

- `index.html` head: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`, `<meta name="apple-mobile-web-app-title" content="CarMaint">`, `<meta name="theme-color" content="#0d0f12">`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`, `<link rel="manifest" href="/manifest.webmanifest">`.
- `client/public/manifest.webmanifest`: name/short_name CarMaint, `display: "standalone"`, background_color/theme_color `#0d0f12`, icons: `/icon-192.png`, `/icon-512.png` (type image/png; the PNG files are generated by the orchestrator — reference them, don't create them) plus `/icon.svg` (create this: simple amber wrench-and-car mark on #0d0f12 rounded square — it is the master the PNGs are rendered from).
- Safe areas: pad fixed/sticky chrome with `env(safe-area-inset-*)` (notch + home indicator, incl. landscape). Use `100dvh` instead of `100vh`.
- Touch: all tap targets ≥ 44×44px; no hover-gated functionality — under `@media (hover: none)` photo actions and row actions must be visible/reachable without hover. `-webkit-tap-highlight-color: transparent` plus a visible :active state. `font-size: 16px` minimum on inputs (prevents iOS focus zoom). `-webkit-text-size-adjust: 100%`.
- Photo upload input: `accept="image/*"` (no `capture` attr, so iOS offers camera AND library); drag-and-drop remains for desktop but the tap-to-browse path is primary on touch.
- Standalone-mode navigation: the app is a SPA with react-router, so in-app links stay in the web-app context (no target=_blank for internal nav; CSV export link may use `download` attr).

Client tests (frontend agent writes): Vitest + @testing-library/react + jsdom, colocated in `client/src/**/*.test.jsx` — cover at least: currency/date/mileage formatting utils, reminder status pill rendering, vehicle form validation behavior, and API-mocked rendering of the vehicles list. `npm test` in client runs `vitest run`.

## Test suite (server/test/, Vitest + Supertest)

- Each test file creates a fresh temp dataDir (`fs.mkdtempSync` in `os.tmpdir()`), calls `createApp({ dataDir })`, and cleans up after.
- Coverage required: vehicle CRUD + validation (each required field, bad year, unknown id 404); photo upload (build a tiny PNG buffer in-test), mimetype rejection, primary promotion on delete, file actually on disk and removed on delete + vehicle cascade; record CRUD + validation + type filter + mileage side effect; reminder CRUD + every status branch (no_history, ok, due_soon by date, due_soon by mileage, overdue by date, overdue by mileage, month-only, miles-only); /api/reminders/due aggregation; stats math; dashboard shape; CSV export content + escaping; service-types endpoint.
- `server/package.json` scripts: `"start": "node src/index.js"`, `"test": "vitest run"`.

## Docker (orchestrator-owned)

- Multi-stage root Dockerfile: client build → server deps → `runtime` (node:20-slim, server + built client at STATIC_DIR=/app/public, DATA_DIR=/app/data, port 3000) + `server-test` and `client-test` stages.
- compose: `app` service on port 3000 with `./data` volume; `server-test`/`client-test` under `profiles: [test]`.
