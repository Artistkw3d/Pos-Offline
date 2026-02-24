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

// ===== Configuration =====
let DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'database');
let DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'pos.db');
let MASTER_DB_PATH = path.join(DB_DIR, 'master.db');
let TENANTS_DB_DIR = path.join(DB_DIR, 'tenants');
let BACKUPS_DIR = path.join(DB_DIR, 'backups');
let FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

let upload = multer({ dest: path.join(DB_DIR, 'uploads') });

// ===== Helper Functions =====

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, full_name TEXT NOT NULL,
      role TEXT DEFAULT 'employee', invoice_prefix TEXT DEFAULT 'INV',
      is_active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      permissions TEXT,
      can_add_products INTEGER DEFAULT 0, can_edit_products INTEGER DEFAULT 0,
      can_delete_products INTEGER DEFAULT 0, can_view_invoices INTEGER DEFAULT 1,
      can_delete_invoices INTEGER DEFAULT 0, can_view_reports INTEGER DEFAULT 0,
      can_view_accounting INTEGER DEFAULT 0, can_manage_users INTEGER DEFAULT 0,
      can_access_settings INTEGER DEFAULT 0, branch_id INTEGER DEFAULT 1,
      can_view_inventory INTEGER DEFAULT 0, can_add_inventory INTEGER DEFAULT 0,
      can_edit_inventory INTEGER DEFAULT 0, can_delete_inventory INTEGER DEFAULT 0,
      can_view_products INTEGER DEFAULT 1, can_view_customers INTEGER DEFAULT 1,
      can_add_customer INTEGER DEFAULT 1, can_edit_customer INTEGER DEFAULT 0,
      can_delete_customer INTEGER DEFAULT 0,
      can_view_returns INTEGER DEFAULT 0, can_view_expenses INTEGER DEFAULT 0,
      can_view_suppliers INTEGER DEFAULT 0, can_view_coupons INTEGER DEFAULT 0,
      can_view_tables INTEGER DEFAULT 0, can_view_attendance INTEGER DEFAULT 0,
      can_view_advanced_reports INTEGER DEFAULT 0, can_view_system_logs INTEGER DEFAULT 0,
      can_view_dcf INTEGER DEFAULT 0, can_cancel_invoices INTEGER DEFAULT 0,
      can_view_branches INTEGER DEFAULT 0, can_view_cross_branch_stock INTEGER DEFAULT 0,
      can_view_xbrl INTEGER DEFAULT 0, last_login TIMESTAMP,
      shift_id INTEGER, can_edit_completed_invoices INTEGER DEFAULT 0,
      can_create_transfer INTEGER DEFAULT 0, can_approve_transfer INTEGER DEFAULT 0,
      can_deliver_transfer INTEGER DEFAULT 0, can_view_transfers INTEGER DEFAULT 0,
      can_view_subscriptions INTEGER DEFAULT 0, can_manage_subscriptions INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT,
      phone TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, branch_number TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT,
      price REAL DEFAULT 0, cost REAL DEFAULT 0, stock INTEGER DEFAULT 0,
      category TEXT, image TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      image_data TEXT, branch_id INTEGER DEFAULT 1, is_master INTEGER DEFAULT 0,
      master_product_id INTEGER, inventory_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT,
      category TEXT, price REAL DEFAULT 0, cost REAL DEFAULT 0, image_data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL,
      variant_name TEXT NOT NULL, price REAL DEFAULT 0, cost REAL DEFAULT 0, barcode TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS branch_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      variant_id INTEGER, stock INTEGER DEFAULT 0, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sales_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT,
      customer_id INTEGER, customer_name TEXT, customer_phone TEXT,
      subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, total REAL DEFAULT 0,
      payment_method TEXT, employee_name TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, transaction_number TEXT,
      delivery_fee REAL DEFAULT 0, discount_type TEXT,
      branch_id INTEGER, branch_name TEXT, customer_address TEXT,
      order_status TEXT DEFAULT 'قيد التنفيذ',
      coupon_discount REAL DEFAULT 0, coupon_code TEXT,
      loyalty_discount REAL DEFAULT 0, loyalty_points_earned INTEGER DEFAULT 0,
      loyalty_points_redeemed INTEGER DEFAULT 0,
      table_id INTEGER, table_name TEXT,
      cancelled INTEGER DEFAULT 0, cancel_reason TEXT, cancelled_at TIMESTAMP,
      stock_returned INTEGER DEFAULT 0,
      shift_id INTEGER, shift_name TEXT,
      edited_at TIMESTAMP, edited_by TEXT, edit_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, product_id INTEGER,
      product_name TEXT, quantity INTEGER, price REAL, total REAL,
      branch_stock_id INTEGER, variant_id INTEGER, variant_name TEXT
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
      email TEXT, address TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      loyalty_points INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_type TEXT, amount REAL,
      description TEXT, expense_date DATE, branch_id INTEGER, created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT, description TEXT,
      user_id INTEGER, user_name TEXT, branch_id INTEGER, target_id INTEGER,
      details TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS attendance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT,
      branch_id INTEGER, check_in TIMESTAMP, check_out TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS damaged_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      quantity INTEGER, reason TEXT, reported_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS damaged_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      quantity INTEGER, reason TEXT, user_id INTEGER, user_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, invoice_number TEXT,
      product_id INTEGER, product_name TEXT, quantity INTEGER, price REAL, total REAL,
      reason TEXT, employee_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
      email TEXT, address TEXT, company TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL,
      invoice_number TEXT, amount REAL DEFAULT 0, file_name TEXT, file_data TEXT,
      file_type TEXT, notes TEXT, invoice_date TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'amount', discount_value REAL NOT NULL DEFAULT 0,
      min_amount REAL DEFAULT 0, max_uses INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, expiry_date TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS restaurant_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, seats INTEGER DEFAULT 4,
      pos_x INTEGER DEFAULT 50, pos_y INTEGER DEFAULT 50, status TEXT DEFAULT 'available',
      current_invoice_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS salary_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER,
      employee_name TEXT NOT NULL, monthly_salary REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      start_time TEXT, end_time TEXT, is_active INTEGER DEFAULT 1,
      auto_lock INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS invoice_edit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL,
      edited_by INTEGER, edited_by_name TEXT, changes TEXT,
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS xbrl_company_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name_ar TEXT, company_name_en TEXT, commercial_registration TEXT,
      tax_number TEXT, reporting_currency TEXT DEFAULT 'SAR', industry_sector TEXT,
      country TEXT DEFAULT 'SA', fiscal_year_end TEXT DEFAULT '12-31',
      legal_form TEXT, contact_email TEXT, contact_phone TEXT, address TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS xbrl_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      report_data TEXT, xbrl_xml TEXT, created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_number TEXT UNIQUE,
      from_branch_id INTEGER, from_branch_name TEXT,
      to_branch_id INTEGER, to_branch_name TEXT,
      status TEXT DEFAULT 'pending',
      requested_by INTEGER, requested_by_name TEXT,
      approved_by INTEGER, approved_by_name TEXT,
      driver_id INTEGER, driver_name TEXT,
      received_by INTEGER, received_by_name TEXT,
      notes TEXT, reject_reason TEXT,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP, picked_up_at TIMESTAMP,
      delivered_at TIMESTAMP, completed_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER NOT NULL,
      inventory_id INTEGER, product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity_requested INTEGER DEFAULT 0, quantity_approved INTEGER DEFAULT 0,
      quantity_received INTEGER DEFAULT 0,
      FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 30, price REAL NOT NULL DEFAULT 0,
      discount_percent REAL DEFAULT 0, loyalty_multiplier REAL DEFAULT 1,
      description TEXT, image TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
      customer_name TEXT, customer_phone TEXT, plan_id INTEGER, plan_name TEXT,
      subscription_code TEXT UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      price_paid REAL DEFAULT 0, discount_percent REAL DEFAULT 0,
      loyalty_multiplier REAL DEFAULT 1, status TEXT DEFAULT 'active',
      notes TEXT, created_by INTEGER, created_by_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
    );
    CREATE TABLE IF NOT EXISTS subscription_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, product_name TEXT,
      variant_id INTEGER, variant_name TEXT, quantity INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS subscription_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      redeemed_by INTEGER, redeemed_by_name TEXT,
      FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);
  // Indexes for performance
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
      CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(created_at);
      CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_branch_stock_inventory ON branch_stock(inventory_id);
      CREATE INDEX IF NOT EXISTS idx_branch_stock_branch ON branch_stock(branch_id);
      CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    `);
  } catch (_e) { /* ignore */ }

  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_points_per_invoice', '10')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_point_value', '0.1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_enabled', 'true')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('store_name', 'متجر العطور والبخور')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'KD')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('tax_enabled', 'false')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('low_stock_threshold', '5')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('store_phone', '')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('store_address', '')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_prefix', 'INV')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('next_invoice_number', '1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('tax_rate', '0')").run();
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (1, 'الفرع الرئيسي', '', 1)").run();
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

// ===== Database Initialization =====

function initMasterDb() {
  const db = new Database(MASTER_DB_PATH);
  db.exec(`
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
      expires_at TEXT
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
  `);

  // Upgrade: add new columns if missing
  try {
    const cols = db.prepare('PRAGMA table_info(tenants)').all().map(c => c.name);
    if (!cols.includes('subscription_amount')) {
      db.exec('ALTER TABLE tenants ADD COLUMN subscription_amount REAL DEFAULT 0');
    }
    if (!cols.includes('subscription_period')) {
      db.exec('ALTER TABLE tenants ADD COLUMN subscription_period INTEGER DEFAULT 30');
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

function createTenantDatabase(slug) {
  const dbPath = getTenantDbPath(slug);
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, full_name TEXT NOT NULL,
      role TEXT DEFAULT 'employee', invoice_prefix TEXT DEFAULT 'INV',
      is_active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      permissions TEXT,
      can_add_products INTEGER DEFAULT 0, can_edit_products INTEGER DEFAULT 0,
      can_delete_products INTEGER DEFAULT 0, can_view_invoices INTEGER DEFAULT 1,
      can_delete_invoices INTEGER DEFAULT 0, can_view_reports INTEGER DEFAULT 0,
      can_view_accounting INTEGER DEFAULT 0, can_manage_users INTEGER DEFAULT 0,
      can_access_settings INTEGER DEFAULT 0, branch_id INTEGER DEFAULT 1,
      can_view_inventory INTEGER DEFAULT 0, can_add_inventory INTEGER DEFAULT 0,
      can_edit_inventory INTEGER DEFAULT 0, can_delete_inventory INTEGER DEFAULT 0,
      can_view_products INTEGER DEFAULT 1, can_view_customers INTEGER DEFAULT 1,
      can_add_customer INTEGER DEFAULT 1, can_edit_customer INTEGER DEFAULT 0,
      can_delete_customer INTEGER DEFAULT 0,
      can_view_returns INTEGER DEFAULT 0, can_view_expenses INTEGER DEFAULT 0,
      can_view_suppliers INTEGER DEFAULT 0, can_view_coupons INTEGER DEFAULT 0,
      can_view_tables INTEGER DEFAULT 0, can_view_attendance INTEGER DEFAULT 0,
      can_view_advanced_reports INTEGER DEFAULT 0, can_view_system_logs INTEGER DEFAULT 0,
      can_view_dcf INTEGER DEFAULT 0, can_cancel_invoices INTEGER DEFAULT 0,
      can_view_branches INTEGER DEFAULT 0, can_view_cross_branch_stock INTEGER DEFAULT 0,
      can_view_xbrl INTEGER DEFAULT 0, last_login TIMESTAMP,
      shift_id INTEGER, can_edit_completed_invoices INTEGER DEFAULT 0,
      can_create_transfer INTEGER DEFAULT 0, can_approve_transfer INTEGER DEFAULT 0,
      can_deliver_transfer INTEGER DEFAULT 0, can_view_transfers INTEGER DEFAULT 0,
      can_view_subscriptions INTEGER DEFAULT 0, can_manage_subscriptions INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT,
      phone TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, branch_number TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT,
      price REAL DEFAULT 0, cost REAL DEFAULT 0, stock INTEGER DEFAULT 0,
      category TEXT, image TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      image_data TEXT, branch_id INTEGER DEFAULT 1, is_master INTEGER DEFAULT 0,
      master_product_id INTEGER, inventory_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT,
      category TEXT, price REAL DEFAULT 0, cost REAL DEFAULT 0, image_data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL,
      variant_name TEXT NOT NULL, price REAL DEFAULT 0, cost REAL DEFAULT 0, barcode TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS branch_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      variant_id INTEGER, stock INTEGER DEFAULT 0, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sales_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT,
      customer_id INTEGER, customer_name TEXT, customer_phone TEXT,
      subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, total REAL DEFAULT 0,
      payment_method TEXT, employee_name TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, transaction_number TEXT,
      delivery_fee REAL DEFAULT 0, discount_type TEXT,
      branch_id INTEGER, branch_name TEXT, customer_address TEXT,
      order_status TEXT DEFAULT 'قيد التنفيذ',
      coupon_discount REAL DEFAULT 0, coupon_code TEXT,
      loyalty_discount REAL DEFAULT 0, loyalty_points_earned INTEGER DEFAULT 0,
      loyalty_points_redeemed INTEGER DEFAULT 0,
      table_id INTEGER, table_name TEXT,
      cancelled INTEGER DEFAULT 0, cancel_reason TEXT, cancelled_at TIMESTAMP,
      stock_returned INTEGER DEFAULT 0,
      shift_id INTEGER, shift_name TEXT,
      edited_at TIMESTAMP, edited_by TEXT, edit_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, product_id INTEGER,
      product_name TEXT, quantity INTEGER, price REAL, total REAL,
      branch_stock_id INTEGER, variant_id INTEGER, variant_name TEXT
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
      email TEXT, address TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      loyalty_points INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_type TEXT, amount REAL,
      description TEXT, expense_date DATE, branch_id INTEGER, created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS salary_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER,
      employee_name TEXT NOT NULL, monthly_salary REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT, description TEXT,
      user_id INTEGER, user_name TEXT, branch_id INTEGER, target_id INTEGER,
      details TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attendance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT,
      branch_id INTEGER, check_in TIMESTAMP, check_out TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS damaged_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      quantity INTEGER, reason TEXT, reported_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS damaged_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      quantity INTEGER, reason TEXT, user_id INTEGER, user_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, invoice_number TEXT,
      product_id INTEGER, product_name TEXT, quantity INTEGER, price REAL, total REAL,
      reason TEXT, employee_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
      email TEXT, address TEXT, company TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL,
      invoice_number TEXT, amount REAL DEFAULT 0, file_name TEXT, file_data TEXT,
      file_type TEXT, notes TEXT, invoice_date TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'amount', discount_value REAL NOT NULL DEFAULT 0,
      min_amount REAL DEFAULT 0, max_uses INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, expiry_date TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS restaurant_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, seats INTEGER DEFAULT 4,
      pos_x INTEGER DEFAULT 50, pos_y INTEGER DEFAULT 50, status TEXT DEFAULT 'available',
      current_invoice_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      start_time TEXT, end_time TEXT, is_active INTEGER DEFAULT 1,
      auto_lock INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoice_edit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL,
      edited_by INTEGER, edited_by_name TEXT, changes TEXT,
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS xbrl_company_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name_ar TEXT, company_name_en TEXT, commercial_registration TEXT,
      tax_number TEXT, reporting_currency TEXT DEFAULT 'SAR', industry_sector TEXT,
      country TEXT DEFAULT 'SA', fiscal_year_end TEXT DEFAULT '12-31',
      legal_form TEXT, contact_email TEXT, contact_phone TEXT, address TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS xbrl_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      report_data TEXT, xbrl_xml TEXT, created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_number TEXT UNIQUE,
      from_branch_id INTEGER, from_branch_name TEXT,
      to_branch_id INTEGER, to_branch_name TEXT,
      status TEXT DEFAULT 'pending',
      requested_by INTEGER, requested_by_name TEXT,
      approved_by INTEGER, approved_by_name TEXT,
      driver_id INTEGER, driver_name TEXT,
      received_by INTEGER, received_by_name TEXT,
      notes TEXT, reject_reason TEXT,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP, picked_up_at TIMESTAMP,
      delivered_at TIMESTAMP, completed_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER NOT NULL,
      inventory_id INTEGER, product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity_requested INTEGER DEFAULT 0, quantity_approved INTEGER DEFAULT 0,
      quantity_received INTEGER DEFAULT 0,
      FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscription_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 30, price REAL NOT NULL DEFAULT 0,
      discount_percent REAL DEFAULT 0, loyalty_multiplier REAL DEFAULT 1,
      description TEXT, image TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
      customer_name TEXT, customer_phone TEXT, plan_id INTEGER, plan_name TEXT,
      subscription_code TEXT UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      price_paid REAL DEFAULT 0, discount_percent REAL DEFAULT 0,
      loyalty_multiplier REAL DEFAULT 1, status TEXT DEFAULT 'active',
      notes TEXT, created_by INTEGER, created_by_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
    );

    CREATE TABLE IF NOT EXISTS subscription_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, product_name TEXT,
      variant_id INTEGER, variant_name TEXT, quantity INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS subscription_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      redeemed_by INTEGER, redeemed_by_name TEXT,
      FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // Default settings
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_points_per_invoice', '10')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_point_value', '0.1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_enabled', 'true')").run();

  // Default branch
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (1, 'الفرع الرئيسي', '', 1)").run();

  db.close();
  return dbPath;
}

function initDefaultDb() {
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, full_name TEXT NOT NULL,
      role TEXT DEFAULT 'employee', invoice_prefix TEXT DEFAULT 'INV',
      is_active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      permissions TEXT,
      can_add_products INTEGER DEFAULT 0, can_edit_products INTEGER DEFAULT 0,
      can_delete_products INTEGER DEFAULT 0, can_view_invoices INTEGER DEFAULT 1,
      can_delete_invoices INTEGER DEFAULT 0, can_view_reports INTEGER DEFAULT 0,
      can_view_accounting INTEGER DEFAULT 0, can_manage_users INTEGER DEFAULT 0,
      can_access_settings INTEGER DEFAULT 0, branch_id INTEGER DEFAULT 1,
      can_view_inventory INTEGER DEFAULT 0, can_add_inventory INTEGER DEFAULT 0,
      can_edit_inventory INTEGER DEFAULT 0, can_delete_inventory INTEGER DEFAULT 0,
      can_view_products INTEGER DEFAULT 1, can_view_customers INTEGER DEFAULT 1,
      can_add_customer INTEGER DEFAULT 1, can_edit_customer INTEGER DEFAULT 0,
      can_delete_customer INTEGER DEFAULT 0,
      can_view_returns INTEGER DEFAULT 0, can_view_expenses INTEGER DEFAULT 0,
      can_view_suppliers INTEGER DEFAULT 0, can_view_coupons INTEGER DEFAULT 0,
      can_view_tables INTEGER DEFAULT 0, can_view_attendance INTEGER DEFAULT 0,
      can_view_advanced_reports INTEGER DEFAULT 0, can_view_system_logs INTEGER DEFAULT 0,
      can_view_dcf INTEGER DEFAULT 0, can_cancel_invoices INTEGER DEFAULT 0,
      can_view_branches INTEGER DEFAULT 0, can_view_cross_branch_stock INTEGER DEFAULT 0,
      can_view_xbrl INTEGER DEFAULT 0, last_login TIMESTAMP,
      shift_id INTEGER, can_edit_completed_invoices INTEGER DEFAULT 0,
      can_create_transfer INTEGER DEFAULT 0, can_approve_transfer INTEGER DEFAULT 0,
      can_deliver_transfer INTEGER DEFAULT 0, can_view_transfers INTEGER DEFAULT 0,
      can_view_subscriptions INTEGER DEFAULT 0, can_manage_subscriptions INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT,
      phone TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, branch_number TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT,
      price REAL DEFAULT 0, cost REAL DEFAULT 0, stock INTEGER DEFAULT 0,
      category TEXT, image TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      image_data TEXT, branch_id INTEGER DEFAULT 1, is_master INTEGER DEFAULT 0,
      master_product_id INTEGER, inventory_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT,
      category TEXT, price REAL DEFAULT 0, cost REAL DEFAULT 0, image_data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL,
      variant_name TEXT NOT NULL, price REAL DEFAULT 0, cost REAL DEFAULT 0, barcode TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS branch_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      variant_id INTEGER, stock INTEGER DEFAULT 0, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sales_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT,
      customer_id INTEGER, customer_name TEXT, customer_phone TEXT,
      subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, total REAL DEFAULT 0,
      payment_method TEXT, employee_name TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, transaction_number TEXT,
      delivery_fee REAL DEFAULT 0, discount_type TEXT,
      branch_id INTEGER, branch_name TEXT, customer_address TEXT,
      order_status TEXT DEFAULT 'قيد التنفيذ',
      coupon_discount REAL DEFAULT 0, coupon_code TEXT,
      loyalty_discount REAL DEFAULT 0, loyalty_points_earned INTEGER DEFAULT 0,
      loyalty_points_redeemed INTEGER DEFAULT 0,
      table_id INTEGER, table_name TEXT,
      cancelled INTEGER DEFAULT 0, cancel_reason TEXT, cancelled_at TIMESTAMP,
      stock_returned INTEGER DEFAULT 0,
      shift_id INTEGER, shift_name TEXT,
      edited_at TIMESTAMP, edited_by TEXT, edit_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, product_id INTEGER,
      product_name TEXT, quantity INTEGER, price REAL, total REAL,
      branch_stock_id INTEGER, variant_id INTEGER, variant_name TEXT
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
      email TEXT, address TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      loyalty_points INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_type TEXT, amount REAL,
      description TEXT, expense_date DATE, branch_id INTEGER, created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS salary_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER,
      employee_name TEXT NOT NULL, monthly_salary REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT, description TEXT,
      user_id INTEGER, user_name TEXT, branch_id INTEGER, target_id INTEGER,
      details TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attendance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT,
      branch_id INTEGER, check_in TIMESTAMP, check_out TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS damaged_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      quantity INTEGER, reason TEXT, reported_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS damaged_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER, branch_id INTEGER,
      quantity INTEGER, reason TEXT, user_id INTEGER, user_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, invoice_number TEXT,
      product_id INTEGER, product_name TEXT, quantity INTEGER, price REAL, total REAL,
      reason TEXT, employee_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
      email TEXT, address TEXT, company TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL,
      invoice_number TEXT, amount REAL DEFAULT 0, file_name TEXT, file_data TEXT,
      file_type TEXT, notes TEXT, invoice_date TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'amount', discount_value REAL NOT NULL DEFAULT 0,
      min_amount REAL DEFAULT 0, max_uses INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, expiry_date TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS restaurant_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, seats INTEGER DEFAULT 4,
      pos_x INTEGER DEFAULT 50, pos_y INTEGER DEFAULT 50, status TEXT DEFAULT 'available',
      current_invoice_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      start_time TEXT, end_time TEXT, is_active INTEGER DEFAULT 1,
      auto_lock INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoice_edit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL,
      edited_by INTEGER, edited_by_name TEXT, changes TEXT,
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS xbrl_company_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name_ar TEXT, company_name_en TEXT, commercial_registration TEXT,
      tax_number TEXT, reporting_currency TEXT DEFAULT 'SAR', industry_sector TEXT,
      country TEXT DEFAULT 'SA', fiscal_year_end TEXT DEFAULT '12-31',
      legal_form TEXT, contact_email TEXT, contact_phone TEXT, address TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS xbrl_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      report_data TEXT, xbrl_xml TEXT, created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_number TEXT UNIQUE,
      from_branch_id INTEGER, from_branch_name TEXT,
      to_branch_id INTEGER, to_branch_name TEXT,
      status TEXT DEFAULT 'pending',
      requested_by INTEGER, requested_by_name TEXT,
      approved_by INTEGER, approved_by_name TEXT,
      driver_id INTEGER, driver_name TEXT,
      received_by INTEGER, received_by_name TEXT,
      notes TEXT, reject_reason TEXT,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP, picked_up_at TIMESTAMP,
      delivered_at TIMESTAMP, completed_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER NOT NULL,
      inventory_id INTEGER, product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity_requested INTEGER DEFAULT 0, quantity_approved INTEGER DEFAULT 0,
      quantity_received INTEGER DEFAULT 0,
      FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscription_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 30, price REAL NOT NULL DEFAULT 0,
      discount_percent REAL DEFAULT 0, loyalty_multiplier REAL DEFAULT 1,
      description TEXT, image TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
      customer_name TEXT, customer_phone TEXT, plan_id INTEGER, plan_name TEXT,
      subscription_code TEXT UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      price_paid REAL DEFAULT 0, discount_percent REAL DEFAULT 0,
      loyalty_multiplier REAL DEFAULT 1, status TEXT DEFAULT 'active',
      notes TEXT, created_by INTEGER, created_by_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
    );

    CREATE TABLE IF NOT EXISTS subscription_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, product_name TEXT,
      variant_id INTEGER, variant_name TEXT, quantity INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS subscription_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      redeemed_by INTEGER, redeemed_by_name TEXT,
      FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  // Default settings
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_points_per_invoice', '10')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_point_value', '0.1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_enabled', 'true')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('store_name', 'متجر العطور والبخور')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'KD')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('tax_enabled', 'false')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('tax_rate', '0')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('low_stock_threshold', '5')").run();

  // Default branch
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (1, 'الفرع الرئيسي', '', 1)").run();

  db.close();
  console.log('[Init] Default database initialized');
}

function migrateDatabase(dbPath) {
  const targetPath = dbPath || DB_PATH;
  if (!fs.existsSync(targetPath)) return;

  const db = new Database(targetPath);

  function safeExec(sql, msg) {
    try {
      db.exec(sql);
    } catch (e) {
      if (!e.message.toLowerCase().includes('duplicate column') && !e.message.toLowerCase().includes('already exists')) {
        console.log(`[Migration] ${msg || ''}: ${e.message}`);
      }
    }
  }

  function addColumn(table, column, colType, defaultVal) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes(column)) {
        let ddl = `ALTER TABLE ${table} ADD COLUMN ${column} ${colType}`;
        if (defaultVal !== undefined && defaultVal !== null) {
          ddl += ` DEFAULT ${defaultVal}`;
        }
        db.exec(ddl);
        console.log(`[Migration] Added ${table}.${column}`);
      }
    } catch (e) {
      console.log(`[Migration] ${table}.${column}: ${e.message}`);
    }
  }

  try {
    // New tables
    safeExec(`CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
      email TEXT, address TEXT, company TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, 'suppliers');

    safeExec(`CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL,
      invoice_number TEXT, amount REAL DEFAULT 0, file_name TEXT, file_data TEXT,
      file_type TEXT, notes TEXT, invoice_date TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE)`, 'supplier_invoices');

    safeExec(`CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'amount', discount_value REAL NOT NULL DEFAULT 0,
      min_amount REAL DEFAULT 0, max_uses INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, expiry_date TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, 'coupons');

    safeExec(`CREATE TABLE IF NOT EXISTS restaurant_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, seats INTEGER DEFAULT 4,
      pos_x INTEGER DEFAULT 50, pos_y INTEGER DEFAULT 50, status TEXT DEFAULT 'available',
      current_invoice_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, 'restaurant_tables');

    safeExec(`CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL,
      variant_name TEXT NOT NULL, price REAL DEFAULT 0, cost REAL DEFAULT 0, barcode TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE)`, 'product_variants');

    safeExec(`CREATE TABLE IF NOT EXISTS salary_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER NOT NULL,
      employee_name TEXT NOT NULL, monthly_salary REAL DEFAULT 0,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE)`, 'salary_details');

    safeExec(`CREATE TABLE IF NOT EXISTS xbrl_company_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name_ar TEXT, company_name_en TEXT, commercial_registration TEXT,
      tax_number TEXT, reporting_currency TEXT DEFAULT 'SAR', industry_sector TEXT,
      country TEXT DEFAULT 'SA', fiscal_year_end TEXT DEFAULT '12-31',
      legal_form TEXT, contact_email TEXT, contact_phone TEXT, address TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, 'xbrl_company_info');

    safeExec(`CREATE TABLE IF NOT EXISTS xbrl_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      report_data TEXT, xbrl_xml TEXT, created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT)`, 'xbrl_reports');

    safeExec(`CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      start_time TEXT, end_time TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, 'shifts');

    safeExec(`CREATE TABLE IF NOT EXISTS invoice_edit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL,
      edited_by INTEGER, edited_by_name TEXT, changes TEXT,
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE)`, 'invoice_edit_history');

    safeExec(`CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_number TEXT UNIQUE,
      from_branch_id INTEGER, from_branch_name TEXT,
      to_branch_id INTEGER, to_branch_name TEXT,
      status TEXT DEFAULT 'pending',
      requested_by INTEGER, requested_by_name TEXT,
      approved_by INTEGER, approved_by_name TEXT,
      driver_id INTEGER, driver_name TEXT,
      received_by INTEGER, received_by_name TEXT,
      notes TEXT, reject_reason TEXT,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP, picked_up_at TIMESTAMP,
      delivered_at TIMESTAMP, completed_at TIMESTAMP)`, 'stock_transfers');

    safeExec(`CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER NOT NULL,
      inventory_id INTEGER, product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity_requested INTEGER DEFAULT 0, quantity_approved INTEGER DEFAULT 0,
      quantity_received INTEGER DEFAULT 0,
      FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE)`, 'stock_transfer_items');

    safeExec(`CREATE TABLE IF NOT EXISTS subscription_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 30, price REAL NOT NULL DEFAULT 0,
      discount_percent REAL DEFAULT 0, loyalty_multiplier REAL DEFAULT 1,
      description TEXT, image TEXT, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, 'subscription_plans');

    safeExec(`CREATE TABLE IF NOT EXISTS customer_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
      customer_name TEXT, customer_phone TEXT, plan_id INTEGER, plan_name TEXT,
      subscription_code TEXT UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      price_paid REAL DEFAULT 0, discount_percent REAL DEFAULT 0,
      loyalty_multiplier REAL DEFAULT 1, status TEXT DEFAULT 'active',
      notes TEXT, created_by INTEGER, created_by_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id))`, 'customer_subscriptions');

    safeExec(`CREATE TABLE IF NOT EXISTS subscription_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, product_name TEXT,
      variant_id INTEGER, variant_name TEXT, quantity INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id))`, 'subscription_plan_items');

    safeExec(`CREATE TABLE IF NOT EXISTS subscription_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      product_name TEXT, variant_id INTEGER, variant_name TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      redeemed_by INTEGER, redeemed_by_name TEXT,
      FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
      FOREIGN KEY (product_id) REFERENCES products(id))`, 'subscription_redemptions');

    // New columns on existing tables
    addColumn('invoices', 'order_status', 'TEXT', "'قيد التنفيذ'");
    addColumn('invoices', 'coupon_discount', 'REAL', 0);
    addColumn('invoices', 'coupon_code', 'TEXT');
    addColumn('invoices', 'loyalty_discount', 'REAL', 0);
    addColumn('invoices', 'loyalty_points_earned', 'INTEGER', 0);
    addColumn('invoices', 'loyalty_points_redeemed', 'INTEGER', 0);
    addColumn('invoices', 'table_id', 'INTEGER');
    addColumn('invoices', 'table_name', 'TEXT');
    addColumn('invoices', 'cancelled', 'INTEGER', 0);
    addColumn('invoices', 'cancel_reason', 'TEXT');
    addColumn('invoices', 'cancelled_at', 'TIMESTAMP');
    addColumn('invoices', 'stock_returned', 'INTEGER', 0);

    addColumn('customers', 'loyalty_points', 'INTEGER', 0);

    addColumn('users', 'can_view_returns', 'INTEGER', 0);
    addColumn('users', 'can_view_expenses', 'INTEGER', 0);
    addColumn('users', 'can_view_suppliers', 'INTEGER', 0);
    addColumn('users', 'can_view_coupons', 'INTEGER', 0);
    addColumn('users', 'can_view_tables', 'INTEGER', 0);
    addColumn('users', 'can_view_attendance', 'INTEGER', 0);
    addColumn('users', 'can_view_advanced_reports', 'INTEGER', 0);
    addColumn('users', 'can_view_system_logs', 'INTEGER', 0);
    addColumn('users', 'can_view_dcf', 'INTEGER', 0);
    addColumn('users', 'can_cancel_invoices', 'INTEGER', 0);
    addColumn('users', 'can_view_branches', 'INTEGER', 0);
    addColumn('users', 'can_view_xbrl', 'INTEGER', 0);
    addColumn('users', 'last_login', 'TIMESTAMP');

    addColumn('invoice_items', 'variant_id', 'INTEGER');
    addColumn('invoice_items', 'variant_name', 'TEXT');

    addColumn('users', 'can_view_cross_branch_stock', 'INTEGER', 0);

    addColumn('branch_stock', 'variant_id', 'INTEGER');
    addColumn('branch_stock', 'notes', 'TEXT');
    addColumn('branch_stock', 'sales_count', 'INTEGER', 0);

    addColumn('subscription_plans', 'image', 'TEXT');

    // Shifts columns
    addColumn('users', 'shift_id', 'INTEGER');
    addColumn('users', 'can_edit_completed_invoices', 'INTEGER', 0);
    addColumn('invoices', 'shift_id', 'INTEGER');
    addColumn('invoices', 'shift_name', 'TEXT');
    addColumn('invoices', 'edited_at', 'TIMESTAMP');
    addColumn('invoices', 'edited_by', 'TEXT');
    addColumn('invoices', 'edit_count', 'INTEGER', 0);
    addColumn('shifts', 'auto_lock', 'INTEGER', 0);

    // Stock transfer permissions
    addColumn('users', 'can_create_transfer', 'INTEGER', 0);
    addColumn('users', 'can_approve_transfer', 'INTEGER', 0);
    addColumn('users', 'can_deliver_transfer', 'INTEGER', 0);
    addColumn('users', 'can_view_transfers', 'INTEGER', 0);

    // Subscription permissions
    addColumn('users', 'can_view_subscriptions', 'INTEGER', 0);
    addColumn('users', 'can_manage_subscriptions', 'INTEGER', 0);

    // Default loyalty settings
    try {
      const cnt = db.prepare("SELECT COUNT(*) as cnt FROM settings WHERE key = 'loyalty_points_per_invoice'").get();
      if (cnt.cnt === 0) {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_points_per_invoice', '10')").run();
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_point_value', '0.1')").run();
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_enabled', 'true')").run();
      }
    } catch (_e) { /* ignore */ }

    // Default low stock threshold
    try {
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('low_stock_threshold', '5')").run();
    } catch (_e) { /* ignore */ }

    // Fix old invoices without branch_id
    try {
      db.exec(`
        UPDATE invoices SET branch_id = (
          SELECT b.id FROM branches b WHERE b.name = invoices.branch_name LIMIT 1
        )
        WHERE branch_id IS NULL AND branch_name IS NOT NULL AND branch_name != ''
      `);
      db.exec(`UPDATE invoices SET branch_id = 1 WHERE branch_id IS NULL`);
    } catch (_e) { /* ignore */ }

    console.log(`[Migration] ✅ ${targetPath}`);
  } catch (e) {
    console.error(`[Migration] ❌ Error: ${e.message}`);
  } finally {
    db.close();
  }
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

  // Ensure directories exist
  const UPLOADS_DIR = path.join(DB_DIR, 'uploads');
  [DB_DIR, TENANTS_DB_DIR, BACKUPS_DIR, UPLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // Reinitialize multer with correct path
  upload = multer({ dest: UPLOADS_DIR });

  // Initialize databases
  initMasterDb();
  initDefaultDb();
  migrateDatabase();

  // Migrate all tenant databases
  if (fs.existsSync(TENANTS_DB_DIR)) {
    const files = fs.readdirSync(TENANTS_DB_DIR);
    for (const f of files) {
      if (f.endsWith('.db')) {
        migrateDatabase(path.join(TENANTS_DB_DIR, f));
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
    getDb, getMasterDb, hashPassword, logAction,
    createBackupFile, getBackupDir, createTenantDatabase, migrateDatabase,
    getTenantSlug, getTenantDbPath,
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
