#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
خادم API لنظام POS
Flask + SQLite
محسّن لأجهزة Synology DS120j
نظام Multi-Tenancy بقواعد بيانات منفصلة
"""

from flask import Flask, request, jsonify, send_from_directory, g, send_file
from flask_cors import CORS
import sqlite3
import os
import shutil
import threading
import time
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
import json
import re
import hashlib

app = Flask(__name__, static_folder='frontend')
CORS(app)

# إعدادات قواعد البيانات
DB_PATH = 'database/pos.db'  # قاعدة البيانات الافتراضية (للتوافق العكسي)
MASTER_DB_PATH = 'database/master.db'
TENANTS_DB_DIR = 'database/tenants'

# إنشاء المجلدات اللازمة
os.makedirs('database', exist_ok=True)
os.makedirs(TENANTS_DB_DIR, exist_ok=True)
BACKUPS_DIR = 'database/backups'
os.makedirs(BACKUPS_DIR, exist_ok=True)

# ===== نظام Multi-Tenancy =====

def hash_password(password):
    """تشفير كلمة المرور"""
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def init_master_db():
    """إنشاء قاعدة البيانات الرئيسية للمستأجرين"""
    conn = sqlite3.connect(MASTER_DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
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
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS super_admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('''
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
        )
    ''')
    # ترقية: إضافة أعمدة جديدة إن لم تكن موجودة
    try:
        cursor.execute("PRAGMA table_info(tenants)")
        cols = [col[1] for col in cursor.fetchall()]
        if 'subscription_amount' not in cols:
            cursor.execute("ALTER TABLE tenants ADD COLUMN subscription_amount REAL DEFAULT 0")
        if 'subscription_period' not in cols:
            cursor.execute("ALTER TABLE tenants ADD COLUMN subscription_period INTEGER DEFAULT 30")
    except:
        pass
    # إنشاء حساب Super Admin افتراضي إن لم يكن موجوداً
    cursor.execute("SELECT COUNT(*) FROM super_admins")
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            "INSERT INTO super_admins (username, password, full_name) VALUES (?, ?, ?)",
            ('superadmin', hash_password('admin123'), 'مدير النظام')
        )
    conn.commit()
    conn.close()

init_master_db()

def migrate_database(db_path=None):
    """ترقية قاعدة البيانات - إضافة أعمدة وجداول جديدة"""
    target_path = db_path or DB_PATH
    if not os.path.exists(target_path):
        return
    conn = sqlite3.connect(target_path)
    cursor = conn.cursor()

    def safe_exec(sql, msg=""):
        try:
            cursor.execute(sql)
            conn.commit()
        except Exception as e:
            if 'duplicate column' not in str(e).lower() and 'already exists' not in str(e).lower():
                print(f"[Migration] {msg}: {e}")

    def add_column(table, column, col_type, default=None):
        try:
            cursor.execute(f"PRAGMA table_info({table})")
            cols = [c[1] for c in cursor.fetchall()]
            if column not in cols:
                ddl = f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"
                if default is not None:
                    ddl += f" DEFAULT {default}"
                cursor.execute(ddl)
                conn.commit()
                print(f"[Migration] Added {table}.{column}")
        except Exception as e:
            print(f"[Migration] {table}.{column}: {e}")

    try:
        # === جداول جديدة ===
        safe_exec('''CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT,
            email TEXT, address TEXT, company TEXT, notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''', 'suppliers')

        safe_exec('''CREATE TABLE IF NOT EXISTS supplier_invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL,
            invoice_number TEXT, amount REAL DEFAULT 0, file_name TEXT, file_data TEXT,
            file_type TEXT, notes TEXT, invoice_date TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE)''', 'supplier_invoices')

        safe_exec('''CREATE TABLE IF NOT EXISTS coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
            discount_type TEXT NOT NULL DEFAULT 'amount', discount_value REAL NOT NULL DEFAULT 0,
            min_amount REAL DEFAULT 0, max_uses INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1, expiry_date TEXT, notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''', 'coupons')

        safe_exec('''CREATE TABLE IF NOT EXISTS restaurant_tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, seats INTEGER DEFAULT 4,
            pos_x INTEGER DEFAULT 50, pos_y INTEGER DEFAULT 50, status TEXT DEFAULT 'available',
            current_invoice_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''', 'restaurant_tables')

        safe_exec('''CREATE TABLE IF NOT EXISTS product_variants (
            id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL,
            variant_name TEXT NOT NULL, price REAL DEFAULT 0, cost REAL DEFAULT 0, barcode TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE)''', 'product_variants')

        safe_exec('''CREATE TABLE IF NOT EXISTS salary_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER NOT NULL,
            employee_name TEXT NOT NULL, monthly_salary REAL DEFAULT 0,
            FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE)''', 'salary_details')

        # === XBRL / IFRS ===
        safe_exec('''CREATE TABLE IF NOT EXISTS xbrl_company_info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_name_ar TEXT,
            company_name_en TEXT,
            commercial_registration TEXT,
            tax_number TEXT,
            reporting_currency TEXT DEFAULT 'SAR',
            industry_sector TEXT,
            country TEXT DEFAULT 'SA',
            fiscal_year_end TEXT DEFAULT '12-31',
            legal_form TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            address TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''', 'xbrl_company_info')

        safe_exec('''CREATE TABLE IF NOT EXISTS xbrl_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_type TEXT NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            report_data TEXT,
            xbrl_xml TEXT,
            created_by INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            notes TEXT
        )''', 'xbrl_reports')

        # === أعمدة جديدة في الجداول الموجودة ===
        add_column('invoices', 'order_status', 'TEXT', "'قيد التنفيذ'")
        add_column('invoices', 'coupon_discount', 'REAL', 0)
        add_column('invoices', 'coupon_code', 'TEXT')
        add_column('invoices', 'loyalty_discount', 'REAL', 0)
        add_column('invoices', 'loyalty_points_earned', 'INTEGER', 0)
        add_column('invoices', 'loyalty_points_redeemed', 'INTEGER', 0)
        add_column('invoices', 'table_id', 'INTEGER')
        add_column('invoices', 'table_name', 'TEXT')
        add_column('invoices', 'cancelled', 'INTEGER', 0)
        add_column('invoices', 'cancel_reason', 'TEXT')
        add_column('invoices', 'cancelled_at', 'TIMESTAMP')
        add_column('invoices', 'stock_returned', 'INTEGER', 0)

        add_column('customers', 'loyalty_points', 'INTEGER', 0)

        # === صلاحيات جديدة ===
        add_column('users', 'can_view_returns', 'INTEGER', 0)
        add_column('users', 'can_view_expenses', 'INTEGER', 0)
        add_column('users', 'can_view_suppliers', 'INTEGER', 0)
        add_column('users', 'can_view_coupons', 'INTEGER', 0)
        add_column('users', 'can_view_tables', 'INTEGER', 0)
        add_column('users', 'can_view_attendance', 'INTEGER', 0)
        add_column('users', 'can_view_advanced_reports', 'INTEGER', 0)
        add_column('users', 'can_view_system_logs', 'INTEGER', 0)
        add_column('users', 'can_view_dcf', 'INTEGER', 0)
        add_column('users', 'can_cancel_invoices', 'INTEGER', 0)
        add_column('users', 'can_view_branches', 'INTEGER', 0)
        add_column('users', 'can_view_xbrl', 'INTEGER', 0)
        add_column('users', 'last_login', 'TIMESTAMP')

        add_column('invoice_items', 'variant_id', 'INTEGER')
        add_column('invoice_items', 'variant_name', 'TEXT')

        add_column('branch_stock', 'variant_id', 'INTEGER')
        add_column('branch_stock', 'notes', 'TEXT')

        add_column('subscription_plans', 'image', 'TEXT')

        # === نظام الشفتات ===
        safe_exec('''CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''', 'shifts')

        # === سجل تعديلات الفواتير ===
        safe_exec('''CREATE TABLE IF NOT EXISTS invoice_edit_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            edited_by INTEGER,
            edited_by_name TEXT,
            changes TEXT,
            edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        )''', 'invoice_edit_history')

        # أعمدة الشفتات
        add_column('users', 'shift_id', 'INTEGER')
        add_column('users', 'can_edit_completed_invoices', 'INTEGER', 0)
        add_column('invoices', 'shift_id', 'INTEGER')
        add_column('invoices', 'shift_name', 'TEXT')
        add_column('invoices', 'edited_at', 'TIMESTAMP')
        add_column('invoices', 'edited_by', 'TEXT')
        add_column('invoices', 'edit_count', 'INTEGER', 0)

        # قفل الشفت التلقائي
        add_column('shifts', 'auto_lock', 'INTEGER', 0)

        # === نظام طلبات النقل المخزني ===
        safe_exec('''CREATE TABLE IF NOT EXISTS stock_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_number TEXT UNIQUE,
            from_branch_id INTEGER,
            from_branch_name TEXT,
            to_branch_id INTEGER,
            to_branch_name TEXT,
            status TEXT DEFAULT 'pending',
            requested_by INTEGER,
            requested_by_name TEXT,
            approved_by INTEGER,
            approved_by_name TEXT,
            driver_id INTEGER,
            driver_name TEXT,
            received_by INTEGER,
            received_by_name TEXT,
            notes TEXT,
            reject_reason TEXT,
            requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            approved_at TIMESTAMP,
            picked_up_at TIMESTAMP,
            delivered_at TIMESTAMP,
            completed_at TIMESTAMP
        )''', 'stock_transfers')

        safe_exec('''CREATE TABLE IF NOT EXISTS stock_transfer_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_id INTEGER NOT NULL,
            inventory_id INTEGER,
            product_name TEXT,
            variant_id INTEGER,
            variant_name TEXT,
            quantity_requested INTEGER DEFAULT 0,
            quantity_approved INTEGER DEFAULT 0,
            quantity_received INTEGER DEFAULT 0,
            FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
        )''', 'stock_transfer_items')

        # صلاحيات النقل المخزني
        add_column('users', 'can_create_transfer', 'INTEGER', 0)
        add_column('users', 'can_approve_transfer', 'INTEGER', 0)
        add_column('users', 'can_deliver_transfer', 'INTEGER', 0)
        add_column('users', 'can_view_transfers', 'INTEGER', 0)

        # صلاحيات الاشتراكات
        add_column('users', 'can_view_subscriptions', 'INTEGER', 0)
        add_column('users', 'can_manage_subscriptions', 'INTEGER', 0)

        # جدول خطط الاشتراك
        safe_exec('''CREATE TABLE IF NOT EXISTS subscription_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            duration_days INTEGER NOT NULL DEFAULT 30,
            price REAL NOT NULL DEFAULT 0,
            discount_percent REAL DEFAULT 0,
            loyalty_multiplier REAL DEFAULT 1,
            description TEXT,
            image TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''', 'subscription_plans')

        # جدول اشتراكات العملاء
        safe_exec('''CREATE TABLE IF NOT EXISTS customer_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            customer_name TEXT,
            customer_phone TEXT,
            plan_id INTEGER,
            plan_name TEXT,
            subscription_code TEXT UNIQUE,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            price_paid REAL DEFAULT 0,
            discount_percent REAL DEFAULT 0,
            loyalty_multiplier REAL DEFAULT 1,
            status TEXT DEFAULT 'active',
            notes TEXT,
            created_by INTEGER,
            created_by_name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers(id),
            FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
        )''', 'customer_subscriptions')

        # جدول منتجات خطط الاشتراك
        safe_exec('''CREATE TABLE IF NOT EXISTS subscription_plan_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            variant_id INTEGER,
            variant_name TEXT,
            quantity INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
        )''', 'subscription_plan_items')

        # جدول استلامات الاشتراك
        safe_exec('''CREATE TABLE IF NOT EXISTS subscription_redemptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription_id INTEGER NOT NULL,
            customer_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            variant_id INTEGER,
            variant_name TEXT,
            quantity INTEGER NOT NULL DEFAULT 1,
            redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            redeemed_by INTEGER,
            redeemed_by_name TEXT,
            FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        )''', 'subscription_redemptions')

        # إعدادات الولاء الافتراضية
        try:
            cursor.execute("SELECT COUNT(*) FROM settings WHERE key = 'loyalty_points_per_invoice'")
            if cursor.fetchone()[0] == 0:
                cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_points_per_invoice', '10')")
                cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_point_value', '0.1')")
                cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_enabled', 'true')")
                conn.commit()
        except Exception as e:
            print(f"[Migration] loyalty settings: {e}")

        # إعداد حد المخزون المنخفض الافتراضي
        try:
            cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('low_stock_threshold', '5')")
            conn.commit()
        except Exception as e:
            print(f"[Migration] low_stock_threshold setting: {e}")

        # إصلاح الفواتير القديمة التي ليس لها branch_id
        try:
            cursor.execute('''
                UPDATE invoices SET branch_id = (
                    SELECT b.id FROM branches b WHERE b.name = invoices.branch_name LIMIT 1
                )
                WHERE branch_id IS NULL AND branch_name IS NOT NULL AND branch_name != ''
            ''')
            # الفواتير التي ليس لها branch_name أيضاً - تعيين الفرع الرئيسي
            cursor.execute('''
                UPDATE invoices SET branch_id = 1
                WHERE branch_id IS NULL
            ''')
            conn.commit()
        except Exception as e:
            print(f"[Migration] fix invoices branch_id: {e}")

        print(f"[Migration] ✅ {target_path}")
    except Exception as e:
        print(f"[Migration] ❌ Error: {e}")
    finally:
        conn.close()

# ترقية قاعدة البيانات الافتراضية
migrate_database()

# ترقية جميع قواعد بيانات المستأجرين
if os.path.exists(TENANTS_DB_DIR):
    for f in os.listdir(TENANTS_DB_DIR):
        if f.endswith('.db'):
            migrate_database(os.path.join(TENANTS_DB_DIR, f))

def get_tenant_slug():
    """استخراج معرف المستأجر من الطلب"""
    return request.headers.get('X-Tenant-ID', '').strip()

def get_tenant_db_path(slug):
    """الحصول على مسار قاعدة بيانات المستأجر"""
    if not slug:
        return DB_PATH  # القاعدة الافتراضية
    # التحقق من صحة slug
    safe_slug = re.sub(r'[^a-zA-Z0-9_-]', '', slug)
    if not safe_slug:
        return DB_PATH
    return os.path.join(TENANTS_DB_DIR, f'{safe_slug}.db')

def get_db():
    """الاتصال بقاعدة البيانات - يدعم Multi-Tenancy"""
    tenant_slug = get_tenant_slug()
    db_path = get_tenant_db_path(tenant_slug)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def get_master_db():
    """الاتصال بقاعدة البيانات الرئيسية"""
    conn = sqlite3.connect(MASTER_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def dict_from_row(row):
    """تحويل صف قاعدة البيانات إلى قاموس"""
    return dict(zip(row.keys(), row))

def create_tenant_database(slug):
    """إنشاء قاعدة بيانات كاملة لمستأجر جديد"""
    db_path = get_tenant_db_path(slug)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # إنشاء جميع الجداول الأساسية
    cursor.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT DEFAULT 'employee',
            invoice_prefix TEXT DEFAULT 'INV',
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            permissions TEXT,
            can_add_products INTEGER DEFAULT 0,
            can_edit_products INTEGER DEFAULT 0,
            can_delete_products INTEGER DEFAULT 0,
            can_view_invoices INTEGER DEFAULT 1,
            can_delete_invoices INTEGER DEFAULT 0,
            can_view_reports INTEGER DEFAULT 0,
            can_view_accounting INTEGER DEFAULT 0,
            can_manage_users INTEGER DEFAULT 0,
            can_access_settings INTEGER DEFAULT 0,
            branch_id INTEGER DEFAULT 1,
            can_view_inventory INTEGER DEFAULT 0,
            can_add_inventory INTEGER DEFAULT 0,
            can_edit_inventory INTEGER DEFAULT 0,
            can_delete_inventory INTEGER DEFAULT 0,
            can_view_products INTEGER DEFAULT 1,
            can_view_customers INTEGER DEFAULT 1,
            can_add_customer INTEGER DEFAULT 1,
            can_edit_customer INTEGER DEFAULT 0,
            can_delete_customer INTEGER DEFAULT 0,
            can_view_returns INTEGER DEFAULT 0,
            can_view_expenses INTEGER DEFAULT 0,
            can_view_suppliers INTEGER DEFAULT 0,
            can_view_coupons INTEGER DEFAULT 0,
            can_view_tables INTEGER DEFAULT 0,
            can_view_attendance INTEGER DEFAULT 0,
            can_view_advanced_reports INTEGER DEFAULT 0,
            can_view_system_logs INTEGER DEFAULT 0,
            can_view_dcf INTEGER DEFAULT 0,
            can_cancel_invoices INTEGER DEFAULT 0,
            can_view_branches INTEGER DEFAULT 0,
            can_view_cross_branch_stock INTEGER DEFAULT 0,
            can_view_xbrl INTEGER DEFAULT 0,
            last_login TIMESTAMP,
            shift_id INTEGER,
            can_edit_completed_invoices INTEGER DEFAULT 0,
            can_create_transfer INTEGER DEFAULT 0,
            can_approve_transfer INTEGER DEFAULT 0,
            can_deliver_transfer INTEGER DEFAULT 0,
            can_view_transfers INTEGER DEFAULT 0,
            can_view_subscriptions INTEGER DEFAULT 0,
            can_manage_subscriptions INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS branches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            location TEXT,
            phone TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            branch_number TEXT
        );

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            barcode TEXT,
            price REAL DEFAULT 0,
            cost REAL DEFAULT 0,
            stock INTEGER DEFAULT 0,
            category TEXT,
            image TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            image_data TEXT,
            branch_id INTEGER DEFAULT 1,
            is_master INTEGER DEFAULT 0,
            master_product_id INTEGER,
            inventory_id INTEGER
        );

        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            barcode TEXT,
            category TEXT,
            price REAL DEFAULT 0,
            cost REAL DEFAULT 0,
            image_data TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS product_variants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER NOT NULL,
            variant_name TEXT NOT NULL,
            price REAL DEFAULT 0,
            cost REAL DEFAULT 0,
            barcode TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS branch_stock (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER,
            branch_id INTEGER,
            variant_id INTEGER,
            stock INTEGER DEFAULT 0,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            sales_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT,
            customer_id INTEGER,
            customer_name TEXT,
            customer_phone TEXT,
            subtotal REAL DEFAULT 0,
            discount REAL DEFAULT 0,
            total REAL DEFAULT 0,
            payment_method TEXT,
            employee_name TEXT,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            transaction_number TEXT,
            delivery_fee REAL DEFAULT 0,
            discount_type TEXT,
            branch_id INTEGER,
            branch_name TEXT,
            customer_address TEXT,
            order_status TEXT DEFAULT 'قيد التنفيذ',
            coupon_discount REAL DEFAULT 0,
            coupon_code TEXT,
            loyalty_discount REAL DEFAULT 0,
            loyalty_points_earned INTEGER DEFAULT 0,
            loyalty_points_redeemed INTEGER DEFAULT 0,
            table_id INTEGER,
            table_name TEXT,
            cancelled INTEGER DEFAULT 0,
            cancel_reason TEXT,
            cancelled_at TIMESTAMP,
            stock_returned INTEGER DEFAULT 0,
            shift_id INTEGER,
            shift_name TEXT,
            edited_at TIMESTAMP,
            edited_by TEXT,
            edit_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER,
            product_id INTEGER,
            product_name TEXT,
            quantity INTEGER,
            price REAL,
            total REAL,
            branch_stock_id INTEGER,
            variant_id INTEGER,
            variant_name TEXT
        );

        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            address TEXT,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            loyalty_points INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            expense_type TEXT,
            amount REAL,
            description TEXT,
            expense_date DATE,
            branch_id INTEGER,
            created_by INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS salary_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            expense_id INTEGER,
            employee_name TEXT NOT NULL,
            monthly_salary REAL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT,
            description TEXT,
            user_id INTEGER,
            user_name TEXT,
            branch_id INTEGER,
            target_id INTEGER,
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS attendance_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            user_name TEXT,
            branch_id INTEGER,
            check_in TIMESTAMP,
            check_out TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS damaged_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER,
            branch_id INTEGER,
            quantity INTEGER,
            reason TEXT,
            reported_by INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS damaged_stock (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER,
            branch_id INTEGER,
            quantity INTEGER,
            reason TEXT,
            user_id INTEGER,
            user_name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS returns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER,
            invoice_number TEXT,
            product_id INTEGER,
            product_name TEXT,
            quantity INTEGER,
            price REAL,
            total REAL,
            reason TEXT,
            employee_name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            address TEXT,
            company TEXT,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS supplier_invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_id INTEGER NOT NULL,
            invoice_number TEXT,
            amount REAL DEFAULT 0,
            file_name TEXT,
            file_data TEXT,
            file_type TEXT,
            notes TEXT,
            invoice_date TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            discount_type TEXT NOT NULL DEFAULT 'amount',
            discount_value REAL NOT NULL DEFAULT 0,
            min_amount REAL DEFAULT 0,
            max_uses INTEGER DEFAULT 0,
            used_count INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            expiry_date TEXT,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS restaurant_tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            seats INTEGER DEFAULT 4,
            pos_x INTEGER DEFAULT 50,
            pos_y INTEGER DEFAULT 50,
            status TEXT DEFAULT 'available',
            current_invoice_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS product_variants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER NOT NULL,
            variant_name TEXT NOT NULL,
            price REAL DEFAULT 0,
            cost REAL DEFAULT 0,
            barcode TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            is_active INTEGER DEFAULT 1,
            auto_lock INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS invoice_edit_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            edited_by INTEGER,
            edited_by_name TEXT,
            changes TEXT,
            edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS xbrl_company_info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_name_ar TEXT,
            company_name_en TEXT,
            commercial_registration TEXT,
            tax_number TEXT,
            reporting_currency TEXT DEFAULT 'SAR',
            industry_sector TEXT,
            country TEXT DEFAULT 'SA',
            fiscal_year_end TEXT DEFAULT '12-31',
            legal_form TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            address TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS xbrl_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_type TEXT NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            report_data TEXT,
            xbrl_xml TEXT,
            created_by INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS stock_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_number TEXT UNIQUE,
            from_branch_id INTEGER,
            from_branch_name TEXT,
            to_branch_id INTEGER,
            to_branch_name TEXT,
            status TEXT DEFAULT 'pending',
            requested_by INTEGER,
            requested_by_name TEXT,
            approved_by INTEGER,
            approved_by_name TEXT,
            driver_id INTEGER,
            driver_name TEXT,
            received_by INTEGER,
            received_by_name TEXT,
            notes TEXT,
            reject_reason TEXT,
            requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            approved_at TIMESTAMP,
            picked_up_at TIMESTAMP,
            delivered_at TIMESTAMP,
            completed_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS stock_transfer_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transfer_id INTEGER NOT NULL,
            inventory_id INTEGER,
            product_name TEXT,
            variant_id INTEGER,
            variant_name TEXT,
            quantity_requested INTEGER DEFAULT 0,
            quantity_approved INTEGER DEFAULT 0,
            quantity_received INTEGER DEFAULT 0,
            FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS subscription_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            duration_days INTEGER NOT NULL DEFAULT 30,
            price REAL NOT NULL DEFAULT 0,
            discount_percent REAL DEFAULT 0,
            loyalty_multiplier REAL DEFAULT 1,
            description TEXT,
            image TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS customer_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            customer_name TEXT,
            customer_phone TEXT,
            plan_id INTEGER,
            plan_name TEXT,
            subscription_code TEXT UNIQUE,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            price_paid REAL DEFAULT 0,
            discount_percent REAL DEFAULT 0,
            loyalty_multiplier REAL DEFAULT 1,
            status TEXT DEFAULT 'active',
            notes TEXT,
            created_by INTEGER,
            created_by_name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers(id),
            FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
        );

        CREATE TABLE IF NOT EXISTS subscription_plan_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            variant_id INTEGER,
            variant_name TEXT,
            quantity INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS subscription_redemptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription_id INTEGER NOT NULL,
            customer_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            product_name TEXT,
            variant_id INTEGER,
            variant_name TEXT,
            quantity INTEGER NOT NULL DEFAULT 1,
            redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            redeemed_by INTEGER,
            redeemed_by_name TEXT,
            FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        );
    ''')

    # إضافة إعدادات افتراضية
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_points_per_invoice', '10')")
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_point_value', '0.1')")
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_enabled', 'true')")

    # إضافة فرع افتراضي
    cursor.execute("INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (1, 'الفرع الرئيسي', '', 1)")

    conn.commit()
    conn.close()
    return db_path

# ===== API المستخدمين =====

@app.route('/api/login', methods=['POST'])
def login():
    """تسجيل دخول المستخدم"""
    try:
        data = request.json
        username = data.get('username')
        password = data.get('password')

        # التحقق من اشتراك المستأجر
        tenant_slug = get_tenant_slug()
        if tenant_slug:
            m_conn = get_master_db()
            m_cursor = m_conn.cursor()
            m_cursor.execute('SELECT is_active, expires_at, name FROM tenants WHERE slug = ?', (tenant_slug,))
            tenant = m_cursor.fetchone()
            m_conn.close()
            if not tenant:
                return jsonify({'success': False, 'error': 'معرف المتجر غير صحيح'}), 404
            if not tenant['is_active']:
                return jsonify({'success': False, 'error': '⛔ هذا المتجر معطل. تواصل مع إدارة النظام'}), 403
            if tenant['expires_at']:
                from datetime import date
                expiry = date.fromisoformat(tenant['expires_at'][:10])
                if date.today() > expiry:
                    # تعطيل المتجر تلقائياً
                    m_conn2 = get_master_db()
                    m_cursor2 = m_conn2.cursor()
                    m_cursor2.execute('UPDATE tenants SET is_active = 0 WHERE slug = ?', (tenant_slug,))
                    m_conn2.commit()
                    m_conn2.close()
                    return jsonify({'success': False, 'error': f'⛔ انتهى اشتراك المتجر "{tenant["name"]}" بتاريخ {tenant["expires_at"][:10]}.\nتواصل مع إدارة النظام لتجديد الاشتراك.'}), 403

        conn = get_db()
        cursor = conn.cursor()

        # إضافة أعمدة الصلاحيات الجديدة تلقائياً عند تسجيل الدخول
        ensure_user_permission_columns(cursor)
        conn.commit()

        hashed_pw = hash_password(password)
        cursor.execute('''
            SELECT u.*, b.name as branch_name
            FROM users u
            LEFT JOIN branches b ON u.branch_id = b.id
            WHERE u.username = ? AND u.is_active = 1
        ''', (username,))

        user = cursor.fetchone()

        if user:
            stored_pw = user['password']
            # دعم كلمات المرور القديمة (نص عادي) والجديدة (مشفرة)
            if stored_pw == hashed_pw or stored_pw == password:
                # ترقية كلمة المرور القديمة إلى مشفرة تلقائياً
                if stored_pw == password and stored_pw != hashed_pw:
                    cursor.execute('UPDATE users SET password = ? WHERE id = ?', (hashed_pw, user['id']))
                # تحديث وقت آخر دخول
                cursor.execute('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', (user['id'],))
                conn.commit()
                conn.close()
                user_data = dict_from_row(user)
                user_data.pop('password', None)
                return jsonify({'success': True, 'user': user_data})

        conn.close()
        return jsonify({'success': False, 'error': 'اسم المستخدم أو كلمة المرور غير صحيحة'}), 401
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/users', methods=['GET'])
def get_users():
    """جلب جميع المستخدمين"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM users ORDER BY created_at DESC')
        users = [dict_from_row(row) for row in cursor.fetchall()]
        for u in users:
            u.pop('password', None)
        conn.close()
        return jsonify({'success': True, 'users': users})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

def ensure_user_permission_columns(cursor):
    """إضافة أعمدة الصلاحيات الجديدة إذا لم تكن موجودة"""
    new_cols = [
        'can_view_returns', 'can_view_expenses', 'can_view_suppliers', 'can_view_coupons',
        'can_view_tables', 'can_view_attendance', 'can_view_advanced_reports',
        'can_view_system_logs', 'can_view_dcf', 'can_cancel_invoices', 'can_view_branches',
        'can_view_cross_branch_stock', 'can_view_xbrl', 'can_edit_completed_invoices',
        'shift_id',
        'can_create_transfer', 'can_approve_transfer', 'can_deliver_transfer', 'can_view_transfers',
        'can_view_subscriptions', 'can_manage_subscriptions'
    ]
    for col in new_cols:
        try:
            cursor.execute(f'ALTER TABLE users ADD COLUMN {col} INTEGER DEFAULT 0')
        except:
            pass

@app.route('/api/users', methods=['POST'])
def add_user():
    """إضافة مستخدم جديد"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        # إضافة الأعمدة الجديدة تلقائياً إذا لم تكن موجودة
        ensure_user_permission_columns(cursor)
        conn.commit()

        cursor.execute('''
            INSERT INTO users (username, password, full_name, role, invoice_prefix, branch_id,
                             can_view_products, can_add_products, can_edit_products, can_delete_products,
                             can_view_inventory, can_add_inventory, can_edit_inventory, can_delete_inventory,
                             can_view_invoices, can_delete_invoices,
                             can_view_customers, can_add_customer, can_edit_customer, can_delete_customer,
                             can_view_reports, can_view_accounting, can_manage_users, can_access_settings,
                             can_view_returns, can_view_expenses, can_view_suppliers, can_view_coupons,
                             can_view_tables, can_view_attendance, can_view_advanced_reports,
                             can_view_system_logs, can_view_dcf, can_cancel_invoices, can_view_branches,
                             can_view_cross_branch_stock, can_view_xbrl, shift_id, can_edit_completed_invoices,
                             can_create_transfer, can_approve_transfer, can_deliver_transfer, can_view_transfers,
                             can_view_subscriptions, can_manage_subscriptions)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            data.get('username'),
            hash_password(data.get('password')),
            data.get('full_name'),
            data.get('role', 'cashier'),
            data.get('invoice_prefix', ''),
            data.get('branch_id', 1),
            data.get('can_view_products', 0),
            data.get('can_add_products', 0),
            data.get('can_edit_products', 0),
            data.get('can_delete_products', 0),
            data.get('can_view_inventory', 0),
            data.get('can_add_inventory', 0),
            data.get('can_edit_inventory', 0),
            data.get('can_delete_inventory', 0),
            data.get('can_view_invoices', 1),
            data.get('can_delete_invoices', 0),
            data.get('can_view_customers', 0),
            data.get('can_add_customer', 0),
            data.get('can_edit_customer', 0),
            data.get('can_delete_customer', 0),
            data.get('can_view_reports', 0),
            data.get('can_view_accounting', 0),
            data.get('can_manage_users', 0),
            data.get('can_access_settings', 0),
            data.get('can_view_returns', 0),
            data.get('can_view_expenses', 0),
            data.get('can_view_suppliers', 0),
            data.get('can_view_coupons', 0),
            data.get('can_view_tables', 0),
            data.get('can_view_attendance', 0),
            data.get('can_view_advanced_reports', 0),
            data.get('can_view_system_logs', 0),
            data.get('can_view_dcf', 0),
            data.get('can_cancel_invoices', 0),
            data.get('can_view_branches', 0),
            data.get('can_view_cross_branch_stock', 0),
            data.get('can_view_xbrl', 0),
            data.get('shift_id'),
            data.get('can_edit_completed_invoices', 0),
            data.get('can_create_transfer', 0),
            data.get('can_approve_transfer', 0),
            data.get('can_deliver_transfer', 0),
            data.get('can_view_transfers', 0),
            data.get('can_view_subscriptions', 0),
            data.get('can_manage_subscriptions', 0)
        ))

        user_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'id': user_id})
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'اسم المستخدم موجود مسبقاً'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/users/<int:user_id>', methods=['PUT'])
def update_user(user_id):
    """تحديث بيانات مستخدم"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        # إضافة الأعمدة الجديدة تلقائياً إذا لم تكن موجودة
        ensure_user_permission_columns(cursor)
        conn.commit()

        # بناء الاستعلام ديناميكياً
        updates = []
        params = []
        
        if 'password' in data and data['password']:
            updates.append('password = ?')
            params.append(hash_password(data['password']))
        if 'full_name' in data:
            updates.append('full_name = ?')
            params.append(data['full_name'])
        if 'role' in data:
            updates.append('role = ?')
            params.append(data['role'])
        if 'invoice_prefix' in data:
            updates.append('invoice_prefix = ?')
            params.append(data['invoice_prefix'])
        if 'branch_id' in data:
            updates.append('branch_id = ?')
            params.append(data['branch_id'])
        if 'can_view_products' in data:
            updates.append('can_view_products = ?')
            params.append(data['can_view_products'])
        if 'can_add_products' in data:
            updates.append('can_add_products = ?')
            params.append(data['can_add_products'])
        if 'can_edit_products' in data:
            updates.append('can_edit_products = ?')
            params.append(data['can_edit_products'])
        if 'can_delete_products' in data:
            updates.append('can_delete_products = ?')
            params.append(data['can_delete_products'])
        if 'can_view_inventory' in data:
            updates.append('can_view_inventory = ?')
            params.append(data['can_view_inventory'])
        if 'can_add_inventory' in data:
            updates.append('can_add_inventory = ?')
            params.append(data['can_add_inventory'])
        if 'can_edit_inventory' in data:
            updates.append('can_edit_inventory = ?')
            params.append(data['can_edit_inventory'])
        if 'can_delete_inventory' in data:
            updates.append('can_delete_inventory = ?')
            params.append(data['can_delete_inventory'])
        if 'can_view_invoices' in data:
            updates.append('can_view_invoices = ?')
            params.append(data['can_view_invoices'])
        if 'can_delete_invoices' in data:
            updates.append('can_delete_invoices = ?')
            params.append(data['can_delete_invoices'])
        if 'can_view_customers' in data:
            updates.append('can_view_customers = ?')
            params.append(data['can_view_customers'])
        if 'can_add_customer' in data:
            updates.append('can_add_customer = ?')
            params.append(data['can_add_customer'])
        if 'can_edit_customer' in data:
            updates.append('can_edit_customer = ?')
            params.append(data['can_edit_customer'])
        if 'can_delete_customer' in data:
            updates.append('can_delete_customer = ?')
            params.append(data['can_delete_customer'])
        if 'can_view_reports' in data:
            updates.append('can_view_reports = ?')
            params.append(data['can_view_reports'])
        if 'can_view_accounting' in data:
            updates.append('can_view_accounting = ?')
            params.append(data['can_view_accounting'])
        if 'can_manage_users' in data:
            updates.append('can_manage_users = ?')
            params.append(data['can_manage_users'])
        if 'can_access_settings' in data:
            updates.append('can_access_settings = ?')
            params.append(data['can_access_settings'])
        if 'can_view_returns' in data:
            updates.append('can_view_returns = ?')
            params.append(data['can_view_returns'])
        if 'can_view_expenses' in data:
            updates.append('can_view_expenses = ?')
            params.append(data['can_view_expenses'])
        if 'can_view_suppliers' in data:
            updates.append('can_view_suppliers = ?')
            params.append(data['can_view_suppliers'])
        if 'can_view_coupons' in data:
            updates.append('can_view_coupons = ?')
            params.append(data['can_view_coupons'])
        if 'can_view_tables' in data:
            updates.append('can_view_tables = ?')
            params.append(data['can_view_tables'])
        if 'can_view_attendance' in data:
            updates.append('can_view_attendance = ?')
            params.append(data['can_view_attendance'])
        if 'can_view_advanced_reports' in data:
            updates.append('can_view_advanced_reports = ?')
            params.append(data['can_view_advanced_reports'])
        if 'can_view_system_logs' in data:
            updates.append('can_view_system_logs = ?')
            params.append(data['can_view_system_logs'])
        if 'can_view_dcf' in data:
            updates.append('can_view_dcf = ?')
            params.append(data['can_view_dcf'])
        if 'can_cancel_invoices' in data:
            updates.append('can_cancel_invoices = ?')
            params.append(data['can_cancel_invoices'])
        if 'can_view_branches' in data:
            updates.append('can_view_branches = ?')
            params.append(data['can_view_branches'])
        if 'can_view_cross_branch_stock' in data:
            updates.append('can_view_cross_branch_stock = ?')
            params.append(data['can_view_cross_branch_stock'])
        if 'can_view_xbrl' in data:
            updates.append('can_view_xbrl = ?')
            params.append(data['can_view_xbrl'])
        if 'shift_id' in data:
            updates.append('shift_id = ?')
            params.append(data['shift_id'])
        if 'can_edit_completed_invoices' in data:
            updates.append('can_edit_completed_invoices = ?')
            params.append(data['can_edit_completed_invoices'])
        if 'can_create_transfer' in data:
            updates.append('can_create_transfer = ?')
            params.append(data['can_create_transfer'])
        if 'can_approve_transfer' in data:
            updates.append('can_approve_transfer = ?')
            params.append(data['can_approve_transfer'])
        if 'can_deliver_transfer' in data:
            updates.append('can_deliver_transfer = ?')
            params.append(data['can_deliver_transfer'])
        if 'can_view_transfers' in data:
            updates.append('can_view_transfers = ?')
            params.append(data['can_view_transfers'])
        if 'can_view_subscriptions' in data:
            updates.append('can_view_subscriptions = ?')
            params.append(data['can_view_subscriptions'])
        if 'can_manage_subscriptions' in data:
            updates.append('can_manage_subscriptions = ?')
            params.append(data['can_manage_subscriptions'])
        if 'is_active' in data:
            updates.append('is_active = ?')
            params.append(data['is_active'])
        
        if updates:
            params.append(user_id)
            query = f"UPDATE users SET {', '.join(updates)} WHERE id = ?"
            cursor.execute(query, params)
            conn.commit()
        
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
def delete_user(user_id):
    """حذف مستخدم"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        # لا يمكن حذف المستخدم admin
        cursor.execute('SELECT role FROM users WHERE id = ?', (user_id,))
        user = cursor.fetchone()
        
        if user and dict_from_row(user)['role'] == 'admin':
            return jsonify({'success': False, 'error': 'لا يمكن حذف حساب المدير'}), 400
        
        cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== الصفحة الرئيسية =====
@app.route('/')
def index():
    return send_from_directory('frontend', 'index.html')

@app.route('/sw.js')
def service_worker():
    """SW يجب أن لا يُخزّن مؤقتاً أبداً"""
    response = send_from_directory('frontend', 'sw.js')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

@app.route('/clear-cache')
def clear_cache_page():
    """صفحة لمسح كاش المتصفح و Service Worker"""
    return '''<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>مسح الكاش</title>
<style>
body{font-family:Arial;background:#1a1a2e;color:white;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
.box{background:#16213e;padding:40px;border-radius:16px;text-align:center;max-width:500px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.5);}
h1{color:#667eea;margin-bottom:20px;}
p{color:#aaa;margin-bottom:20px;line-height:1.8;}
.btn{padding:15px 40px;border:none;border-radius:10px;font-size:18px;font-weight:bold;cursor:pointer;margin:10px;display:inline-block;}
.btn-clear{background:#e74c3c;color:white;}
.btn-clear:hover{background:#c0392b;}
.btn-home{background:#28a745;color:white;}
.btn-home:hover{background:#218838;}
#status{margin-top:20px;padding:15px;border-radius:8px;display:none;font-size:14px;line-height:1.6;}
.success{background:#d4edda;color:#155724;display:block!important;}
.error{background:#f8d7da;color:#721c24;display:block!important;}
</style></head>
<body>
<div class="box">
<h1>🔄 مسح الكاش وتحديث النظام</h1>
<p>هذه الصفحة تمسح جميع ملفات الكاش القديمة وتحدّث النظام لآخر إصدار.</p>
<button class="btn btn-clear" onclick="clearAll()">🗑️ مسح الكاش وتحديث</button>
<div id="status"></div>
</div>
<script>
async function clearAll() {
    const status = document.getElementById('status');
    status.className = '';
    status.style.display = 'block';
    status.textContent = '⏳ جاري المسح...';
    try {
        // 1. إلغاء تسجيل جميع Service Workers
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) { await reg.unregister(); }
        status.textContent += '\\n✅ تم إلغاء Service Workers (' + regs.length + ')';
        // 2. حذف جميع الكاشات
        const keys = await caches.keys();
        for (const key of keys) { await caches.delete(key); }
        status.textContent += '\\n✅ تم حذف الكاشات (' + keys.length + ')';
        // 3. مسح localStorage
        const tenant = localStorage.getItem('pos_tenant_slug');
        const viewMode = localStorage.getItem('pos_view_mode');
        localStorage.clear();
        if (tenant) localStorage.setItem('pos_tenant_slug', tenant);
        if (viewMode) localStorage.setItem('pos_view_mode', viewMode);
        status.textContent += '\\n✅ تم مسح البيانات المؤقتة';
        status.className = 'success';
        status.textContent += '\\n\\n🎉 تم التحديث! سيتم إعادة التوجيه...';
        setTimeout(() => { window.location.href = '/'; }, 2000);
    } catch (err) {
        status.className = 'error';
        status.textContent = '❌ خطأ: ' + err.message;
    }
}
</script>
</body></html>'''

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('frontend', path)

# ===== API المنتجات =====

@app.route('/api/products', methods=['GET'])
def get_products():
    """جلب جميع المنتجات - من التوزيعات على الفروع"""
    try:
        branch_id = request.args.get('branch_id')
        conn = get_db()
        cursor = conn.cursor()

        # جلب المنتجات من branch_stock مع معلومات المنتج من inventory
        base_query = '''
            SELECT bs.id, bs.stock, bs.branch_id, bs.inventory_id, bs.variant_id,
                   i.name, i.barcode, i.category, i.price, i.cost, i.image_data,
                   pv.variant_name, pv.price as variant_price, pv.cost as variant_cost, pv.barcode as variant_barcode
            FROM branch_stock bs
            JOIN inventory i ON bs.inventory_id = i.id
            LEFT JOIN product_variants pv ON bs.variant_id = pv.id
        '''
        if branch_id == 'all':
            cursor.execute(base_query + ' ORDER BY bs.branch_id, i.name')
        elif branch_id:
            cursor.execute(base_query + ' WHERE bs.branch_id = ? ORDER BY i.name', (branch_id,))
        else:
            cursor.execute(base_query + ' WHERE bs.branch_id = ? ORDER BY i.name', (1,))

        products = []
        for row in cursor.fetchall():
            p = dict_from_row(row)
            # إذا التوزيع لخاصية معينة، استخدم اسمها وسعرها
            if p.get('variant_id') and p.get('variant_name'):
                p['display_name'] = f"{p['name']} ({p['variant_name']})"
                p['price'] = p.get('variant_price') or p['price']
                p['cost'] = p.get('variant_cost') or p['cost']
                if p.get('variant_barcode'):
                    p['barcode'] = p['variant_barcode']
            else:
                p['display_name'] = p['name']
            products.append(p)

        # جلب المتغيرات الكاملة لكل منتج (للـ POS)
        seen_inv = set()
        for p in products:
            inv_id = p.get('inventory_id')
            if inv_id and inv_id not in seen_inv:
                cursor.execute('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id', (inv_id,))
                variants = [dict_from_row(row) for row in cursor.fetchall()]
                for pp in products:
                    if pp.get('inventory_id') == inv_id:
                        pp['variants'] = variants
                seen_inv.add(inv_id)
            elif inv_id not in seen_inv if inv_id else True:
                p['variants'] = p.get('variants', [])

        conn.close()
        return jsonify({'success': True, 'products': products})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/products', methods=['POST'])
def add_product():
    """إضافة منتج جديد"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO products (name, barcode, price, cost, stock, category, image_data, branch_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            data.get('name'),
            data.get('barcode'),
            data.get('price', 0),
            data.get('cost', 0),
            data.get('stock', 0),
            data.get('category', ''),
            data.get('image_data', ''),
            data.get('branch_id', 1)
        ))
        
        product_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'id': product_id})
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'الباركود موجود مسبقاً'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/products/<int:product_id>', methods=['PUT'])
def update_product(product_id):
    """تحديث منتج"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE products 
            SET name=?, barcode=?, price=?, cost=?, stock=?, category=?, image_data=?, branch_id=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
        ''', (
            data.get('name'),
            data.get('barcode'),
            data.get('price'),
            data.get('cost'),
            data.get('stock'),
            data.get('category'),
            data.get('image_data'),
            data.get('branch_id', 1),
            product_id
        ))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/products/<int:product_id>', methods=['DELETE'])
def delete_product(product_id):
    """حذف منتج"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM products WHERE id=?', (product_id,))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API المخزون الأساسي =====

@app.route('/api/inventory', methods=['GET'])
def get_inventory():
    """جلب جميع المنتجات الأساسية مع متغيراتها"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM inventory ORDER BY name')
        inventory = [dict_from_row(row) for row in cursor.fetchall()]

        # جلب المتغيرات لكل منتج
        for item in inventory:
            cursor.execute('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id', (item['id'],))
            item['variants'] = [dict_from_row(row) for row in cursor.fetchall()]

        conn.close()
        return jsonify({'success': True, 'inventory': inventory})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/inventory', methods=['POST'])
def add_inventory():
    """إضافة منتج أساسي للمخزون"""
    conn = None
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO inventory (name, barcode, category, price, cost, image_data)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (
            data.get('name'),
            data.get('barcode'),
            data.get('category', ''),
            data.get('price', 0),
            data.get('cost', 0),
            data.get('image_data', '')
        ))
        
        inventory_id = cursor.lastrowid
        conn.commit()
        
        return jsonify({'success': True, 'id': inventory_id})
    except sqlite3.IntegrityError:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': 'الباركود موجود مسبقاً'}), 400
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if conn:
            conn.close()

@app.route('/api/inventory/<int:inventory_id>', methods=['PUT'])
def update_inventory(inventory_id):
    """تعديل منتج أساسي"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE inventory 
            SET name=?, barcode=?, category=?, price=?, cost=?, image_data=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
        ''', (
            data.get('name'),
            data.get('barcode'),
            data.get('category'),
            data.get('price'),
            data.get('cost'),
            data.get('image_data'),
            inventory_id
        ))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/inventory/<int:inventory_id>', methods=['DELETE'])
def delete_inventory(inventory_id):
    """حذف منتج أساسي"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        # حذف المتغيرات والتوزيعات أولاً
        cursor.execute('DELETE FROM product_variants WHERE inventory_id=?', (inventory_id,))
        cursor.execute('DELETE FROM branch_stock WHERE inventory_id=?', (inventory_id,))
        cursor.execute('DELETE FROM inventory WHERE id=?', (inventory_id,))
        conn.commit()
        conn.close()

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API خصائص/متغيرات المنتجات =====

@app.route('/api/inventory/<int:inventory_id>/variants', methods=['GET'])
def get_variants(inventory_id):
    """جلب متغيرات منتج"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id', (inventory_id,))
        variants = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'variants': variants})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/inventory/<int:inventory_id>/variants', methods=['POST'])
def save_variants(inventory_id):
    """حفظ متغيرات منتج (استبدال الكل)"""
    conn = None
    try:
        data = request.json
        variants = data.get('variants', [])
        conn = get_db()
        cursor = conn.cursor()

        # حذف المتغيرات القديمة
        cursor.execute('DELETE FROM product_variants WHERE inventory_id = ?', (inventory_id,))

        # إدراج الجديدة
        for v in variants:
            cursor.execute('''
                INSERT INTO product_variants (inventory_id, variant_name, price, cost, barcode)
                VALUES (?, ?, ?, ?, ?)
            ''', (
                inventory_id,
                v.get('variant_name', ''),
                v.get('price', 0),
                v.get('cost', 0),
                v.get('barcode', '')
            ))

        conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if conn:
            conn.close()

# ===== API توزيع المخزون على الفروع =====

@app.route('/api/branch-stock', methods=['GET'])
def get_branch_stock():
    """جلب توزيع المخزون (حسب الفرع أو المنتج)"""
    try:
        branch_id = request.args.get('branch_id')
        inventory_id = request.args.get('inventory_id')
        
        conn = get_db()
        cursor = conn.cursor()
        
        query = '''
            SELECT bs.*, i.name, i.barcode, i.category, i.price, i.cost, i.image_data,
                   pv.variant_name, pv.price as variant_price, pv.cost as variant_cost, pv.barcode as variant_barcode,
                   b.name as branch_name
            FROM branch_stock bs
            JOIN inventory i ON bs.inventory_id = i.id
            LEFT JOIN product_variants pv ON bs.variant_id = pv.id
            LEFT JOIN branches b ON bs.branch_id = b.id
            WHERE 1=1
        '''
        params = []
        
        if branch_id:
            query += ' AND bs.branch_id = ?'
            params.append(branch_id)
        
        if inventory_id:
            query += ' AND bs.inventory_id = ?'
            params.append(inventory_id)
        
        query += ' ORDER BY i.name'
        
        cursor.execute(query, params)
        stock = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({'success': True, 'stock': stock})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/branch-stock', methods=['POST'])
def add_branch_stock():
    """توزيع منتج على فرع"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        variant_id = data.get('variant_id')
        notes = data.get('notes', '').strip()
        added_stock = data.get('stock', 0)

        # بناء سطر الملاحظة مع التاريخ والكمية
        from datetime import datetime
        note_entry = ''
        if notes:
            now = datetime.now().strftime('%Y-%m-%d %H:%M')
            note_entry = f"[{now}] +{added_stock}: {notes}"

        # التحقق من وجود التوزيع (مع variant_id)
        if variant_id:
            cursor.execute('''
                SELECT id, stock, notes FROM branch_stock
                WHERE inventory_id = ? AND branch_id = ? AND variant_id = ?
            ''', (data.get('inventory_id'), data.get('branch_id'), variant_id))
        else:
            cursor.execute('''
                SELECT id, stock, notes FROM branch_stock
                WHERE inventory_id = ? AND branch_id = ? AND (variant_id IS NULL OR variant_id = 0)
            ''', (data.get('inventory_id'), data.get('branch_id')))

        existing = cursor.fetchone()

        if existing:
            new_stock = existing['stock'] + added_stock
            # إلحاق الملاحظة الجديدة بالقديمة
            old_notes = existing['notes'] or ''
            if note_entry:
                combined_notes = (old_notes + '\n' + note_entry).strip() if old_notes else note_entry
            else:
                combined_notes = old_notes
            cursor.execute('''
                UPDATE branch_stock SET stock = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''', (new_stock, combined_notes, existing['id']))
            stock_id = existing['id']
        else:
            cursor.execute('''
                INSERT INTO branch_stock (inventory_id, branch_id, variant_id, stock, notes)
                VALUES (?, ?, ?, ?, ?)
            ''', (
                data.get('inventory_id'),
                data.get('branch_id'),
                variant_id,
                added_stock,
                note_entry
            ))
            stock_id = cursor.lastrowid

        conn.commit()
        conn.close()

        return jsonify({'success': True, 'id': stock_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/branch-stock/<int:stock_id>', methods=['PUT'])
def update_branch_stock(stock_id):
    """تحديث كمية في فرع"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE branch_stock 
            SET stock = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (data.get('stock', 0), stock_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/branch-stock/<int:stock_id>', methods=['DELETE'])
def delete_branch_stock(stock_id):
    """حذف توزيع من فرع"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM branch_stock WHERE id = ?', (stock_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/products/search', methods=['GET'])
def search_products():
    """البحث عن منتج بالاسم أو الباركود - من branch_stock مع فلترة بالفرع"""
    try:
        query = request.args.get('q', '')
        branch_id = request.args.get('branch_id')
        conn = get_db()
        cursor = conn.cursor()

        base_query = '''
            SELECT bs.id, bs.stock, bs.branch_id, bs.inventory_id, bs.variant_id,
                   i.name, i.barcode, i.category, i.price, i.cost, i.image_data,
                   pv.variant_name, pv.price as variant_price, pv.cost as variant_cost, pv.barcode as variant_barcode
            FROM branch_stock bs
            JOIN inventory i ON bs.inventory_id = i.id
            LEFT JOIN product_variants pv ON bs.variant_id = pv.id
            WHERE (i.name LIKE ? OR i.barcode LIKE ? OR pv.barcode LIKE ? OR pv.variant_name LIKE ?)
        '''
        params = [f'%{query}%', f'%{query}%', f'%{query}%', f'%{query}%']

        if branch_id and branch_id != 'all':
            base_query += ' AND bs.branch_id = ?'
            params.append(branch_id)

        base_query += ' ORDER BY i.name LIMIT 20'

        cursor.execute(base_query, params)

        products = []
        for row in cursor.fetchall():
            p = dict_from_row(row)
            if p.get('variant_id') and p.get('variant_name'):
                p['display_name'] = f"{p['name']} ({p['variant_name']})"
                p['price'] = p.get('variant_price') or p['price']
                p['cost'] = p.get('variant_cost') or p['cost']
                if p.get('variant_barcode'):
                    p['barcode'] = p['variant_barcode']
            else:
                p['display_name'] = p['name']
            products.append(p)

        conn.close()

        return jsonify({'success': True, 'products': products})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API الفواتير =====

@app.route('/api/invoices', methods=['GET'])
def get_invoices():
    """جلب الفواتير مع إمكانية التصفية"""
    try:
        # معاملات البحث
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        limit = request.args.get('limit', 100, type=int)
        
        conn = get_db()
        cursor = conn.cursor()
        
        query = 'SELECT * FROM invoices WHERE 1=1'
        params = []
        
        if start_date:
            query += ' AND date(created_at) >= ?'
            params.append(start_date)
        
        if end_date:
            query += ' AND date(created_at) <= ?'
            params.append(end_date)
        
        query += ' ORDER BY created_at DESC LIMIT ?'
        params.append(limit)
        
        cursor.execute(query, params)
        invoices = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({'success': True, 'invoices': invoices})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/invoices/<int:invoice_id>', methods=['GET'])
def get_invoice(invoice_id):
    """جلب فاتورة محددة مع عناصرها"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        # جلب الفاتورة
        cursor.execute('SELECT * FROM invoices WHERE id=?', (invoice_id,))
        invoice_row = cursor.fetchone()
        
        if not invoice_row:
            return jsonify({'success': False, 'error': 'الفاتورة غير موجودة'}), 404
        
        invoice = dict_from_row(invoice_row)
        
        # جلب عناصر الفاتورة
        cursor.execute('SELECT * FROM invoice_items WHERE invoice_id=?', (invoice_id,))
        items = [dict_from_row(row) for row in cursor.fetchall()]
        
        invoice['items'] = items
        conn.close()
        
        return jsonify({'success': True, 'invoice': invoice})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/invoices/clear-all', methods=['DELETE'])
def clear_all_invoices():
    """حذف جميع الفواتير (Admin فقط)"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        # حذف عناصر الفواتير أولاً
        cursor.execute('DELETE FROM invoice_items')
        
        # حذف الفواتير
        cursor.execute('DELETE FROM invoices')
        
        conn.commit()
        deleted_count = cursor.rowcount
        conn.close()
        
        return jsonify({'success': True, 'deleted': deleted_count})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/invoices', methods=['POST'])
def create_invoice():
    """إنشاء فاتورة جديدة"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        # الحصول على اسم الفرع
        branch_id = data.get('branch_id', 1)
        cursor.execute('SELECT name FROM branches WHERE id = ?', (branch_id,))
        branch = cursor.fetchone()
        branch_name = branch['name'] if branch else 'الفرع الرئيسي'
        
        # تعديل رقم الفاتورة ليشمل رقم الفرع (مثل: AHM-001-B1)
        original_invoice_number = data.get('invoice_number', '')
        invoice_number_with_branch = f"{original_invoice_number}-B{branch_id}"
        
        # جلب اسم الشفت إن وجد
        shift_id = data.get('shift_id')
        shift_name = ''
        if shift_id:
            cursor.execute('SELECT name FROM shifts WHERE id = ?', (shift_id,))
            shift_row = cursor.fetchone()
            shift_name = shift_row['name'] if shift_row else ''

        # إدراج الفاتورة
        cursor.execute('''
            INSERT INTO invoices
            (invoice_number, customer_id, customer_name, customer_phone, customer_address,
             subtotal, discount, total, payment_method, employee_name, notes, transaction_number, branch_id, branch_name, delivery_fee,
             coupon_discount, coupon_code, loyalty_discount, loyalty_points_earned, loyalty_points_redeemed,
             table_id, table_name, shift_id, shift_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            invoice_number_with_branch,
            data.get('customer_id'),
            data.get('customer_name', ''),
            data.get('customer_phone', ''),
            data.get('customer_address', ''),
            data.get('subtotal', 0),
            data.get('discount', 0),
            data.get('total', 0),
            data.get('payment_method', 'نقداً'),
            data.get('employee_name', ''),
            data.get('notes', ''),
            data.get('transaction_number', ''),
            branch_id,
            branch_name,
            data.get('delivery_fee', 0),
            data.get('coupon_discount', 0),
            data.get('coupon_code', ''),
            data.get('loyalty_discount', 0),
            data.get('loyalty_points_earned', 0),
            data.get('loyalty_points_redeemed', 0),
            data.get('table_id'),
            data.get('table_name', ''),
            shift_id,
            shift_name
        ))

        invoice_id = cursor.lastrowid

        # ربط الطاولة بالفاتورة
        table_id = data.get('table_id')
        if table_id:
            cursor.execute('UPDATE restaurant_tables SET status = ?, current_invoice_id = ? WHERE id = ?',
                           ('occupied', invoice_id, table_id))

        # إدراج عناصر الفاتورة وتحديث المخزون
        for item in data.get('items', []):
            # الحصول على branch_stock_id
            branch_stock_id = item.get('branch_stock_id') or item.get('product_id')
            
            cursor.execute('''
                INSERT INTO invoice_items
                (invoice_id, product_id, product_name, quantity, price, total, branch_stock_id, variant_id, variant_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                invoice_id,
                item.get('product_id'),
                item.get('product_name'),
                item.get('quantity'),
                item.get('price'),
                item.get('total'),
                branch_stock_id,
                item.get('variant_id'),
                item.get('variant_name')
            ))
            
            # تحديث المخزون في branch_stock
            if branch_stock_id:
                cursor.execute('''
                    UPDATE branch_stock 
                    SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                ''', (item.get('quantity'), branch_stock_id))
        
        # حفظ عمليات الدفع المتعددة كـ JSON
        payments = data.get('payments', [])
        if payments:
            import json as json_mod
            payments_json = json_mod.dumps(payments, ensure_ascii=False)
            cursor.execute('UPDATE invoices SET transaction_number = ? WHERE id = ?', (payments_json, invoice_id))

        # تحديث نقاط الولاء للعميل
        customer_id = data.get('customer_id')
        if customer_id:
            points_earned = data.get('loyalty_points_earned', 0)
            points_redeemed = data.get('loyalty_points_redeemed', 0)
            net_points = points_earned - points_redeemed
            if net_points != 0:
                cursor.execute('''
                    UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?)
                    WHERE id = ?
                ''', (net_points, customer_id))

        conn.commit()

        # فحص المنتجات منخفضة المخزون بعد البيع
        low_stock_warnings = []
        try:
            cursor.execute("SELECT value FROM settings WHERE key = 'low_stock_threshold'")
            threshold_row = cursor.fetchone()
            threshold = int(threshold_row['value']) if threshold_row else 5

            for item in data.get('items', []):
                bs_id = item.get('branch_stock_id') or item.get('product_id')
                if bs_id:
                    cursor.execute('''
                        SELECT bs.stock, inv.name as product_name, pv.variant_name
                        FROM branch_stock bs
                        LEFT JOIN inventory inv ON inv.id = bs.inventory_id
                        LEFT JOIN product_variants pv ON pv.id = bs.variant_id
                        WHERE bs.id = ?
                    ''', (bs_id,))
                    row = cursor.fetchone()
                    if row and row['stock'] <= threshold:
                        pname = row['product_name'] or item.get('product_name', '')
                        if row['variant_name']:
                            pname += f" ({row['variant_name']})"
                        low_stock_warnings.append({
                            'product_name': pname,
                            'stock': row['stock']
                        })
        except Exception as e:
            print(f"[LowStock] Warning check error: {e}")

        conn.close()

        result = {'success': True, 'id': invoice_id, 'invoice_number': invoice_number_with_branch}
        if low_stock_warnings:
            result['low_stock_warnings'] = low_stock_warnings
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/invoices/<int:invoice_id>/status', methods=['PUT'])
def update_invoice_status(invoice_id):
    """تحديث حالة الطلب"""
    try:
        data = request.json
        new_status = data.get('order_status')

        valid_statuses = ['قيد التنفيذ', 'قيد التوصيل', 'منجز']
        if new_status not in valid_statuses:
            return jsonify({'success': False, 'error': 'حالة غير صالحة'}), 400

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('UPDATE invoices SET order_status = ? WHERE id = ?', (new_status, invoice_id))
        conn.commit()
        conn.close()

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/invoices/<int:invoice_id>/cancel', methods=['PUT'])
def cancel_invoice(invoice_id):
    """إلغاء فاتورة مع إرجاع المخزون"""
    try:
        data = request.json
        cancel_reason = data.get('reason', '')
        return_stock = data.get('return_stock', False)

        if not cancel_reason:
            return jsonify({'success': False, 'error': 'يجب تحديد سبب الإلغاء'}), 400

        conn = get_db()
        cursor = conn.cursor()

        # إضافة الأعمدة إذا لم تكن موجودة
        for col_sql in [
            "ALTER TABLE invoices ADD COLUMN cancelled INTEGER DEFAULT 0",
            "ALTER TABLE invoices ADD COLUMN cancel_reason TEXT",
            "ALTER TABLE invoices ADD COLUMN cancelled_at TIMESTAMP",
            "ALTER TABLE invoices ADD COLUMN stock_returned INTEGER DEFAULT 0"
        ]:
            try:
                cursor.execute(col_sql)
                conn.commit()
            except:
                pass

        # التحقق من الفاتورة
        cursor.execute('SELECT * FROM invoices WHERE id = ?', (invoice_id,))
        invoice = cursor.fetchone()
        if not invoice:
            conn.close()
            return jsonify({'success': False, 'error': 'الفاتورة غير موجودة'}), 404

        inv = dict_from_row(invoice)
        if inv.get('cancelled'):
            conn.close()
            return jsonify({'success': False, 'error': 'الفاتورة ملغية مسبقاً'}), 400

        # إرجاع المخزون إذا مطلوب
        stock_returned = 0
        if return_stock:
            cursor.execute('SELECT * FROM invoice_items WHERE invoice_id = ?', (invoice_id,))
            items = cursor.fetchall()
            for item in items:
                bsid = item['branch_stock_id']
                qty = item['quantity']
                if bsid and qty:
                    cursor.execute('''
                        UPDATE branch_stock
                        SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    ''', (qty, bsid))
            stock_returned = 1

        # تحديث الفاتورة
        cursor.execute('''
            UPDATE invoices
            SET cancelled = 1, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP,
                stock_returned = ?, order_status = 'ملغية'
            WHERE id = ?
        ''', (cancel_reason, stock_returned, invoice_id))

        # إرجاع نقاط الولاء للعميل
        customer_id = inv.get('customer_id')
        if customer_id:
            points_earned = inv.get('loyalty_points_earned') or 0
            points_redeemed = inv.get('loyalty_points_redeemed') or 0
            net_reverse = points_redeemed - points_earned
            if net_reverse != 0:
                cursor.execute('''
                    UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?)
                    WHERE id = ?
                ''', (net_reverse, customer_id))

        conn.commit()
        conn.close()

        return jsonify({'success': True, 'stock_returned': bool(stock_returned)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API التالف =====

@app.route('/api/damaged-items', methods=['GET'])
def get_damaged_items():
    """جلب التالف"""
    try:
        branch_id = request.args.get('branch_id')
        conn = get_db()
        cursor = conn.cursor()
        
        query = '''
            SELECT d.*, i.name as product_name, b.name as branch_name
            FROM damaged_items d
            JOIN inventory i ON d.inventory_id = i.id
            LEFT JOIN branches b ON d.branch_id = b.id
            WHERE 1=1
        '''
        params = []
        
        if branch_id:
            query += ' AND d.branch_id = ?'
            params.append(branch_id)
        
        query += ' ORDER BY d.created_at DESC'
        
        cursor.execute(query, params)
        damaged = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({'success': True, 'damaged': damaged})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/damaged-items', methods=['POST'])
def add_damaged_item():
    """إضافة تالف"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        # إضافة التالف
        cursor.execute('''
            INSERT INTO damaged_items 
            (inventory_id, branch_id, quantity, reason, reported_by)
            VALUES (?, ?, ?, ?, ?)
        ''', (
            data.get('inventory_id'),
            data.get('branch_id'),
            data.get('quantity'),
            data.get('reason', ''),
            data.get('reported_by')
        ))
        
        # تحديث المخزون (خصم التالف)
        cursor.execute('''
            UPDATE branch_stock 
            SET stock = stock - ?
            WHERE inventory_id = ? AND branch_id = ?
        ''', (
            data.get('quantity'),
            data.get('inventory_id'),
            data.get('branch_id')
        ))
        
        damaged_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'id': damaged_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/damaged-items/<int:damaged_id>', methods=['DELETE'])
def delete_damaged_item(damaged_id):
    """حذف تالف"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM damaged_items WHERE id = ?', (damaged_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/system-logs', methods=['GET'])
def get_system_logs():
    """جلب سجل النظام"""
    try:
        limit = request.args.get('limit', 500)
        action_type = request.args.get('action_type')
        user_id = request.args.get('user_id')
        date_from = request.args.get('date_from')
        date_to = request.args.get('date_to')

        conn = get_db()
        cursor = conn.cursor()

        query = 'SELECT * FROM system_logs WHERE 1=1'
        params = []

        if action_type:
            query += ' AND action_type = ?'
            params.append(action_type)

        if user_id:
            query += ' AND user_id = ?'
            params.append(user_id)

        if date_from:
            query += ' AND created_at >= ?'
            params.append(date_from + ' 00:00:00')

        if date_to:
            query += ' AND created_at <= ?'
            params.append(date_to + ' 23:59:59')

        query += ' ORDER BY created_at DESC LIMIT ?'
        params.append(limit)

        cursor.execute(query, params)
        logs = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()

        return jsonify({'success': True, 'logs': logs})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/system-logs', methods=['POST'])
def add_system_log():
    """إضافة سجل"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO system_logs 
            (action_type, description, user_id, user_name, branch_id, target_id, details)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (
            data.get('action_type'),
            data.get('description'),
            data.get('user_id'),
            data.get('user_name'),
            data.get('branch_id'),
            data.get('target_id'),
            data.get('details')
        ))
        
        log_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'id': log_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API التقارير =====

@app.route('/api/reports/sales', methods=['GET'])
def sales_report():
    """تقرير المبيعات خلال فترة"""
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        branch_id = request.args.get('branch_id')
        
        conn = get_db()
        cursor = conn.cursor()
        
        # الإحصائيات العامة
        query = '''
            SELECT 
                COUNT(*) as total_invoices,
                SUM(subtotal) as total_subtotal,
                SUM(discount) as total_discount,
                SUM(delivery_fee) as total_delivery,
                SUM(total) as total_sales,
                AVG(total) as average_sale
            FROM invoices
            WHERE 1=1
        '''
        params = []
        
        if start_date:
            query += ' AND date(created_at) >= ?'
            params.append(start_date)
        
        if end_date:
            query += ' AND date(created_at) <= ?'
            params.append(end_date)
        
        if branch_id:
            # البحث بـ branch_id أو branch_name
            try:
                # استخدام cursor منفصل للبحث عن الفرع
                temp_cursor = conn.cursor()
                temp_cursor.execute('SELECT name FROM branches WHERE id = ?', (branch_id,))
                branch = temp_cursor.fetchone()
                if branch:
                    query += ' AND branch_name = ?'
                    params.append(branch['name'])
                else:
                    query += ' AND branch_name LIKE ?'
                    params.append(f'%{branch_id}%')
            except:
                # إذا فشل، استخدم LIKE
                query += ' AND branch_name LIKE ?'
                params.append(f'%{branch_id}%')
        
        cursor.execute(query, params)
        report = dict_from_row(cursor.fetchone())
        
        # تقرير حسب طريقة الدفع
        query_payment = '''
            SELECT payment_method, COUNT(*) as count, SUM(total) as total
            FROM invoices
            WHERE 1=1
        '''
        
        if start_date:
            query_payment += ' AND date(created_at) >= ?'
        if end_date:
            query_payment += ' AND date(created_at) <= ?'
        if branch_id:
            query_payment += ' AND branch_name LIKE ?'
        
        query_payment += ' GROUP BY payment_method'
        
        cursor.execute(query_payment, params)
        payment_methods = [dict_from_row(row) for row in cursor.fetchall()]
        
        # تقرير حسب الفرع
        query_branch = '''
            SELECT branch_name, COUNT(*) as count, SUM(total) as total
            FROM invoices
            WHERE branch_name IS NOT NULL
        '''
        
        if start_date:
            query_branch += ' AND date(created_at) >= ?'
        if end_date:
            query_branch += ' AND date(created_at) <= ?'
        if branch_id:
            query_branch += ' AND branch_name LIKE ?'
        
        query_branch += ' GROUP BY branch_name'
        
        cursor.execute(query_branch, params)
        branches = [dict_from_row(row) for row in cursor.fetchall()]
        
        # جلب الفواتير
        query_invoices = '''
            SELECT * FROM invoices
            WHERE 1=1
        '''
        
        if start_date:
            query_invoices += ' AND date(created_at) >= ?'
        if end_date:
            query_invoices += ' AND date(created_at) <= ?'
        if branch_id:
            query_invoices += ' AND branch_name LIKE ?'
        
        query_invoices += ' ORDER BY created_at DESC'
        
        cursor.execute(query_invoices, params)
        invoices = [dict_from_row(row) for row in cursor.fetchall()]
        
        report['payment_methods'] = payment_methods
        report['branches'] = branches
        report['invoices'] = invoices
        
        conn.close()
        
        return jsonify({'success': True, 'report': report})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/reports/inventory', methods=['GET'])
def inventory_report():
    """تقرير المخزون"""
    try:
        branch_id = request.args.get('branch_id')
        
        conn = get_db()
        cursor = conn.cursor()
        
        # جلب المخزون مع الحسابات
        query = '''
            SELECT 
                i.id,
                i.name,
                i.barcode,
                i.category,
                i.price,
                i.cost,
                bs.branch_id,
                b.name as branch_name,
                bs.stock,
                (bs.stock * i.cost) as stock_value
            FROM inventory i
            LEFT JOIN branch_stock bs ON i.id = bs.inventory_id
            LEFT JOIN branches b ON bs.branch_id = b.id
            WHERE 1=1
        '''
        params = []
        
        if branch_id:
            query += ' AND bs.branch_id = ?'
            params.append(branch_id)
        
        query += ' ORDER BY i.name'
        
        cursor.execute(query, params)
        items = [dict_from_row(row) for row in cursor.fetchall()]
        
        # الإحصائيات
        total_items = len(items)
        total_stock = sum(item['stock'] or 0 for item in items)
        total_value = sum(item['stock_value'] or 0 for item in items)
        
        conn.close()
        
        return jsonify({
            'success': True,
            'report': {
                'total_items': total_items,
                'total_stock': total_stock,
                'total_value': total_value,
                'items': items
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/reports/damaged', methods=['GET'])
def damaged_report():
    """تقرير التالف خلال فترة"""
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        branch_id = request.args.get('branch_id')
        
        conn = get_db()
        cursor = conn.cursor()
        
        query = '''
            SELECT 
                d.*,
                i.name as product_name,
                i.cost,
                (d.quantity * i.cost) as damage_value,
                b.name as branch_name
            FROM damaged_items d
            JOIN inventory i ON d.inventory_id = i.id
            LEFT JOIN branches b ON d.branch_id = b.id
            WHERE 1=1
        '''
        params = []
        
        if start_date:
            query += ' AND date(d.created_at) >= ?'
            params.append(start_date)
        
        if end_date:
            query += ' AND date(d.created_at) <= ?'
            params.append(end_date)
        
        if branch_id:
            query += ' AND d.branch_id = ?'
            params.append(branch_id)
        
        query += ' ORDER BY d.created_at DESC'
        
        cursor.execute(query, params)
        damaged = [dict_from_row(row) for row in cursor.fetchall()]
        
        # الإحصائيات
        total_damaged = sum(item['quantity'] for item in damaged)
        total_value = sum(item['damage_value'] or 0 for item in damaged)
        
        conn.close()
        
        return jsonify({
            'success': True,
            'report': {
                'total_damaged': total_damaged,
                'total_value': total_value,
                'items': damaged
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
        conn.close()
        
        return jsonify({'success': True, 'report': report})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/reports/top-products', methods=['GET'])
def top_products_report():
    """تقرير المنتجات الأكثر مبيعاً"""
    try:
        limit = request.args.get('limit', 10, type=int)
        
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT 
                product_name,
                SUM(quantity) as total_quantity,
                SUM(total) as total_sales,
                COUNT(DISTINCT invoice_id) as times_sold
            FROM invoice_items
            GROUP BY product_name
            ORDER BY total_quantity DESC
            LIMIT ?
        ''', (limit,))
        
        products = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({'success': True, 'products': products})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/reports/low-stock', methods=['GET'])
def low_stock_report():
    """تقرير المنتجات منخفضة المخزون"""
    try:
        threshold = request.args.get('threshold', 10, type=int)
        
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT * FROM products 
            WHERE stock <= ?
            ORDER BY stock ASC
        ''', (threshold,))
        
        products = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({'success': True, 'products': products})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API الإعدادات =====

@app.route('/api/settings', methods=['GET'])
def get_settings():
    """جلب جميع الإعدادات"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM settings')
        settings = {row['key']: row['value'] for row in cursor.fetchall()}
        conn.close()
        return jsonify({'success': True, 'settings': settings})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/settings', methods=['PUT'])
def update_settings():
    """تحديث الإعدادات"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        for key, value in data.items():
            cursor.execute('''
                INSERT OR REPLACE INTO settings (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
            ''', (key, value))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API الفروع =====

@app.route('/api/branches', methods=['GET'])
def get_branches():
    """جلب كل الفروع"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM branches WHERE is_active = 1 ORDER BY name')
        branches = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'branches': branches})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/branches', methods=['POST'])
def add_branch():
    """إضافة فرع جديد"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO branches (name, location, phone)
            VALUES (?, ?, ?)
        ''', (data.get('name'), data.get('location', ''), data.get('phone', '')))
        branch_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'id': branch_id})
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'اسم الفرع موجود مسبقاً'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/branches/<int:branch_id>', methods=['PUT'])
def update_branch(branch_id):
    """تحديث فرع"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        updates = []
        params = []
        
        if 'name' in data:
            updates.append('name = ?')
            params.append(data['name'])
        if 'location' in data:
            updates.append('location = ?')
            params.append(data['location'])
        if 'phone' in data:
            updates.append('phone = ?')
            params.append(data['phone'])
        if 'is_active' in data:
            updates.append('is_active = ?')
            params.append(data['is_active'])
        
        if updates:
            params.append(branch_id)
            query = f"UPDATE branches SET {', '.join(updates)} WHERE id = ?"
            cursor.execute(query, params)
            conn.commit()
        
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/branches/<int:branch_id>', methods=['DELETE'])
def delete_branch(branch_id):
    """حذف فرع (soft delete)"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('UPDATE branches SET is_active = 0 WHERE id = ?', (branch_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API سجل الحضور =====

@app.route('/api/attendance/check-in', methods=['POST'])
def check_in():
    """تسجيل حضور"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO attendance_log (user_id, user_name, branch_id, check_in)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ''', (data.get('user_id'), data.get('user_name'), data.get('branch_id', 1)))
        attendance_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'id': attendance_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/attendance/check-out', methods=['POST'])
def check_out():
    """تسجيل انصراف"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        # البحث عن آخر سجل حضور بدون انصراف
        cursor.execute('''
            SELECT id FROM attendance_log
            WHERE user_id = ? AND check_out IS NULL
            ORDER BY check_in DESC LIMIT 1
        ''', (data.get('user_id'),))
        record = cursor.fetchone()
        
        if record:
            cursor.execute('''
                UPDATE attendance_log SET check_out = CURRENT_TIMESTAMP
                WHERE id = ?
            ''', (record['id'],))
            conn.commit()
            conn.close()
            return jsonify({'success': True})
        else:
            conn.close()
            return jsonify({'success': False, 'error': 'لا يوجد سجل حضور'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/attendance', methods=['GET'])
def get_attendance():
    """جلب سجل الحضور مع الفلترة"""
    try:
        user_id = request.args.get('user_id')
        date = request.args.get('date')
        branch_id = request.args.get('branch_id')
        
        conn = get_db()
        cursor = conn.cursor()
        
        query = 'SELECT * FROM attendance_log WHERE 1=1'
        params = []
        
        if user_id:
            query += ' AND user_id = ?'
            params.append(user_id)
        
        if date:
            query += ' AND DATE(check_in) = ?'
            params.append(date)
        
        if branch_id:
            query += ' AND branch_id = ?'
            params.append(branch_id)
        
        query += ' ORDER BY check_in DESC'
        
        cursor.execute(query, params)
        records = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'records': records})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API العملاء (CRM) =====

@app.route('/api/customers', methods=['GET'])
def get_customers():
    """جلب جميع العملاء"""
    try:
        search = request.args.get('search', '')
        conn = get_db()
        cursor = conn.cursor()
        
        if search:
            cursor.execute('''
                SELECT *, 
                       (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
                       (SELECT SUM(total) FROM invoices WHERE customer_id = customers.id) as total_spent
                FROM customers 
                WHERE name LIKE ? OR phone LIKE ? OR address LIKE ?
                ORDER BY created_at DESC
            ''', (f'%{search}%', f'%{search}%', f'%{search}%'))
        else:
            cursor.execute('''
                SELECT *, 
                       (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
                       (SELECT SUM(total) FROM invoices WHERE customer_id = customers.id) as total_spent
                FROM customers 
                ORDER BY created_at DESC
            ''')
        
        customers = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({'success': True, 'customers': customers})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customers/<int:customer_id>', methods=['GET'])
def get_customer(customer_id):
    """جلب بيانات عميل محدد"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT *,
                   (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
                   (SELECT SUM(total) FROM invoices WHERE customer_id = customers.id) as total_spent
            FROM customers WHERE id = ?
        ''', (customer_id,))
        row = cursor.fetchone()
        conn.close()

        if row:
            return jsonify({'success': True, 'customer': dict_from_row(row)})
        else:
            return jsonify({'success': False, 'error': 'العميل غير موجود'}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customers/search', methods=['GET'])
def search_customer():
    """البحث عن عميل بالهاتف"""
    try:
        phone = request.args.get('phone', '')
        if not phone:
            return jsonify({'success': False, 'error': 'رقم الهاتف مطلوب'}), 400
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT *,
                   COALESCE(loyalty_points, 0) as points,
                   (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
                   (SELECT SUM(total) FROM invoices WHERE customer_id = customers.id) as total_spent
            FROM customers WHERE phone = ?
        ''', (phone,))
        row = cursor.fetchone()
        conn.close()
        if row:
            return jsonify({'success': True, 'customer': dict_from_row(row)})
        else:
            return jsonify({'success': False, 'error': 'العميل غير موجود'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customers/<int:customer_id>/points/adjust', methods=['POST'])
def adjust_customer_points(customer_id):
    """تعديل نقاط الولاء للعميل"""
    try:
        data = request.json
        points = data.get('points', 0)
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?)
            WHERE id = ?
        ''', (points, customer_id))
        conn.commit()
        cursor.execute('SELECT COALESCE(loyalty_points, 0) as loyalty_points FROM customers WHERE id = ?', (customer_id,))
        row = cursor.fetchone()
        conn.close()
        return jsonify({'success': True, 'new_points': row['loyalty_points'] if row else 0})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customers', methods=['POST'])
def add_customer():
    """إضافة أو تحديث عميل"""
    conn = None
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        # البحث عن عميل موجود بنفس الهاتف
        phone = data.get('phone', '')
        if phone:
            cursor.execute('SELECT id FROM customers WHERE phone = ?', (phone,))
            existing = cursor.fetchone()
            
            if existing:
                # تحديث العميل الموجود
                cursor.execute('''
                    UPDATE customers 
                    SET name = ?, address = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                ''', (
                    data.get('name', ''),
                    data.get('address', ''),
                    data.get('notes', ''),
                    existing['id']
                ))
                conn.commit()
                return jsonify({'success': True, 'id': existing['id'], 'updated': True})
        
        # إضافة عميل جديد
        cursor.execute('''
            INSERT INTO customers (name, phone, address, notes)
            VALUES (?, ?, ?, ?)
        ''', (
            data.get('name', ''),
            data.get('phone', ''),
            data.get('address', ''),
            data.get('notes', '')
        ))
        
        customer_id = cursor.lastrowid
        conn.commit()
        
        return jsonify({'success': True, 'id': customer_id})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if conn:
            conn.close()

@app.route('/api/customers/<int:customer_id>', methods=['PUT'])
def update_customer(customer_id):
    """تحديث بيانات عميل"""
    conn = None
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE customers 
            SET name = ?, phone = ?, address = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (
            data.get('name', ''),
            data.get('phone', ''),
            data.get('address', ''),
            data.get('notes', ''),
            customer_id
        ))
        
        conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if conn:
            conn.close()

@app.route('/api/customers/<int:customer_id>', methods=['DELETE'])
def delete_customer(customer_id):
    """حذف عميل"""
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM customers WHERE id = ?', (customer_id,))
        conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if conn:
            conn.close()

@app.route('/api/customers/<int:customer_id>/invoices', methods=['GET'])
def get_customer_invoices(customer_id):
    """جلب فواتير عميل محدد"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT * FROM invoices 
            WHERE customer_id = ?
            ORDER BY created_at DESC
        ''', (customer_id,))
        
        invoices = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({'success': True, 'invoices': invoices})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API التكاليف =====

@app.route('/api/expenses', methods=['GET'])
def get_expenses():
    """جلب التكاليف"""
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        branch_id = request.args.get('branch_id')

        conn = get_db()
        cursor = conn.cursor()

        query = 'SELECT * FROM expenses WHERE 1=1'
        params = []

        if start_date:
            query += ' AND date(expense_date) >= ?'
            params.append(start_date)
        if end_date:
            query += ' AND date(expense_date) <= ?'
            params.append(end_date)
        if branch_id:
            query += ' AND branch_id = ?'
            params.append(branch_id)

        query += ' ORDER BY expense_date DESC'

        cursor.execute(query, params)
        expenses = [dict_from_row(row) for row in cursor.fetchall()]

        # جلب تفاصيل الرواتب لكل تكلفة نوعها رواتب
        for exp in expenses:
            if exp['expense_type'] == 'رواتب':
                cursor.execute('SELECT * FROM salary_details WHERE expense_id = ? ORDER BY id', (exp['id'],))
                exp['salary_details'] = [dict_from_row(row) for row in cursor.fetchall()]
            else:
                exp['salary_details'] = []

        conn.close()

        return jsonify({'success': True, 'expenses': expenses})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/expenses', methods=['POST'])
def add_expense():
    """إضافة تكلفة"""
    conn = None
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('''
            INSERT INTO expenses (expense_type, amount, description, expense_date, branch_id, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (
            data.get('expense_type'),
            data.get('amount'),
            data.get('description', ''),
            data.get('expense_date'),
            data.get('branch_id'),
            data.get('created_by')
        ))

        expense_id = cursor.lastrowid

        # حفظ تفاصيل الرواتب إذا كان النوع رواتب
        salary_details = data.get('salary_details', [])
        if data.get('expense_type') == 'رواتب' and salary_details:
            for emp in salary_details:
                cursor.execute('''
                    INSERT INTO salary_details (expense_id, employee_name, monthly_salary)
                    VALUES (?, ?, ?)
                ''', (expense_id, emp.get('employee_name', ''), emp.get('monthly_salary', 0)))

        conn.commit()

        return jsonify({'success': True, 'id': expense_id})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if conn:
            conn.close()

@app.route('/api/expenses/<int:expense_id>', methods=['DELETE'])
def delete_expense(expense_id):
    """حذف تكلفة"""
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        # حذف تفاصيل الرواتب المرتبطة
        cursor.execute('DELETE FROM salary_details WHERE expense_id = ?', (expense_id,))
        cursor.execute('DELETE FROM expenses WHERE id = ?', (expense_id,))
        conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if conn:
            conn.close()

# ===== التقارير المتقدمة =====

@app.route('/api/reports/sales-by-product', methods=['GET'])
def sales_by_product():
    """تقرير المبيعات حسب المنتج"""
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        branch_id = request.args.get('branch_id')
        
        conn = get_db()
        cursor = conn.cursor()
        
        query = '''
            SELECT 
                ii.product_name,
                SUM(ii.quantity) as total_quantity,
                SUM(ii.total) as total_sales,
                COUNT(DISTINCT ii.invoice_id) as invoice_count,
                AVG(ii.price) as avg_price
            FROM invoice_items ii
            JOIN invoices i ON ii.invoice_id = i.id
            WHERE 1=1
        '''
        params = []
        
        if start_date:
            query += ' AND date(i.created_at) >= ?'
            params.append(start_date)
        if end_date:
            query += ' AND date(i.created_at) <= ?'
            params.append(end_date)
        if branch_id:
            cursor.execute('SELECT name FROM branches WHERE id = ?', (branch_id,))
            branch = cursor.fetchone()
            if branch:
                query += ' AND i.branch_name = ?'
                params.append(branch['name'])
        
        query += ' GROUP BY ii.product_name ORDER BY total_sales DESC'
        
        cursor.execute(query, params)
        products = [dict_from_row(row) for row in cursor.fetchall()]
        
        # إحصائيات إجمالية
        total_sales = sum(p['total_sales'] for p in products)
        total_quantity = sum(p['total_quantity'] for p in products)
        
        conn.close()
        
        return jsonify({
            'success': True,
            'products': products,
            'summary': {
                'total_sales': total_sales,
                'total_quantity': total_quantity,
                'products_count': len(products)
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/reports/sales-by-branch', methods=['GET'])
def sales_by_branch():
    """تقرير المبيعات حسب الفرع"""
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        conn = get_db()
        cursor = conn.cursor()
        
        query = '''
            SELECT 
                branch_name,
                COUNT(*) as invoice_count,
                SUM(subtotal) as total_subtotal,
                SUM(discount) as total_discount,
                SUM(delivery_fee) as total_delivery,
                SUM(total) as total_sales,
                AVG(total) as avg_sale
            FROM invoices
            WHERE 1=1
        '''
        params = []
        
        if start_date:
            query += ' AND date(created_at) >= ?'
            params.append(start_date)
        if end_date:
            query += ' AND date(created_at) <= ?'
            params.append(end_date)
        
        query += ' GROUP BY branch_name ORDER BY total_sales DESC'
        
        cursor.execute(query, params)
        branches = [dict_from_row(row) for row in cursor.fetchall()]
        
        # إحصائيات إجمالية
        total_sales = sum(b['total_sales'] for b in branches)
        total_invoices = sum(b['invoice_count'] for b in branches)
        
        conn.close()
        
        return jsonify({
            'success': True,
            'branches': branches,
            'summary': {
                'total_sales': total_sales,
                'total_invoices': total_invoices,
                'branches_count': len(branches)
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/reports/profit-loss', methods=['GET'])
def profit_loss():
    """تقرير الربح والخسارة"""
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        branch_id = request.args.get('branch_id')
        
        conn = get_db()
        cursor = conn.cursor()
        
        # حساب المبيعات
        sales_query = 'SELECT SUM(total) as total_sales, SUM(subtotal) as subtotal FROM invoices WHERE 1=1'
        sales_params = []
        
        if start_date:
            sales_query += ' AND date(created_at) >= ?'
            sales_params.append(start_date)
        if end_date:
            sales_query += ' AND date(created_at) <= ?'
            sales_params.append(end_date)
        if branch_id:
            cursor.execute('SELECT name FROM branches WHERE id = ?', (branch_id,))
            branch = cursor.fetchone()
            if branch:
                sales_query += ' AND branch_name = ?'
                sales_params.append(branch['name'])
        
        cursor.execute(sales_query, sales_params)
        sales_data = dict_from_row(cursor.fetchone())
        total_revenue = sales_data['total_sales'] or 0
        
        # حساب تكلفة البضاعة المباعة (COGS)
        cogs_query = '''
            SELECT SUM(ii.quantity * COALESCE(inv.cost, 0)) as total_cogs
            FROM invoice_items ii
            LEFT JOIN inventory inv ON ii.product_name = inv.name
            JOIN invoices i ON ii.invoice_id = i.id
            WHERE 1=1
        '''
        cogs_params = []
        
        if start_date:
            cogs_query += ' AND date(i.created_at) >= ?'
            cogs_params.append(start_date)
        if end_date:
            cogs_query += ' AND date(i.created_at) <= ?'
            cogs_params.append(end_date)
        if branch_id:
            cursor.execute('SELECT name FROM branches WHERE id = ?', (branch_id,))
            branch = cursor.fetchone()
            if branch:
                cogs_query += ' AND i.branch_name = ?'
                cogs_params.append(branch['name'])
        
        cursor.execute(cogs_query, cogs_params)
        cogs_data = dict_from_row(cursor.fetchone())
        total_cogs = cogs_data['total_cogs'] or 0
        
        # حساب التكاليف
        expenses_query = 'SELECT SUM(amount) as total_expenses FROM expenses WHERE 1=1'
        expenses_params = []
        
        if start_date:
            expenses_query += ' AND date(expense_date) >= ?'
            expenses_params.append(start_date)
        if end_date:
            expenses_query += ' AND date(expense_date) <= ?'
            expenses_params.append(end_date)
        if branch_id:
            expenses_query += ' AND branch_id = ?'
            expenses_params.append(branch_id)
        
        cursor.execute(expenses_query, expenses_params)
        expenses_data = dict_from_row(cursor.fetchone())
        total_expenses = expenses_data['total_expenses'] or 0
        
        # حساب الربح
        gross_profit = total_revenue - total_cogs
        net_profit = gross_profit - total_expenses
        profit_margin = (net_profit / total_revenue * 100) if total_revenue > 0 else 0
        
        conn.close()
        
        return jsonify({
            'success': True,
            'report': {
                'total_revenue': total_revenue,
                'total_cogs': total_cogs,
                'gross_profit': gross_profit,
                'total_expenses': total_expenses,
                'net_profit': net_profit,
                'profit_margin': profit_margin
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== نظام المرتجعات =====

@app.route('/api/returns', methods=['GET'])
def get_returns():
    """جلب جميع المرتجعات"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT * FROM returns 
            ORDER BY created_at DESC
        ''')
        
        returns = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({
            'success': True,
            'returns': returns
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/returns/<int:return_id>', methods=['GET'])
def get_return(return_id):
    """جلب تفاصيل مرتجع واحد"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('SELECT * FROM returns WHERE id = ?', (return_id,))
        return_data = cursor.fetchone()
        conn.close()
        
        if not return_data:
            return jsonify({'success': False, 'error': 'المرتجع غير موجود'}), 404
        
        return jsonify({
            'success': True,
            'return': dict_from_row(return_data)
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/returns', methods=['POST'])
def add_return():
    """إضافة مرتجع"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        
        # إضافة المرتجع
        cursor.execute('''
            INSERT INTO returns (
                invoice_id, invoice_number, product_id, product_name,
                quantity, price, total, reason, employee_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            data.get('invoice_id'),
            data.get('invoice_number'),
            data.get('product_id'),
            data.get('product_name'),
            data.get('quantity'),
            data.get('price'),
            data.get('total'),
            data.get('reason'),
            data.get('employee_name')
        ))
        
        # إعادة المنتج للمخزون
        if data.get('product_id'):
            cursor.execute('''
                UPDATE products 
                SET stock = stock + ? 
                WHERE id = ?
            ''', (data.get('quantity'), data.get('product_id')))
        
        conn.commit()
        return_id = cursor.lastrowid
        conn.close()
        
        return jsonify({
            'success': True,
            'return_id': return_id,
            'message': 'تم إضافة المرتجع وإعادة المنتج للمخزون'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/returns/<int:return_id>', methods=['DELETE'])
def delete_return(return_id):
    """حذف مرتجع"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        # جلب بيانات المرتجع قبل الحذف
        cursor.execute('SELECT * FROM returns WHERE id = ?', (return_id,))
        return_data = dict_from_row(cursor.fetchone())
        
        if not return_data:
            return jsonify({'success': False, 'error': 'المرتجع غير موجود'}), 404
        
        # إعادة خصم المنتج من المخزون
        if return_data.get('product_id'):
            cursor.execute('''
                UPDATE products 
                SET stock = stock - ? 
                WHERE id = ?
            ''', (return_data['quantity'], return_data['product_id']))
        
        # حذف المرتجع
        cursor.execute('DELETE FROM returns WHERE id = ?', (return_id,))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': 'تم حذف المرتجع'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== تشغيل الخادم =====

# ===== API طاولات المطاعم =====

@app.route('/api/tables', methods=['GET'])
def get_tables():
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT rt.*, i.invoice_number, i.total as invoice_total, i.customer_name as invoice_customer
            FROM restaurant_tables rt
            LEFT JOIN invoices i ON rt.current_invoice_id = i.id
            ORDER BY rt.id
        ''')
        tables = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'tables': tables})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/tables', methods=['POST'])
def add_table():
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO restaurant_tables (name, seats, pos_x, pos_y)
            VALUES (?, ?, ?, ?)
        ''', (data.get('name', 'طاولة'), data.get('seats', 4), data.get('pos_x', 50), data.get('pos_y', 50)))
        conn.commit()
        table_id = cursor.lastrowid
        conn.close()
        return jsonify({'success': True, 'id': table_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/tables/<int:table_id>', methods=['PUT'])
def update_table(table_id):
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        fields = []
        values = []
        for key in ['name', 'seats', 'pos_x', 'pos_y', 'status', 'current_invoice_id']:
            if key in data:
                fields.append(f'{key} = ?')
                values.append(data[key])
        if fields:
            values.append(table_id)
            cursor.execute(f'UPDATE restaurant_tables SET {", ".join(fields)} WHERE id = ?', values)
            conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/tables/<int:table_id>', methods=['DELETE'])
def delete_table(table_id):
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM restaurant_tables WHERE id = ?', (table_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/tables/<int:table_id>/assign', methods=['POST'])
def assign_table_invoice(table_id):
    """ربط فاتورة بطاولة"""
    try:
        data = request.json
        invoice_id = data.get('invoice_id')
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('UPDATE restaurant_tables SET status = ?, current_invoice_id = ? WHERE id = ?',
                       ('occupied', invoice_id, table_id))
        if invoice_id:
            cursor.execute('SELECT name FROM restaurant_tables WHERE id = ?', (table_id,))
            tbl = cursor.fetchone()
            table_name = tbl['name'] if tbl else ''
            cursor.execute('UPDATE invoices SET table_id = ?, table_name = ? WHERE id = ?',
                           (table_id, table_name, invoice_id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/tables/<int:table_id>/release', methods=['POST'])
def release_table(table_id):
    """تحرير طاولة"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('UPDATE restaurant_tables SET status = ?, current_invoice_id = NULL WHERE id = ?',
                       ('available', table_id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/tables/<int:table_id>/reserve', methods=['POST'])
def reserve_table(table_id):
    """حجز طاولة"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT status FROM restaurant_tables WHERE id = ?', (table_id,))
        table = cursor.fetchone()
        if not table:
            conn.close()
            return jsonify({'success': False, 'error': 'الطاولة غير موجودة'}), 404
        if table['status'] == 'occupied':
            conn.close()
            return jsonify({'success': False, 'error': 'لا يمكن حجز طاولة مشغولة'}), 400
        cursor.execute('UPDATE restaurant_tables SET status = ? WHERE id = ?',
                       ('reserved', table_id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API الكوبونات =====

@app.route('/api/coupons', methods=['GET'])
def get_coupons():
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM coupons ORDER BY created_at DESC')
        coupons = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'coupons': coupons})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/coupons', methods=['POST'])
def add_coupon():
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO coupons (code, discount_type, discount_value, min_amount, max_uses, expiry_date, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (data.get('code', '').upper(), data.get('discount_type', 'amount'),
              data.get('discount_value', 0), data.get('min_amount', 0),
              data.get('max_uses', 0), data.get('expiry_date', ''), data.get('notes', '')))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'id': cursor.lastrowid})
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'كود الكوبون موجود مسبقاً'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/coupons/<int:coupon_id>', methods=['PUT'])
def update_coupon(coupon_id):
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE coupons SET code=?, discount_type=?, discount_value=?, min_amount=?,
                   max_uses=?, is_active=?, expiry_date=?, notes=?
            WHERE id=?
        ''', (data.get('code', '').upper(), data.get('discount_type', 'amount'),
              data.get('discount_value', 0), data.get('min_amount', 0),
              data.get('max_uses', 0), data.get('is_active', 1),
              data.get('expiry_date', ''), data.get('notes', ''), coupon_id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/coupons/<int:coupon_id>', methods=['DELETE'])
def delete_coupon(coupon_id):
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM coupons WHERE id = ?', (coupon_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/coupons/validate', methods=['POST'])
def validate_coupon():
    """التحقق من صلاحية كوبون وحساب الخصم"""
    try:
        data = request.json
        code = data.get('code', '').upper()
        subtotal = data.get('subtotal', 0)

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM coupons WHERE code = ?', (code,))
        row = cursor.fetchone()

        if not row:
            conn.close()
            return jsonify({'success': False, 'error': 'كود الكوبون غير صحيح'})

        coupon = dict_from_row(row)

        if not coupon['is_active']:
            conn.close()
            return jsonify({'success': False, 'error': 'الكوبون غير مفعّل'})

        if coupon['expiry_date'] and coupon['expiry_date'] < datetime.now().strftime('%Y-%m-%d'):
            conn.close()
            return jsonify({'success': False, 'error': 'الكوبون منتهي الصلاحية'})

        if coupon['max_uses'] > 0 and coupon['used_count'] >= coupon['max_uses']:
            conn.close()
            return jsonify({'success': False, 'error': 'تم استخدام الكوبون الحد الأقصى من المرات'})

        if subtotal < coupon['min_amount']:
            conn.close()
            return jsonify({'success': False, 'error': f'الحد الأدنى للطلب {coupon["min_amount"]:.3f} د.ك'})

        # حساب الخصم
        if coupon['discount_type'] == 'percent':
            discount = subtotal * (coupon['discount_value'] / 100)
        else:
            discount = coupon['discount_value']

        conn.close()
        return jsonify({'success': True, 'discount': round(discount, 3), 'coupon': coupon})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/coupons/use', methods=['POST'])
def use_coupon():
    """تسجيل استخدام كوبون"""
    try:
        data = request.json
        code = data.get('code', '').upper()
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', (code,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== API الموردين =====

@app.route('/api/suppliers', methods=['GET'])
def get_suppliers():
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT s.*,
                   (SELECT COUNT(*) FROM supplier_invoices WHERE supplier_id = s.id) as invoice_count,
                   (SELECT SUM(amount) FROM supplier_invoices WHERE supplier_id = s.id) as total_amount
            FROM suppliers s ORDER BY s.created_at DESC
        ''')
        suppliers = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'suppliers': suppliers})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/suppliers', methods=['POST'])
def add_supplier():
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO suppliers (name, phone, email, address, company, notes)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (data.get('name'), data.get('phone', ''), data.get('email', ''),
              data.get('address', ''), data.get('company', ''), data.get('notes', '')))
        conn.commit()
        supplier_id = cursor.lastrowid
        conn.close()
        return jsonify({'success': True, 'id': supplier_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/suppliers/<int:supplier_id>', methods=['PUT'])
def update_supplier(supplier_id):
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE suppliers SET name=?, phone=?, email=?, address=?, company=?, notes=?
            WHERE id=?
        ''', (data.get('name'), data.get('phone', ''), data.get('email', ''),
              data.get('address', ''), data.get('company', ''), data.get('notes', ''), supplier_id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/suppliers/<int:supplier_id>', methods=['DELETE'])
def delete_supplier(supplier_id):
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM supplier_invoices WHERE supplier_id = ?', (supplier_id,))
        cursor.execute('DELETE FROM suppliers WHERE id = ?', (supplier_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/suppliers/<int:supplier_id>/invoices', methods=['GET'])
def get_supplier_invoices(supplier_id):
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT id, supplier_id, invoice_number, amount, file_name, file_type, notes, invoice_date, created_at FROM supplier_invoices WHERE supplier_id = ? ORDER BY created_at DESC', (supplier_id,))
        invoices = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'invoices': invoices})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/suppliers/invoices', methods=['POST'])
def add_supplier_invoice():
    try:
        data = request.json
        file_data = data.get('file_data', '')

        # التحقق من حجم الملف (1 MB = ~1.37 MB base64)
        if file_data and len(file_data) > 1400000:
            return jsonify({'success': False, 'error': 'حجم الملف يتجاوز 1 ميجابايت'}), 400

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO supplier_invoices (supplier_id, invoice_number, amount, file_name, file_data, file_type, notes, invoice_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (data.get('supplier_id'), data.get('invoice_number', ''), data.get('amount', 0),
              data.get('file_name', ''), file_data, data.get('file_type', ''),
              data.get('notes', ''), data.get('invoice_date', '')))
        conn.commit()
        invoice_id = cursor.lastrowid
        conn.close()
        return jsonify({'success': True, 'id': invoice_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/suppliers/invoices/<int:invoice_id>', methods=['DELETE'])
def delete_supplier_invoice(invoice_id):
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM supplier_invoices WHERE id = ?', (invoice_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/suppliers/invoices/<int:invoice_id>/file', methods=['GET'])
def get_supplier_invoice_file(invoice_id):
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT file_data, file_name, file_type FROM supplier_invoices WHERE id = ?', (invoice_id,))
        row = cursor.fetchone()
        conn.close()
        if row:
            return jsonify({'success': True, 'file_data': row['file_data'], 'file_name': row['file_name'], 'file_type': row['file_type']})
        return jsonify({'success': False, 'error': 'الملف غير موجود'}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== نظام Multi-Tenancy API =====

@app.route('/api/super-admin/login', methods=['POST'])
def super_admin_login():
    """تسجيل دخول المدير الأعلى"""
    try:
        data = request.json
        username = data.get('username', '')
        password = data.get('password', '')
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM super_admins WHERE username = ? AND password = ?',
                       (username, hash_password(password)))
        admin = cursor.fetchone()
        conn.close()
        if admin:
            return jsonify({
                'success': True,
                'admin': {
                    'id': admin['id'],
                    'username': admin['username'],
                    'full_name': admin['full_name'],
                    'role': 'super_admin'
                }
            })
        return jsonify({'success': False, 'error': 'بيانات الدخول غير صحيحة'}), 401
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/tenants', methods=['GET'])
def get_tenants():
    """جلب قائمة المستأجرين"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM tenants ORDER BY created_at DESC')
        tenants = [dict_from_row(row) for row in cursor.fetchall()]
        # إضافة إحصائيات لكل مستأجر
        for tenant in tenants:
            try:
                t_conn = sqlite3.connect(tenant['db_path'])
                t_conn.row_factory = sqlite3.Row
                t_cursor = t_conn.cursor()
                t_cursor.execute("SELECT COUNT(*) as c FROM users")
                tenant['users_count'] = t_cursor.fetchone()['c']
                t_cursor.execute("SELECT COUNT(*) as c FROM invoices")
                tenant['invoices_count'] = t_cursor.fetchone()['c']
                t_cursor.execute("SELECT COUNT(*) as c FROM products")
                tenant['products_count'] = t_cursor.fetchone()['c']
                t_conn.close()
            except:
                tenant['users_count'] = 0
                tenant['invoices_count'] = 0
                tenant['products_count'] = 0
        conn.close()
        return jsonify({'success': True, 'tenants': tenants})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/tenants', methods=['POST'])
def create_tenant():
    """إنشاء مستأجر جديد"""
    try:
        data = request.json
        name = data.get('name', '').strip()
        slug = data.get('slug', '').strip().lower()
        owner_name = data.get('owner_name', '').strip()
        owner_email = data.get('owner_email', '').strip()
        owner_phone = data.get('owner_phone', '').strip()
        admin_username = data.get('admin_username', 'admin').strip()
        admin_password = data.get('admin_password', 'admin123').strip()
        plan = data.get('plan', 'basic')
        max_users = data.get('max_users', 5)
        max_branches = data.get('max_branches', 3)
        subscription_amount = data.get('subscription_amount', 0)
        subscription_period = data.get('subscription_period', 30)

        if not name or not slug or not owner_name:
            return jsonify({'success': False, 'error': 'الاسم والمعرف واسم المالك مطلوبة'}), 400

        # تنظيف slug
        slug = re.sub(r'[^a-zA-Z0-9_-]', '', slug)
        if not slug:
            return jsonify({'success': False, 'error': 'المعرف (slug) غير صالح'}), 400

        db_path = get_tenant_db_path(slug)

        # التحقق من عدم وجود مستأجر بنفس المعرف
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM tenants WHERE slug = ?', (slug,))
        if cursor.fetchone():
            conn.close()
            return jsonify({'success': False, 'error': 'هذا المعرف مستخدم بالفعل'}), 400

        # إنشاء قاعدة بيانات المستأجر
        create_tenant_database(slug)

        # إضافة مستخدم أدمن للمستأجر
        t_conn = sqlite3.connect(db_path)
        t_cursor = t_conn.cursor()
        t_cursor.execute('''
            INSERT INTO users (username, password, full_name, role, invoice_prefix, is_active, branch_id)
            VALUES (?, ?, ?, 'admin', 'INV', 1, 1)
        ''', (admin_username, admin_password, owner_name))
        t_conn.commit()
        t_conn.close()

        # تسجيل المستأجر في القاعدة الرئيسية
        cursor.execute('''
            INSERT INTO tenants (name, slug, owner_name, owner_email, owner_phone, db_path, plan, max_users, max_branches, subscription_amount, subscription_period)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (name, slug, owner_name, owner_email, owner_phone, db_path, plan, max_users, max_branches, subscription_amount, subscription_period))
        conn.commit()
        tenant_id = cursor.lastrowid
        conn.close()

        return jsonify({'success': True, 'id': tenant_id, 'slug': slug})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/tenants/<int:tenant_id>', methods=['PUT'])
def update_tenant(tenant_id):
    """تحديث بيانات مستأجر"""
    try:
        data = request.json
        conn = get_master_db()
        cursor = conn.cursor()
        fields = []
        values = []
        for key in ['name', 'owner_name', 'owner_email', 'owner_phone', 'is_active', 'plan', 'max_users', 'max_branches', 'expires_at', 'subscription_amount', 'subscription_period']:
            if key in data:
                fields.append(f'{key} = ?')
                values.append(data[key])
        if fields:
            values.append(tenant_id)
            cursor.execute(f'UPDATE tenants SET {", ".join(fields)} WHERE id = ?', values)
            conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/tenants/<int:tenant_id>', methods=['DELETE'])
def delete_tenant(tenant_id):
    """حذف مستأجر"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT db_path, slug FROM tenants WHERE id = ?', (tenant_id,))
        tenant = cursor.fetchone()
        if not tenant:
            conn.close()
            return jsonify({'success': False, 'error': 'المستأجر غير موجود'}), 404

        # حذف قاعدة بيانات المستأجر
        db_path = tenant['db_path']
        if os.path.exists(db_path):
            os.remove(db_path)

        cursor.execute('DELETE FROM tenants WHERE id = ?', (tenant_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/tenants/<int:tenant_id>/stats', methods=['GET'])
def get_tenant_stats(tenant_id):
    """إحصائيات تفصيلية لمستأجر"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM tenants WHERE id = ?', (tenant_id,))
        tenant = cursor.fetchone()
        conn.close()
        if not tenant:
            return jsonify({'success': False, 'error': 'المستأجر غير موجود'}), 404

        t_conn = sqlite3.connect(tenant['db_path'])
        t_conn.row_factory = sqlite3.Row
        t_cursor = t_conn.cursor()

        stats = {}
        t_cursor.execute("SELECT COUNT(*) as c FROM users")
        stats['users_count'] = t_cursor.fetchone()['c']
        t_cursor.execute("SELECT COUNT(*) as c FROM invoices")
        stats['invoices_count'] = t_cursor.fetchone()['c']
        t_cursor.execute("SELECT COUNT(*) as c FROM products")
        stats['products_count'] = t_cursor.fetchone()['c']
        t_cursor.execute("SELECT COUNT(*) as c FROM customers")
        stats['customers_count'] = t_cursor.fetchone()['c']
        t_cursor.execute("SELECT COALESCE(SUM(total), 0) as t FROM invoices")
        stats['total_sales'] = t_cursor.fetchone()['t']
        t_cursor.execute("SELECT COUNT(*) as c FROM branches")
        stats['branches_count'] = t_cursor.fetchone()['c']
        t_conn.close()

        return jsonify({'success': True, 'stats': stats, 'tenant': dict_from_row(tenant)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/subscriptions/<int:tenant_id>', methods=['GET'])
def get_subscription_invoices(tenant_id):
    """جلب فواتير اشتراك مستأجر"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM subscription_invoices WHERE tenant_id = ? ORDER BY created_at DESC', (tenant_id,))
        invoices = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'invoices': invoices})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/subscriptions', methods=['POST'])
def create_subscription_invoice():
    """إنشاء فاتورة اشتراك وتجديد المتجر"""
    try:
        data = request.json
        tenant_id = data.get('tenant_id')
        amount = float(data.get('amount', 0))
        period_days = int(data.get('period_days', 30))
        notes = data.get('notes', '')
        payment_method = data.get('payment_method', 'cash')

        if not tenant_id or amount <= 0 or period_days <= 0:
            return jsonify({'success': False, 'error': 'بيانات الفاتورة غير مكتملة'}), 400

        conn = get_master_db()
        cursor = conn.cursor()

        # جلب بيانات المستأجر
        cursor.execute('SELECT * FROM tenants WHERE id = ?', (tenant_id,))
        tenant = cursor.fetchone()
        if not tenant:
            conn.close()
            return jsonify({'success': False, 'error': 'المستأجر غير موجود'}), 404

        # حساب تاريخ البداية والنهاية
        from datetime import date, timedelta
        today = date.today()

        # إذا كان الاشتراك ساري، نضيف من تاريخ الانتهاء الحالي
        if tenant['expires_at']:
            try:
                current_expiry = date.fromisoformat(tenant['expires_at'][:10])
                if current_expiry > today:
                    start_date = current_expiry
                else:
                    start_date = today
            except:
                start_date = today
        else:
            start_date = today

        end_date = start_date + timedelta(days=period_days)

        # إنشاء فاتورة الاشتراك
        cursor.execute('''
            INSERT INTO subscription_invoices (tenant_id, amount, period_days, start_date, end_date, notes, payment_method)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (tenant_id, amount, period_days, start_date.isoformat(), end_date.isoformat(), notes, payment_method))

        # تحديث تاريخ الانتهاء وتفعيل المتجر
        cursor.execute('UPDATE tenants SET expires_at = ?, is_active = 1 WHERE id = ?',
                       (end_date.isoformat(), tenant_id))

        conn.commit()
        invoice_id = cursor.lastrowid
        conn.close()

        return jsonify({
            'success': True,
            'id': invoice_id,
            'start_date': start_date.isoformat(),
            'end_date': end_date.isoformat()
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/subscriptions/<int:invoice_id>', methods=['DELETE'])
def delete_subscription_invoice(invoice_id):
    """حذف فاتورة اشتراك"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM subscription_invoices WHERE id = ?', (invoice_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/change-password', methods=['POST'])
def super_admin_change_password():
    """تغيير اسم المستخدم وكلمة مرور المدير الأعلى"""
    try:
        data = request.json
        admin_id = data.get('admin_id')
        old_password = data.get('old_password', '')
        new_password = data.get('new_password', '')
        new_username = data.get('new_username', '').strip()
        new_full_name = data.get('new_full_name', '').strip()
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM super_admins WHERE id = ? AND password = ?',
                       (admin_id, hash_password(old_password)))
        admin = cursor.fetchone()
        if not admin:
            conn.close()
            return jsonify({'success': False, 'error': 'كلمة المرور القديمة غير صحيحة'}), 400

        # تحديث كلمة المرور
        if new_password:
            cursor.execute('UPDATE super_admins SET password = ? WHERE id = ?',
                           (hash_password(new_password), admin_id))

        # تحديث اسم المستخدم
        if new_username and new_username != admin['username']:
            cursor.execute('SELECT id FROM super_admins WHERE username = ? AND id != ?', (new_username, admin_id))
            if cursor.fetchone():
                conn.close()
                return jsonify({'success': False, 'error': 'اسم المستخدم مستخدم بالفعل'}), 400
            cursor.execute('UPDATE super_admins SET username = ? WHERE id = ?', (new_username, admin_id))

        # تحديث الاسم الكامل
        if new_full_name:
            cursor.execute('UPDATE super_admins SET full_name = ? WHERE id = ?', (new_full_name, admin_id))

        conn.commit()
        # إرجاع البيانات المحدّثة
        cursor.execute('SELECT id, username, full_name FROM super_admins WHERE id = ?', (admin_id,))
        updated = cursor.fetchone()
        conn.close()
        return jsonify({
            'success': True,
            'admin': {
                'id': updated['id'],
                'username': updated['username'],
                'full_name': updated['full_name'],
                'role': 'super_admin'
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/backup/tenant/<int:tenant_id>', methods=['POST'])
def super_admin_backup_tenant(tenant_id):
    """إنشاء نسخة احتياطية لمتجر معين من السوبر أدمن"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM tenants WHERE id = ?', (tenant_id,))
        tenant = cursor.fetchone()
        conn.close()
        if not tenant:
            return jsonify({'success': False, 'error': 'المتجر غير موجود'}), 404
        slug = tenant['slug']
        backup_info, error = create_backup_file(slug)
        if error:
            return jsonify({'success': False, 'error': error}), 500
        backup_info['tenant_name'] = tenant['name']
        return jsonify({'success': True, 'backup': backup_info})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/backup/all', methods=['POST'])
def super_admin_backup_all():
    """إنشاء نسخ احتياطية لجميع المتاجر"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM tenants WHERE is_active = 1 ORDER BY id')
        tenants = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()

        results = []
        errors = []

        # نسخة احتياطية للقاعدة الرئيسية (default)
        backup_info, error = create_backup_file(None)
        if error:
            errors.append({'tenant': 'default', 'error': error})
        else:
            backup_info['tenant_name'] = 'القاعدة الرئيسية'
            results.append(backup_info)

        # نسخ احتياطية لكل متجر
        for tenant in tenants:
            backup_info, error = create_backup_file(tenant['slug'])
            if error:
                errors.append({'tenant': tenant['name'], 'error': error})
            else:
                backup_info['tenant_name'] = tenant['name']
                results.append(backup_info)

        return jsonify({
            'success': True,
            'backups': results,
            'errors': errors,
            'total': len(results),
            'failed': len(errors)
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/super-admin/backup/list', methods=['GET'])
def super_admin_list_all_backups():
    """قائمة النسخ الاحتياطية لجميع المتاجر"""
    try:
        conn = get_master_db()
        cursor = conn.cursor()
        cursor.execute('SELECT id, name, slug FROM tenants ORDER BY id')
        tenants = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()

        all_backups = {}

        # نسخ القاعدة الرئيسية
        default_dir = get_backup_dir(None)
        default_backups = []
        if os.path.exists(default_dir):
            for f in sorted(os.listdir(default_dir), reverse=True):
                if f.endswith('.db'):
                    fp = os.path.join(default_dir, f)
                    default_backups.append({
                        'filename': f,
                        'size': os.path.getsize(fp),
                        'created_at': datetime.fromtimestamp(os.path.getmtime(fp)).isoformat()
                    })
        all_backups['default'] = {'name': 'القاعدة الرئيسية', 'backups': default_backups}

        # نسخ كل متجر
        for tenant in tenants:
            tenant_dir = get_backup_dir(tenant['slug'])
            tenant_backups = []
            if os.path.exists(tenant_dir):
                for f in sorted(os.listdir(tenant_dir), reverse=True):
                    if f.endswith('.db'):
                        fp = os.path.join(tenant_dir, f)
                        tenant_backups.append({
                            'filename': f,
                            'size': os.path.getsize(fp),
                            'created_at': datetime.fromtimestamp(os.path.getmtime(fp)).isoformat()
                        })
            all_backups[tenant['slug']] = {'name': tenant['name'], 'backups': tenant_backups}

        return jsonify({'success': True, 'all_backups': all_backups})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== نظام النسخ الاحتياطي =====

def get_backup_dir(tenant_slug=None):
    """الحصول على مجلد النسخ الاحتياطية للمستأجر"""
    if tenant_slug:
        safe_slug = re.sub(r'[^a-zA-Z0-9_-]', '', tenant_slug)
        backup_dir = os.path.join(BACKUPS_DIR, safe_slug)
    else:
        backup_dir = os.path.join(BACKUPS_DIR, 'default')
    os.makedirs(backup_dir, exist_ok=True)
    return backup_dir

def create_backup_file(tenant_slug=None):
    """إنشاء نسخة احتياطية من قاعدة البيانات"""
    db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH
    if not os.path.exists(db_path):
        return None, 'قاعدة البيانات غير موجودة'

    backup_dir = get_backup_dir(tenant_slug)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_filename = f'backup_{timestamp}.db'
    backup_path = os.path.join(backup_dir, backup_filename)

    try:
        # استخدام SQLite backup API للتأكد من سلامة النسخة
        source = sqlite3.connect(db_path)
        dest = sqlite3.connect(backup_path)
        source.backup(dest)
        dest.close()
        source.close()

        file_size = os.path.getsize(backup_path)
        return {
            'filename': backup_filename,
            'path': backup_path,
            'size': file_size,
            'created_at': datetime.now().isoformat(),
            'tenant': tenant_slug or 'default'
        }, None
    except Exception as e:
        return None, str(e)

@app.route('/api/backup/create', methods=['POST'])
def create_backup():
    """إنشاء نسخة احتياطية جديدة"""
    try:
        tenant_slug = get_tenant_slug()
        backup_info, error = create_backup_file(tenant_slug)
        if error:
            return jsonify({'success': False, 'error': error}), 500
        return jsonify({'success': True, 'backup': backup_info})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup/list', methods=['GET'])
def list_backups():
    """قائمة النسخ الاحتياطية"""
    try:
        tenant_slug = get_tenant_slug()
        backup_dir = get_backup_dir(tenant_slug)
        backups = []

        if os.path.exists(backup_dir):
            for f in sorted(os.listdir(backup_dir), reverse=True):
                if f.endswith('.db'):
                    fpath = os.path.join(backup_dir, f)
                    stat = os.stat(fpath)
                    backups.append({
                        'filename': f,
                        'size': stat.st_size,
                        'created_at': datetime.fromtimestamp(stat.st_mtime).isoformat()
                    })

        # جلب إعدادات الجدولة
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH
        schedule = {'enabled': False, 'time': '03:00', 'keep_days': 30, 'gdrive_auto': False}
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT key, value FROM settings WHERE key LIKE 'backup_%'")
            for row in cursor.fetchall():
                k = row['key'].replace('backup_', '')
                if k == 'schedule_enabled':
                    schedule['enabled'] = row['value'] == 'true'
                elif k == 'schedule_time':
                    schedule['time'] = row['value']
                elif k == 'keep_days':
                    schedule['keep_days'] = int(row['value'])
                elif k == 'gdrive_auto':
                    schedule['gdrive_auto'] = row['value'] == 'true'
            conn.close()
        except:
            pass

        return jsonify({'success': True, 'backups': backups, 'schedule': schedule})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup/download/<filename>', methods=['GET'])
def download_backup(filename):
    """تحميل نسخة احتياطية"""
    try:
        # التحقق من اسم الملف (منع path traversal)
        safe_filename = re.sub(r'[^a-zA-Z0-9_.\-]', '', filename)
        if safe_filename != filename or '..' in filename:
            return jsonify({'success': False, 'error': 'اسم ملف غير صالح'}), 400

        tenant_slug = get_tenant_slug()
        backup_dir = get_backup_dir(tenant_slug)
        filepath = os.path.join(backup_dir, safe_filename)

        if not os.path.exists(filepath):
            return jsonify({'success': False, 'error': 'الملف غير موجود'}), 404

        return send_file(filepath, as_attachment=True, download_name=safe_filename)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup/delete/<filename>', methods=['DELETE'])
def delete_backup(filename):
    """حذف نسخة احتياطية"""
    try:
        safe_filename = re.sub(r'[^a-zA-Z0-9_.\-]', '', filename)
        if safe_filename != filename or '..' in filename:
            return jsonify({'success': False, 'error': 'اسم ملف غير صالح'}), 400

        tenant_slug = get_tenant_slug()
        backup_dir = get_backup_dir(tenant_slug)
        filepath = os.path.join(backup_dir, safe_filename)

        if not os.path.exists(filepath):
            return jsonify({'success': False, 'error': 'الملف غير موجود'}), 404

        os.remove(filepath)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup/restore', methods=['POST'])
def restore_backup():
    """استعادة نسخة احتياطية"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        # التحقق من وجود ملف مرفوع أو اسم ملف
        if 'file' in request.files:
            file = request.files['file']
            if not file.filename.endswith('.db'):
                return jsonify({'success': False, 'error': 'يجب أن يكون الملف بصيغة .db'}), 400

            # إنشاء نسخة احتياطية قبل الاستعادة
            pre_restore_info, _ = create_backup_file(tenant_slug)

            # حفظ الملف المرفوع كنسخة مؤقتة والتحقق منه
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
                file.save(tmp.name)
                tmp_path = tmp.name

            # التحقق من صحة قاعدة البيانات
            try:
                test_conn = sqlite3.connect(tmp_path)
                test_conn.execute('SELECT count(*) FROM sqlite_master')
                test_conn.close()
            except:
                os.unlink(tmp_path)
                return jsonify({'success': False, 'error': 'الملف ليس قاعدة بيانات صالحة'}), 400

            # استعادة القاعدة
            source = sqlite3.connect(tmp_path)
            dest = sqlite3.connect(db_path)
            source.backup(dest)
            dest.close()
            source.close()
            os.unlink(tmp_path)

        elif request.json and request.json.get('filename'):
            filename = request.json['filename']
            safe_filename = re.sub(r'[^a-zA-Z0-9_.\-]', '', filename)
            backup_dir = get_backup_dir(tenant_slug)
            filepath = os.path.join(backup_dir, safe_filename)

            if not os.path.exists(filepath):
                return jsonify({'success': False, 'error': 'النسخة الاحتياطية غير موجودة'}), 404

            # إنشاء نسخة احتياطية قبل الاستعادة
            pre_restore_info, _ = create_backup_file(tenant_slug)

            source = sqlite3.connect(filepath)
            dest = sqlite3.connect(db_path)
            source.backup(dest)
            dest.close()
            source.close()
        else:
            return jsonify({'success': False, 'error': 'لم يتم تحديد ملف'}), 400

        return jsonify({'success': True, 'message': 'تمت الاستعادة بنجاح. تم إنشاء نسخة احتياطية تلقائية قبل الاستعادة.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup/schedule', methods=['PUT'])
def update_backup_schedule():
    """تحديث جدولة النسخ الاحتياطي التلقائي"""
    try:
        data = request.json
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        settings = {
            'backup_schedule_enabled': 'true' if data.get('enabled') else 'false',
            'backup_schedule_time': data.get('time', '03:00'),
            'backup_keep_days': str(data.get('keep_days', 30)),
            'backup_gdrive_auto': 'true' if data.get('gdrive_auto') else 'false'
        }

        for key, value in settings.items():
            cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                           (key, value, datetime.now().isoformat()))

        conn.commit()
        conn.close()

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== Google Drive Integration =====

GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
GOOGLE_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
GOOGLE_DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

@app.route('/api/backup/gdrive/save-credentials', methods=['POST'])
def gdrive_save_credentials():
    """حفظ بيانات اعتماد Google Drive"""
    try:
        data = request.json
        client_id = data.get('client_id', '').strip()
        client_secret = data.get('client_secret', '').strip()
        base_url = data.get('base_url', '').strip().rstrip('/')

        if not client_id or not client_secret:
            return jsonify({'success': False, 'error': 'يرجى إدخال Client ID و Client Secret'}), 400

        # بناء redirect_uri من عنوان التطبيق
        redirect_uri = f'{base_url}/api/backup/gdrive/callback' if base_url else f'{request.host_url.rstrip("/")}/api/backup/gdrive/callback'

        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                       ('gdrive_client_id', client_id, datetime.now().isoformat()))
        cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                       ('gdrive_client_secret', client_secret, datetime.now().isoformat()))
        cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                       ('gdrive_redirect_uri', redirect_uri, datetime.now().isoformat()))
        conn.commit()
        conn.close()

        # إنشاء رابط التفويض مع تمرير tenant_slug في state
        params = urllib.parse.urlencode({
            'client_id': client_id,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': GOOGLE_DRIVE_SCOPE,
            'access_type': 'offline',
            'prompt': 'consent',
            'state': tenant_slug or ''
        })
        auth_url = f'{GOOGLE_OAUTH_AUTH_URL}?{params}'

        return jsonify({'success': True, 'auth_url': auth_url, 'redirect_uri': redirect_uri})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

def _gdrive_exchange_code(auth_code, tenant_slug=None):
    """تبادل كود التفويض بالتوكن - دالة مشتركة"""
    db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    row = cursor.fetchone()
    client_id = row['value'] if row else None
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    row = cursor.fetchone()
    client_secret = row['value'] if row else None
    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_redirect_uri'")
    row = cursor.fetchone()
    redirect_uri = row['value'] if row else None
    conn.close()

    if not client_id or not client_secret:
        raise ValueError('لم يتم العثور على بيانات الاعتماد')

    if not redirect_uri:
        raise ValueError('لم يتم العثور على redirect_uri - أعد إدخال بيانات الاعتماد')

    # تبادل الكود بالتوكن
    token_data = urllib.parse.urlencode({
        'code': auth_code,
        'client_id': client_id,
        'client_secret': client_secret,
        'redirect_uri': redirect_uri,
        'grant_type': 'authorization_code'
    }).encode()

    req = urllib.request.Request(GOOGLE_OAUTH_TOKEN_URL, data=token_data)
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    response = urllib.request.urlopen(req)
    tokens = json.loads(response.read().decode())

    if 'access_token' not in tokens:
        raise ValueError('فشل الحصول على التوكن')

    # حفظ التوكنات
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                   ('gdrive_access_token', tokens['access_token'], datetime.now().isoformat()))
    cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                   ('gdrive_refresh_token', tokens.get('refresh_token', ''), datetime.now().isoformat()))
    cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                   ('gdrive_token_expiry', str(time.time() + tokens.get('expires_in', 3600)), datetime.now().isoformat()))
    conn.commit()
    conn.close()

    return tokens

@app.route('/api/backup/gdrive/callback')
def gdrive_callback():
    """صفحة استقبال كود التفويض من Google - يتم التوجيه إليها تلقائياً"""
    auth_code = request.args.get('code', '')
    error = request.args.get('error', '')

    if error:
        return f'''<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>خطأ في ربط Google Drive</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#ef4444;">❌ فشل ربط Google Drive</h2>
<p>الخطأ: {error}</p>
<p>يمكنك إغلاق هذه النافذة والمحاولة مرة أخرى.</p>
<script>setTimeout(function(){{ window.close(); }}, 5000);</script>
</body></html>''', 400

    if not auth_code:
        return '''<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>خطأ</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#ef4444;">❌ لم يتم استلام كود التفويض</h2>
<p>يمكنك إغلاق هذه النافذة والمحاولة مرة أخرى.</p>
</body></html>''', 400

    try:
        # استخراج tenant_slug من state parameter (لأن الـ callback redirect ما فيه X-Tenant-ID header)
        tenant_slug = request.args.get('state', '').strip()
        _gdrive_exchange_code(auth_code, tenant_slug)

        return '''<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>تم ربط Google Drive</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#22c55e;">✅ تم ربط Google Drive بنجاح!</h2>
<p>سيتم إغلاق هذه النافذة تلقائياً...</p>
<script>
if (window.opener) { window.opener.postMessage('gdrive_connected', '*'); }
setTimeout(function(){ window.close(); }, 2000);
</script>
</body></html>'''
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        return f'''<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>خطأ</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#ef4444;">❌ فشل ربط Google Drive</h2>
<p>خطأ من Google: {error_body}</p>
<script>setTimeout(function(){{ window.close(); }}, 8000);</script>
</body></html>''', 400
    except Exception as e:
        return f'''<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>خطأ</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#ef4444;">❌ فشل ربط Google Drive</h2>
<p>{str(e)}</p>
<script>setTimeout(function(){{ window.close(); }}, 8000);</script>
</body></html>''', 400

@app.route('/api/backup/gdrive/connect', methods=['POST'])
def gdrive_connect():
    """ربط Google Drive باستخدام كود التفويض - طريقة يدوية احتياطية"""
    try:
        data = request.json
        auth_code = data.get('code', '').strip()

        if not auth_code:
            return jsonify({'success': False, 'error': 'يرجى إدخال كود التفويض'}), 400

        tenant_slug = get_tenant_slug()
        _gdrive_exchange_code(auth_code, tenant_slug)

        return jsonify({'success': True, 'message': 'تم ربط Google Drive بنجاح'})
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        return jsonify({'success': False, 'error': f'خطأ من Google: {error_body}'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

def refresh_gdrive_token(db_path):
    """تجديد توكن Google Drive"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
    row = cursor.fetchone()
    client_id = row['value'] if row else None

    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_secret'")
    row = cursor.fetchone()
    client_secret = row['value'] if row else None

    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'")
    row = cursor.fetchone()
    refresh_token = row['value'] if row else None
    conn.close()

    if not all([client_id, client_secret, refresh_token]):
        return None

    token_data = urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token'
    }).encode()

    try:
        req = urllib.request.Request(GOOGLE_OAUTH_TOKEN_URL, data=token_data)
        req.add_header('Content-Type', 'application/x-www-form-urlencoded')
        response = urllib.request.urlopen(req)
        tokens = json.loads(response.read().decode())

        new_token = tokens.get('access_token')
        if new_token:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                           ('gdrive_access_token', new_token, datetime.now().isoformat()))
            cursor.execute('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
                           ('gdrive_token_expiry', str(time.time() + tokens.get('expires_in', 3600)), datetime.now().isoformat()))
            conn.commit()
            conn.close()
            return new_token
    except:
        pass
    return None

def get_gdrive_token(db_path):
    """الحصول على توكن Google Drive صالح"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_access_token'")
    row = cursor.fetchone()
    access_token = row['value'] if row else None

    cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_token_expiry'")
    row = cursor.fetchone()
    expiry = float(row['value']) if row else 0
    conn.close()

    if not access_token:
        return None

    # تجديد التوكن إذا انتهت صلاحيته
    if time.time() >= expiry - 60:
        access_token = refresh_gdrive_token(db_path)

    return access_token

@app.route('/api/backup/gdrive/status', methods=['GET'])
def gdrive_status():
    """حالة اتصال Google Drive"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'")
        row = cursor.fetchone()
        has_token = bool(row and row['value'])

        cursor.execute("SELECT value FROM settings WHERE key = 'gdrive_client_id'")
        row = cursor.fetchone()
        has_credentials = bool(row and row['value'])
        conn.close()

        return jsonify({
            'success': True,
            'connected': has_token,
            'has_credentials': has_credentials
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup/gdrive/disconnect', methods=['POST'])
def gdrive_disconnect():
    """قطع اتصال Google Drive"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        for key in ['gdrive_client_id', 'gdrive_client_secret', 'gdrive_access_token', 'gdrive_refresh_token', 'gdrive_token_expiry']:
            cursor.execute("DELETE FROM settings WHERE key = ?", (key,))
        conn.commit()
        conn.close()

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup/gdrive/upload', methods=['POST'])
def gdrive_upload():
    """رفع نسخة احتياطية إلى Google Drive"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        token = get_gdrive_token(db_path)
        if not token:
            return jsonify({'success': False, 'error': 'Google Drive غير متصل. يرجى الربط أولاً.'}), 400

        data = request.json or {}
        filename = data.get('filename')

        if filename:
            safe_filename = re.sub(r'[^a-zA-Z0-9_.\-]', '', filename)
            backup_dir = get_backup_dir(tenant_slug)
            filepath = os.path.join(backup_dir, safe_filename)
            if not os.path.exists(filepath):
                return jsonify({'success': False, 'error': 'الملف غير موجود'}), 404
        else:
            # إنشاء نسخة احتياطية جديدة ورفعها
            backup_info, error = create_backup_file(tenant_slug)
            if error:
                return jsonify({'success': False, 'error': error}), 500
            filepath = backup_info['path']
            safe_filename = backup_info['filename']

        # إنشاء/البحث عن مجلد POS-Backups في Google Drive
        folder_id = _gdrive_find_or_create_folder(token, tenant_slug)

        # رفع الملف
        store_name = tenant_slug or 'default'
        upload_name = f'POS_{store_name}_{safe_filename}'

        boundary = '----BackupBoundary'
        metadata = json.dumps({
            'name': upload_name,
            'parents': [folder_id] if folder_id else []
        })

        with open(filepath, 'rb') as f:
            file_data = f.read()

        body = (
            f'--{boundary}\r\n'
            f'Content-Type: application/json; charset=UTF-8\r\n\r\n'
            f'{metadata}\r\n'
            f'--{boundary}\r\n'
            f'Content-Type: application/x-sqlite3\r\n\r\n'
        ).encode() + file_data + f'\r\n--{boundary}--'.encode()

        req = urllib.request.Request(
            f'{GOOGLE_DRIVE_UPLOAD_URL}?uploadType=multipart',
            data=body,
            method='POST'
        )
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Content-Type', f'multipart/related; boundary={boundary}')

        response = urllib.request.urlopen(req)
        result = json.loads(response.read().decode())

        return jsonify({
            'success': True,
            'message': f'تم رفع النسخة إلى Google Drive بنجاح',
            'file_id': result.get('id'),
            'file_name': upload_name
        })
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        if e.code == 401:
            return jsonify({'success': False, 'error': 'انتهت صلاحية التوكن. يرجى إعادة ربط Google Drive.'}), 401
        return jsonify({'success': False, 'error': f'خطأ في Google Drive: {error_body}'}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

def _gdrive_find_or_create_folder(token, tenant_slug=None):
    """البحث عن مجلد POS-Backups أو إنشاؤه"""
    folder_name = f'POS-Backups-{tenant_slug}' if tenant_slug else 'POS-Backups'
    try:
        query = urllib.parse.quote(f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false")
        req = urllib.request.Request(f'{GOOGLE_DRIVE_FILES_URL}?q={query}')
        req.add_header('Authorization', f'Bearer {token}')
        response = urllib.request.urlopen(req)
        result = json.loads(response.read().decode())

        if result.get('files'):
            return result['files'][0]['id']

        # إنشاء المجلد
        metadata = json.dumps({
            'name': folder_name,
            'mimeType': 'application/vnd.google-apps.folder'
        }).encode()

        req = urllib.request.Request(GOOGLE_DRIVE_FILES_URL, data=metadata, method='POST')
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Content-Type', 'application/json')
        response = urllib.request.urlopen(req)
        result = json.loads(response.read().decode())
        return result.get('id')
    except:
        return None

@app.route('/api/backup/gdrive/files', methods=['GET'])
def gdrive_list_files():
    """قائمة النسخ الاحتياطية في Google Drive"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        token = get_gdrive_token(db_path)
        if not token:
            return jsonify({'success': False, 'error': 'Google Drive غير متصل'}), 400

        folder_name = f'POS-Backups-{tenant_slug}' if tenant_slug else 'POS-Backups'
        query = urllib.parse.quote(f"name contains 'POS_' and trashed=false")
        req = urllib.request.Request(
            f'{GOOGLE_DRIVE_FILES_URL}?q={query}&orderBy=createdTime desc&fields=files(id,name,size,createdTime)'
        )
        req.add_header('Authorization', f'Bearer {token}')
        response = urllib.request.urlopen(req)
        result = json.loads(response.read().decode())

        files = []
        for f in result.get('files', []):
            files.append({
                'id': f['id'],
                'name': f['name'],
                'size': int(f.get('size', 0)),
                'created_at': f.get('createdTime', '')
            })

        return jsonify({'success': True, 'files': files})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ===== مجدول النسخ الاحتياطي التلقائي =====

_backup_scheduler_running = False

def backup_scheduler_loop():
    """حلقة المجدول - تعمل في خيط منفصل"""
    global _backup_scheduler_running
    _backup_scheduler_running = True
    print("[Backup Scheduler] تم بدء مجدول النسخ الاحتياطي التلقائي")

    while _backup_scheduler_running:
        try:
            now = datetime.now()
            current_time = now.strftime('%H:%M')

            # فحص كل قواعد البيانات (الافتراضية + المستأجرين)
            db_paths = [('', DB_PATH)]
            if os.path.exists(TENANTS_DB_DIR):
                for f in os.listdir(TENANTS_DB_DIR):
                    if f.endswith('.db'):
                        slug = f[:-3]
                        db_paths.append((slug, os.path.join(TENANTS_DB_DIR, f)))

            for tenant_slug, db_path in db_paths:
                try:
                    conn = sqlite3.connect(db_path)
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()

                    cursor.execute("SELECT value FROM settings WHERE key = 'backup_schedule_enabled'")
                    row = cursor.fetchone()
                    enabled = row and row['value'] == 'true'

                    if not enabled:
                        conn.close()
                        continue

                    cursor.execute("SELECT value FROM settings WHERE key = 'backup_schedule_time'")
                    row = cursor.fetchone()
                    schedule_time = row['value'] if row else '03:00'

                    cursor.execute("SELECT value FROM settings WHERE key = 'backup_keep_days'")
                    row = cursor.fetchone()
                    keep_days = int(row['value']) if row else 30

                    cursor.execute("SELECT value FROM settings WHERE key = 'backup_gdrive_auto'")
                    row = cursor.fetchone()
                    gdrive_auto = row and row['value'] == 'true'
                    conn.close()

                    # التحقق من الوقت (مع هامش دقيقة واحدة)
                    if current_time == schedule_time:
                        slug_label = tenant_slug or 'default'
                        print(f"[Backup Scheduler] بدء نسخ احتياطي تلقائي لـ {slug_label}")

                        backup_info, error = create_backup_file(tenant_slug if tenant_slug else None)
                        if error:
                            print(f"[Backup Scheduler] خطأ: {error}")
                        else:
                            print(f"[Backup Scheduler] تم إنشاء نسخة: {backup_info['filename']}")

                            # رفع تلقائي إلى Google Drive
                            if gdrive_auto:
                                try:
                                    token = get_gdrive_token(db_path)
                                    if token:
                                        folder_id = _gdrive_find_or_create_folder(token, tenant_slug if tenant_slug else None)
                                        store_name = tenant_slug or 'default'
                                        upload_name = f'POS_{store_name}_{backup_info["filename"]}'

                                        boundary = '----BackupBoundary'
                                        metadata = json.dumps({
                                            'name': upload_name,
                                            'parents': [folder_id] if folder_id else []
                                        })

                                        with open(backup_info['path'], 'rb') as bf:
                                            file_data = bf.read()

                                        body = (
                                            f'--{boundary}\r\n'
                                            f'Content-Type: application/json; charset=UTF-8\r\n\r\n'
                                            f'{metadata}\r\n'
                                            f'--{boundary}\r\n'
                                            f'Content-Type: application/x-sqlite3\r\n\r\n'
                                        ).encode() + file_data + f'\r\n--{boundary}--'.encode()

                                        req = urllib.request.Request(
                                            f'{GOOGLE_DRIVE_UPLOAD_URL}?uploadType=multipart',
                                            data=body, method='POST'
                                        )
                                        req.add_header('Authorization', f'Bearer {token}')
                                        req.add_header('Content-Type', f'multipart/related; boundary={boundary}')
                                        urllib.request.urlopen(req)
                                        print(f"[Backup Scheduler] تم رفع النسخة إلى Google Drive")
                                except Exception as ge:
                                    print(f"[Backup Scheduler] خطأ في رفع Google Drive: {ge}")

                        # حذف النسخ القديمة
                        _cleanup_old_backups(tenant_slug if tenant_slug else None, keep_days)

                except Exception as te:
                    print(f"[Backup Scheduler] خطأ للمستأجر: {te}")

        except Exception as e:
            print(f"[Backup Scheduler] خطأ عام: {e}")

        # الانتظار 60 ثانية قبل الفحص التالي
        time.sleep(60)

def _cleanup_old_backups(tenant_slug, keep_days):
    """حذف النسخ الاحتياطية الأقدم من عدد الأيام المحدد"""
    backup_dir = get_backup_dir(tenant_slug)
    cutoff = time.time() - (keep_days * 86400)

    for f in os.listdir(backup_dir):
        if f.endswith('.db'):
            fpath = os.path.join(backup_dir, f)
            if os.path.getmtime(fpath) < cutoff:
                os.remove(fpath)
                print(f"[Backup Cleanup] تم حذف نسخة قديمة: {f}")

# ===== شاشة الأدمن - لوحة مراقبة الشركة =====

@app.route('/api/admin-dashboard/invoices-summary', methods=['GET'])
def admin_dashboard_invoices_summary():
    """ملخص الفواتير لكل الفروع"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # إجمالي الفواتير لكل فرع
        cursor.execute('''
            SELECT
                b.id as branch_id,
                b.name as branch_name,
                COUNT(i.id) as total_invoices,
                COALESCE(SUM(i.total), 0) as total_sales,
                COUNT(CASE WHEN i.cancelled = 1 THEN 1 END) as cancelled_invoices,
                COUNT(CASE WHEN DATE(i.created_at) = DATE('now') THEN 1 END) as today_invoices,
                COALESCE(SUM(CASE WHEN DATE(i.created_at) = DATE('now') THEN i.total ELSE 0 END), 0) as today_sales
            FROM branches b
            LEFT JOIN invoices i ON i.branch_id = b.id
            WHERE b.is_active = 1
            GROUP BY b.id, b.name
            ORDER BY b.id
        ''')
        branches_summary = [dict(row) for row in cursor.fetchall()]

        # إجمالي عام
        cursor.execute('''
            SELECT
                COUNT(id) as total_invoices,
                COALESCE(SUM(total), 0) as total_sales,
                COUNT(CASE WHEN cancelled = 1 THEN 1 END) as cancelled_invoices,
                COUNT(CASE WHEN DATE(created_at) = DATE('now') THEN 1 END) as today_invoices,
                COALESCE(SUM(CASE WHEN DATE(created_at) = DATE('now') THEN total ELSE 0 END), 0) as today_sales
            FROM invoices
        ''')
        overall = dict(cursor.fetchone())

        conn.close()
        return jsonify({
            'success': True,
            'branches': branches_summary,
            'overall': overall
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin-dashboard/stock-summary', methods=['GET'])
def admin_dashboard_stock_summary():
    """ملخص المخزون لكل منتج في كل فرع"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # جلب كل الفروع النشطة
        cursor.execute('SELECT id, name FROM branches WHERE is_active = 1 ORDER BY id')
        branches = [dict(row) for row in cursor.fetchall()]

        # جلب المخزون لكل منتج في كل فرع مع التنويعات
        cursor.execute('''
            SELECT
                inv.id as product_id,
                inv.name as product_name,
                inv.category,
                pv.id as variant_id,
                pv.variant_name,
                bs.branch_id,
                b.name as branch_name,
                bs.stock,
                bs.sales_count
            FROM inventory inv
            LEFT JOIN product_variants pv ON pv.inventory_id = inv.id
            LEFT JOIN branch_stock bs ON bs.inventory_id = inv.id
                AND (bs.variant_id = pv.id OR (bs.variant_id IS NULL AND pv.id IS NULL))
            LEFT JOIN branches b ON b.id = bs.branch_id AND b.is_active = 1
            ORDER BY inv.name, pv.variant_name, b.id
        ''')
        raw_data = [dict(row) for row in cursor.fetchall()]

        # تنظيم البيانات: لكل منتج (+ تنويع) نعرض المخزون في كل فرع
        products_map = {}
        for row in raw_data:
            key = f"{row['product_id']}_{row['variant_id'] or 0}"
            if key not in products_map:
                display_name = row['product_name']
                if row['variant_name']:
                    display_name += f" - {row['variant_name']}"
                products_map[key] = {
                    'product_id': row['product_id'],
                    'variant_id': row['variant_id'],
                    'name': display_name,
                    'category': row['category'] or '',
                    'branches': {}
                }
            if row['branch_id']:
                products_map[key]['branches'][row['branch_id']] = {
                    'stock': row['stock'] or 0,
                    'sales_count': row['sales_count'] or 0
                }

        products_list = list(products_map.values())

        conn.close()
        return jsonify({
            'success': True,
            'branches': branches,
            'products': products_list
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== XBRL / IFRS =====

def ensure_xbrl_tables(cursor):
    """إنشاء جداول XBRL إذا لم تكن موجودة"""
    try:
        cursor.execute('''CREATE TABLE IF NOT EXISTS xbrl_company_info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_name_ar TEXT,
            company_name_en TEXT,
            commercial_registration TEXT,
            tax_number TEXT,
            reporting_currency TEXT DEFAULT 'SAR',
            industry_sector TEXT,
            country TEXT DEFAULT 'SA',
            fiscal_year_end TEXT DEFAULT '12-31',
            legal_form TEXT,
            contact_email TEXT,
            contact_phone TEXT,
            address TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS xbrl_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_type TEXT NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            report_data TEXT,
            xbrl_xml TEXT,
            created_by INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            notes TEXT
        )''')
    except Exception as e:
        print(f"[XBRL] ensure_xbrl_tables: {e}")

@app.route('/api/xbrl/company-info', methods=['GET'])
def get_xbrl_company_info():
    """جلب بيانات الشركة لتقارير XBRL"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        ensure_xbrl_tables(cursor)
        conn.commit()
        cursor.execute('SELECT * FROM xbrl_company_info ORDER BY id DESC LIMIT 1')
        row = cursor.fetchone()
        conn.close()
        if row:
            return jsonify({'success': True, 'data': dict_from_row(row)})
        return jsonify({'success': True, 'data': None})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/xbrl/company-info', methods=['POST'])
def save_xbrl_company_info():
    """حفظ / تحديث بيانات الشركة"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        ensure_xbrl_tables(cursor)
        conn.commit()
        cursor.execute('SELECT id FROM xbrl_company_info ORDER BY id DESC LIMIT 1')
        existing = cursor.fetchone()
        if existing:
            cursor.execute('''UPDATE xbrl_company_info SET
                company_name_ar=?, company_name_en=?, commercial_registration=?,
                tax_number=?, reporting_currency=?, industry_sector=?,
                country=?, fiscal_year_end=?, legal_form=?,
                contact_email=?, contact_phone=?, address=?,
                updated_at=CURRENT_TIMESTAMP WHERE id=?''',
                (data.get('company_name_ar',''), data.get('company_name_en',''),
                 data.get('commercial_registration',''), data.get('tax_number',''),
                 data.get('reporting_currency','SAR'), data.get('industry_sector',''),
                 data.get('country','SA'), data.get('fiscal_year_end','12-31'),
                 data.get('legal_form',''), data.get('contact_email',''),
                 data.get('contact_phone',''), data.get('address',''),
                 existing['id']))
        else:
            cursor.execute('''INSERT INTO xbrl_company_info
                (company_name_ar, company_name_en, commercial_registration,
                 tax_number, reporting_currency, industry_sector,
                 country, fiscal_year_end, legal_form,
                 contact_email, contact_phone, address)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                (data.get('company_name_ar',''), data.get('company_name_en',''),
                 data.get('commercial_registration',''), data.get('tax_number',''),
                 data.get('reporting_currency','SAR'), data.get('industry_sector',''),
                 data.get('country','SA'), data.get('fiscal_year_end','12-31'),
                 data.get('legal_form',''), data.get('contact_email',''),
                 data.get('contact_phone',''), data.get('address','')))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'message': 'تم حفظ بيانات الشركة'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/xbrl/financial-data', methods=['GET'])
def get_xbrl_financial_data():
    """جلب البيانات المالية من النظام لتقارير IFRS"""
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        branch_id = request.args.get('branch_id')

        conn = get_db()
        cursor = conn.cursor()

        date_filter = ''
        date_params = []
        if start_date:
            date_filter += ' AND date(created_at) >= ?'
            date_params.append(start_date)
        if end_date:
            date_filter += ' AND date(created_at) <= ?'
            date_params.append(end_date)

        branch_filter = ''
        branch_params = []
        if branch_id:
            cursor.execute('SELECT name FROM branches WHERE id = ?', (branch_id,))
            br = cursor.fetchone()
            if br:
                branch_filter = ' AND branch_name = ?'
                branch_params = [br['name']]

        # === الإيرادات (Revenue) - IFRS 15 ===
        cursor.execute(f'''SELECT
            COUNT(*) as invoice_count,
            COALESCE(SUM(total), 0) as total_revenue,
            COALESCE(SUM(subtotal), 0) as gross_revenue,
            COALESCE(SUM(discount), 0) as total_discounts,
            COALESCE(SUM(delivery_fee), 0) as delivery_revenue,
            COALESCE(SUM(coupon_discount), 0) as coupon_discounts,
            COALESCE(SUM(loyalty_discount), 0) as loyalty_discounts
            FROM invoices WHERE cancelled = 0 {date_filter} {branch_filter}''',
            date_params + branch_params)
        revenue = dict_from_row(cursor.fetchone())

        # === تكلفة البضاعة المباعة (COGS) ===
        cogs_date_filter = date_filter.replace('created_at', 'i.created_at')
        cogs_branch_filter = branch_filter.replace('branch_name', 'i.branch_name')
        cursor.execute(f'''SELECT
            COALESCE(SUM(ii.quantity * COALESCE(inv.cost, 0)), 0) as total_cogs
            FROM invoice_items ii
            LEFT JOIN inventory inv ON ii.product_name = inv.name
            JOIN invoices i ON ii.invoice_id = i.id
            WHERE i.cancelled = 0 {cogs_date_filter} {cogs_branch_filter}''',
            date_params + branch_params)
        cogs_data = dict_from_row(cursor.fetchone())
        total_cogs = cogs_data['total_cogs'] or 0

        # === المصروفات التشغيلية (Operating Expenses) ===
        exp_date_filter = ''
        exp_params = []
        if start_date:
            exp_date_filter += ' AND date(expense_date) >= ?'
            exp_params.append(start_date)
        if end_date:
            exp_date_filter += ' AND date(expense_date) <= ?'
            exp_params.append(end_date)
        exp_branch_filter = ''
        if branch_id:
            exp_branch_filter = ' AND branch_id = ?'
            exp_params.append(branch_id)

        cursor.execute(f'''SELECT
            COALESCE(SUM(amount), 0) as total_expenses,
            expense_type, COALESCE(SUM(amount), 0) as type_total
            FROM expenses WHERE 1=1 {exp_date_filter} {exp_branch_filter}
            GROUP BY expense_type''', exp_params)
        expense_rows = cursor.fetchall()
        expenses_by_type = {}
        total_expenses = 0
        for row in expense_rows:
            r = dict_from_row(row)
            expenses_by_type[r['expense_type'] or 'أخرى'] = r['type_total']
            total_expenses += r['type_total']

        # رواتب (من salary_details)
        salary_params = []
        salary_date_filter = ''
        if start_date:
            salary_date_filter += ' AND date(e.expense_date) >= ?'
            salary_params.append(start_date)
        if end_date:
            salary_date_filter += ' AND date(e.expense_date) <= ?'
            salary_params.append(end_date)
        cursor.execute(f'''SELECT COALESCE(SUM(sd.monthly_salary), 0) as total_salaries
            FROM salary_details sd
            JOIN expenses e ON sd.expense_id = e.id
            WHERE 1=1 {salary_date_filter}''', salary_params)
        sal = dict_from_row(cursor.fetchone())
        total_salaries = sal['total_salaries'] or 0

        # === المخزون (Inventory) - IAS 2 ===
        cursor.execute('''SELECT
            COALESCE(SUM(bs.stock * COALESCE(inv.cost, 0)), 0) as inventory_value,
            COALESCE(SUM(bs.stock), 0) as total_units
            FROM branch_stock bs
            JOIN inventory inv ON bs.inventory_id = inv.id''')
        inv_data = dict_from_row(cursor.fetchone())

        # === العملاء - الذمم المدينة ===
        cursor.execute('SELECT COUNT(*) as customer_count FROM customers')
        cust = dict_from_row(cursor.fetchone())

        # === المرتجعات ===
        cursor.execute(f'''SELECT
            COUNT(*) as return_count,
            COALESCE(SUM(total), 0) as total_refunds
            FROM returns WHERE 1=1 {date_filter}''', date_params)
        try:
            returns_data = dict_from_row(cursor.fetchone())
        except:
            returns_data = {'return_count': 0, 'total_refunds': 0}

        # === حسابات مشتقة ===
        total_rev = revenue['total_revenue'] or 0
        gross_profit = total_rev - total_cogs
        operating_profit = gross_profit - total_expenses
        net_profit = operating_profit
        total_refunds = returns_data.get('total_refunds', 0) or 0

        # === المبيعات حسب طريقة الدفع ===
        cursor.execute(f'''SELECT payment_method,
            COUNT(*) as count, COALESCE(SUM(total), 0) as total
            FROM invoices WHERE cancelled = 0 {date_filter} {branch_filter}
            GROUP BY payment_method''', date_params + branch_params)
        payment_rows = cursor.fetchall()
        payments = [dict_from_row(r) for r in payment_rows]

        # === المبيعات حسب الفرع ===
        cursor.execute(f'''SELECT branch_name,
            COUNT(*) as count, COALESCE(SUM(total), 0) as total
            FROM invoices WHERE cancelled = 0 {date_filter} {branch_filter}
            GROUP BY branch_name''', date_params + branch_params)
        branch_rows = cursor.fetchall()
        branches_data = [dict_from_row(r) for r in branch_rows]

        conn.close()

        return jsonify({
            'success': True,
            'data': {
                'revenue': {
                    'total_revenue': total_rev,
                    'gross_revenue': revenue['gross_revenue'] or 0,
                    'total_discounts': revenue['total_discounts'] or 0,
                    'delivery_revenue': revenue['delivery_revenue'] or 0,
                    'coupon_discounts': revenue['coupon_discounts'] or 0,
                    'loyalty_discounts': revenue['loyalty_discounts'] or 0,
                    'invoice_count': revenue['invoice_count'] or 0
                },
                'cost_of_sales': total_cogs,
                'gross_profit': gross_profit,
                'operating_expenses': {
                    'total': total_expenses,
                    'by_type': expenses_by_type,
                    'salaries': total_salaries
                },
                'operating_profit': operating_profit,
                'net_profit': net_profit,
                'profit_margin': round((net_profit / total_rev * 100), 2) if total_rev > 0 else 0,
                'inventory': {
                    'value': inv_data['inventory_value'] or 0,
                    'units': inv_data['total_units'] or 0
                },
                'customers': {
                    'count': cust['customer_count'] or 0
                },
                'returns': {
                    'count': returns_data.get('return_count', 0) or 0,
                    'total_refunds': total_refunds
                },
                'payments': payments,
                'branches': branches_data
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/xbrl/generate', methods=['POST'])
def generate_xbrl():
    """توليد تقرير XBRL بصيغة XML وفق معايير IFRS"""
    try:
        data = request.json
        period_start = data.get('period_start')
        period_end = data.get('period_end')
        financial = data.get('financial_data', {})
        company = data.get('company_info', {})
        manual_adjustments = data.get('manual_adjustments', {})

        currency = company.get('reporting_currency', 'SAR')
        entity_name = company.get('company_name_en', 'Entity')
        entity_name_ar = company.get('company_name_ar', '')
        cr_number = company.get('commercial_registration', '')
        tax_number = company.get('tax_number', '')

        # دمج التعديلات اليدوية
        rev = financial.get('revenue', {})
        total_revenue = rev.get('total_revenue', 0) + manual_adjustments.get('other_income', 0)
        cost_of_sales = financial.get('cost_of_sales', 0)
        gross_profit = total_revenue - cost_of_sales
        op_exp = financial.get('operating_expenses', {})
        total_opex = op_exp.get('total', 0) + manual_adjustments.get('additional_expenses', 0)
        depreciation = manual_adjustments.get('depreciation', 0)
        total_opex += depreciation
        operating_profit = gross_profit - total_opex
        finance_costs = manual_adjustments.get('finance_costs', 0)
        zakat_tax = manual_adjustments.get('zakat_tax', 0)
        profit_before_tax = operating_profit - finance_costs
        net_profit = profit_before_tax - zakat_tax

        # أصول يدوية
        cash_equivalents = manual_adjustments.get('cash_equivalents', 0)
        receivables = manual_adjustments.get('trade_receivables', 0)
        inventory_val = financial.get('inventory', {}).get('value', 0)
        total_current_assets = cash_equivalents + receivables + inventory_val + manual_adjustments.get('other_current_assets', 0)

        ppe = manual_adjustments.get('property_plant_equipment', 0)
        intangible_assets = manual_adjustments.get('intangible_assets', 0)
        total_non_current_assets = ppe + intangible_assets + manual_adjustments.get('other_non_current_assets', 0)
        total_assets = total_current_assets + total_non_current_assets

        # خصوم يدوية
        trade_payables = manual_adjustments.get('trade_payables', 0)
        short_term_loans = manual_adjustments.get('short_term_loans', 0)
        total_current_liabilities = trade_payables + short_term_loans + manual_adjustments.get('other_current_liabilities', 0)

        long_term_loans = manual_adjustments.get('long_term_loans', 0)
        total_non_current_liabilities = long_term_loans + manual_adjustments.get('other_non_current_liabilities', 0)
        total_liabilities = total_current_liabilities + total_non_current_liabilities

        # حقوق الملكية
        share_capital = manual_adjustments.get('share_capital', 0)
        retained_earnings_opening = manual_adjustments.get('retained_earnings', 0)
        retained_earnings = retained_earnings_opening + net_profit
        other_equity = manual_adjustments.get('other_equity', 0)
        total_equity = share_capital + retained_earnings + other_equity

        # === قائمة التدفقات النقدية (IAS 7) ===
        # أنشطة تشغيلية
        cf_customers_received = manual_adjustments.get('cf_customers_received', 0)
        cf_suppliers_paid = manual_adjustments.get('cf_suppliers_paid', 0)
        cf_employees_paid = manual_adjustments.get('cf_employees_paid', 0)
        cf_other_operating = manual_adjustments.get('cf_other_operating', 0)
        cf_interest_paid = manual_adjustments.get('cf_interest_paid', 0)
        cf_taxes_paid = manual_adjustments.get('cf_taxes_paid', 0)
        # إذا لم يُدخل المستخدم بيانات يدوية، نحسب من بيانات النظام (الطريقة المباشرة)
        if cf_customers_received == 0 and total_revenue > 0:
            cf_customers_received = total_revenue
        if cf_suppliers_paid == 0 and cost_of_sales > 0:
            cf_suppliers_paid = cost_of_sales
        if cf_employees_paid == 0:
            cf_employees_paid = op_exp.get('salaries', 0) if isinstance(op_exp, dict) else 0
        net_cash_operating = cf_customers_received - cf_suppliers_paid - cf_employees_paid + cf_other_operating - cf_interest_paid - cf_taxes_paid

        # أنشطة استثمارية
        cf_ppe_purchased = manual_adjustments.get('cf_ppe_purchased', 0)
        cf_ppe_sold = manual_adjustments.get('cf_ppe_sold', 0)
        cf_investments_purchased = manual_adjustments.get('cf_investments_purchased', 0)
        cf_investments_sold = manual_adjustments.get('cf_investments_sold', 0)
        cf_other_investing = manual_adjustments.get('cf_other_investing', 0)
        net_cash_investing = cf_ppe_sold - cf_ppe_purchased + cf_investments_sold - cf_investments_purchased + cf_other_investing

        # أنشطة تمويلية
        cf_loans_received = manual_adjustments.get('cf_loans_received', 0)
        cf_loans_repaid = manual_adjustments.get('cf_loans_repaid', 0)
        cf_capital_contributed = manual_adjustments.get('cf_capital_contributed', 0)
        cf_dividends_paid = manual_adjustments.get('cf_dividends_paid', 0)
        cf_other_financing = manual_adjustments.get('cf_other_financing', 0)
        net_cash_financing = cf_loans_received - cf_loans_repaid + cf_capital_contributed - cf_dividends_paid + cf_other_financing

        net_change_cash = net_cash_operating + net_cash_investing + net_cash_financing
        cash_beginning = manual_adjustments.get('cash_beginning', 0)
        cash_ending = cash_beginning + net_change_cash

        # === قائمة التغيرات في حقوق الملكية (IAS 1) ===
        equity_opening_capital = manual_adjustments.get('equity_opening_capital', share_capital)
        equity_opening_retained = retained_earnings_opening
        equity_opening_other = manual_adjustments.get('equity_opening_other', 0)
        equity_opening_total = equity_opening_capital + equity_opening_retained + equity_opening_other

        equity_new_capital = manual_adjustments.get('equity_new_capital', 0)
        dividends_declared = manual_adjustments.get('dividends_declared', 0)
        other_comprehensive_income = manual_adjustments.get('other_comprehensive_income', 0)

        equity_closing_capital = equity_opening_capital + equity_new_capital
        equity_closing_retained = equity_opening_retained + net_profit - dividends_declared
        equity_closing_other = equity_opening_other + other_comprehensive_income
        equity_closing_total = equity_closing_capital + equity_closing_retained + equity_closing_other

        # === بيانات الشركاء (IAS 1 - تفصيل حقوق الملكية لكل شريك) ===
        partners = manual_adjustments.get('partners', [])
        partners_data = []
        for p in partners:
            p_name = p.get('name', '')
            p_capital_opening = p.get('capital_opening', 0)
            p_share_pct = p.get('share_percent', 0)
            p_profit = net_profit * (p_share_pct / 100) if p_share_pct > 0 else 0
            p_distributions = p.get('distributions', 0)
            p_capital_change = p.get('capital_change', 0)
            p_capital_closing = p_capital_opening + p_profit - p_distributions + p_capital_change
            partners_data.append({
                'name': p_name,
                'capital_opening': p_capital_opening,
                'share_percent': p_share_pct,
                'profit_share': round(p_profit, 2),
                'distributions': p_distributions,
                'capital_change': p_capital_change,
                'capital_closing': round(p_capital_closing, 2)
            })

        # Inline XBRL (iXBRL) HTML Generation (IFRS Taxonomy 2024)
        def fmt(v):
            return f'{v:,.2f}'

        # مُعرف فريد لكل حقيقة XBRL
        _fact_id_counter = [0]
        def fid():
            _fact_id_counter[0] += 1
            return f'fact_{_fact_id_counter[0]}'

        # تاغ رقمي مع كل الخصائص اللازمة للمفتش
        def nf(concept, ctx, val, sign_neg=False):
            """ix:nonFraction tag with full inspector properties"""
            fid_val = fid()
            abs_val = abs(val) if val else 0
            sign_attr = ' sign="-"' if (sign_neg and abs_val > 0) else ''
            return f'<ix:nonFraction id="{fid_val}" name="ifrs-full:{concept}" contextRef="{ctx}" unitRef="{currency}" decimals="0" scale="0" format="ixt:num-dot-decimal"{sign_attr}>{fmt(abs_val)}</ix:nonFraction>'

        # تاغ نصي
        def nt(concept, ctx, text):
            """ix:nonNumeric tag with full inspector properties"""
            fid_val = fid()
            safe_text = str(text).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            return f'<ix:nonNumeric id="{fid_val}" name="ifrs-full:{concept}" contextRef="{ctx}" xml:lang="ar">{safe_text}</ix:nonNumeric>'

        xbrl_xml = f'''<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:ixt="http://www.xbrl.org/inlineXBRL/transformation/2020-02-12"
      xmlns:ixt4="http://www.xbrl.org/inlineXBRL/transformation/2020-02-12"
      xmlns:link="http://www.xbrl.org/2003/linkbase"
      xmlns:xlink="http://www.w3.org/1999/xlink"
      xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
      xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
      xmlns:ifrs-full="https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full"
      xml:lang="ar">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
  <title>التقرير المالي - {entity_name_ar or entity_name} - {period_end}</title>
  <style type="text/css">
    body {{ font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 40px; background: #f9f9f9; color: #333; line-height: 1.6; }}
    h1 {{ text-align: center; color: #1a365d; border-bottom: 3px solid #2b6cb0; padding-bottom: 15px; }}
    h2 {{ color: #2b6cb0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-top: 35px; }}
    .company-info {{ background: #edf2f7; padding: 20px; border-radius: 8px; margin: 20px 0; }}
    .company-info p {{ margin: 5px 0; }}
    table {{ width: 100%; border-collapse: collapse; margin: 15px 0; background: white; }}
    th {{ background: #2b6cb0; color: white; padding: 12px 15px; text-align: right; }}
    td {{ padding: 10px 15px; border-bottom: 1px solid #e2e8f0; }}
    .num {{ text-align: left; direction: ltr; }}
    .total {{ font-weight: bold; background: #edf2f7; }}
    .grand-total {{ font-weight: bold; background: #e2e8f0; border-top: 2px solid #2b6cb0; }}
    .section-head {{ background: #f7fafc; font-weight: bold; color: #2b6cb0; }}
    .footer {{ text-align: center; margin-top: 40px; color: #a0aec0; font-size: 0.85em; border-top: 1px solid #e2e8f0; padding-top: 15px; }}
    @media print {{ body {{ margin: 20px; background: white; }} }}
  </style>
</head>
<body>
  <ix:header>
    <ix:hidden>
      <!-- حقائق مخفية - بيانات الكيان والفترة -->
      <ix:nonNumeric id="h_entity_name" name="ifrs-full:NameOfReportingEntityOrOtherMeansOfIdentification" contextRef="CurrentPeriod" xml:lang="ar">{entity_name_ar or entity_name}</ix:nonNumeric>
      <ix:nonNumeric id="h_domicile" name="ifrs-full:DomicileOfEntity" contextRef="CurrentPeriod" xml:lang="ar">{company.get('country', 'SA')}</ix:nonNumeric>
      <ix:nonNumeric id="h_legal_form" name="ifrs-full:LegalFormOfEntity" contextRef="CurrentPeriod" xml:lang="ar">{company.get('legal_form', '')}</ix:nonNumeric>
      <ix:nonNumeric id="h_nature" name="ifrs-full:DescriptionOfNatureOfEntitysOperationsAndPrincipalActivities" contextRef="CurrentPeriod" xml:lang="ar">{company.get('industry_sector', '')}</ix:nonNumeric>
      <ix:nonNumeric id="h_currency" name="ifrs-full:DescriptionOfPresentationCurrency" contextRef="CurrentPeriod" xml:lang="ar">{currency}</ix:nonNumeric>
    </ix:hidden>
    <ix:references>
      <link:schemaRef xlink:type="simple" xlink:href="https://xbrl.ifrs.org/taxonomy/2024-03-27/full_ifrs_entry_point_2024-03-27.xsd"/>
    </ix:references>
    <ix:resources>
      <xbrli:context id="CurrentPeriod">
        <xbrli:entity>
          <xbrli:identifier scheme="http://www.cr.gov.sa">{cr_number}</xbrli:identifier>
        </xbrli:entity>
        <xbrli:period>
          <xbrli:startDate>{period_start}</xbrli:startDate>
          <xbrli:endDate>{period_end}</xbrli:endDate>
        </xbrli:period>
      </xbrli:context>
      <xbrli:context id="CurrentInstant">
        <xbrli:entity>
          <xbrli:identifier scheme="http://www.cr.gov.sa">{cr_number}</xbrli:identifier>
        </xbrli:entity>
        <xbrli:period>
          <xbrli:instant>{period_end}</xbrli:instant>
        </xbrli:period>
      </xbrli:context>
      <xbrli:context id="PriorInstant">
        <xbrli:entity>
          <xbrli:identifier scheme="http://www.cr.gov.sa">{cr_number}</xbrli:identifier>
        </xbrli:entity>
        <xbrli:period>
          <xbrli:instant>{period_start}</xbrli:instant>
        </xbrli:period>
      </xbrli:context>
      <xbrli:unit id="{currency}">
        <xbrli:measure>iso4217:{currency}</xbrli:measure>
      </xbrli:unit>
    </ix:resources>
  </ix:header>

  <h1>التقرير المالي وفق معايير IFRS</h1>
  <p style="text-align:center; color:#718096;">الفترة من {period_start} إلى {period_end}</p>

  <!-- ===== بيانات الشركة ===== -->
  <div class="company-info">
    <p><strong>اسم الشركة:</strong> {nt('NameOfReportingEntityOrOtherMeansOfIdentification', 'CurrentPeriod', entity_name_ar or entity_name)}</p>
    <p><strong>البلد:</strong> {nt('DomicileOfEntity', 'CurrentPeriod', company.get('country', 'SA'))}</p>
    <p><strong>الشكل القانوني:</strong> {nt('LegalFormOfEntity', 'CurrentPeriod', company.get('legal_form', ''))}</p>
    <p><strong>طبيعة النشاط:</strong> {nt('DescriptionOfNatureOfEntitysOperationsAndPrincipalActivities', 'CurrentPeriod', company.get('industry_sector', ''))}</p>
    <p><strong>السجل التجاري:</strong> {cr_number}</p>
    <p><strong>الرقم الضريبي:</strong> {tax_number}</p>
    <p><strong>العملة:</strong> {currency}</p>
  </div>

  <!-- ===== قائمة الدخل الشامل - Statement of Comprehensive Income (IAS 1) ===== -->
  <h2>قائمة الدخل الشامل</h2>
  <table>
    <tr><th>البند</th><th style="width:200px">المبلغ ({currency})</th></tr>
    <tr>
      <td>الإيرادات</td>
      <td class="num">{nf('Revenue', 'CurrentPeriod', total_revenue)}</td>
    </tr>
    <tr>
      <td>تكلفة المبيعات</td>
      <td class="num">({nf('CostOfSales', 'CurrentPeriod', cost_of_sales)})</td>
    </tr>
    <tr class="total">
      <td>مجمل الربح</td>
      <td class="num">{nf('GrossProfit', 'CurrentPeriod', gross_profit)}</td>
    </tr>
    <tr>
      <td>الاستهلاك والإطفاء</td>
      <td class="num">({nf('DepreciationAndAmortisationExpense', 'CurrentPeriod', depreciation)})</td>
    </tr>
    <tr>
      <td>مصاريف تشغيلية أخرى</td>
      <td class="num">({nf('OtherExpenseByNature', 'CurrentPeriod', total_opex)})</td>
    </tr>
    <tr class="total">
      <td>ربح العمليات</td>
      <td class="num">{nf('ProfitLossFromOperatingActivities', 'CurrentPeriod', operating_profit)}</td>
    </tr>
    <tr>
      <td>تكاليف التمويل</td>
      <td class="num">({nf('FinanceCosts', 'CurrentPeriod', finance_costs)})</td>
    </tr>
    <tr class="total">
      <td>الربح قبل الزكاة/الضريبة</td>
      <td class="num">{nf('ProfitLossBeforeTax', 'CurrentPeriod', profit_before_tax)}</td>
    </tr>
    <tr>
      <td>الزكاة / ضريبة الدخل</td>
      <td class="num">({nf('IncomeTaxExpenseContinuingOperations', 'CurrentPeriod', zakat_tax)})</td>
    </tr>
    <tr class="grand-total">
      <td>صافي الربح</td>
      <td class="num">{nf('ProfitLoss', 'CurrentPeriod', net_profit)}</td>
    </tr>
  </table>

  <!-- ===== قائمة المركز المالي - Statement of Financial Position (IAS 1) ===== -->
  <h2>قائمة المركز المالي</h2>
  <table>
    <tr><th>البند</th><th style="width:200px">المبلغ ({currency})</th></tr>
    <tr class="section-head"><td colspan="2">الأصول المتداولة</td></tr>
    <tr>
      <td>النقد وما يعادله</td>
      <td class="num">{nf('CashAndCashEquivalents', 'CurrentInstant', cash_equivalents)}</td>
    </tr>
    <tr>
      <td>الذمم المدينة التجارية</td>
      <td class="num">{nf('TradeAndOtherCurrentReceivables', 'CurrentInstant', receivables)}</td>
    </tr>
    <tr>
      <td>المخزون</td>
      <td class="num">{nf('Inventories', 'CurrentInstant', inventory_val)}</td>
    </tr>
    <tr class="total">
      <td>إجمالي الأصول المتداولة</td>
      <td class="num">{nf('CurrentAssets', 'CurrentInstant', total_current_assets)}</td>
    </tr>
    <tr class="section-head"><td colspan="2">الأصول غير المتداولة</td></tr>
    <tr>
      <td>الممتلكات والمعدات</td>
      <td class="num">{nf('PropertyPlantAndEquipment', 'CurrentInstant', ppe)}</td>
    </tr>
    <tr>
      <td>الأصول غير الملموسة</td>
      <td class="num">{nf('IntangibleAssetsOtherThanGoodwill', 'CurrentInstant', intangible_assets)}</td>
    </tr>
    <tr class="total">
      <td>إجمالي الأصول غير المتداولة</td>
      <td class="num">{nf('NoncurrentAssets', 'CurrentInstant', total_non_current_assets)}</td>
    </tr>
    <tr class="grand-total">
      <td>إجمالي الأصول</td>
      <td class="num">{nf('Assets', 'CurrentInstant', total_assets)}</td>
    </tr>
    <tr class="section-head"><td colspan="2">الخصوم المتداولة</td></tr>
    <tr>
      <td>الذمم الدائنة التجارية</td>
      <td class="num">{nf('TradeAndOtherCurrentPayables', 'CurrentInstant', trade_payables)}</td>
    </tr>
    <tr>
      <td>قروض قصيرة الأجل</td>
      <td class="num">{nf('ShorttermBorrowings', 'CurrentInstant', short_term_loans)}</td>
    </tr>
    <tr class="total">
      <td>إجمالي الخصوم المتداولة</td>
      <td class="num">{nf('CurrentLiabilities', 'CurrentInstant', total_current_liabilities)}</td>
    </tr>
    <tr class="section-head"><td colspan="2">الخصوم غير المتداولة</td></tr>
    <tr>
      <td>قروض طويلة الأجل</td>
      <td class="num">{nf('LongtermBorrowings', 'CurrentInstant', long_term_loans)}</td>
    </tr>
    <tr class="total">
      <td>إجمالي الخصوم غير المتداولة</td>
      <td class="num">{nf('NoncurrentLiabilities', 'CurrentInstant', total_non_current_liabilities)}</td>
    </tr>
    <tr class="grand-total">
      <td>إجمالي الخصوم</td>
      <td class="num">{nf('Liabilities', 'CurrentInstant', total_liabilities)}</td>
    </tr>
    <tr class="section-head"><td colspan="2">حقوق الملكية</td></tr>
    <tr>
      <td>رأس المال</td>
      <td class="num">{nf('IssuedCapital', 'CurrentInstant', share_capital)}</td>
    </tr>
    <tr>
      <td>الأرباح المبقاة</td>
      <td class="num">{nf('RetainedEarnings', 'CurrentInstant', retained_earnings)}</td>
    </tr>
    <tr class="total">
      <td>إجمالي حقوق الملكية</td>
      <td class="num">{nf('Equity', 'CurrentInstant', total_equity)}</td>
    </tr>
    <tr class="grand-total">
      <td>إجمالي الخصوم وحقوق الملكية</td>
      <td class="num">{nf('EquityAndLiabilities', 'CurrentInstant', total_liabilities + total_equity)}</td>
    </tr>
  </table>

  <!-- ===== قائمة التدفقات النقدية - Statement of Cash Flows (IAS 7) ===== -->
  <h2>قائمة التدفقات النقدية</h2>
  <table>
    <tr><th>البند</th><th style="width:200px">المبلغ ({currency})</th></tr>
    <tr class="section-head"><td colspan="2">الأنشطة التشغيلية (الطريقة المباشرة)</td></tr>
    <tr>
      <td>المقبوضات من العملاء</td>
      <td class="num">{nf('ReceiptsFromSalesOfGoodsAndRenderingOfServices', 'CurrentPeriod', cf_customers_received)}</td>
    </tr>
    <tr>
      <td>المدفوعات للموردين</td>
      <td class="num">({nf('PaymentsToSuppliersForGoodsAndServices', 'CurrentPeriod', cf_suppliers_paid)})</td>
    </tr>
    <tr>
      <td>المدفوعات للموظفين</td>
      <td class="num">({nf('PaymentsToAndOnBehalfOfEmployees', 'CurrentPeriod', cf_employees_paid)})</td>
    </tr>
    <tr>
      <td>فوائد مدفوعة</td>
      <td class="num">({nf('InterestPaidClassifiedAsOperatingActivities', 'CurrentPeriod', cf_interest_paid)})</td>
    </tr>
    <tr>
      <td>ضرائب مدفوعة</td>
      <td class="num">({nf('IncomeTaxesPaidRefundClassifiedAsOperatingActivities', 'CurrentPeriod', cf_taxes_paid)})</td>
    </tr>
    <tr class="total">
      <td>صافي النقد من الأنشطة التشغيلية</td>
      <td class="num">{nf('CashFlowsFromUsedInOperatingActivities', 'CurrentPeriod', net_cash_operating)}</td>
    </tr>
    <tr class="section-head"><td colspan="2">الأنشطة الاستثمارية</td></tr>
    <tr>
      <td>شراء ممتلكات ومعدات</td>
      <td class="num">({nf('PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'CurrentPeriod', cf_ppe_purchased)})</td>
    </tr>
    <tr>
      <td>بيع ممتلكات ومعدات</td>
      <td class="num">{nf('ProceedsFromSalesOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'CurrentPeriod', cf_ppe_sold)}</td>
    </tr>
    <tr class="total">
      <td>صافي النقد من الأنشطة الاستثمارية</td>
      <td class="num">{nf('CashFlowsFromUsedInInvestingActivities', 'CurrentPeriod', net_cash_investing)}</td>
    </tr>
    <tr class="section-head"><td colspan="2">الأنشطة التمويلية</td></tr>
    <tr>
      <td>قروض مستلمة</td>
      <td class="num">{nf('ProceedsFromBorrowingsClassifiedAsFinancingActivities', 'CurrentPeriod', cf_loans_received)}</td>
    </tr>
    <tr>
      <td>سداد قروض</td>
      <td class="num">({nf('RepaymentsOfBorrowingsClassifiedAsFinancingActivities', 'CurrentPeriod', cf_loans_repaid)})</td>
    </tr>
    <tr>
      <td>أرباح موزعة</td>
      <td class="num">({nf('DividendsPaidClassifiedAsFinancingActivities', 'CurrentPeriod', cf_dividends_paid)})</td>
    </tr>
    <tr class="total">
      <td>صافي النقد من الأنشطة التمويلية</td>
      <td class="num">{nf('CashFlowsFromUsedInFinancingActivities', 'CurrentPeriod', net_cash_financing)}</td>
    </tr>
    <tr class="grand-total">
      <td>صافي التغير في النقد</td>
      <td class="num">{nf('IncreaseDecreaseInCashAndCashEquivalents', 'CurrentPeriod', net_change_cash)}</td>
    </tr>
    <tr>
      <td>رصيد النقد - بداية الفترة</td>
      <td class="num">{nf('CashAndCashEquivalents', 'PriorInstant', cash_beginning)}</td>
    </tr>
    <tr class="grand-total">
      <td>رصيد النقد - نهاية الفترة</td>
      <td class="num">{nf('CashAndCashEquivalents', 'CurrentInstant', cash_ending)}</td>
    </tr>
  </table>

  <!-- ===== قائمة التغيرات في حقوق الملكية - Statement of Changes in Equity (IAS 1) ===== -->
  <h2>قائمة التغيرات في حقوق الملكية</h2>
  <table>
    <tr><th>البند</th><th style="width:150px">رأس المال</th><th style="width:150px">أرباح مبقاة</th><th style="width:150px">الإجمالي</th></tr>
    <tr>
      <td>الرصيد الافتتاحي</td>
      <td class="num">{nf('IssuedCapital', 'PriorInstant', equity_opening_capital)}</td>
      <td class="num">{nf('RetainedEarnings', 'PriorInstant', equity_opening_retained)}</td>
      <td class="num">{nf('Equity', 'PriorInstant', equity_opening_total)}</td>
    </tr>
    <tr>
      <td>صافي الربح</td>
      <td class="num">-</td>
      <td class="num">{nf('ProfitLoss', 'CurrentPeriod', net_profit)}</td>
      <td class="num">{fmt(net_profit)}</td>
    </tr>
    <tr>
      <td>الدخل الشامل الآخر</td>
      <td class="num">-</td>
      <td class="num">{nf('OtherComprehensiveIncome', 'CurrentPeriod', other_comprehensive_income)}</td>
      <td class="num">{fmt(other_comprehensive_income)}</td>
    </tr>
    <tr>
      <td>أرباح موزعة (توزيعات على الشركاء)</td>
      <td class="num">-</td>
      <td class="num">({nf('DividendsRecognisedAsDistributionsToOwnersOfParent', 'CurrentPeriod', dividends_declared)})</td>
      <td class="num">({fmt(dividends_declared)})</td>
    </tr>
    <tr>
      <td>زيادة / تغير في رأس المال</td>
      <td class="num">{nf('IncreaseDecreaseThroughTransactionsWithOwners', 'CurrentPeriod', equity_new_capital)}</td>
      <td class="num">-</td>
      <td class="num">{fmt(equity_new_capital)}</td>
    </tr>
    <tr class="grand-total">
      <td>الرصيد الختامي</td>
      <td class="num">{nf('IssuedCapital', 'CurrentInstant', equity_closing_capital)}</td>
      <td class="num">{nf('RetainedEarnings', 'CurrentInstant', equity_closing_retained)}</td>
      <td class="num">{nf('Equity', 'CurrentInstant', equity_closing_total)}</td>
    </tr>
  </table>

  {''.join(f"""
  <!-- تفصيل حقوق الملكية لكل شريك -->
  <h3 style="color: #2b6cb0; margin-top: 25px;">تفصيل حقوق الملكية حسب الشركاء</h3>
  <table>
    <tr>
      <th>الشريك</th>
      <th style="width:100px">نسبة الملكية</th>
      <th style="width:130px">رأس المال الافتتاحي</th>
      <th style="width:130px">نصيب الربح</th>
      <th style="width:130px">التوزيعات</th>
      <th style="width:130px">تغير رأس المال</th>
      <th style="width:130px">الرصيد الختامي</th>
    </tr>
    """ + ''.join(f"""<tr>
      <td style="font-weight: bold;">{pd['name']}</td>
      <td class="num">{pd['share_percent']:.1f}%</td>
      <td class="num">{fmt(pd['capital_opening'])}</td>
      <td class="num" style="color: #38a169;">{fmt(pd['profit_share'])}</td>
      <td class="num" style="color: #c53030;">({fmt(pd['distributions'])})</td>
      <td class="num">{fmt(pd['capital_change'])}</td>
      <td class="num" style="font-weight: bold;">{fmt(pd['capital_closing'])}</td>
    </tr>""" for pd in partners_data) + f"""
    <tr class="grand-total">
      <td>الإجمالي</td>
      <td class="num">{sum(pd['share_percent'] for pd in partners_data):.1f}%</td>
      <td class="num">{fmt(sum(pd['capital_opening'] for pd in partners_data))}</td>
      <td class="num">{fmt(sum(pd['profit_share'] for pd in partners_data))}</td>
      <td class="num">({fmt(sum(pd['distributions'] for pd in partners_data))})</td>
      <td class="num">{fmt(sum(pd['capital_change'] for pd in partners_data))}</td>
      <td class="num">{fmt(sum(pd['capital_closing'] for pd in partners_data))}</td>
    </tr>
  </table>
  """ if partners_data else '')}

  <div class="footer">
    <p>تقرير مالي مولّد آلياً وفق معايير IFRS - صيغة Inline XBRL (iXBRL)</p>
    <p>تم التوليد بتاريخ: {period_end}</p>
  </div>
</body>
</html>'''

        # حفظ التقرير
        conn = get_db()
        cursor = conn.cursor()
        ensure_xbrl_tables(cursor)
        conn.commit()
        report_data_json = json.dumps({
            'revenue': total_revenue,
            'cost_of_sales': cost_of_sales,
            'gross_profit': gross_profit,
            'operating_expenses': total_opex,
            'depreciation': depreciation,
            'operating_profit': operating_profit,
            'finance_costs': finance_costs,
            'profit_before_tax': profit_before_tax,
            'zakat_tax': zakat_tax,
            'net_profit': net_profit,
            'total_current_assets': total_current_assets,
            'total_non_current_assets': total_non_current_assets,
            'total_assets': total_assets,
            'total_current_liabilities': total_current_liabilities,
            'total_non_current_liabilities': total_non_current_liabilities,
            'total_liabilities': total_liabilities,
            'total_equity': total_equity,
            'cash_flow': {
                'net_cash_operating': net_cash_operating,
                'net_cash_investing': net_cash_investing,
                'net_cash_financing': net_cash_financing,
                'net_change_cash': net_change_cash,
                'cash_beginning': cash_beginning,
                'cash_ending': cash_ending
            },
            'equity_changes': {
                'opening_total': equity_opening_total,
                'closing_total': equity_closing_total,
                'net_profit': net_profit,
                'dividends': dividends_declared,
                'new_capital': equity_new_capital,
                'other_comprehensive_income': other_comprehensive_income,
                'partners': partners_data
            },
            'company': company,
            'manual_adjustments': manual_adjustments
        }, ensure_ascii=False)

        cursor.execute('''INSERT INTO xbrl_reports
            (report_type, period_start, period_end, report_data, xbrl_xml, notes)
            VALUES (?, ?, ?, ?, ?, ?)''',
            ('IFRS_FULL', period_start, period_end, report_data_json, xbrl_xml,
             data.get('notes', '')))
        report_id = cursor.lastrowid
        conn.commit()
        conn.close()

        return jsonify({
            'success': True,
            'report_id': report_id,
            'xbrl_xml': xbrl_xml,
            'summary': {
                'total_revenue': total_revenue,
                'cost_of_sales': cost_of_sales,
                'gross_profit': gross_profit,
                'operating_expenses': total_opex,
                'operating_profit': operating_profit,
                'finance_costs': finance_costs,
                'profit_before_tax': profit_before_tax,
                'zakat_tax': zakat_tax,
                'net_profit': net_profit,
                'total_assets': total_assets,
                'total_liabilities': total_liabilities,
                'total_equity': total_equity,
                'net_cash_operating': net_cash_operating,
                'net_cash_investing': net_cash_investing,
                'net_cash_financing': net_cash_financing,
                'net_change_cash': net_change_cash,
                'cash_beginning': cash_beginning,
                'cash_ending': cash_ending,
                'equity_opening_total': equity_opening_total,
                'equity_closing_total': equity_closing_total,
                'dividends_declared': dividends_declared,
                'other_comprehensive_income': other_comprehensive_income,
                'partners': partners_data
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/xbrl/reports', methods=['GET'])
def list_xbrl_reports():
    """قائمة التقارير المحفوظة"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        ensure_xbrl_tables(cursor)
        conn.commit()
        cursor.execute('SELECT id, report_type, period_start, period_end, created_at, notes FROM xbrl_reports ORDER BY created_at DESC LIMIT 50')
        rows = cursor.fetchall()
        conn.close()
        reports = [dict_from_row(r) for r in rows]
        return jsonify({'success': True, 'reports': reports})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/xbrl/reports/<int:report_id>', methods=['GET'])
def get_xbrl_report(report_id):
    """جلب تقرير XBRL محدد"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        ensure_xbrl_tables(cursor)
        conn.commit()
        cursor.execute('SELECT * FROM xbrl_reports WHERE id = ?', (report_id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            return jsonify({'success': False, 'error': 'التقرير غير موجود'}), 404
        return jsonify({'success': True, 'report': dict_from_row(row)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== نظام الشفتات =====

@app.route('/api/shifts', methods=['GET'])
def get_shifts():
    """جلب جميع الشفتات"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM shifts ORDER BY created_at DESC')
        shifts = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'shifts': shifts})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/shifts', methods=['POST'])
def add_shift():
    """إضافة شفت جديد"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO shifts (name, start_time, end_time, is_active, auto_lock)
            VALUES (?, ?, ?, ?, ?)
        ''', (
            data.get('name'),
            data.get('start_time', ''),
            data.get('end_time', ''),
            data.get('is_active', 1),
            data.get('auto_lock', 0)
        ))
        shift_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'id': shift_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/shifts/<int:shift_id>', methods=['PUT'])
def update_shift(shift_id):
    """تحديث شفت"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE shifts SET name = ?, start_time = ?, end_time = ?, is_active = ?, auto_lock = ?
            WHERE id = ?
        ''', (
            data.get('name'),
            data.get('start_time', ''),
            data.get('end_time', ''),
            data.get('is_active', 1),
            data.get('auto_lock', 0),
            shift_id
        ))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/shifts/<int:shift_id>', methods=['DELETE'])
def delete_shift(shift_id):
    """حذف شفت"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        # إزالة الشفت من المستخدمين المرتبطين
        cursor.execute('UPDATE users SET shift_id = NULL WHERE shift_id = ?', (shift_id,))
        cursor.execute('DELETE FROM shifts WHERE id = ?', (shift_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/shifts/check-lock', methods=['POST'])
def check_shift_lock():
    """فحص هل انتهى الشفت ويجب قفل النظام"""
    try:
        data = request.json
        shift_id = data.get('shift_id')
        if not shift_id:
            return jsonify({'success': True, 'locked': False})

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM shifts WHERE id = ?', (shift_id,))
        shift = cursor.fetchone()
        conn.close()

        if not shift:
            return jsonify({'success': True, 'locked': False})

        shift = dict_from_row(shift)
        if not shift.get('auto_lock') or not shift.get('end_time'):
            return jsonify({'success': True, 'locked': False})

        # مقارنة الوقت الحالي مع وقت انتهاء الشفت
        from datetime import datetime
        now = datetime.now()
        current_time = now.strftime('%H:%M')

        end_time = shift['end_time']
        start_time = shift.get('start_time', '00:00')

        # التعامل مع الشفتات التي تتجاوز منتصف الليل
        if start_time <= end_time:
            # شفت عادي (مثل 08:00 - 16:00)
            locked = current_time >= end_time or current_time < start_time
        else:
            # شفت ليلي (مثل 22:00 - 06:00)
            locked = current_time >= end_time and current_time < start_time

        return jsonify({
            'success': True,
            'locked': locked,
            'shift_name': shift['name'],
            'end_time': end_time,
            'current_time': current_time
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== تعديل الفواتير =====

@app.route('/api/invoices/<int:invoice_id>/edit', methods=['PUT'])
def edit_invoice(invoice_id):
    """تعديل فاتورة مع تعديل المخزون"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        # جلب الفاتورة الحالية
        cursor.execute('SELECT * FROM invoices WHERE id = ?', (invoice_id,))
        invoice = cursor.fetchone()
        if not invoice:
            conn.close()
            return jsonify({'success': False, 'error': 'الفاتورة غير موجودة'}), 404

        inv = dict_from_row(invoice)

        # التحقق إذا كانت ملغية
        if inv.get('cancelled'):
            conn.close()
            return jsonify({'success': False, 'error': 'لا يمكن تعديل فاتورة ملغية'}), 400

        # التحقق من الصلاحية: إذا كانت "منجز" يحتاج صلاحية خاصة
        if inv.get('order_status') == 'منجز':
            user_can_edit = data.get('can_edit_completed', False)
            if not user_can_edit:
                conn.close()
                return jsonify({'success': False, 'error': 'لا تملك صلاحية تعديل فاتورة منجزة'}), 403

        # جلب العناصر القديمة
        cursor.execute('SELECT * FROM invoice_items WHERE invoice_id = ?', (invoice_id,))
        old_items = [dict_from_row(row) for row in cursor.fetchall()]

        # إرجاع المخزون القديم
        for item in old_items:
            bs_id = item.get('branch_stock_id')
            if bs_id:
                cursor.execute('''
                    UPDATE branch_stock
                    SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                ''', (item.get('quantity', 0), bs_id))

        # حذف العناصر القديمة
        cursor.execute('DELETE FROM invoice_items WHERE invoice_id = ?', (invoice_id,))

        # إدراج العناصر الجديدة وخصم المخزون
        new_items = data.get('items', [])
        for item in new_items:
            branch_stock_id = item.get('branch_stock_id') or item.get('product_id')
            cursor.execute('''
                INSERT INTO invoice_items
                (invoice_id, product_id, product_name, quantity, price, total, branch_stock_id, variant_id, variant_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                invoice_id,
                item.get('product_id'),
                item.get('product_name'),
                item.get('quantity'),
                item.get('price'),
                item.get('total'),
                branch_stock_id,
                item.get('variant_id'),
                item.get('variant_name')
            ))
            # خصم المخزون الجديد
            if branch_stock_id:
                cursor.execute('''
                    UPDATE branch_stock
                    SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                ''', (item.get('quantity', 0), branch_stock_id))

        # تحديث بيانات الفاتورة
        cursor.execute('''
            UPDATE invoices SET
                customer_id = ?, customer_name = ?, customer_phone = ?, customer_address = ?,
                subtotal = ?, discount = ?, total = ?, payment_method = ?,
                notes = ?, delivery_fee = ?,
                edited_at = CURRENT_TIMESTAMP, edited_by = ?,
                edit_count = COALESCE(edit_count, 0) + 1
            WHERE id = ?
        ''', (
            data.get('customer_id', inv.get('customer_id')),
            data.get('customer_name', inv.get('customer_name', '')),
            data.get('customer_phone', inv.get('customer_phone', '')),
            data.get('customer_address', inv.get('customer_address', '')),
            data.get('subtotal', inv.get('subtotal', 0)),
            data.get('discount', inv.get('discount', 0)),
            data.get('total', inv.get('total', 0)),
            data.get('payment_method', inv.get('payment_method', '')),
            data.get('notes', inv.get('notes', '')),
            data.get('delivery_fee', inv.get('delivery_fee', 0)),
            data.get('edited_by', ''),
            invoice_id
        ))

        # حفظ عمليات الدفع المتعددة
        payments = data.get('payments', [])
        if payments:
            payments_json = json.dumps(payments, ensure_ascii=False)
            cursor.execute('UPDATE invoices SET transaction_number = ? WHERE id = ?', (payments_json, invoice_id))

        # حفظ سجل التعديل
        changes = json.dumps({
            'old_total': inv.get('total', 0),
            'new_total': data.get('total', 0),
            'old_items_count': len(old_items),
            'new_items_count': len(new_items)
        }, ensure_ascii=False)
        cursor.execute('''
            INSERT INTO invoice_edit_history (invoice_id, edited_by, edited_by_name, changes)
            VALUES (?, ?, ?, ?)
        ''', (
            invoice_id,
            data.get('edited_by_id'),
            data.get('edited_by', ''),
            changes
        ))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/invoices/<int:invoice_id>/edit-history', methods=['GET'])
def get_invoice_edit_history(invoice_id):
    """جلب سجل تعديلات فاتورة"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM invoice_edit_history WHERE invoice_id = ? ORDER BY edited_at DESC', (invoice_id,))
        history = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'history': history})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== أداء الشفتات - شاشة الأدمن =====

@app.route('/api/admin-dashboard/shift-performance', methods=['GET'])
def admin_dashboard_shift_performance():
    """أداء الموظفين حسب الشفتات"""
    try:
        tenant_slug = get_tenant_slug()
        db_path = get_tenant_db_path(tenant_slug) if tenant_slug else DB_PATH

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # جلب الشفتات
        cursor.execute('SELECT * FROM shifts WHERE is_active = 1 ORDER BY id')
        shifts = [dict(row) for row in cursor.fetchall()]

        # أداء كل شفت
        shift_stats = []
        for shift in shifts:
            # إجمالي المبيعات
            cursor.execute('''
                SELECT
                    COUNT(i.id) as total_invoices,
                    COALESCE(SUM(i.total), 0) as total_sales,
                    COUNT(CASE WHEN DATE(i.created_at) = DATE('now') THEN 1 END) as today_invoices,
                    COALESCE(SUM(CASE WHEN DATE(i.created_at) = DATE('now') THEN i.total ELSE 0 END), 0) as today_sales
                FROM invoices i
                WHERE i.shift_id = ? AND i.cancelled = 0
            ''', (shift['id'],))
            stats = dict(cursor.fetchone())

            # موظفي هذا الشفت
            cursor.execute('''
                SELECT u.id, u.full_name, u.username,
                    COUNT(i.id) as invoice_count,
                    COALESCE(SUM(i.total), 0) as total_sales
                FROM users u
                LEFT JOIN invoices i ON i.employee_name = u.full_name AND i.shift_id = ? AND i.cancelled = 0
                WHERE u.shift_id = ? AND u.is_active = 1
                GROUP BY u.id
                ORDER BY total_sales DESC
            ''', (shift['id'], shift['id']))
            employees = [dict(row) for row in cursor.fetchall()]

            shift_stats.append({
                'shift': shift,
                'stats': stats,
                'employees': employees
            })

        # موظفين بدون شفت
        cursor.execute('''
            SELECT u.id, u.full_name, u.username,
                COUNT(i.id) as invoice_count,
                COALESCE(SUM(i.total), 0) as total_sales
            FROM users u
            LEFT JOIN invoices i ON i.employee_name = u.full_name AND i.cancelled = 0
            WHERE (u.shift_id IS NULL OR u.shift_id = 0) AND u.is_active = 1
            GROUP BY u.id
            ORDER BY total_sales DESC
        ''')
        unassigned = [dict(row) for row in cursor.fetchall()]

        conn.close()
        return jsonify({
            'success': True,
            'shift_stats': shift_stats,
            'unassigned_employees': unassigned
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== نظام طلبات النقل المخزني =====

@app.route('/api/stock-transfers', methods=['GET'])
def get_stock_transfers():
    """جلب جميع طلبات النقل"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        status = request.args.get('status')
        branch_id = request.args.get('branch_id')

        query = 'SELECT * FROM stock_transfers WHERE 1=1'
        params = []

        if status:
            query += ' AND status = ?'
            params.append(status)

        if branch_id:
            query += ' AND (from_branch_id = ? OR to_branch_id = ?)'
            params.extend([branch_id, branch_id])

        query += ' ORDER BY requested_at DESC LIMIT 200'
        cursor.execute(query, params)
        transfers = [dict_from_row(row) for row in cursor.fetchall()]

        # جلب عناصر كل طلب
        for t in transfers:
            cursor.execute('SELECT * FROM stock_transfer_items WHERE transfer_id = ?', (t['id'],))
            t['items'] = [dict_from_row(r) for r in cursor.fetchall()]

        conn.close()
        return jsonify({'success': True, 'transfers': transfers})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stock-transfers/<int:transfer_id>', methods=['GET'])
def get_stock_transfer(transfer_id):
    """جلب تفاصيل طلب نقل واحد"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM stock_transfers WHERE id = ?', (transfer_id,))
        transfer = cursor.fetchone()
        if not transfer:
            conn.close()
            return jsonify({'success': False, 'error': 'الطلب غير موجود'}), 404

        transfer = dict_from_row(transfer)
        cursor.execute('SELECT * FROM stock_transfer_items WHERE transfer_id = ?', (transfer_id,))
        transfer['items'] = [dict_from_row(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'transfer': transfer})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stock-transfers', methods=['POST'])
def create_stock_transfer():
    """إنشاء طلب نقل مخزني جديد"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        # إنشاء رقم الطلب
        cursor.execute('SELECT COUNT(*) FROM stock_transfers')
        count = cursor.fetchone()[0]
        transfer_number = f'TR-{count + 1:05d}'

        # جلب أسماء الفروع
        from_branch_name = ''
        to_branch_name = ''
        if data.get('from_branch_id'):
            cursor.execute('SELECT name FROM branches WHERE id = ?', (data['from_branch_id'],))
            row = cursor.fetchone()
            if row: from_branch_name = row['name']
        if data.get('to_branch_id'):
            cursor.execute('SELECT name FROM branches WHERE id = ?', (data['to_branch_id'],))
            row = cursor.fetchone()
            if row: to_branch_name = row['name']

        cursor.execute('''
            INSERT INTO stock_transfers
            (transfer_number, from_branch_id, from_branch_name, to_branch_id, to_branch_name,
             status, requested_by, requested_by_name, notes)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ''', (
            transfer_number,
            data.get('from_branch_id'),
            from_branch_name,
            data.get('to_branch_id'),
            to_branch_name,
            data.get('requested_by'),
            data.get('requested_by_name'),
            data.get('notes', '')
        ))
        transfer_id = cursor.lastrowid

        # إضافة العناصر
        items = data.get('items', [])
        for item in items:
            cursor.execute('''
                INSERT INTO stock_transfer_items
                (transfer_id, inventory_id, product_name, variant_id, variant_name, quantity_requested)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (
                transfer_id,
                item.get('inventory_id'),
                item.get('product_name', ''),
                item.get('variant_id'),
                item.get('variant_name', ''),
                item.get('quantity', 0)
            ))

        conn.commit()
        conn.close()
        return jsonify({'success': True, 'id': transfer_id, 'transfer_number': transfer_number})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stock-transfers/<int:transfer_id>/approve', methods=['PUT'])
def approve_stock_transfer(transfer_id):
    """الموافقة على طلب النقل وتجهيز البضاعة (خصم من المصدر)"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT * FROM stock_transfers WHERE id = ?', (transfer_id,))
        transfer = cursor.fetchone()
        if not transfer:
            conn.close()
            return jsonify({'success': False, 'error': 'الطلب غير موجود'}), 404
        if transfer['status'] != 'pending':
            conn.close()
            return jsonify({'success': False, 'error': 'لا يمكن الموافقة - الحالة الحالية: ' + transfer['status']}), 400

        # التحقق من أن المستخدم من الفرع المرسل
        user_branch = data.get('user_branch_id')
        if user_branch and int(user_branch) != transfer['from_branch_id']:
            conn.close()
            return jsonify({'success': False, 'error': 'فقط الفرع المرسل يمكنه الموافقة على الطلب'}), 403

        # تحديث الكميات المعتمدة
        approved_items = data.get('items', [])
        for ai in approved_items:
            cursor.execute('''
                UPDATE stock_transfer_items SET quantity_approved = ?
                WHERE id = ? AND transfer_id = ?
            ''', (ai.get('quantity_approved', 0), ai.get('item_id'), transfer_id))

        # خصم المخزون من الفرع المصدر (بضاعة بالطريق)
        cursor.execute('SELECT * FROM stock_transfer_items WHERE transfer_id = ?', (transfer_id,))
        items = [dict_from_row(r) for r in cursor.fetchall()]

        for item in items:
            qty = item.get('quantity_approved') or item.get('quantity_requested', 0)
            if qty > 0 and item.get('inventory_id'):
                cursor.execute('''
                    UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
                    WHERE inventory_id = ? AND branch_id = ?
                    AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL))
                ''', (qty, item['inventory_id'], transfer['from_branch_id'],
                      item.get('variant_id'), item.get('variant_id')))

        cursor.execute('''
            UPDATE stock_transfers
            SET status = 'approved', approved_by = ?, approved_by_name = ?, approved_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (data.get('approved_by'), data.get('approved_by_name'), transfer_id))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stock-transfers/<int:transfer_id>/reject', methods=['PUT'])
def reject_stock_transfer(transfer_id):
    """رفض طلب النقل"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT * FROM stock_transfers WHERE id = ?', (transfer_id,))
        transfer = cursor.fetchone()
        if not transfer:
            conn.close()
            return jsonify({'success': False, 'error': 'الطلب غير موجود'}), 404
        if transfer['status'] != 'pending':
            conn.close()
            return jsonify({'success': False, 'error': 'لا يمكن الرفض - الحالة: ' + transfer['status']}), 400

        # التحقق من أن المستخدم من الفرع المرسل
        user_branch = data.get('user_branch_id')
        if user_branch and int(user_branch) != transfer['from_branch_id']:
            conn.close()
            return jsonify({'success': False, 'error': 'فقط الفرع المرسل يمكنه رفض الطلب'}), 403

        cursor.execute('''
            UPDATE stock_transfers
            SET status = 'rejected', reject_reason = ?, approved_by = ?, approved_by_name = ?, approved_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (data.get('reject_reason', ''), data.get('approved_by'), data.get('approved_by_name'), transfer_id))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stock-transfers/<int:transfer_id>/pickup', methods=['PUT'])
def pickup_stock_transfer(transfer_id):
    """استلام السائق للبضاعة - تحويل الحالة إلى جاري التوصيل"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT * FROM stock_transfers WHERE id = ?', (transfer_id,))
        transfer = cursor.fetchone()
        if not transfer:
            conn.close()
            return jsonify({'success': False, 'error': 'الطلب غير موجود'}), 404
        if transfer['status'] != 'approved':
            conn.close()
            return jsonify({'success': False, 'error': 'لا يمكن الاستلام - الحالة: ' + transfer['status']}), 400

        # التحقق من أن المستخدم من الفرع المرسل
        user_branch = data.get('user_branch_id')
        if user_branch and int(user_branch) != transfer['from_branch_id']:
            conn.close()
            return jsonify({'success': False, 'error': 'فقط الفرع المرسل يمكنه تسليم البضاعة للسائق'}), 403

        cursor.execute('''
            UPDATE stock_transfers
            SET status = 'in_transit', driver_id = ?, driver_name = ?, picked_up_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (data.get('driver_id'), data.get('driver_name'), transfer_id))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stock-transfers/<int:transfer_id>/receive', methods=['PUT'])
def receive_stock_transfer(transfer_id):
    """تأكيد الاستلام - إضافة المخزون للفرع الطالب وإتمام الطلب"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT * FROM stock_transfers WHERE id = ?', (transfer_id,))
        transfer = cursor.fetchone()
        if not transfer:
            conn.close()
            return jsonify({'success': False, 'error': 'الطلب غير موجود'}), 404
        if transfer['status'] != 'in_transit':
            conn.close()
            return jsonify({'success': False, 'error': 'لا يمكن تأكيد الاستلام - الحالة: ' + transfer['status']}), 400

        # التحقق من أن المستخدم من الفرع الطالب
        user_branch = data.get('user_branch_id')
        if user_branch and int(user_branch) != transfer['to_branch_id']:
            conn.close()
            return jsonify({'success': False, 'error': 'فقط الفرع الطالب يمكنه تأكيد الاستلام وإتمام العملية'}), 403

        transfer = dict_from_row(transfer)

        # تحديث الكميات المستلمة
        received_items = data.get('items', [])
        for ri in received_items:
            if ri.get('item_id') and ri.get('quantity_received') is not None:
                cursor.execute('''
                    UPDATE stock_transfer_items SET quantity_received = ?
                    WHERE id = ? AND transfer_id = ?
                ''', (ri['quantity_received'], ri['item_id'], transfer_id))

        # جلب العناصر بعد التحديث
        cursor.execute('SELECT * FROM stock_transfer_items WHERE transfer_id = ?', (transfer_id,))
        items = [dict_from_row(r) for r in cursor.fetchall()]

        # إضافة المخزون للفرع المستلم
        to_branch_id = transfer['to_branch_id']
        for item in items:
            qty = item.get('quantity_received') or item.get('quantity_approved') or item.get('quantity_requested', 0)
            if qty > 0 and item.get('inventory_id'):
                # تحقق من وجود سجل branch_stock
                cursor.execute('''
                    SELECT id, stock FROM branch_stock
                    WHERE inventory_id = ? AND branch_id = ?
                    AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL))
                ''', (item['inventory_id'], to_branch_id,
                      item.get('variant_id'), item.get('variant_id')))
                existing = cursor.fetchone()

                if existing:
                    cursor.execute('''
                        UPDATE branch_stock SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    ''', (qty, existing['id']))
                else:
                    cursor.execute('''
                        INSERT INTO branch_stock (inventory_id, branch_id, variant_id, stock)
                        VALUES (?, ?, ?, ?)
                    ''', (item['inventory_id'], to_branch_id, item.get('variant_id'), qty))

        cursor.execute('''
            UPDATE stock_transfers
            SET status = 'completed', received_by = ?, received_by_name = ?,
                delivered_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (data.get('received_by'), data.get('received_by_name'), transfer_id))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/stock-transfers/<int:transfer_id>', methods=['DELETE'])
def delete_stock_transfer(transfer_id):
    """حذف طلب نقل (فقط الطلبات قيد الانتظار أو المرفوضة)"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT status, from_branch_id, to_branch_id FROM stock_transfers WHERE id = ?', (transfer_id,))
        transfer = cursor.fetchone()
        if not transfer:
            conn.close()
            return jsonify({'success': False, 'error': 'الطلب غير موجود'}), 404
        if transfer['status'] not in ('pending', 'rejected'):
            conn.close()
            return jsonify({'success': False, 'error': 'لا يمكن حذف طلب في حالة: ' + transfer['status']}), 400

        # التحقق من أن المستخدم من الفرع الطالب
        user_branch = request.args.get('user_branch_id')
        if user_branch and int(user_branch) != transfer['to_branch_id']:
            conn.close()
            return jsonify({'success': False, 'error': 'فقط الفرع الطالب يمكنه حذف الطلب'}), 403

        cursor.execute('DELETE FROM stock_transfer_items WHERE transfer_id = ?', (transfer_id,))
        cursor.execute('DELETE FROM stock_transfers WHERE id = ?', (transfer_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== API الاشتراكات =====

@app.route('/api/subscription-plans', methods=['GET'])
def get_subscription_plans():
    """جلب خطط الاشتراك مع منتجاتها"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM subscription_plans ORDER BY price ASC')
        plans = [dict_from_row(row) for row in cursor.fetchall()]
        # جلب منتجات كل خطة
        for plan in plans:
            cursor.execute('SELECT * FROM subscription_plan_items WHERE plan_id = ?', (plan['id'],))
            plan['items'] = [dict_from_row(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'plans': plans})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-plans', methods=['POST'])
def add_subscription_plan():
    """إضافة خطة اشتراك مع منتجات"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO subscription_plans (name, duration_days, price, discount_percent, loyalty_multiplier, description, image)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (data.get('name'), data.get('duration_days', 30), data.get('price', 0),
              data.get('discount_percent', 0), data.get('loyalty_multiplier', 1), data.get('description', ''), data.get('image', '')))
        plan_id = cursor.lastrowid

        # إضافة منتجات الخطة
        items = data.get('items', [])
        for item in items:
            cursor.execute('''
                INSERT INTO subscription_plan_items (plan_id, product_id, product_name, variant_id, variant_name, quantity)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (plan_id, item.get('product_id'), item.get('product_name'),
                  item.get('variant_id'), item.get('variant_name'), item.get('quantity', 1)))

        conn.commit()
        conn.close()
        return jsonify({'success': True, 'id': plan_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-plans/<int:plan_id>', methods=['PUT'])
def update_subscription_plan(plan_id):
    """تحديث خطة اشتراك"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE subscription_plans SET name=?, duration_days=?, price=?, discount_percent=?,
            loyalty_multiplier=?, description=?, image=?, is_active=? WHERE id=?
        ''', (data.get('name'), data.get('duration_days'), data.get('price'),
              data.get('discount_percent'), data.get('loyalty_multiplier'),
              data.get('description', ''), data.get('image', ''), data.get('is_active', 1), plan_id))

        # تحديث المنتجات إذا تم إرسالها
        if 'items' in data:
            cursor.execute('DELETE FROM subscription_plan_items WHERE plan_id = ?', (plan_id,))
            for item in data['items']:
                cursor.execute('''
                    INSERT INTO subscription_plan_items (plan_id, product_id, product_name, variant_id, variant_name, quantity)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (plan_id, item.get('product_id'), item.get('product_name'),
                      item.get('variant_id'), item.get('variant_name'), item.get('quantity', 1)))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-plans/<int:plan_id>', methods=['DELETE'])
def delete_subscription_plan(plan_id):
    """حذف خطة اشتراك ومنتجاتها"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM subscription_plan_items WHERE plan_id = ?', (plan_id,))
        cursor.execute('DELETE FROM subscription_plans WHERE id = ?', (plan_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-plans/<int:plan_id>/items', methods=['GET'])
def get_plan_items(plan_id):
    """جلب منتجات خطة اشتراك"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM subscription_plan_items WHERE plan_id = ?', (plan_id,))
        items = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'items': items})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-plans/<int:plan_id>/items', methods=['POST'])
def add_plan_item(plan_id):
    """إضافة منتج لخطة اشتراك"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO subscription_plan_items (plan_id, product_id, product_name, variant_id, variant_name, quantity)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (plan_id, data.get('product_id'), data.get('product_name'),
              data.get('variant_id'), data.get('variant_name'), data.get('quantity', 1)))
        conn.commit()
        item_id = cursor.lastrowid
        conn.close()
        return jsonify({'success': True, 'id': item_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-plan-items/<int:item_id>', methods=['DELETE'])
def delete_plan_item(item_id):
    """حذف منتج من خطة اشتراك"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM subscription_plan_items WHERE id = ?', (item_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customer-subscriptions', methods=['GET'])
def get_customer_subscriptions():
    """جلب اشتراكات العملاء مع منتجاتها والاستلامات"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        status_filter = request.args.get('status', '')
        query = 'SELECT * FROM customer_subscriptions WHERE 1=1'
        params = []
        if status_filter:
            query += ' AND status = ?'
            params.append(status_filter)
        query += ' ORDER BY created_at DESC'
        cursor.execute(query, params)
        subs = [dict_from_row(row) for row in cursor.fetchall()]

        # جلب منتجات الخطة والاستلامات لكل اشتراك
        for sub in subs:
            if sub.get('plan_id'):
                cursor.execute('SELECT * FROM subscription_plan_items WHERE plan_id = ?', (sub['plan_id'],))
                sub['plan_items'] = [dict_from_row(r) for r in cursor.fetchall()]
            else:
                sub['plan_items'] = []
            # مجموع الاستلامات لكل منتج
            cursor.execute('''
                SELECT product_id, variant_id, SUM(quantity) as total_redeemed
                FROM subscription_redemptions WHERE subscription_id = ?
                GROUP BY product_id, variant_id
            ''', (sub['id'],))
            redeemed_map = {}
            for r in cursor.fetchall():
                rd = dict_from_row(r)
                key = f"{rd['product_id']}_{rd['variant_id'] or 0}"
                redeemed_map[key] = rd['total_redeemed']
            sub['redeemed_map'] = redeemed_map

        conn.close()
        return jsonify({'success': True, 'subscriptions': subs})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customer-subscriptions', methods=['POST'])
def add_customer_subscription():
    """إضافة اشتراك لعميل"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()

        customer_id = data.get('customer_id')
        plan_id = data.get('plan_id')
        subscription_code = data.get('subscription_code', '').strip()

        if not customer_id or not plan_id:
            conn.close()
            return jsonify({'success': False, 'error': 'يجب تحديد العميل والخطة'}), 400

        if not subscription_code:
            conn.close()
            return jsonify({'success': False, 'error': 'يجب إدخال كود الاشتراك'}), 400

        # التحقق من عدم تكرار الكود
        cursor.execute('SELECT id FROM customer_subscriptions WHERE subscription_code = ?', (subscription_code,))
        if cursor.fetchone():
            conn.close()
            return jsonify({'success': False, 'error': 'كود الاشتراك مستخدم مسبقاً'}), 400

        # جلب بيانات الخطة
        cursor.execute('SELECT * FROM subscription_plans WHERE id = ?', (plan_id,))
        plan_row = cursor.fetchone()
        if not plan_row:
            conn.close()
            return jsonify({'success': False, 'error': 'الخطة غير موجودة'}), 404
        plan = dict_from_row(plan_row)

        # جلب بيانات العميل
        cursor.execute('SELECT name, phone FROM customers WHERE id = ?', (customer_id,))
        cust_row = cursor.fetchone()
        if not cust_row:
            conn.close()
            return jsonify({'success': False, 'error': 'العميل غير موجود'}), 404
        cust = dict_from_row(cust_row)

        from datetime import datetime, timedelta
        start_date = data.get('start_date', datetime.now().strftime('%Y-%m-%d'))
        start_dt = datetime.strptime(start_date, '%Y-%m-%d')
        end_dt = start_dt + timedelta(days=plan['duration_days'])
        end_date = end_dt.strftime('%Y-%m-%d')

        cursor.execute('''
            INSERT INTO customer_subscriptions
            (customer_id, customer_name, customer_phone, plan_id, plan_name, subscription_code,
             start_date, end_date, price_paid, discount_percent, loyalty_multiplier, notes,
             created_by, created_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (customer_id, cust['name'], cust['phone'], plan_id, plan['name'],
              subscription_code, start_date, end_date, data.get('price_paid', plan['price']),
              plan['discount_percent'], plan['loyalty_multiplier'],
              data.get('notes', ''), data.get('created_by'), data.get('created_by_name')))

        conn.commit()
        sub_id = cursor.lastrowid
        conn.close()
        return jsonify({'success': True, 'id': sub_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customer-subscriptions/<int:sub_id>', methods=['PUT'])
def update_customer_subscription(sub_id):
    """تحديث اشتراك"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE customer_subscriptions SET status=?, notes=?, end_date=? WHERE id=?
        ''', (data.get('status'), data.get('notes', ''), data.get('end_date'), sub_id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customer-subscriptions/<int:sub_id>', methods=['DELETE'])
def delete_customer_subscription(sub_id):
    """حذف اشتراك"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM customer_subscriptions WHERE id = ?', (sub_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/customer-subscriptions/check', methods=['GET'])
def check_customer_subscription():
    """التحقق من اشتراك عميل مع المنتجات والكميات المتبقية"""
    try:
        code = request.args.get('code', '').strip()
        phone = request.args.get('phone', '').strip()
        customer_id = request.args.get('customer_id', '')

        conn = get_db()
        cursor = conn.cursor()

        query = 'SELECT * FROM customer_subscriptions WHERE status = \'active\''
        params = []

        if code:
            query += ' AND subscription_code = ?'
            params.append(code)
        elif customer_id:
            query += ' AND customer_id = ?'
            params.append(int(customer_id))
        elif phone:
            query += ' AND customer_phone = ?'
            params.append(phone)
        else:
            conn.close()
            return jsonify({'success': True, 'subscription': None})

        query += ' ORDER BY end_date DESC LIMIT 1'
        cursor.execute(query, params)
        row = cursor.fetchone()

        if not row:
            conn.close()
            return jsonify({'success': True, 'subscription': None, 'active': False})

        sub = dict_from_row(row)
        from datetime import datetime
        today = datetime.now().strftime('%Y-%m-%d')
        if sub['end_date'] < today:
            cursor.execute('UPDATE customer_subscriptions SET status = \'expired\' WHERE id = ?', (sub['id'],))
            conn.commit()
            sub['status'] = 'expired'
            conn.close()
            return jsonify({'success': True, 'subscription': sub, 'active': False})

        # جلب منتجات الخطة
        if sub.get('plan_id'):
            cursor.execute('SELECT * FROM subscription_plan_items WHERE plan_id = ?', (sub['plan_id'],))
            sub['plan_items'] = [dict_from_row(r) for r in cursor.fetchall()]
        else:
            sub['plan_items'] = []

        # جلب مجموع الاستلامات
        cursor.execute('''
            SELECT product_id, variant_id, SUM(quantity) as total_redeemed
            FROM subscription_redemptions WHERE subscription_id = ?
            GROUP BY product_id, variant_id
        ''', (sub['id'],))
        redeemed_map = {}
        for r in cursor.fetchall():
            rd = dict_from_row(r)
            key = f"{rd['product_id']}_{rd['variant_id'] or 0}"
            redeemed_map[key] = rd['total_redeemed']
        sub['redeemed_map'] = redeemed_map

        conn.close()
        return jsonify({'success': True, 'subscription': sub, 'active': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-redemptions', methods=['POST'])
def create_subscription_redemption():
    """استلام منتجات من الاشتراك مع خصم من مخزون الفرع"""
    try:
        data = request.json
        subscription_id = data.get('subscription_id')
        items = data.get('items', [])
        branch_id = data.get('branch_id')

        if not subscription_id or not items:
            return jsonify({'success': False, 'error': 'بيانات الاستلام غير مكتملة'}), 400

        if not branch_id:
            return jsonify({'success': False, 'error': 'يجب تحديد الفرع'}), 400

        conn = get_db()
        cursor = conn.cursor()

        # التحقق من الاشتراك
        cursor.execute('SELECT * FROM customer_subscriptions WHERE id = ? AND status = ?', (subscription_id, 'active'))
        sub_row = cursor.fetchone()
        if not sub_row:
            conn.close()
            return jsonify({'success': False, 'error': 'الاشتراك غير موجود أو غير فعّال'}), 404
        sub = dict_from_row(sub_row)

        from datetime import datetime
        today = datetime.now().strftime('%Y-%m-%d')
        if sub['end_date'] < today:
            cursor.execute('UPDATE customer_subscriptions SET status = ? WHERE id = ?', ('expired', subscription_id))
            conn.commit()
            conn.close()
            return jsonify({'success': False, 'error': 'الاشتراك منتهي الصلاحية'}), 400

        # جلب منتجات الخطة
        cursor.execute('SELECT * FROM subscription_plan_items WHERE plan_id = ?', (sub['plan_id'],))
        plan_items = {f"{dict_from_row(r)['product_id']}_{dict_from_row(r)['variant_id'] or 0}": dict_from_row(r) for r in cursor.fetchall()}

        # جلب الاستلامات السابقة
        cursor.execute('''
            SELECT product_id, variant_id, SUM(quantity) as total_redeemed
            FROM subscription_redemptions WHERE subscription_id = ?
            GROUP BY product_id, variant_id
        ''', (subscription_id,))
        redeemed = {}
        for r in cursor.fetchall():
            rd = dict_from_row(r)
            key = f"{rd['product_id']}_{rd['variant_id'] or 0}"
            redeemed[key] = rd['total_redeemed']

        redeemed_items = []
        for item in items:
            product_id = item.get('product_id')
            variant_id = item.get('variant_id')
            qty = int(item.get('quantity', 1))
            key = f"{product_id}_{variant_id or 0}"

            # التحقق من أن المنتج ضمن الخطة
            if key not in plan_items:
                conn.close()
                return jsonify({'success': False, 'error': f"المنتج {item.get('product_name', '')} غير مشمول في الخطة"}), 400

            # التحقق من الكمية المتبقية
            allowed = plan_items[key]['quantity']
            already_redeemed = redeemed.get(key, 0)
            remaining = allowed - already_redeemed
            if qty > remaining:
                conn.close()
                return jsonify({'success': False, 'error': f"الكمية المتبقية لـ {item.get('product_name', '')} هي {remaining} فقط"}), 400

            # التحقق من مخزون الفرع
            if variant_id:
                cursor.execute('''
                    SELECT id, stock FROM branch_stock
                    WHERE inventory_id = ? AND branch_id = ? AND variant_id = ?
                ''', (product_id, branch_id, variant_id))
            else:
                cursor.execute('''
                    SELECT id, stock FROM branch_stock
                    WHERE inventory_id = ? AND branch_id = ? AND (variant_id IS NULL OR variant_id = 0)
                ''', (product_id, branch_id))
            bs_row = cursor.fetchone()

            if not bs_row:
                conn.close()
                return jsonify({'success': False, 'error': f"المنتج {item.get('product_name', '')} غير موجود في مخزون هذا الفرع"}), 400

            bs = dict_from_row(bs_row)
            if bs['stock'] < qty:
                conn.close()
                return jsonify({'success': False, 'error': f"مخزون الفرع لا يكفي لـ {item.get('product_name', '')} (المتوفر: {bs['stock']})"}), 400

            # تسجيل الاستلام
            cursor.execute('''
                INSERT INTO subscription_redemptions (subscription_id, customer_id, product_id, product_name, variant_id, variant_name, quantity, redeemed_by, redeemed_by_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (subscription_id, sub['customer_id'], product_id, item.get('product_name'),
                  variant_id, item.get('variant_name'), qty,
                  data.get('redeemed_by'), data.get('redeemed_by_name')))

            # خصم من مخزون الفرع
            cursor.execute('''
                UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''', (qty, bs['id']))

            redeemed_items.append({'product_name': item.get('product_name'), 'quantity': qty})

        conn.commit()
        conn.close()
        return jsonify({'success': True, 'redeemed': redeemed_items})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/subscription-redemptions/<int:subscription_id>', methods=['GET'])
def get_subscription_redemptions(subscription_id):
    """جلب سجل استلامات اشتراك"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM subscription_redemptions WHERE subscription_id = ? ORDER BY redeemed_at DESC', (subscription_id,))
        redemptions = [dict_from_row(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({'success': True, 'redemptions': redemptions})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ===== Sync API - للتزامن بين التطبيق المحلي والسيرفر =====

@app.route('/api/sync/upload', methods=['POST'])
def sync_upload():
    """رفع البيانات المحلية (فواتير، عملاء) إلى السيرفر"""
    try:
        data = request.json
        conn = get_db()
        cursor = conn.cursor()
        results = {'invoices_synced': 0, 'customers_synced': 0, 'errors': []}

        # 1. مزامنة العملاء الجدد
        for customer in data.get('customers', []):
            try:
                # تحقق من عدم وجود العميل بنفس الهاتف
                if customer.get('phone'):
                    cursor.execute('SELECT id FROM customers WHERE phone = ?', (customer['phone'],))
                    existing = cursor.fetchone()
                    if existing:
                        results['customers_synced'] += 1
                        continue
                cursor.execute('''
                    INSERT INTO customers (name, phone, email, address, notes)
                    VALUES (?, ?, ?, ?, ?)
                ''', (
                    customer.get('name', ''),
                    customer.get('phone', ''),
                    customer.get('email', ''),
                    customer.get('address', ''),
                    customer.get('notes', '')
                ))
                results['customers_synced'] += 1
            except Exception as e:
                results['errors'].append(f"Customer {customer.get('name','')}: {str(e)}")

        # 2. مزامنة الفواتير
        for invoice in data.get('invoices', []):
            try:
                # تحقق من عدم وجود الفاتورة
                inv_num = invoice.get('invoice_number', '')
                if inv_num:
                    cursor.execute('SELECT id FROM invoices WHERE invoice_number = ?', (inv_num,))
                    if cursor.fetchone():
                        results['invoices_synced'] += 1
                        continue

                branch_id = invoice.get('branch_id', 1)
                cursor.execute('SELECT name FROM branches WHERE id = ?', (branch_id,))
                branch = cursor.fetchone()
                branch_name = branch['name'] if branch else ''

                shift_id = invoice.get('shift_id')
                shift_name = ''
                if shift_id:
                    cursor.execute('SELECT name FROM shifts WHERE id = ?', (shift_id,))
                    s = cursor.fetchone()
                    shift_name = s['name'] if s else ''

                cursor.execute('''
                    INSERT INTO invoices
                    (invoice_number, customer_id, customer_name, customer_phone, customer_address,
                     subtotal, discount, total, payment_method, employee_name, notes,
                     transaction_number, branch_id, branch_name, delivery_fee,
                     coupon_discount, coupon_code, loyalty_discount,
                     loyalty_points_earned, loyalty_points_redeemed,
                     table_id, table_name, shift_id, shift_name, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ''', (
                    inv_num,
                    invoice.get('customer_id'),
                    invoice.get('customer_name', ''),
                    invoice.get('customer_phone', ''),
                    invoice.get('customer_address', ''),
                    invoice.get('subtotal', 0),
                    invoice.get('discount', 0),
                    invoice.get('total', 0),
                    invoice.get('payment_method', 'cash'),
                    invoice.get('employee_name', ''),
                    invoice.get('notes', ''),
                    invoice.get('transaction_number', ''),
                    branch_id,
                    branch_name,
                    invoice.get('delivery_fee', 0),
                    invoice.get('coupon_discount', 0),
                    invoice.get('coupon_code', ''),
                    invoice.get('loyalty_discount', 0),
                    invoice.get('loyalty_points_earned', 0),
                    invoice.get('loyalty_points_redeemed', 0),
                    invoice.get('table_id'),
                    invoice.get('table_name', ''),
                    shift_id,
                    shift_name,
                    invoice.get('created_at', datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
                ))
                new_invoice_id = cursor.lastrowid

                # إدراج عناصر الفاتورة
                for item in invoice.get('items', []):
                    branch_stock_id = item.get('branch_stock_id') or item.get('product_id')
                    cursor.execute('''
                        INSERT INTO invoice_items
                        (invoice_id, product_id, product_name, quantity, price, total, branch_stock_id, variant_id, variant_name)
                        VALUES (?,?,?,?,?,?,?,?,?)
                    ''', (
                        new_invoice_id,
                        item.get('product_id'),
                        item.get('product_name'),
                        item.get('quantity'),
                        item.get('price'),
                        item.get('total'),
                        branch_stock_id,
                        item.get('variant_id'),
                        item.get('variant_name')
                    ))
                    # تحديث المخزون
                    if branch_stock_id:
                        cursor.execute('''
                            UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                        ''', (item.get('quantity', 0), branch_stock_id))

                # حفظ عمليات الدفع
                payments = invoice.get('payments', [])
                if payments:
                    cursor.execute('''
                        UPDATE invoices SET payment_details = ? WHERE id = ?
                    ''', (json.dumps(payments, ensure_ascii=False), new_invoice_id))

                results['invoices_synced'] += 1
            except Exception as e:
                results['errors'].append(f"Invoice {invoice.get('invoice_number','')}: {str(e)}")

        conn.commit()
        conn.close()
        return jsonify({
            'success': True,
            'results': results,
            'synced_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/sync/download', methods=['GET'])
def sync_download():
    """تحميل كل البيانات من السيرفر للتطبيق المحلي"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        branch_id = request.args.get('branch_id', 1, type=int)
        since = request.args.get('since', '')  # ISO timestamp للتحديث التدريجي

        result = {}

        # 1. المنتجات (من branch_stock)
        if since:
            cursor.execute('''
                SELECT bs.*, i.name as product_name, i.barcode, i.category, i.image,
                       i.description, i.unit
                FROM branch_stock bs
                JOIN inventory i ON bs.inventory_id = i.id
                WHERE bs.branch_id = ? AND (bs.updated_at > ? OR i.updated_at > ?)
            ''', (branch_id, since, since))
        else:
            cursor.execute('''
                SELECT bs.*, i.name as product_name, i.barcode, i.category, i.image,
                       i.description, i.unit
                FROM branch_stock bs
                JOIN inventory i ON bs.inventory_id = i.id
                WHERE bs.branch_id = ?
            ''', (branch_id,))
        products = [dict(row) for row in cursor.fetchall()]

        # fallback: إذا لم يكن هناك branch_stock، نستخدم products مباشرة
        if not products and not since:
            cursor.execute('SELECT * FROM products')
            products = [dict(row) for row in cursor.fetchall()]

        result['products'] = products

        # 2. العملاء
        if since:
            cursor.execute('SELECT * FROM customers WHERE updated_at > ?', (since,))
        else:
            cursor.execute('SELECT * FROM customers')
        result['customers'] = [dict(row) for row in cursor.fetchall()]

        # 3. الإعدادات
        cursor.execute('SELECT * FROM settings')
        settings = {}
        for row in cursor.fetchall():
            settings[row['key']] = row['value']
        result['settings'] = settings

        # 4. الفروع
        cursor.execute('SELECT * FROM branches')
        result['branches'] = [dict(row) for row in cursor.fetchall()]

        # 5. الفئات (من المنتجات)
        cursor.execute('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""')
        result['categories'] = [row['category'] for row in cursor.fetchall()]

        # 6. الكوبونات النشطة
        cursor.execute('SELECT * FROM coupons WHERE is_active = 1')
        result['coupons'] = [dict(row) for row in cursor.fetchall()]

        conn.close()
        return jsonify({
            'success': True,
            'data': result,
            'synced_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/sync/status', methods=['GET'])
def sync_status():
    """حالة السيرفر والبيانات المتاحة للتزامن"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT COUNT(*) as cnt FROM products')
        products_count = cursor.fetchone()['cnt']

        cursor.execute('SELECT COUNT(*) as cnt FROM customers')
        customers_count = cursor.fetchone()['cnt']

        cursor.execute('SELECT COUNT(*) as cnt FROM invoices')
        invoices_count = cursor.fetchone()['cnt']

        # آخر فاتورة
        cursor.execute('SELECT MAX(created_at) as last_invoice FROM invoices')
        row = cursor.fetchone()
        last_invoice = row['last_invoice'] if row else None

        conn.close()
        return jsonify({
            'success': True,
            'server_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'stats': {
                'products': products_count,
                'customers': customers_count,
                'invoices': invoices_count,
                'last_invoice': last_invoice
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/sync/full-download', methods=['GET'])
def sync_full_download():
    """تحميل كامل لجميع بيانات المتجر (للتثبيت الأولي أو إعادة التزامن الكامل)"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        branch_id = request.args.get('branch_id', 1, type=int)
        result = {}

        # المنتجات
        cursor.execute('''
            SELECT bs.id, bs.inventory_id, bs.stock, bs.price, bs.cost,
                   i.name as product_name, i.barcode, i.category, i.image, i.unit
            FROM branch_stock bs
            JOIN inventory i ON bs.inventory_id = i.id
            WHERE bs.branch_id = ?
        ''', (branch_id,))
        products = [dict(row) for row in cursor.fetchall()]
        if not products:
            cursor.execute('SELECT * FROM products')
            products = [dict(row) for row in cursor.fetchall()]
        result['products'] = products

        # العملاء
        cursor.execute('SELECT * FROM customers')
        result['customers'] = [dict(row) for row in cursor.fetchall()]

        # الإعدادات
        cursor.execute('SELECT * FROM settings')
        settings = {}
        for row in cursor.fetchall():
            settings[row['key']] = row['value']
        result['settings'] = settings

        # الفروع
        try:
            cursor.execute('SELECT * FROM branches')
            result['branches'] = [dict(row) for row in cursor.fetchall()]
        except:
            result['branches'] = []

        # الفئات
        cursor.execute('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""')
        result['categories'] = [row['category'] for row in cursor.fetchall()]

        # الكوبونات
        try:
            cursor.execute('SELECT * FROM coupons WHERE is_active = 1')
            result['coupons'] = [dict(row) for row in cursor.fetchall()]
        except:
            result['coupons'] = []

        # المتغيرات (variants)
        try:
            cursor.execute('SELECT * FROM product_variants')
            result['variants'] = [dict(row) for row in cursor.fetchall()]
        except:
            result['variants'] = []

        conn.close()
        return jsonify({
            'success': True,
            'data': result,
            'synced_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'full_sync': True
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/version', methods=['GET'])
def get_version():
    """جلب تاريخ آخر تحديث"""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    try:
        # تاريخ آخر تعديل لملف server.py
        mtime = os.path.getmtime(os.path.join(base_dir, 'server.py'))
        last_update = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d')
        return jsonify({'success': True, 'version': last_update})
    except:
        return jsonify({'success': True, 'version': datetime.now().strftime('%Y-%m-%d')})


if __name__ == '__main__':
    print("🚀 تشغيل خادم POS (Multi-Tenancy)...")
    print("📍 العنوان: http://0.0.0.0:5000")
    print("💡 يمكنك الوصول من أي جهاز على الشبكة المحلية")
    print("🏢 نظام تعدد المستأجرين مفعل")
    print("💾 نظام النسخ الاحتياطي مفعل")
    print("⏹️  لإيقاف الخادم: اضغط Ctrl+C")

    # بدء مجدول النسخ الاحتياطي
    scheduler_thread = threading.Thread(target=backup_scheduler_loop, daemon=True)
    scheduler_thread.start()

    app.run(host='0.0.0.0', port=5000, debug=False)
