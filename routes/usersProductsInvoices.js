/**
 * Routes: Users, Products, Inventory, Branch Stock, Invoices
 * Converted from server.py lines 981-2255
 */

const { fetchFromFlask } = require('./proxyToFlask');
const jwt = require('jsonwebtoken');

const LICENSE_SECRET = process.env.POS_LICENSE_SECRET || 'pos-offline-license-secret-v1';
if (LICENSE_SECRET === 'pos-offline-license-secret-v1' && !process.env.POS_ALLOW_DEFAULT_SECRET) {
  console.warn('WARNING: Using default LICENSE_SECRET. Set POS_LICENSE_SECRET environment variable for production security.');
}
const LICENSE_GRACE_DAYS = 7;

module.exports = function (app, helpers) {
  const { getDb, getMasterDb, hashPassword, verifyPassword, needsRehash, getFlaskServerUrl } = helpers;

  // === License helpers ===

  /**
   * Read and validate license_token from tenant's settings table.
   * Returns decoded payload or null if invalid/missing.
   */
  function validateLicenseToken(db) {
    let tokenStr = null;
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'license_token'").get();
      if (!row || !row.value) return null;
      tokenStr = row.value;
      return jwt.verify(tokenStr, LICENSE_SECRET, { issuer: 'pos-offline-flask' });
    } catch (e) {
      // Token expired or invalid signature
      if (e.name === 'TokenExpiredError' && tokenStr) {
        try {
          return { _expired: true, ...jwt.decode(tokenStr) };
        } catch (_) {}
      }
      return null;
    }
  }

  /**
   * Try to fetch a fresh license token from Flask server and store it.
   * Returns the decoded token payload or null on failure.
   */
  async function refreshLicenseToken(db, tenantSlug) {
    const flaskUrl = getFlaskServerUrl();
    if (!flaskUrl || !tenantSlug) return null;
    try {
      const result = await fetchFromFlask(flaskUrl, `/api/license/refresh-token`, 'GET', null, { 'X-Tenant-ID': tenantSlug });
      if (result.ok && result.data && result.data.success && result.data.token) {
        try {
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('license_token', ?)").run(result.data.token);
        } catch (_) {}
        return jwt.verify(result.data.token, LICENSE_SECRET, { issuer: 'pos-offline-flask' });
      }
    } catch (e) {
      console.warn('[License] Failed to refresh token:', e.message);
    }
    return null;
  }

  // === License refresh endpoint ===
  app.get('/api/license/refresh-token', async (req, res) => {
    try {
      const tenantSlug = req.headers['x-tenant-id'];
      if (!tenantSlug) {
        return res.status(400).json({ success: false, error: 'لا يوجد معرف مستأجر' });
      }
      const db = getDb(req);
      const decoded = await refreshLicenseToken(db, tenantSlug);
      if (decoded) {
        return res.json({ success: true, token: db.prepare("SELECT value FROM settings WHERE key = 'license_token'").get()?.value, decoded });
      }
      // Flask unreachable — return cached token if available
      const cached = db.prepare("SELECT value FROM settings WHERE key = 'license_token'").get();
      if (cached && cached.value) {
        return res.json({ success: true, token: cached.value, cached: true });
      }
      return res.status(503).json({ success: false, error: 'تعذر الاتصال بالخادم لتجديد الترخيص' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Helper: ensure new permission columns exist on users table
  function ensureUserPermissionColumns(db) {
    const newCols = [
      'can_view_returns', 'can_view_expenses', 'can_view_suppliers', 'can_view_coupons',
      'can_view_tables', 'can_view_attendance', 'can_view_advanced_reports',
      'can_view_system_logs', 'can_view_dcf', 'can_cancel_invoices', 'can_view_branches',
      'can_view_cross_branch_stock', 'can_view_xbrl', 'can_edit_completed_invoices',
      'shift_id',
      'can_create_transfer', 'can_approve_transfer', 'can_deliver_transfer', 'can_view_transfers',
      'can_view_subscriptions', 'can_manage_subscriptions'
    ];
    for (const col of newCols) {
      try {
        db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER DEFAULT 0`);
      } catch (e) {
        // Column already exists - ignore
      }
    }
  }

  // ===== POST /api/login =====
  app.post('/api/login', async (req, res) => {
    try {
      const data = req.body;
      const username = data.username;
      const password = data.password;

      // Check tenant subscription via Flask server (remote master.db)
      const tenantSlug = req.headers['x-tenant-id'];
      if (tenantSlug) {
        const flaskUrl = getFlaskServerUrl();
        if (flaskUrl) {
          // Remote check via Flask server
          const result = await fetchFromFlask(flaskUrl, `/api/tenant/check-status?slug=${encodeURIComponent(tenantSlug)}`);
          if (result.ok && result.data) {
            if (!result.data.success) {
              return res.status(404).json({ success: false, error: 'معرف المتجر غير صحيح' });
            }
            if (!result.data.is_active) {
              if (result.data.expires_at) {
                return res.status(403).json({
                  success: false,
                  error: `⛔ انتهى اشتراك المتجر "${result.data.name}" بتاريخ ${result.data.expires_at}.\nتواصل مع إدارة النظام لتجديد الاشتراك.`
                });
              }
              return res.status(403).json({ success: false, error: '⛔ هذا المتجر معطل. تواصل مع إدارة النظام' });
            }
          }
          // If Flask reachable, also refresh license token
          if (result.ok) {
            try {
              const tDb = getDb(req);
              await refreshLicenseToken(tDb, tenantSlug);
            } catch (_) {}
          }
          // If Flask unreachable (result.ok === false), allow login to proceed (offline-first)
        } else {
          // No Flask URL configured — fallback to local master.db
          try {
            const masterDb = getMasterDb();
            const tenant = masterDb.prepare('SELECT is_active, expires_at, name FROM tenants WHERE slug = ?').get(tenantSlug);
            if (!tenant) {
              return res.status(404).json({ success: false, error: 'معرف المتجر غير صحيح' });
            }
            if (!tenant.is_active) {
              return res.status(403).json({ success: false, error: '⛔ هذا المتجر معطل. تواصل مع إدارة النظام' });
            }
            if (tenant.expires_at) {
              const expiry = new Date(tenant.expires_at.substring(0, 10));
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              if (today > expiry) {
                masterDb.prepare('UPDATE tenants SET is_active = 0 WHERE slug = ?').run(tenantSlug);
                return res.status(403).json({
                  success: false,
                  error: `⛔ انتهى اشتراك المتجر "${tenant.name}" بتاريخ ${tenant.expires_at.substring(0, 10)}.\nتواصل مع إدارة النظام لتجديد الاشتراك.`
                });
              }
            }
          } catch (masterErr) {
            // Local master.db unavailable — allow login to proceed (offline-first)
            console.warn('[Login] Could not check tenant status locally:', masterErr.message);
          }
        }

        // License token check for offline enforcement
        try {
          const tDb = getDb(req);
          const license = validateLicenseToken(tDb);
          if (license) {
            if (license._expired) {
              // Token expired — try to refresh
              const refreshed = await refreshLicenseToken(tDb, tenantSlug);
              if (!refreshed) {
                return res.status(403).json({
                  success: false,
                  error: '⛔ انتهت صلاحية الترخيص. يرجى الاتصال بالخادم الرئيسي لتجديد الترخيص.',
                  license_expired: true
                });
              }
            } else if (!license.is_active) {
              return res.status(403).json({
                success: false,
                error: '⛔ هذا المتجر معطل. تواصل مع إدارة النظام'
              });
            }
          }
          // If no token exists (first use), allow login (offline-first)
        } catch (licErr) {
          console.warn('[Login] License check error:', licErr.message);
        }
      }

      const db = getDb(req);
      ensureUserPermissionColumns(db);

      const user = db.prepare(`
        SELECT u.*, b.name as branch_name
        FROM users u
        LEFT JOIN branches b ON u.branch_id = b.id
        WHERE u.username = ? AND u.is_active = 1
      `).get(username);

      if (user) {
        const storedPw = user.password;
        if (verifyPassword(password, storedPw) || storedPw === password) {
          // Upgrade old hash (SHA-256 or plaintext) to PBKDF2
          if (needsRehash(storedPw) || storedPw === password) {
            const newHash = hashPassword(password);
            db.prepare('UPDATE users SET password = ? WHERE id = ?').run(newHash, user.id);
          }
          db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
          const userData = { ...user };
          delete userData.password;
          db.close();
          return res.json({ success: true, user: userData });
        }
      }
      db.close();

      // Local login failed — try Flask server if configured (tenant DB may not be synced yet)
      const flaskUrl = getFlaskServerUrl();
      if (flaskUrl) {
        const extraHeaders = {};
        if (tenantSlug) extraHeaders['X-Tenant-ID'] = tenantSlug;
        const flaskResult = await fetchFromFlask(
          flaskUrl, '/api/login', 'POST',
          { username, password },
          extraHeaders
        );
        if (flaskResult.ok && flaskResult.data && flaskResult.data.success) {
          return res.json(flaskResult.data);
        }
      }

      return res.status(401).json({ success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/users =====
  app.get('/api/users', (req, res) => {
    try {
      const db = getDb(req);
      const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
      for (const u of users) {
        delete u.password;
      }
      return res.json({ success: true, users });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/users =====
  app.post('/api/users', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);

      // License enforcement: check max_users via JWT token
      const tenantSlug = req.headers['x-tenant-id'];
      if (tenantSlug) {
        const license = validateLicenseToken(db);
        if (license && !license._expired) {
          const maxUsers = license.max_users || 999;
          const activeCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active = 1').get().c;
          if (activeCount >= maxUsers) {
            return res.status(403).json({
              success: false,
              error: `تم الوصول للحد الأقصى من المستخدمين (${maxUsers}). قم بترقية الاشتراك لإضافة المزيد.`
            });
          }
        }
      }

      ensureUserPermissionColumns(db);

      const result = db.prepare(`
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
      `).run(
        data.username, hashPassword(data.password), data.full_name,
        data.role || 'cashier', data.invoice_prefix || '', data.branch_id || 1,
        data.can_view_products || 0, data.can_add_products || 0,
        data.can_edit_products || 0, data.can_delete_products || 0,
        data.can_view_inventory || 0, data.can_add_inventory || 0,
        data.can_edit_inventory || 0, data.can_delete_inventory || 0,
        data.can_view_invoices !== undefined ? data.can_view_invoices : 1,
        data.can_delete_invoices || 0,
        data.can_view_customers || 0, data.can_add_customer || 0,
        data.can_edit_customer || 0, data.can_delete_customer || 0,
        data.can_view_reports || 0, data.can_view_accounting || 0,
        data.can_manage_users || 0, data.can_access_settings || 0,
        data.can_view_returns || 0, data.can_view_expenses || 0,
        data.can_view_suppliers || 0, data.can_view_coupons || 0,
        data.can_view_tables || 0, data.can_view_attendance || 0,
        data.can_view_advanced_reports || 0, data.can_view_system_logs || 0,
        data.can_view_dcf || 0, data.can_cancel_invoices || 0,
        data.can_view_branches || 0, data.can_view_cross_branch_stock || 0,
        data.can_view_xbrl || 0, data.shift_id || null,
        data.can_edit_completed_invoices || 0,
        data.can_create_transfer || 0, data.can_approve_transfer || 0,
        data.can_deliver_transfer || 0, data.can_view_transfers || 0,
        data.can_view_subscriptions || 0, data.can_manage_subscriptions || 0
      );

      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ success: false, error: 'اسم المستخدم موجود مسبقاً' });
      }
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/users/:user_id =====
  app.put('/api/users/:user_id', (req, res) => {
    try {
      const userId = req.params.user_id;
      const data = req.body;
      const db = getDb(req);
      ensureUserPermissionColumns(db);

      const updates = [];
      const params = [];

      const fields = [
        'full_name', 'role', 'invoice_prefix', 'branch_id',
        'can_view_products', 'can_add_products', 'can_edit_products', 'can_delete_products',
        'can_view_inventory', 'can_add_inventory', 'can_edit_inventory', 'can_delete_inventory',
        'can_view_invoices', 'can_delete_invoices',
        'can_view_customers', 'can_add_customer', 'can_edit_customer', 'can_delete_customer',
        'can_view_reports', 'can_view_accounting', 'can_manage_users', 'can_access_settings',
        'can_view_returns', 'can_view_expenses', 'can_view_suppliers', 'can_view_coupons',
        'can_view_tables', 'can_view_attendance', 'can_view_advanced_reports',
        'can_view_system_logs', 'can_view_dcf', 'can_cancel_invoices', 'can_view_branches',
        'can_view_cross_branch_stock', 'can_view_xbrl', 'shift_id', 'can_edit_completed_invoices',
        'can_create_transfer', 'can_approve_transfer', 'can_deliver_transfer', 'can_view_transfers',
        'can_view_subscriptions', 'can_manage_subscriptions', 'is_active'
      ];

      if (data.password) {
        updates.push('password = ?');
        params.push(hashPassword(data.password));
      }

      for (const field of fields) {
        if (field in data) {
          updates.push(`${field} = ?`);
          params.push(data[field]);
        }
      }

      if (updates.length > 0) {
        params.push(userId);
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/users/:user_id =====
  app.delete('/api/users/:user_id', (req, res) => {
    try {
      const userId = req.params.user_id;
      const db = getDb(req);
      const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
      if (user && user.role === 'admin') {
        return res.status(400).json({ success: false, error: 'لا يمكن حذف حساب المدير' });
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/products =====
  app.get('/api/products', (req, res) => {
    try {
      const branchId = req.query.branch_id;
      const db = getDb(req);

      const baseQuery = `
        SELECT bs.id, bs.stock, bs.branch_id, bs.inventory_id, bs.variant_id,
               i.name, i.barcode, i.category, i.price, i.cost, i.image_data,
               pv.variant_name, pv.price as variant_price, pv.cost as variant_cost, pv.barcode as variant_barcode
        FROM branch_stock bs
        JOIN inventory i ON bs.inventory_id = i.id
        LEFT JOIN product_variants pv ON bs.variant_id = pv.id
      `;

      let rows;
      if (branchId === 'all') {
        rows = db.prepare(baseQuery + ' ORDER BY bs.branch_id, i.name').all();
      } else if (branchId) {
        rows = db.prepare(baseQuery + ' WHERE bs.branch_id = ? ORDER BY i.name').all(branchId);
      } else {
        rows = db.prepare(baseQuery + ' WHERE bs.branch_id = ? ORDER BY i.name').all(1);
      }

      const products = rows.map(p => {
        if (p.variant_id && p.variant_name) {
          p.display_name = `${p.name} (${p.variant_name})`;
          p.price = p.variant_price || p.price;
          p.cost = p.variant_cost || p.cost;
          if (p.variant_barcode) p.barcode = p.variant_barcode;
        } else {
          p.display_name = p.name;
        }
        return p;
      });

      const seenInv = new Set();
      for (const p of products) {
        const invId = p.inventory_id;
        if (invId && !seenInv.has(invId)) {
          const variants = db.prepare('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id').all(invId);
          for (const pp of products) {
            if (pp.inventory_id === invId) pp.variants = variants;
          }
          seenInv.add(invId);
        } else if (!seenInv.has(invId)) {
          p.variants = p.variants || [];
        }
      }

      return res.json({ success: true, products });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/products =====
  app.post('/api/products', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO products (name, barcode, price, cost, stock, category, image_data, branch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(data.name, data.barcode, data.price || 0, data.cost || 0, data.stock || 0,
        data.category || '', data.image_data || '', data.branch_id || 1);
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ success: false, error: 'الباركود موجود مسبقاً' });
      }
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/products/:product_id =====
  app.put('/api/products/:product_id', (req, res) => {
    try {
      const productId = req.params.product_id;
      const data = req.body;
      const db = getDb(req);
      db.prepare(`
        UPDATE products SET name=?, barcode=?, price=?, cost=?, stock=?, category=?, image_data=?, branch_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(data.name, data.barcode, data.price, data.cost, data.stock, data.category, data.image_data, data.branch_id || 1, productId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/products/:product_id =====
  app.delete('/api/products/:product_id', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('DELETE FROM products WHERE id=?').run(req.params.product_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/inventory =====
  app.get('/api/inventory', (req, res) => {
    try {
      const db = getDb(req);
      const inventory = db.prepare('SELECT * FROM inventory ORDER BY name').all();
      for (const item of inventory) {
        item.variants = db.prepare('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id').all(item.id);
      }
      return res.json({ success: true, inventory });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/inventory =====
  app.post('/api/inventory', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO inventory (name, barcode, category, price, cost, image_data) VALUES (?, ?, ?, ?, ?, ?)
      `).run(data.name, data.barcode, data.category || '', data.price || 0, data.cost || 0, data.image_data || '');
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ success: false, error: 'الباركود موجود مسبقاً' });
      }
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/inventory/:inventory_id =====
  app.put('/api/inventory/:inventory_id', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      db.prepare(`
        UPDATE inventory SET name=?, barcode=?, category=?, price=?, cost=?, image_data=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(data.name, data.barcode, data.category, data.price, data.cost, data.image_data, req.params.inventory_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/inventory/:inventory_id =====
  app.delete('/api/inventory/:inventory_id', (req, res) => {
    try {
      const inventoryId = req.params.inventory_id;
      const db = getDb(req);
      db.prepare('DELETE FROM product_variants WHERE inventory_id=?').run(inventoryId);
      db.prepare('DELETE FROM branch_stock WHERE inventory_id=?').run(inventoryId);
      db.prepare('DELETE FROM inventory WHERE id=?').run(inventoryId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/inventory/:inventory_id/variants =====
  app.get('/api/inventory/:inventory_id/variants', (req, res) => {
    try {
      const db = getDb(req);
      const variants = db.prepare('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id').all(req.params.inventory_id);
      return res.json({ success: true, variants });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/inventory/:inventory_id/variants =====
  app.post('/api/inventory/:inventory_id/variants', (req, res) => {
    try {
      const inventoryId = req.params.inventory_id;
      const variants = req.body.variants || [];
      const db = getDb(req);

      const saveVariants = db.transaction(() => {
        db.prepare('DELETE FROM product_variants WHERE inventory_id = ?').run(inventoryId);
        const stmt = db.prepare(`
          INSERT INTO product_variants (inventory_id, variant_name, price, cost, barcode) VALUES (?, ?, ?, ?, ?)
        `);
        for (const v of variants) {
          stmt.run(inventoryId, v.variant_name || '', v.price || 0, v.cost || 0, v.barcode || '');
        }
      });
      saveVariants();
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/branch-stock =====
  app.get('/api/branch-stock', (req, res) => {
    try {
      const branchId = req.query.branch_id;
      const inventoryId = req.query.inventory_id;
      const db = getDb(req);

      let query = `
        SELECT bs.*, i.name, i.barcode, i.category, i.price, i.cost, i.image_data,
               pv.variant_name, pv.price as variant_price, pv.cost as variant_cost, pv.barcode as variant_barcode,
               b.name as branch_name
        FROM branch_stock bs
        JOIN inventory i ON bs.inventory_id = i.id
        LEFT JOIN product_variants pv ON bs.variant_id = pv.id
        LEFT JOIN branches b ON bs.branch_id = b.id
        WHERE 1=1
      `;
      const params = [];
      if (branchId) { query += ' AND bs.branch_id = ?'; params.push(branchId); }
      if (inventoryId) { query += ' AND bs.inventory_id = ?'; params.push(inventoryId); }
      query += ' ORDER BY i.name';

      return res.json({ success: true, stock: db.prepare(query).all(...params) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/branch-stock =====
  app.post('/api/branch-stock', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const variantId = data.variant_id;
      const notes = (data.notes || '').trim();
      const addedStock = data.stock || 0;

      let noteEntry = '';
      if (notes) {
        const now = new Date();
        const dateStr = now.getFullYear() + '-' +
          String(now.getMonth() + 1).padStart(2, '0') + '-' +
          String(now.getDate()).padStart(2, '0') + ' ' +
          String(now.getHours()).padStart(2, '0') + ':' +
          String(now.getMinutes()).padStart(2, '0');
        noteEntry = `[${dateStr}] +${addedStock}: ${notes}`;
      }

      let existing;
      if (variantId) {
        existing = db.prepare('SELECT id, stock, notes FROM branch_stock WHERE inventory_id = ? AND branch_id = ? AND variant_id = ?')
          .get(data.inventory_id, data.branch_id, variantId);
      } else {
        existing = db.prepare('SELECT id, stock, notes FROM branch_stock WHERE inventory_id = ? AND branch_id = ? AND (variant_id IS NULL OR variant_id = 0)')
          .get(data.inventory_id, data.branch_id);
      }

      let stockId;
      if (existing) {
        const newStock = existing.stock + addedStock;
        const oldNotes = existing.notes || '';
        const combinedNotes = noteEntry ? (oldNotes ? (oldNotes + '\n' + noteEntry).trim() : noteEntry) : oldNotes;
        db.prepare('UPDATE branch_stock SET stock = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(newStock, combinedNotes, existing.id);
        stockId = existing.id;
      } else {
        const result = db.prepare('INSERT INTO branch_stock (inventory_id, branch_id, variant_id, stock, notes) VALUES (?, ?, ?, ?, ?)')
          .run(data.inventory_id, data.branch_id, variantId, addedStock, noteEntry);
        stockId = Number(result.lastInsertRowid);
      }

      return res.json({ success: true, id: stockId });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/branch-stock/:stock_id =====
  app.put('/api/branch-stock/:stock_id', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('UPDATE branch_stock SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(req.body.stock || 0, req.params.stock_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/branch-stock/:stock_id =====
  app.delete('/api/branch-stock/:stock_id', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('DELETE FROM branch_stock WHERE id = ?').run(req.params.stock_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/branches =====
  app.get('/api/branches', (req, res) => {
    try {
      const db = getDb(req);
      const branches = db.prepare('SELECT * FROM branches WHERE is_active = 1 ORDER BY name').all();
      return res.json({ success: true, branches });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/branches =====
  app.post('/api/branches', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);

      // License enforcement: check max_branches via JWT token
      const tenantSlug = req.headers['x-tenant-id'];
      if (tenantSlug) {
        const license = validateLicenseToken(db);
        if (license && !license._expired) {
          const maxBranches = license.max_branches || 999;
          const activeCount = db.prepare('SELECT COUNT(*) as c FROM branches WHERE is_active = 1').get().c;
          if (activeCount >= maxBranches) {
            return res.status(403).json({
              success: false,
              error: `تم الوصول للحد الأقصى من الفروع (${maxBranches}). قم بترقية الاشتراك لإضافة المزيد.`
            });
          }
        }
      }

      const result = db.prepare('INSERT INTO branches (name, location, phone) VALUES (?, ?, ?)').run(
        data.name, data.location || '', data.phone || ''
      );
      return res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        return res.status(400).json({ success: false, error: 'اسم الفرع موجود مسبقاً' });
      }
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/branches/:branch_id =====
  app.put('/api/branches/:branch_id', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const updates = [];
      const params = [];

      if ('name' in data) { updates.push('name = ?'); params.push(data.name); }
      if ('location' in data) { updates.push('location = ?'); params.push(data.location); }
      if ('phone' in data) { updates.push('phone = ?'); params.push(data.phone); }
      if ('is_active' in data) { updates.push('is_active = ?'); params.push(data.is_active); }

      if (updates.length) {
        params.push(req.params.branch_id);
        db.prepare(`UPDATE branches SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/branches/:branch_id =====
  app.delete('/api/branches/:branch_id', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('UPDATE branches SET is_active = 0 WHERE id = ?').run(req.params.branch_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/products/search =====
  app.get('/api/products/search', (req, res) => {
    try {
      const query = req.query.q || '';
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let baseQuery = `
        SELECT bs.id, bs.stock, bs.branch_id, bs.inventory_id, bs.variant_id,
               i.name, i.barcode, i.category, i.price, i.cost, i.image_data,
               pv.variant_name, pv.price as variant_price, pv.cost as variant_cost, pv.barcode as variant_barcode
        FROM branch_stock bs
        JOIN inventory i ON bs.inventory_id = i.id
        LEFT JOIN product_variants pv ON bs.variant_id = pv.id
        WHERE (i.name LIKE ? OR i.barcode LIKE ? OR pv.barcode LIKE ? OR pv.variant_name LIKE ?)
      `;
      const searchPattern = `%${query}%`;
      const params = [searchPattern, searchPattern, searchPattern, searchPattern];

      if (branchId && branchId !== 'all') {
        baseQuery += ' AND bs.branch_id = ?';
        params.push(branchId);
      }
      baseQuery += ' ORDER BY i.name LIMIT 20';

      const rows = db.prepare(baseQuery).all(...params);
      const products = rows.map(p => {
        if (p.variant_id && p.variant_name) {
          p.display_name = `${p.name} (${p.variant_name})`;
          p.price = p.variant_price || p.price;
          p.cost = p.variant_cost || p.cost;
          if (p.variant_barcode) p.barcode = p.variant_barcode;
        } else {
          p.display_name = p.name;
        }
        return p;
      });
      return res.json({ success: true, products });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/invoices =====
  app.get('/api/invoices', (req, res) => {
    try {
      const startDate = req.query.start_date;
      const endDate = req.query.end_date;
      const limit = parseInt(req.query.limit) || 100;
      const db = getDb(req);

      let query = 'SELECT * FROM invoices WHERE 1=1';
      const params = [];
      if (startDate) { query += ' AND date(created_at) >= ?'; params.push(startDate); }
      if (endDate) { query += ' AND date(created_at) <= ?'; params.push(endDate); }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      return res.json({ success: true, invoices: db.prepare(query).all(...params) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/invoices/:invoice_id =====
  app.get('/api/invoices/:invoice_id', (req, res) => {
    try {
      const db = getDb(req);
      const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.invoice_id);
      if (!invoice) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
      invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(req.params.invoice_id);
      return res.json({ success: true, invoice });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/invoices/clear-all =====
  app.delete('/api/invoices/clear-all', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('DELETE FROM invoice_items').run();
      const result = db.prepare('DELETE FROM invoices').run();
      return res.json({ success: true, deleted: result.changes });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/invoices =====
  app.post('/api/invoices', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);

      const branchId = data.branch_id || 1;
      const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId);
      const branchName = branch ? branch.name : 'الفرع الرئيسي';
      const invoiceNumberWithBranch = `${data.invoice_number || ''}-B${branchId}`;

      let shiftName = '';
      if (data.shift_id) {
        const shiftRow = db.prepare('SELECT name FROM shifts WHERE id = ?').get(data.shift_id);
        shiftName = shiftRow ? shiftRow.name : '';
      }

      const invoiceResult = db.prepare(`
        INSERT INTO invoices
        (invoice_number, customer_id, customer_name, customer_phone, customer_address,
         subtotal, discount, total, payment_method, employee_name, notes, transaction_number,
         branch_id, branch_name, delivery_fee,
         coupon_discount, coupon_code, loyalty_discount, loyalty_points_earned, loyalty_points_redeemed,
         table_id, table_name, shift_id, shift_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        invoiceNumberWithBranch, data.customer_id || null, data.customer_name || '',
        data.customer_phone || '', data.customer_address || '',
        data.subtotal || 0, data.discount || 0, data.total || 0,
        data.payment_method || 'نقداً', data.employee_name || '', data.notes || '',
        data.transaction_number || '', branchId, branchName, data.delivery_fee || 0,
        data.coupon_discount || 0, data.coupon_code || '',
        data.loyalty_discount || 0, data.loyalty_points_earned || 0, data.loyalty_points_redeemed || 0,
        data.table_id || null, data.table_name || '', data.shift_id || null, shiftName
      );

      const invoiceId = Number(invoiceResult.lastInsertRowid);

      if (data.table_id) {
        db.prepare('UPDATE restaurant_tables SET status = ?, current_invoice_id = ? WHERE id = ?')
          .run('occupied', invoiceId, data.table_id);
      }

      const items = data.items || [];
      const insertItemStmt = db.prepare(`
        INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, price, total, branch_stock_id, variant_id, variant_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateStockStmt = db.prepare('UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

      for (const item of items) {
        const branchStockId = item.branch_stock_id || item.product_id;
        insertItemStmt.run(invoiceId, item.product_id, item.product_name, item.quantity,
          item.price, item.total, branchStockId, item.variant_id || null, item.variant_name || null);
        if (branchStockId) updateStockStmt.run(item.quantity, branchStockId);
      }

      const payments = data.payments || [];
      if (payments.length > 0) {
        db.prepare('UPDATE invoices SET transaction_number = ? WHERE id = ?').run(JSON.stringify(payments), invoiceId);
      }

      if (data.customer_id) {
        const netPoints = (data.loyalty_points_earned || 0) - (data.loyalty_points_redeemed || 0);
        if (netPoints !== 0) {
          db.prepare('UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?) WHERE id = ?')
            .run(netPoints, data.customer_id);
        }
      }

      // Low stock warnings
      const lowStockWarnings = [];
      try {
        const thresholdRow = db.prepare("SELECT value FROM settings WHERE key = 'low_stock_threshold'").get();
        const threshold = thresholdRow ? parseInt(thresholdRow.value) : 5;
        for (const item of items) {
          const bsId = item.branch_stock_id || item.product_id;
          if (bsId) {
            const row = db.prepare(`
              SELECT bs.stock, inv.name as product_name, pv.variant_name
              FROM branch_stock bs LEFT JOIN inventory inv ON inv.id = bs.inventory_id
              LEFT JOIN product_variants pv ON pv.id = bs.variant_id WHERE bs.id = ?
            `).get(bsId);
            if (row && row.stock <= threshold) {
              let pname = row.product_name || item.product_name || '';
              if (row.variant_name) pname += ` (${row.variant_name})`;
              lowStockWarnings.push({ product_name: pname, stock: row.stock });
            }
          }
        }
      } catch (_e) { /* ignore */ }

      const result = { success: true, id: invoiceId, invoice_number: invoiceNumberWithBranch };
      if (lowStockWarnings.length > 0) result.low_stock_warnings = lowStockWarnings;
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/invoices/:invoice_id/status =====
  app.put('/api/invoices/:invoice_id/status', (req, res) => {
    try {
      const newStatus = req.body.order_status;
      if (!['قيد التنفيذ', 'قيد التوصيل', 'منجز'].includes(newStatus)) {
        return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
      }
      const db = getDb(req);
      db.prepare('UPDATE invoices SET order_status = ? WHERE id = ?').run(newStatus, req.params.invoice_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/customers =====
  app.get('/api/customers', (req, res) => {
    try {
      const search = req.query.search || '';
      const db = getDb(req);
      let rows;
      if (search) {
        const pattern = `%${search}%`;
        rows = db.prepare(`
          SELECT *,
                 (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
                 (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE customer_id = customers.id) as total_spent
          FROM customers
          WHERE name LIKE ? OR phone LIKE ? OR address LIKE ?
          ORDER BY created_at DESC
        `).all(pattern, pattern, pattern);
      } else {
        rows = db.prepare(`
          SELECT *,
                 (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
                 (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE customer_id = customers.id) as total_spent
          FROM customers
          ORDER BY created_at DESC
        `).all();
      }
      return res.json({ success: true, customers: rows });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/customers/search =====
  app.get('/api/customers/search', (req, res) => {
    try {
      const phone = req.query.phone || '';
      if (!phone) return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
      const db = getDb(req);
      const row = db.prepare(`
        SELECT *,
               COALESCE(loyalty_points, 0) as points,
               (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
               (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE customer_id = customers.id) as total_spent
        FROM customers WHERE phone = ?
      `).get(phone);
      if (row) return res.json({ success: true, customer: row });
      return res.json({ success: false, error: 'العميل غير موجود' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/customers/:customer_id =====
  app.get('/api/customers/:customer_id', (req, res) => {
    try {
      const db = getDb(req);
      const row = db.prepare(`
        SELECT *,
               (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id) as total_orders,
               (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE customer_id = customers.id) as total_spent
        FROM customers WHERE id = ?
      `).get(req.params.customer_id);
      if (row) return res.json({ success: true, customer: row });
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/customers/:customer_id/points/adjust =====
  app.post('/api/customers/:customer_id/points/adjust', (req, res) => {
    try {
      const points = req.body.points || 0;
      const db = getDb(req);
      db.prepare('UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?) WHERE id = ?')
        .run(points, req.params.customer_id);
      const row = db.prepare('SELECT COALESCE(loyalty_points, 0) as loyalty_points FROM customers WHERE id = ?')
        .get(req.params.customer_id);
      return res.json({ success: true, new_points: row ? row.loyalty_points : 0 });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/customers =====
  app.post('/api/customers', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const phone = data.phone || '';
      if (phone) {
        const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone);
        if (existing) {
          db.prepare('UPDATE customers SET name = ?, address = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(data.name || '', data.address || '', data.notes || '', existing.id);
          return res.json({ success: true, id: existing.id, updated: true });
        }
      }
      const result = db.prepare('INSERT INTO customers (name, phone, address, notes) VALUES (?, ?, ?, ?)')
        .run(data.name || '', data.phone || '', data.address || '', data.notes || '');
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/customers/:customer_id =====
  app.put('/api/customers/:customer_id', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      db.prepare('UPDATE customers SET name = ?, phone = ?, address = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(data.name || '', data.phone || '', data.address || '', data.notes || '', req.params.customer_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/customers/:customer_id =====
  app.delete('/api/customers/:customer_id', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.customer_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/customers/:customer_id/invoices =====
  app.get('/api/customers/:customer_id/invoices', (req, res) => {
    try {
      const db = getDb(req);
      const invoices = db.prepare('SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC')
        .all(req.params.customer_id);
      return res.json({ success: true, invoices });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/settings =====
  app.get('/api/settings', (req, res) => {
    try {
      const db = getDb(req);
      const rows = db.prepare('SELECT * FROM settings').all();
      const settings = {};
      for (const row of rows) { settings[row.key] = row.value; }
      return res.json({ success: true, settings });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/settings =====
  app.put('/api/settings', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
      for (const [key, value] of Object.entries(data)) {
        stmt.run(key, value);
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/reports/sales =====
  app.get('/api/reports/sales', (req, res) => {
    try {
      const startDate = req.query.start_date;
      const endDate = req.query.end_date;
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let where = ' WHERE 1=1';
      const params = [];

      if (startDate) { where += ' AND date(created_at) >= ?'; params.push(startDate); }
      if (endDate) { where += ' AND date(created_at) <= ?'; params.push(endDate); }
      if (branchId) {
        const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId);
        if (branch) { where += ' AND branch_name = ?'; params.push(branch.name); }
      }

      const report = db.prepare(`
        SELECT COUNT(*) as total_invoices, COALESCE(SUM(subtotal), 0) as total_subtotal,
               COALESCE(SUM(discount), 0) as total_discount, COALESCE(SUM(delivery_fee), 0) as total_delivery,
               COALESCE(SUM(total), 0) as total_sales, COALESCE(AVG(total), 0) as average_sale
        FROM invoices ${where}
      `).get(...params);

      const payment_methods = db.prepare(`
        SELECT payment_method, COUNT(*) as count, COALESCE(SUM(total), 0) as total
        FROM invoices ${where} GROUP BY payment_method
      `).all(...params);

      const branches = db.prepare(`
        SELECT branch_name, COUNT(*) as count, COALESCE(SUM(total), 0) as total
        FROM invoices ${where} AND branch_name IS NOT NULL GROUP BY branch_name
      `).all(...params);

      const invoices = db.prepare(`SELECT * FROM invoices ${where} ORDER BY created_at DESC`).all(...params);

      report.payment_methods = payment_methods;
      report.branches = branches;
      report.invoices = invoices;

      return res.json({ success: true, report });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/reports/inventory =====
  app.get('/api/reports/inventory', (req, res) => {
    try {
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let query = `
        SELECT i.id, i.name, i.barcode, i.category, i.price, i.cost,
               bs.branch_id, b.name as branch_name, bs.stock,
               (bs.stock * i.cost) as stock_value
        FROM inventory i
        LEFT JOIN branch_stock bs ON i.id = bs.inventory_id
        LEFT JOIN branches b ON bs.branch_id = b.id
        WHERE 1=1
      `;
      const params = [];
      if (branchId) { query += ' AND bs.branch_id = ?'; params.push(branchId); }
      query += ' ORDER BY i.name';

      const items = db.prepare(query).all(...params);
      let totalStock = 0, totalValue = 0;
      for (const item of items) {
        totalStock += item.stock || 0;
        totalValue += item.stock_value || 0;
      }

      return res.json({
        success: true,
        report: { total_items: items.length, total_stock: totalStock, total_value: totalValue, items }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/reports/damaged =====
  app.get('/api/reports/damaged', (req, res) => {
    try {
      const startDate = req.query.start_date;
      const endDate = req.query.end_date;
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let query = `
        SELECT d.*, i.name as product_name, i.cost,
               (d.quantity * i.cost) as damage_value, b.name as branch_name
        FROM damaged_items d
        JOIN inventory i ON d.inventory_id = i.id
        LEFT JOIN branches b ON d.branch_id = b.id
        WHERE 1=1
      `;
      const params = [];
      if (startDate) { query += ' AND date(d.created_at) >= ?'; params.push(startDate); }
      if (endDate) { query += ' AND date(d.created_at) <= ?'; params.push(endDate); }
      if (branchId) { query += ' AND d.branch_id = ?'; params.push(branchId); }
      query += ' ORDER BY d.created_at DESC';

      const items = db.prepare(query).all(...params);
      let totalDamaged = 0, totalValue = 0;
      for (const item of items) {
        totalDamaged += item.quantity || 0;
        totalValue += item.damage_value || 0;
      }

      return res.json({
        success: true,
        report: { total_damaged: totalDamaged, total_value: totalValue, items }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/reports/top-products =====
  app.get('/api/reports/top-products', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const db = getDb(req);
      const products = db.prepare(`
        SELECT product_name, SUM(quantity) as total_quantity,
               SUM(total) as total_sales, COUNT(DISTINCT invoice_id) as times_sold
        FROM invoice_items GROUP BY product_name ORDER BY total_quantity DESC LIMIT ?
      `).all(limit);
      return res.json({ success: true, products });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/reports/low-stock =====
  app.get('/api/reports/low-stock', (req, res) => {
    try {
      const threshold = parseInt(req.query.threshold) || 10;
      const db = getDb(req);
      const products = db.prepare('SELECT * FROM products WHERE stock <= ? ORDER BY stock ASC').all(threshold);
      return res.json({ success: true, products });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/reports/sales-by-product =====
  app.get('/api/reports/sales-by-product', (req, res) => {
    try {
      const startDate = req.query.start_date;
      const endDate = req.query.end_date;
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let where = ' WHERE 1=1';
      const params = [];
      if (startDate) { where += ' AND date(i.created_at) >= ?'; params.push(startDate); }
      if (endDate) { where += ' AND date(i.created_at) <= ?'; params.push(endDate); }
      if (branchId) {
        const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId);
        if (branch) { where += ' AND i.branch_name = ?'; params.push(branch.name); }
      }

      const products = db.prepare(`
        SELECT ii.product_name, SUM(ii.quantity) as total_quantity,
               SUM(ii.total) as total_sales, COUNT(DISTINCT ii.invoice_id) as invoice_count,
               AVG(ii.price) as avg_price
        FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id
        ${where} GROUP BY ii.product_name ORDER BY total_sales DESC
      `).all(...params);

      let totalSales = 0, totalQuantity = 0;
      for (const p of products) { totalSales += p.total_sales || 0; totalQuantity += p.total_quantity || 0; }

      return res.json({
        success: true, products,
        summary: { total_sales: totalSales, total_quantity: totalQuantity, products_count: products.length }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/reports/sales-by-branch =====
  app.get('/api/reports/sales-by-branch', (req, res) => {
    try {
      const startDate = req.query.start_date;
      const endDate = req.query.end_date;
      const db = getDb(req);

      let where = ' WHERE 1=1';
      const params = [];
      if (startDate) { where += ' AND date(created_at) >= ?'; params.push(startDate); }
      if (endDate) { where += ' AND date(created_at) <= ?'; params.push(endDate); }

      const branches = db.prepare(`
        SELECT branch_name, COUNT(*) as invoice_count,
               COALESCE(SUM(subtotal), 0) as total_subtotal, COALESCE(SUM(discount), 0) as total_discount,
               COALESCE(SUM(delivery_fee), 0) as total_delivery, COALESCE(SUM(total), 0) as total_sales,
               COALESCE(AVG(total), 0) as avg_sale
        FROM invoices ${where} GROUP BY branch_name ORDER BY total_sales DESC
      `).all(...params);

      let totalSales = 0, totalInvoices = 0;
      for (const b of branches) { totalSales += b.total_sales || 0; totalInvoices += b.invoice_count || 0; }

      return res.json({
        success: true, branches,
        summary: { total_sales: totalSales, total_invoices: totalInvoices, branches_count: branches.length }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/returns =====
  app.get('/api/returns', (req, res) => {
    try {
      const db = getDb(req);
      const returns = db.prepare('SELECT * FROM returns ORDER BY created_at DESC').all();
      return res.json({ success: true, returns });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/returns/:return_id =====
  app.get('/api/returns/:return_id', (req, res) => {
    try {
      const db = getDb(req);
      const row = db.prepare('SELECT * FROM returns WHERE id = ?').get(req.params.return_id);
      if (!row) return res.status(404).json({ success: false, error: 'المرتجع غير موجود' });
      return res.json({ success: true, 'return': row });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/returns =====
  app.post('/api/returns', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO returns (invoice_id, invoice_number, product_id, product_name, quantity, price, total, reason, employee_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.invoice_id, data.invoice_number, data.product_id, data.product_name,
        data.quantity, data.price, data.total, data.reason, data.employee_name
      );
      if (data.product_id) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(data.quantity, data.product_id);
      }
      return res.json({ success: true, return_id: Number(result.lastInsertRowid), message: 'تم إضافة المرتجع وإعادة المنتج للمخزون' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/returns/:return_id =====
  app.delete('/api/returns/:return_id', (req, res) => {
    try {
      const db = getDb(req);
      const row = db.prepare('SELECT * FROM returns WHERE id = ?').get(req.params.return_id);
      if (!row) return res.status(404).json({ success: false, error: 'المرتجع غير موجود' });
      if (row.product_id) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(row.quantity, row.product_id);
      }
      db.prepare('DELETE FROM returns WHERE id = ?').run(req.params.return_id);
      return res.json({ success: true, message: 'تم حذف المرتجع' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/expenses =====
  app.get('/api/expenses', (req, res) => {
    try {
      const startDate = req.query.start_date;
      const endDate = req.query.end_date;
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let query = 'SELECT * FROM expenses WHERE 1=1';
      const params = [];
      if (startDate) { query += ' AND date(expense_date) >= ?'; params.push(startDate); }
      if (endDate) { query += ' AND date(expense_date) <= ?'; params.push(endDate); }
      if (branchId) { query += ' AND branch_id = ?'; params.push(branchId); }
      query += ' ORDER BY expense_date DESC';

      const expenses = db.prepare(query).all(...params);
      for (const exp of expenses) {
        if (exp.expense_type === 'رواتب') {
          exp.salary_details = db.prepare('SELECT * FROM salary_details WHERE expense_id = ? ORDER BY id').all(exp.id);
        } else {
          exp.salary_details = [];
        }
      }
      return res.json({ success: true, expenses });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/expenses =====
  app.post('/api/expenses', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO expenses (expense_type, amount, description, expense_date, branch_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(data.expense_type, data.amount, data.description || '', data.expense_date, data.branch_id, data.created_by);
      const expenseId = Number(result.lastInsertRowid);

      const salaryDetails = data.salary_details || [];
      if (data.expense_type === 'رواتب' && salaryDetails.length > 0) {
        const stmt = db.prepare('INSERT INTO salary_details (expense_id, employee_name, monthly_salary) VALUES (?, ?, ?)');
        for (const emp of salaryDetails) {
          stmt.run(expenseId, emp.employee_name || '', emp.monthly_salary || 0);
        }
      }
      return res.json({ success: true, id: expenseId });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/expenses/:expense_id =====
  app.delete('/api/expenses/:expense_id', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('DELETE FROM salary_details WHERE expense_id = ?').run(req.params.expense_id);
      db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.expense_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/attendance/check-in =====
  app.post('/api/attendance/check-in', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare('INSERT INTO attendance_log (user_id, user_name, branch_id, check_in) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
        .run(data.user_id, data.user_name, data.branch_id || 1);
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/attendance/check-out =====
  app.post('/api/attendance/check-out', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const record = db.prepare('SELECT id FROM attendance_log WHERE user_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1')
        .get(data.user_id);
      if (record) {
        db.prepare('UPDATE attendance_log SET check_out = CURRENT_TIMESTAMP WHERE id = ?').run(record.id);
        return res.json({ success: true });
      }
      return res.json({ success: false, error: 'لا يوجد سجل حضور' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/attendance =====
  app.get('/api/attendance', (req, res) => {
    try {
      const userId = req.query.user_id;
      const date = req.query.date;
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let query = 'SELECT * FROM attendance_log WHERE 1=1';
      const params = [];
      if (userId) { query += ' AND user_id = ?'; params.push(userId); }
      if (date) { query += ' AND DATE(check_in) = ?'; params.push(date); }
      if (branchId) { query += ' AND branch_id = ?'; params.push(branchId); }
      query += ' ORDER BY check_in DESC';

      return res.json({ success: true, records: db.prepare(query).all(...params) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/damaged-items =====
  app.get('/api/damaged-items', (req, res) => {
    try {
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let query = `
        SELECT d.*, i.name as product_name, b.name as branch_name
        FROM damaged_items d
        JOIN inventory i ON d.inventory_id = i.id
        LEFT JOIN branches b ON d.branch_id = b.id
        WHERE 1=1
      `;
      const params = [];
      if (branchId) { query += ' AND d.branch_id = ?'; params.push(branchId); }
      query += ' ORDER BY d.created_at DESC';

      return res.json({ success: true, damaged: db.prepare(query).all(...params) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/damaged-items =====
  app.post('/api/damaged-items', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare('INSERT INTO damaged_items (inventory_id, branch_id, quantity, reason, reported_by) VALUES (?, ?, ?, ?, ?)')
        .run(data.inventory_id, data.branch_id, data.quantity, data.reason || '', data.reported_by);
      db.prepare('UPDATE branch_stock SET stock = stock - ? WHERE inventory_id = ? AND branch_id = ?')
        .run(data.quantity, data.inventory_id, data.branch_id);
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/damaged-items/:damaged_id =====
  app.delete('/api/damaged-items/:damaged_id', (req, res) => {
    try {
      const db = getDb(req);
      db.prepare('DELETE FROM damaged_items WHERE id = ?').run(req.params.damaged_id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/system-logs =====
  app.get('/api/system-logs', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 500;
      const actionType = req.query.action_type;
      const userId = req.query.user_id;
      const dateFrom = req.query.date_from;
      const dateTo = req.query.date_to;
      const db = getDb(req);

      let query = 'SELECT * FROM system_logs WHERE 1=1';
      const params = [];
      if (actionType) { query += ' AND action_type = ?'; params.push(actionType); }
      if (userId) { query += ' AND user_id = ?'; params.push(userId); }
      if (dateFrom) { query += ' AND created_at >= ?'; params.push(dateFrom + ' 00:00:00'); }
      if (dateTo) { query += ' AND created_at <= ?'; params.push(dateTo + ' 23:59:59'); }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      return res.json({ success: true, logs: db.prepare(query).all(...params) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/system-logs =====
  app.post('/api/system-logs', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO system_logs (action_type, description, user_id, user_name, branch_id, target_id, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(data.action_type, data.description, data.user_id, data.user_name, data.branch_id, data.target_id, data.details);
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/invoices/:invoice_id/cancel =====
  app.put('/api/invoices/:invoice_id/cancel', (req, res) => {
    try {
      const invoiceId = req.params.invoice_id;
      const data = req.body;
      const cancelReason = data.reason || '';
      const returnStock = data.return_stock || false;

      if (!cancelReason) {
        return res.status(400).json({ success: false, error: 'يجب تحديد سبب الإلغاء' });
      }

      const db = getDb(req);

      // Ensure columns exist
      for (const sql of [
        "ALTER TABLE invoices ADD COLUMN cancelled INTEGER DEFAULT 0",
        "ALTER TABLE invoices ADD COLUMN cancel_reason TEXT",
        "ALTER TABLE invoices ADD COLUMN cancelled_at TIMESTAMP",
        "ALTER TABLE invoices ADD COLUMN stock_returned INTEGER DEFAULT 0"
      ]) {
        try { db.exec(sql); } catch (_e) { /* ignore */ }
      }

      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      if (!invoice) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
      if (invoice.cancelled) return res.status(400).json({ success: false, error: 'الفاتورة ملغية مسبقاً' });

      let stockReturned = 0;
      if (returnStock) {
        const invoiceItems = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
        for (const item of invoiceItems) {
          if (item.branch_stock_id && item.quantity) {
            db.prepare('UPDATE branch_stock SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(item.quantity, item.branch_stock_id);
          }
        }
        stockReturned = 1;
      }

      db.prepare(`
        UPDATE invoices SET cancelled = 1, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP,
        stock_returned = ?, order_status = 'ملغية' WHERE id = ?
      `).run(cancelReason, stockReturned, invoiceId);

      if (invoice.customer_id) {
        const netReverse = (invoice.loyalty_points_redeemed || 0) - (invoice.loyalty_points_earned || 0);
        if (netReverse !== 0) {
          db.prepare('UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?) WHERE id = ?')
            .run(netReverse, invoice.customer_id);
        }
      }

      return res.json({ success: true, stock_returned: Boolean(stockReturned) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

};
