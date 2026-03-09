-- Migration 001: Base column additions and table extensions
-- This captures all existing ALTER TABLE migrations from the original migrate_database()
-- These are safe to re-run: the runner handles "duplicate column" errors

-- Invoice extensions
ALTER TABLE invoices ADD COLUMN order_status TEXT DEFAULT 'قيد التنفيذ';
ALTER TABLE invoices ADD COLUMN coupon_discount REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN coupon_code TEXT;
ALTER TABLE invoices ADD COLUMN loyalty_discount REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN loyalty_points_earned INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN loyalty_points_redeemed INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN table_id INTEGER;
ALTER TABLE invoices ADD COLUMN table_name TEXT;
ALTER TABLE invoices ADD COLUMN cancelled INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN cancel_reason TEXT;
ALTER TABLE invoices ADD COLUMN cancelled_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN stock_returned INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN shift_id INTEGER;
ALTER TABLE invoices ADD COLUMN shift_name TEXT;
ALTER TABLE invoices ADD COLUMN edited_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN edited_by TEXT;
ALTER TABLE invoices ADD COLUMN edit_count INTEGER DEFAULT 0;

-- Customer loyalty
ALTER TABLE customers ADD COLUMN loyalty_points INTEGER DEFAULT 0;

-- User permissions
ALTER TABLE users ADD COLUMN can_view_returns INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_expenses INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_suppliers INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_coupons INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_tables INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_attendance INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_advanced_reports INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_system_logs INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_dcf INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_cancel_invoices INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_branches INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_xbrl INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login TIMESTAMP;
ALTER TABLE users ADD COLUMN shift_id INTEGER;
ALTER TABLE users ADD COLUMN can_edit_completed_invoices INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_create_transfer INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_approve_transfer INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_deliver_transfer INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_transfers INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_subscriptions INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN can_manage_subscriptions INTEGER DEFAULT 0;

-- Invoice items variants
ALTER TABLE invoice_items ADD COLUMN variant_id INTEGER;
ALTER TABLE invoice_items ADD COLUMN variant_name TEXT;

-- Branch stock extensions
ALTER TABLE branch_stock ADD COLUMN variant_id INTEGER;
ALTER TABLE branch_stock ADD COLUMN notes TEXT;

-- Subscription plan image
ALTER TABLE subscription_plans ADD COLUMN image TEXT;

-- Shifts auto-lock
ALTER TABLE shifts ADD COLUMN auto_lock INTEGER DEFAULT 0;

-- Master DB: tenant extensions
ALTER TABLE tenants ADD COLUMN subscription_amount REAL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN subscription_period INTEGER DEFAULT 30;
ALTER TABLE tenants ADD COLUMN mode TEXT DEFAULT 'online';

-- Master DB: super admin security
ALTER TABLE super_admins ADD COLUMN must_change_password INTEGER DEFAULT 0;
