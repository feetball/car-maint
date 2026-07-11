# CarMaint 🔧

An elegant, self-hosted vehicle maintenance tracker. Log oil changes, tire rotations, repairs, and every other service across multiple vehicles — with photos, smart service reminders, cost analytics, and CSV export.

## Features

- **Multi-vehicle garage** — track any number of vehicles (make, model, year, VIN, plate, color, mileage, notes)
- **Service log** — 17 service types (oil change, tire rotation, brakes, battery, …) with date, mileage, cost, shop, and notes; timeline view with type filtering
- **Photo gallery** — drag-and-drop photo uploads per vehicle, primary-photo selection, lightbox viewer
- **Smart reminders** — recurring intervals by months and/or miles; status computed from your latest matching service (`ok` → `due soon` → `overdue`), surfaced on a cross-vehicle dashboard
- **Cost analytics** — total spend, cost by service type, cost by year
- **History export** — per-vehicle CSV, all-vehicle CSV, or a complete JSON data export
- **Backup & restore** — one-click full backup (SQLite snapshot + all photos in a zip); on iPhone/iPad the share sheet saves it straight to **iCloud Drive** (Files app) or the **Google Drive** app; restore any backup from the Backup page
- **Automatic backups** — a daily backup zip lands in `./backups` on the host; point a cloud-sync client (iCloud Drive folder, Google Drive for desktop) at it for hands-off offsite backup
- **Mileage auto-tracking** — logging a service with a higher odometer reading updates the vehicle automatically
- **iOS web app** — Add to Home Screen for a full-screen, app-like experience with proper safe-area and touch support
- Dark, premium UI; fully responsive; zero external runtime dependencies (no CDNs, no trackers)

## Quick start

Requires Docker with Compose.

```sh
docker compose up -d --build
```

Open **http://localhost:3000**.

Data (SQLite database + photos) lives on a named Docker volume (`carmaint-data`) — bind-mounting SQLite's WAL files through Docker Desktop is unreliable, so the database stays on a proper Linux filesystem. Getting data out is what the **Backup** page is for:

- **Backup page → Download backup (.zip)** — complete snapshot (database + photos)
- **`./backups/`** — automatic daily backup zips appear here on the host (sync this folder to iCloud/Google Drive for offsite copies); tune with `AUTO_BACKUP_HOURS` (default 24, `0` disables) and `AUTO_BACKUP_KEEP` (default 14)
- Raw access if you ever need it: `docker compose cp app:/app/data ./data-copy`

On a Linux host, make `./backups` writable by the container user: `chown 1000:1000 backups`.

## Running the test suite

```sh
docker compose --profile test run --rm server-test   # API test suite (Vitest + Supertest)
docker compose --profile test run --rm client-test   # frontend component/unit tests
```

## Architecture

| Piece | Tech |
|---|---|
| API server | Node 20, Express 4, better-sqlite3 (WAL), multer |
| Frontend | React 18 + Vite, plain CSS, inline SVG charts/icons |
| Storage | SQLite at `data/carmaint.db`, photos at `data/photos/` |
| Container | Single multi-stage image; server serves the built SPA |

- `server/` — REST API (`/api/*`), photo serving (`/photos/*`), SPA static hosting
- `client/` — React SPA
- `SPEC.md` — full API contract and schema

### Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/app/data` (in container) | SQLite + photos location |
| `STATIC_DIR` | `/app/public` (in container) | Built SPA to serve |

To change the host port, edit the `ports` mapping in `docker-compose.yml` (e.g. `"8080:3000"`).

## Development without Docker

```sh
cd server && npm install && npm start        # API on :3000
cd client && npm install && npm run dev      # Vite dev server on :5173, proxies /api + /photos
```
