-- Migration 002: Feature flags system for per-tenant feature toggling
-- Adds tenant_features table to master.db for controlling which features
-- are enabled/disabled per store

CREATE TABLE IF NOT EXISTS tenant_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    feature_key TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    enabled_at TEXT,
    disabled_at TEXT,
    UNIQUE(tenant_id, feature_key)
);
