#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
سكريبت إنشاء قاعدة بيانات نظام POS
يقوم بإنشاء جميع الجداول المطلوبة
"""

import sqlite3
import os
from datetime import datetime

def create_database():
    """إنشاء قاعدة البيانات مع كل الجداول"""

    # إنشاء مجلد database إذا لم يكن موجود
    os.makedirs('database', exist_ok=True)

    # الاتصال بقاعدة البيانات (سيتم إنشاؤها إذا لم تكن موجودة)
    conn = sqlite3.connect('database/pos.db')
    cursor = conn.cursor()

    print("جاري إنشاء قاعدة البيانات...")

    # ===== إنشاء جميع الجداول الأساسية =====
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
    print("تم إنشاء جميع الجداول (33 جدول)")

    # ===== إضافة إعدادات افتراضية =====
    default_settings = [
        ('store_name', 'متجر العطور والبخور'),
        ('store_phone', ''),
        ('store_address', ''),
        ('tax_enabled', 'false'),
        ('tax_rate', '0'),
        ('currency', 'KD'),
        ('invoice_prefix', 'INV'),
        ('next_invoice_number', '1'),
        ('loyalty_points_per_invoice', '10'),
        ('loyalty_point_value', '0.1'),
        ('loyalty_enabled', 'true'),
        ('low_stock_threshold', '5')
    ]

    cursor.executemany('''
        INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
    ''', default_settings)
    print("الإعدادات الافتراضية")

    # إضافة فرع افتراضي
    cursor.execute("INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (1, 'الفرع الرئيسي', '', 1)")
    print("الفرع الافتراضي")

    # ===== إنشاء فهارس لتحسين الأداء =====
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(created_at)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_branch_stock_inventory ON branch_stock(inventory_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_branch_stock_branch ON branch_stock(branch_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)')
    print("الفهارس")

    # حفظ التغييرات
    conn.commit()
    conn.close()

    print(f"\nتم إنشاء قاعدة البيانات بنجاح!")
    print(f"المسار: database/pos.db")
    print(f"التاريخ: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

if __name__ == "__main__":
    create_database()
