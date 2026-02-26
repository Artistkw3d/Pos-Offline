/**
 * Node.js Express server - POS Offline
 * Replaces the Python Flask server (server.py)
 * Multi-Tenancy with separate SQLite databases per tenant
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const multer = require('multer');
const { createAllTables, insertDefaultSettings, insertDefaultBranch } = require('../database/schema');
const { initMasterDb: initMasterDbModule } = require('../database/master');
const { migrateDatabase: migrateDatabaseModule } = require('../database/migrate');

// ===== Configuration =====
let DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'database');
let DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'pos.db');
let MASTER_DB_PATH = path.join(DB_DIR, 'master.db');
let TENANTS_DB_DIR = path.join(DB_DIR, 'tenants');
let BACKUPS_DIR = path.join(DB_DIR, 'backups');
let FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

let upload = null; // Initialized in startServer() after directories are created

// ===== Helper Functions =====

function hashPassword(password) {
  // PBKDF2 with random salt (secure)
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 260000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2:sha256:${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  // Old format: plain SHA-256 (64 hex chars)
  if (storedHash.length === 64 && /^[0-9a-f]{64}$/.test(storedHash)) {
    return crypto.createHash('sha256').update(password, 'utf8').digest('hex') === storedHash;
  }
  // New format: pbkdf2:sha256:iterations$salt$hash
  const match = storedHash.match(/^pbkdf2:sha256:(\d+)\$([^$]+)\$([0-9a-f]+)$/);
  if (match) {
    const [, iterations, salt, expectedHash] = match;
    const hash = crypto.pbkdf2Sync(password, salt, parseInt(iterations, 10), 32, 'sha256').toString('hex');
    return hash === expectedHash;
  }
  // Plaintext fallback (legacy)
  return storedHash === password;
}

function needsRehash(storedHash) {
  if (!storedHash) return false;
  return storedHash.length === 64 && /^[0-9a-f]{64}$/.test(storedHash);
}

function getTenantSlug(req) {
  return (req.headers['x-tenant-id'] || '').trim();
}

function getTenantDbPath(slug) {
  if (!slug) return DB_PATH;
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeSlug) return DB_PATH;
  return path.join(TENANTS_DB_DIR, `${safeSlug}.db`);
}

const _initializedDbs = new Set();

function ensureDbTables(dbPath) {
  if (_initializedDbs.has(dbPath)) return;
  const db = new Database(dbPath);
  createAllTables(db);
  insertDefaultSettings(db, true);
  insertDefaultBranch(db);
  db.close();
  _initializedDbs.add(dbPath);
}

function getDb(req) {
  const slug = getTenantSlug(req);
  const dbPath = getTenantDbPath(slug);
  ensureDbTables(dbPath);
  return new Database(dbPath);
}

function getMasterDb() {
  return new Database(MASTER_DB_PATH);
}

function getFlaskServerUrl() {
  try {
    const db = new Database(DB_PATH);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'flask_server_url'").get();
    db.close();
    return row ? row.value.replace(/\/+$/, '') : null;
  } catch (e) {
    return null;
  }
}

function logAction(db, actionType, description, userId, userName, branchId, targetId, details) {
  try {
    db.prepare(`
      INSERT INTO system_logs (action_type, description, user_id, user_name, branch_id, target_id, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(actionType, description, userId, userName, branchId, targetId, details);
  } catch (e) {
    console.error('[logAction]', e.message);
  }
}

function getBackupDir(reqOrSlug) {
  let tenantSlug;
  if (typeof reqOrSlug === 'string') {
    tenantSlug = reqOrSlug;
  } else if (reqOrSlug && reqOrSlug.headers) {
    tenantSlug = getTenantSlug(reqOrSlug);
  }
  let dir;
  if (tenantSlug) {
    const safeSlug = tenantSlug.replace(/[^a-zA-Z0-9_-]/g, '');
    dir = path.join(BACKUPS_DIR, safeSlug);
  } else {
    dir = path.join(BACKUPS_DIR, 'default');
  }
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function createBackupFile(dbPath, backupDir, label) {
  if (!fs.existsSync(dbPath)) {
    return { backupInfo: null, error: 'قاعدة البيانات غير موجودة' };
  }
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2');
  const backupFilename = `backup_${timestamp}.db`;
  const backupPath = path.join(backupDir, backupFilename);

  try {
    const source = new Database(dbPath, { readonly: true });
    source.backup(backupPath).then(() => {
      source.close();
    }).catch(() => {
      source.close();
      // Fallback: simple file copy
      fs.copyFileSync(dbPath, backupPath);
    });

    const stat = fs.statSync(dbPath);
    return {
      backupInfo: {
        filename: backupFilename,
        path: backupPath,
        size: stat.size,
        created_at: now.toISOString(),
        tenant: label || 'default'
      },
      error: null
    };
  } catch (e) {
    // Fallback: simple file copy
    try {
      fs.copyFileSync(dbPath, backupPath);
      const stat = fs.statSync(backupPath);
      return {
        backupInfo: {
          filename: backupFilename,
          path: backupPath,
          size: stat.size,
          created_at: now.toISOString(),
          tenant: label || 'default'
        },
        error: null
      };
    } catch (e2) {
      return { backupInfo: null, error: e2.message };
    }
  }
}

// ===== Database Initialization (uses database/*.js modules) =====

function initMasterDb() {
  initMasterDbModule(Database, MASTER_DB_PATH, hashPassword);
}

function createTenantDatabase(slug) {
  const dbPath = getTenantDbPath(slug);
  const db = new Database(dbPath);
  createAllTables(db);
  insertDefaultSettings(db, false);
  insertDefaultBranch(db);
  db.close();
  return dbPath;
}

function initDefaultDb() {
  const db = new Database(DB_PATH);
  createAllTables(db);
  insertDefaultSettings(db, true);
  insertDefaultBranch(db);
  db.close();
  console.log('[Init] Default database initialized');
}

function migrateDatabase(dbPath) {
  migrateDatabaseModule(Database, dbPath || DB_PATH);
}

// ===== Server Setup =====

function startServer(options = {}) {
  const port = options.port || parseInt(process.env.PORT || '5000', 10);

  // Override paths if provided
  if (options.dbDir) {
    DB_DIR = options.dbDir;
    DB_PATH = path.join(DB_DIR, 'pos.db');
    MASTER_DB_PATH = path.join(DB_DIR, 'master.db');
    TENANTS_DB_DIR = path.join(DB_DIR, 'tenants');
    BACKUPS_DIR = path.join(DB_DIR, 'backups');
  }
  if (options.frontendDir) {
    FRONTEND_DIR = options.frontendDir;
  }
  if (options.backupsDir) {
    BACKUPS_DIR = options.backupsDir;
  }

  // Ensure directories exist (and are actually directories, not files)
  const UPLOADS_DIR = path.join(DB_DIR, 'uploads');
  [DB_DIR, TENANTS_DB_DIR, BACKUPS_DIR, UPLOADS_DIR].forEach(dir => {
    if (fs.existsSync(dir)) {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) {
        console.error(`[Server] ENOTDIR: "${dir}" exists but is NOT a directory — removing and recreating`);
        fs.unlinkSync(dir);
        fs.mkdirSync(dir, { recursive: true });
      }
    } else {
      console.log(`[Server] Creating directory: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // Reinitialize multer with correct path
  upload = multer({ dest: UPLOADS_DIR });

  // Initialize databases
  // Skip local master.db init if Flask server URL is configured (shared master.db)
  if (!getFlaskServerUrl()) {
    initMasterDb();
  }
  initDefaultDb();
  migrateDatabase();

  // Ensure all tenant databases have full schema, then migrate
  if (fs.existsSync(TENANTS_DB_DIR)) {
    const files = fs.readdirSync(TENANTS_DB_DIR);
    for (const f of files) {
      if (f.endsWith('.db')) {
        const tenantPath = path.join(TENANTS_DB_DIR, f);
        ensureDbTables(tenantPath);
        migrateDatabase(tenantPath);
      }
    }
  }

  // Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Shared helpers context for route modules
  const helpers = {
    getDb, getMasterDb, hashPassword, verifyPassword, needsRehash, logAction,
    createBackupFile, getBackupDir, createTenantDatabase, migrateDatabase,
    getTenantSlug, getTenantDbPath, getFlaskServerUrl,
    DB_PATH, MASTER_DB_PATH, TENANTS_DB_DIR, BACKUPS_DIR, FRONTEND_DIR,
    upload, Database
  };

  // ===== Static Files =====
  app.get('/', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });

  app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'sw.js'));
  });

  // ===== Load Route Modules =====
  const routesDir = path.join(__dirname, '..', 'routes');

  // Part 1: Users, Products, Inventory, Invoices, etc. (server.py lines 981-2255)
  require(path.join(routesDir, 'usersProductsInvoices.js'))(app, helpers);

  // Part 2: Tables, Coupons, Suppliers, Super Admin, Backups, Google Drive, Admin Dashboard (server.py lines 2256-5216)
  require(path.join(routesDir, 'tablesCouponsBackups.js'))(app, helpers);

  // Part 3: Admin Dashboard (invoices/stock summary), XBRL, Shifts, Invoice Editing (server.py lines 5217-6615)
  require(path.join(routesDir, 'adminDashboardXbrlShifts.js'))(app, helpers);

  // Part 4: Stock Transfers, Subscriptions, Sync, Version (server.py lines 6616-7794)
  require(path.join(routesDir, 'stockTransfersSubscriptionsSync.js'))(app, helpers);

  // ===== Catch-all: serve frontend static files =====
  app.use(express.static(FRONTEND_DIR));
  app.get('*', (req, res) => {
    const filePath = path.join(FRONTEND_DIR, req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.sendFile(filePath);
    } else {
      res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    }
  });

  // Start server
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 POS Server running on http://0.0.0.0:${port}`);
    console.log(`📍 Multi-Tenancy enabled`);
    console.log(`💾 Database: ${DB_PATH}`);
  });

  return server;
}

// Allow running directly: node electron/server.js
if (require.main === module) {
  startServer();
}

module.exports = { startServer };
