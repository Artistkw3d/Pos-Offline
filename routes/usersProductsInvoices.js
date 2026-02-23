/**
 * Routes: Users, Products, Inventory, Branch Stock, Invoices
 * Converted from server.py lines 981-2255
 */

module.exports = function (app, helpers) {
  const { getDb, getMasterDb, hashPassword } = helpers;

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
  app.post('/api/login', (req, res) => {
    try {
      const data = req.body;
      const username = data.username;
      const password = data.password;

      // Check tenant subscription
      const tenantSlug = req.headers['x-tenant-id'];
      if (tenantSlug) {
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
      }

      const db = getDb(req);
      ensureUserPermissionColumns(db);

      const hashedPw = hashPassword(password);
      const user = db.prepare(`
        SELECT u.*, b.name as branch_name
        FROM users u
        LEFT JOIN branches b ON u.branch_id = b.id
        WHERE u.username = ? AND u.is_active = 1
      `).get(username);

      if (user) {
        const storedPw = user.password;
        if (storedPw === hashedPw || storedPw === password) {
          if (storedPw === password && storedPw !== hashedPw) {
            db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPw, user.id);
          }
          db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
          const userData = { ...user };
          delete userData.password;
          return res.json({ success: true, user: userData });
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
