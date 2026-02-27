/**
 * Master Database - Super Admin & Multi-Tenant management
 * Shared between all deployments (one master.db)
 */

const MASTER_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      owner_name TEXT NOT NULL,
      owner_email TEXT,
      owner_phone TEXT,
      db_path TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      plan TEXT DEFAULT 'basic',
      max_users INTEGER DEFAULT 5,
      max_branches INTEGER DEFAULT 3,
      subscription_amount REAL DEFAULT 0,
      subscription_period INTEGER DEFAULT 30,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      mode TEXT DEFAULT 'online'
    );
    CREATE TABLE IF NOT EXISTS super_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS subscription_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      period_days INTEGER NOT NULL DEFAULT 30,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      notes TEXT,
      payment_method TEXT DEFAULT 'cash',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
`;

/**
 * Initialize master database (super admin + tenants)
 * @param {Function} Database - better-sqlite3 constructor
 * @param {string} masterDbPath - path to master.db
 * @param {Function} hashPassword - password hashing function
 */
function initMasterDb(Database, masterDbPath, hashPassword) {
  const db = new Database(masterDbPath);
  db.exec(MASTER_TABLES_SQL);

  // Upgrade: add new columns if missing
  try {
    const cols = db.prepare('PRAGMA table_info(tenants)').all().map(c => c.name);
    if (!cols.includes('subscription_amount')) {
      db.exec('ALTER TABLE tenants ADD COLUMN subscription_amount REAL DEFAULT 0');
    }
    if (!cols.includes('subscription_period')) {
      db.exec('ALTER TABLE tenants ADD COLUMN subscription_period INTEGER DEFAULT 30');
    }
    if (!cols.includes('mode')) {
      db.exec("ALTER TABLE tenants ADD COLUMN mode TEXT DEFAULT 'online'");
    }
  } catch (_e) { /* ignore */ }

  // Create default super admin if none exists
  const count = db.prepare('SELECT COUNT(*) as cnt FROM super_admins').get();
  if (count.cnt === 0) {
    db.prepare('INSERT INTO super_admins (username, password, full_name) VALUES (?, ?, ?)').run(
      'superadmin', hashPassword('admin123'), 'مدير النظام'
    );
  }
  db.close();
}

module.exports = {
  MASTER_TABLES_SQL,
  initMasterDb
};
