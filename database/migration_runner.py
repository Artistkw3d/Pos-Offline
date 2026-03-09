# -*- coding: utf-8 -*-
"""
Versioned database migration runner for POS Offline.
Replaces scattered ALTER TABLE try/except blocks with ordered, tracked migrations.

Usage:
    from database.migration_runner import run_migrations
    run_migrations(db_path)                    # Run tenant DB migrations
    run_migrations(master_db_path, master=True) # Run master DB migrations
"""

import sqlite3
import os
import re

MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), 'migrations')


def _ensure_migrations_table(cursor):
    """Create db_migrations table if it doesn't exist."""
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS db_migrations (
            version INTEGER PRIMARY KEY,
            filename TEXT NOT NULL,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')


def _get_current_version(cursor):
    """Get the highest applied migration version."""
    try:
        cursor.execute('SELECT MAX(version) FROM db_migrations')
        row = cursor.fetchone()
        return row[0] if row[0] is not None else 0
    except Exception:
        return 0


def _parse_migration_files():
    """Read and parse all .sql migration files from the migrations directory.
    Returns list of (version, filename, sql_content) sorted by version.
    """
    migrations = []
    if not os.path.exists(MIGRATIONS_DIR):
        return migrations

    for filename in sorted(os.listdir(MIGRATIONS_DIR)):
        if not filename.endswith('.sql'):
            continue
        match = re.match(r'^(\d+)', filename)
        if not match:
            continue
        version = int(match.group(1))
        filepath = os.path.join(MIGRATIONS_DIR, filename)
        with open(filepath, 'r', encoding='utf-8') as f:
            sql_content = f.read()
        migrations.append((version, filename, sql_content))

    return sorted(migrations, key=lambda x: x[0])


def _execute_sql_statements(cursor, sql_content, db_path):
    """Execute SQL statements from a migration file.
    Each statement is executed individually with error handling for
    idempotent operations (duplicate column, table already exists).
    """
    statements = []
    for line in sql_content.split('\n'):
        stripped = line.strip()
        if not stripped or stripped.startswith('--'):
            continue
        statements.append(stripped)

    full_sql = ' '.join(statements)
    for stmt in full_sql.split(';'):
        stmt = stmt.strip()
        if not stmt:
            continue
        try:
            cursor.execute(stmt)
        except Exception as e:
            err = str(e).lower()
            if 'duplicate column' in err or 'already exists' in err:
                continue
            # Table might not exist in this DB type (e.g. tenants table in tenant DB)
            if 'no such table' in err:
                continue
            print(f"[Migration] ERROR in {db_path}: {stmt[:100]}... -> {e}")
            raise RuntimeError(f"Migration failed on {db_path}: {e}")


def run_migrations(db_path, master=False):
    """Run all pending migrations on a database.

    Args:
        db_path: Path to the SQLite database file
        master: If True, run only master DB migrations (tenant_features etc.)
                If False, run only tenant/default DB migrations
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        _ensure_migrations_table(cursor)
        conn.commit()

        current_version = _get_current_version(cursor)
        migrations = _parse_migration_files()

        applied = 0
        for version, filename, sql_content in migrations:
            if version <= current_version:
                continue

            # Migration 002 (feature_flags) is master-only
            if version == 2 and not master:
                # For tenant DBs, mark as applied but don't run the SQL
                cursor.execute(
                    'INSERT OR IGNORE INTO db_migrations (version, filename) VALUES (?, ?)',
                    (version, filename)
                )
                conn.commit()
                continue

            # Migration 001 has both tenant and master SQL mixed
            # For master DB, only run ALTER TABLE tenants/super_admins statements
            if version == 1 and master:
                # Filter to only master-relevant statements
                master_lines = []
                for line in sql_content.split('\n'):
                    stripped = line.strip()
                    if not stripped or stripped.startswith('--'):
                        continue
                    if any(t in stripped.lower() for t in ['tenants', 'super_admins']):
                        master_lines.append(stripped)
                filtered_sql = '\n'.join(master_lines)
                _execute_sql_statements(cursor, filtered_sql, db_path)
            elif version == 1 and not master:
                # For tenant DBs, skip master-only statements
                tenant_lines = []
                for line in sql_content.split('\n'):
                    stripped = line.strip()
                    if not stripped or stripped.startswith('--'):
                        continue
                    if any(t in stripped.lower() for t in ['tenants', 'super_admins']):
                        continue
                    tenant_lines.append(stripped)
                filtered_sql = '\n'.join(tenant_lines)
                _execute_sql_statements(cursor, filtered_sql, db_path)
            else:
                _execute_sql_statements(cursor, sql_content, db_path)

            cursor.execute(
                'INSERT OR IGNORE INTO db_migrations (version, filename) VALUES (?, ?)',
                (version, filename)
            )
            conn.commit()
            applied += 1
            print(f"[Migration] Applied {filename} to {os.path.basename(db_path)}")

        if applied == 0 and current_version > 0:
            pass  # Already up to date, no output needed
        elif applied == 0:
            # First run on existing DB - mark all migrations as applied
            # (existing DBs already have all columns from the old migrate_database)
            for version, filename, _ in migrations:
                cursor.execute(
                    'INSERT OR IGNORE INTO db_migrations (version, filename) VALUES (?, ?)',
                    (version, filename)
                )
            conn.commit()
            print(f"[Migration] Initialized tracking for {os.path.basename(db_path)} (v{len(migrations)})")

    except Exception as e:
        print(f"[Migration] Error on {db_path}: {e}")
    finally:
        conn.close()


def get_db_version(db_path):
    """Get the current migration version of a database."""
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        _ensure_migrations_table(cursor)
        version = _get_current_version(cursor)
        conn.close()
        return version
    except Exception:
        return 0
