# CLAUDE.md - POS Offline

## Communication
- Always respond in English only. The user's terminal does not support Arabic text.

## Project Overview

POS Offline is a multi-tenant Point-of-Sale system designed for offline-first operation with manual sync to a server. The UI is Arabic (RTL). It targets four deployment platforms: Docker (Python Flask server), Electron (Windows/Linux desktop), Capacitor (Android), and PWA (browser).

**App ID**: `com.pos.offline`
**Version**: 1.2.11
**Currency**: Kuwaiti Dinar (KD)

## Repositories

There are **two repositories** for this project:

| Repo | URL | Purpose |
|------|-----|---------|
| **Pos-Offline** (this repo) | `https://github.com/Artistkw3d/Pos-Offline.git` | Main/canonical — Electron + Flask + frontend. Has both Node.js Express server (`electron/server.js` + `routes/*.js`) and Python Flask server (`server.py`). JWT-based license enforcement. |
| **My-Pos** | `https://github.com/Artistkw3d/My-Pos.git` | Docker/server deployment — Flask-only. Modularized DB layer (`db_modules/`). Periodically synced from Pos-Offline. Date-based subscription enforcement. |

### Key Differences Between Repos

- **My-Pos** has a modularized DB layer: `db_modules/schema.py`, `db_modules/master.py`, `db_modules/migrate.py` (extracted from server.py for Docker volume mounts)
- **My-Pos** does NOT have `electron/`, `routes/`, or Node.js Express — it's Flask-only for Docker
- **Pos-Offline** (this repo) has JWT license tokens; **My-Pos** uses simple date-based expiry checks
- Both share the same `frontend/` code, SQLite schema, and REST API contract
- When syncing changes: `server.py` changes in Pos-Offline must be adapted to My-Pos's modular structure, and vice versa

## Architecture

```
                    ┌──────────────────────────┐
                    │     frontend/ (SPA)       │
                    │  Vanilla JS + HTML + CSS  │
                    └────────┬─────────────────┘
                             │ REST API (/api/*)
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
     server.py (Flask)  electron/server.js   routes/*.js
     Python 3.11        Node.js Express      (modular)
     Port 5000          Port 5050
              └──────────────┼──────────────────┘
                             ▼
                    SQLite3 Databases
                    database/pos.db (default)
                    database/master.db (multi-tenant)
                    database/tenants/<slug>.db
```

There are **two parallel server implementations**:
- `server.py` — Python Flask, used for Docker/web deployment (8,810 lines, canonical)
- `electron/server.js` + `routes/*.js` — Node.js Express, used inside Electron desktop app

Both implement the same REST API and share the same SQLite schema. When modifying API behavior, changes must be applied to **both** server implementations to stay in sync.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend (Docker/Web) | Python 3.11, Flask 3.0.0, Flask-CORS |
| Backend (Electron) | Node.js, Express 4.18.2, better-sqlite3 11.0.0 |
| Database | SQLite3 (33 tables, per-tenant isolation) |
| Frontend | Vanilla JavaScript (ES6+), HTML5, CSS3 (no framework) |
| Offline storage | IndexedDB (via `frontend/localdb.js`) |
| PWA | Service Worker (`frontend/sw.js`) |
| Desktop | Electron 28.0.0 |
| Mobile | Capacitor 5.7.0 (Android) |
| CI/CD | GitHub Actions |

## Directory Structure

```
/
├── server.py               # Flask REST API server (primary/canonical)
├── setup_database.py       # DB schema initialization script
├── requirements.txt        # Python deps: Flask, Flask-CORS, Werkzeug
├── package.json            # Node deps & Electron/Capacitor build scripts
├── Dockerfile              # Python 3.11 slim, port 5000
├── docker-compose.yml      # Single service with nginx-proxy network
├── capacitor.config.json   # Android/Capacitor config
├── routes.js               # Partial route conversion (reference file)
├── routes-converted.js     # Full route conversion (reference file)
│
├── frontend/               # All client-side code (SPA)
│   ├── index.html          # Main HTML (3,276 lines, RTL Arabic)
│   ├── app.js              # Main application logic (13,029 lines)
│   ├── style.css           # Styles with dark mode support (980 lines)
│   ├── localdb.js          # IndexedDB wrapper for offline caching
│   ├── sync-manager.js     # Server sync logic (upload/download)
│   ├── sw.js               # Service Worker (Network First strategy)
│   ├── manifest.json       # PWA manifest
│   ├── products-search.js  # Fast product/barcode search
│   ├── customers_fix.js    # Customer sync utilities
│   └── accounting.html     # Accounting reports sub-page
│
├── electron/               # Desktop app wrapper
│   ├── main.js             # Electron main process, window & menu
│   ├── preload.js          # contextBridge security layer
│   └── server.js           # Express server for Electron (1,383 lines)
│
├── routes/                 # Modular Express route handlers
│   ├── usersProductsInvoices.js
│   ├── adminDashboardXbrlShifts.js
│   ├── tablesCouponsBackups.js
│   └── stockTransfersSubscriptionsSync.js
│
├── database/               # SQLite databases (runtime, not committed)
│   └── pos.db              # Default database (committed as seed)
│
└── .github/workflows/
    ├── ci.yml              # CI: test Flask, lint frontend, build Docker
    └── release.yml         # Release: build Electron .exe, Docker image
```

## Development Commands

### Python / Flask server (Docker deployment)
```bash
pip install -r requirements.txt       # Install Python deps
python setup_database.py              # Initialize database schema
python server.py                      # Run Flask on port 5000
```

### Node.js / Electron (Desktop)
```bash
npm ci                                # Install Node deps (also triggers electron-rebuild)
npm start                             # Run the Express server standalone (port 5050)
npm run electron:dev                  # Run as Electron desktop app
npm run electron:build                # Build Windows .exe (NSIS installer)
npm run electron:build-linux          # Build Linux AppImage
```

### Capacitor / Android
```bash
npm run cap:sync                      # Sync web assets to Android project
npm run cap:open-android              # Open in Android Studio
npm run cap:build-android             # Build release APK
```

### Docker
```bash
docker build -t pos-offline .         # Build image
docker run -d -p 5000:5000 pos-offline  # Run container
docker compose up -d                  # Run with docker-compose (uses nginx-proxy)
```

## CI/CD Pipeline

**CI** (`.github/workflows/ci.yml`) runs on push to `main`, `master`, `claude/**` and on PRs:

1. **test-server** — Installs Python 3.11, initializes DB, tests Flask endpoints:
   - `GET /` (index page)
   - `GET /api/settings`
   - `GET /api/sync/status`
   - `GET /api/sync/download?branch_id=1`
   - `GET /api/sync/full-download?branch_id=1`
   - `POST /api/sync/upload` (empty invoices/customers)
   - `GET /api/products`
   - `GET /api/version`
2. **lint-frontend** — Checks HTML structure, JS syntax (`node --check`), JSON validity, required files
3. **build-docker** — Builds Docker image, starts container, health-checks `/api/version` and `/api/sync/status`
4. **validate-electron** — Validates Electron config (main entry exists)
5. **validate-capacitor** — Validates Capacitor config (appId, webDir)

**Release** (`.github/workflows/release.yml`) triggers on `v*` tags:
- Builds Windows .exe via electron-builder
- Builds Docker image tagged with git tag
- Creates GitHub Release with artifacts

## Key Conventions

### Multi-Tenancy
- Tenant isolation via `X-Tenant-ID` HTTP header on all `/api/*` requests
- Each tenant gets a separate SQLite database at `database/tenants/<slug>.db`
- `database/master.db` stores tenant metadata and super admin accounts
- `database/pos.db` is the default (non-tenant) database
- The frontend monkey-patches `window.fetch` to inject `X-Tenant-ID` automatically

### API Pattern
All API routes follow this pattern:
- Base path: `/api/<resource>`
- Methods: standard REST (GET list, GET by id, POST create, PUT update, DELETE)
- Response format: `{ "success": true/false, "data": ..., "error": "..." }`
- Error messages are in Arabic
- Authentication is session-based with `currentUser` on the frontend

### Database Schema Migrations
- Schema changes use `ALTER TABLE ... ADD COLUMN` wrapped in try/except (Python) or try/catch (JS)
- Both `server.py` and `electron/server.js` contain inline `ensureDbTables()` / migration logic
- `setup_database.py` is the canonical schema definition for fresh installs
- New columns should default to safe values (usually `0` or `''`)

### Frontend Conventions
- Single-page app in vanilla JS — no build step, no bundler, no framework
- All UI logic is in `frontend/app.js` (monolithic, 13k+ lines)
- XSS protection via `escHTML()` helper — use it for all user-provided text in HTML
- RTL Arabic interface — all user-facing strings are Arabic
- Connection detection uses real HTTP ping, not `navigator.onLine`
- Global state variables at top of `app.js`: `currentUser`, `cart`, `allProducts`, `allInvoices`, etc.

### Offline-First Design
- `frontend/localdb.js` wraps IndexedDB with 5 object stores
- `frontend/sync-manager.js` handles upload/download sync with server
- `frontend/sw.js` uses Network First caching strategy
- When offline, the app operates from IndexedDB cache
- Sync happens automatically when connection is restored

### Security Notes
- Passwords are hashed with SHA-256 (see `hash_password()` in both servers)
- Default super admin: username `superadmin`, password `admin123` — change in production
- `electron/preload.js` uses `contextBridge` for secure IPC
- `escHTML()` is used for XSS prevention in the frontend
- Tenant slugs are sanitized: `slug.replace(/[^a-zA-Z0-9_-]/g, '')`

### Code Style
- Python: standard Flask patterns, Arabic comments, snake_case
- JavaScript (Node): CommonJS `require()`, camelCase, `module.exports = function(app, helpers)`
- JavaScript (Frontend): ES6+ globals, no modules, no build toolchain
- Comments and UI strings are primarily in Arabic
- Route modules in `routes/` export a single function that takes `(app, helpers)`

## Database Tables (33 total)

**Core**: users, branches, products, inventory, product_variants, branch_stock, categories, settings
**Sales**: invoices, invoice_items, customers, returns, coupons
**Financial**: expenses, salary_details, damaged_items, damaged_stock
**Operations**: system_logs, attendance_log, suppliers, supplier_invoices, shifts
**Restaurant**: restaurant_tables
**Advanced**: invoice_edit_history, xbrl_company_info, xbrl_reports, stock_transfers, stock_transfer_items
**Subscriptions**: subscription_plans, customer_subscriptions, subscription_plan_items, subscription_redemptions
**Multi-Tenant** (master.db): tenants, super_admins, subscription_invoices

## Testing

There is no dedicated test suite. The CI pipeline tests the Flask server by importing the app and making HTTP requests via Flask's test client. To run locally:

```bash
python setup_database.py
python -c "
from server import app
client = app.test_client()
r = client.get('/api/version')
assert r.status_code == 200
print('OK')
"
```

Frontend JS files are validated with `node --check` for syntax only.

## Cross-Repo & Cross-Platform Sync Policy

**CRITICAL: On every change, you MUST ask the user:**

> "This change affects [describe scope]. Should I also apply it to:"
> 1. **My-Pos repo** (Docker/server deployment at `C:\Users\em6er\Desktop\My-Pos`)?
> 2. **Electron/Windows desktop app** (electron/server.js + routes/*.js)?
> 3. **Android/Capacitor app** (rebuild APK)?

The two repos (Pos-Offline and My-Pos) share the same frontend, SQLite schema, and REST API contract but have different backend structures. Changes must be adapted when syncing:
- `server.py` in Pos-Offline → must be adapted to My-Pos's modular `db_modules/` structure
- `frontend/` changes → must be copied to My-Pos's `frontend/` as-is
- `setup_database.py` schema changes → must be applied to both repos
- My-Pos does NOT have `electron/`, `routes/`, or Node.js — skip those for My-Pos

### Platform build checklist
After applying changes, remind the user if any platform needs rebuilding:
- **Docker**: `docker build` in My-Pos repo
- **Electron (.exe)**: `npm run electron:build` in Pos-Offline repo
- **Android (.apk)**: `npx cap sync android && gradlew assembleDebug` in Pos-Offline repo
- **PWA**: Update `frontend/sw.js` version if caching changed

## Important Files to Change Together

When modifying the API:
1. `server.py` — Flask routes (canonical)
2. `electron/server.js` or `routes/*.js` — Express routes (must stay in sync)
3. `frontend/app.js` — Frontend API calls
4. **My-Pos repo**: `server.py` + `db_modules/` (adapted to modular structure)

When modifying the database schema:
1. `setup_database.py` — Fresh install schema
2. `server.py` `init_default_db()` — Flask runtime schema init + migration
3. `electron/server.js` `ensureDbTables()` — Electron runtime schema init + migration
4. **My-Pos repo**: `db_modules/schema.py` + `db_modules/migrate.py`

When modifying the frontend:
1. `frontend/app.js` — Main logic
2. `frontend/index.html` — HTML structure and modals
3. `frontend/style.css` — Styling
4. `frontend/sw.js` — Update service worker version if caching changes
5. **My-Pos repo**: Copy the same `frontend/` changes
