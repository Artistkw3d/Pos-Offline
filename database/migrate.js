/**
 * Database Migration - Schema upgrades for existing databases
 */

const fs = require('fs');
const { createAllTables, insertDefaultSettings } = require('./schema');

/**
 * Run migrations on a database
 * @param {Function} Database - better-sqlite3 constructor
 * @param {string} dbPath - path to the database file
 */
function migrateDatabase(Database, dbPath) {
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath);

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
    // Ensure all tables exist (handles old databases missing newer tables)
    createAllTables(db);

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
    addColumn('invoices', 'shift_id', 'INTEGER');
    addColumn('invoices', 'shift_name', 'TEXT');
    addColumn('invoices', 'edited_at', 'TIMESTAMP');
    addColumn('invoices', 'edited_by', 'TEXT');
    addColumn('invoices', 'edit_count', 'INTEGER', 0);

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
    addColumn('users', 'shift_id', 'INTEGER');
    addColumn('users', 'can_edit_completed_invoices', 'INTEGER', 0);
    addColumn('users', 'can_view_cross_branch_stock', 'INTEGER', 0);
    addColumn('users', 'can_create_transfer', 'INTEGER', 0);
    addColumn('users', 'can_approve_transfer', 'INTEGER', 0);
    addColumn('users', 'can_deliver_transfer', 'INTEGER', 0);
    addColumn('users', 'can_view_transfers', 'INTEGER', 0);
    addColumn('users', 'can_view_subscriptions', 'INTEGER', 0);
    addColumn('users', 'can_manage_subscriptions', 'INTEGER', 0);

    addColumn('invoice_items', 'variant_id', 'INTEGER');
    addColumn('invoice_items', 'variant_name', 'TEXT');

    addColumn('branch_stock', 'variant_id', 'INTEGER');
    addColumn('branch_stock', 'notes', 'TEXT');
    addColumn('branch_stock', 'sales_count', 'INTEGER', 0);

    addColumn('subscription_plans', 'image', 'TEXT');
    addColumn('shifts', 'auto_lock', 'INTEGER', 0);

    // Default loyalty settings
    try {
      const cnt = db.prepare("SELECT COUNT(*) as cnt FROM settings WHERE key = 'loyalty_points_per_invoice'").get();
      if (cnt.cnt === 0) {
        insertDefaultSettings(db, false);
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

    console.log(`[Migration] Done: ${dbPath}`);
  } catch (e) {
    console.error(`[Migration] Error: ${e.message}`);
  } finally {
    db.close();
  }
}

module.exports = { migrateDatabase };
