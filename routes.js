// ============================================================
// Converted from server.py lines 981-2255
// All Flask routes -> Express route handlers
// ============================================================

const path = require('path');

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
          // Auto-deactivate expired tenant
          masterDb.prepare('UPDATE tenants SET is_active = 0 WHERE slug = ?').run(tenantSlug);
          return res.status(403).json({
            success: false,
            error: `⛔ انتهى اشتراك المتجر "${tenant.name}" بتاريخ ${tenant.expires_at.substring(0, 10)}.\nتواصل مع إدارة النظام لتجديد الاشتراك.`
          });
        }
      }
    }

    const db = getDb(req);

    // Ensure new permission columns exist
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
      // Support legacy plain text passwords and new hashed passwords
      if (storedPw === hashedPw || storedPw === password) {
        // Upgrade legacy plain text password to hashed automatically
        if (storedPw === password && storedPw !== hashedPw) {
          db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPw, user.id);
        }
        // Update last login time
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

    // Ensure new permission columns exist
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
      data.username,
      hashPassword(data.password),
      data.full_name,
      data.role || 'cashier',
      data.invoice_prefix || '',
      data.branch_id || 1,
      data.can_view_products || 0,
      data.can_add_products || 0,
      data.can_edit_products || 0,
      data.can_delete_products || 0,
      data.can_view_inventory || 0,
      data.can_add_inventory || 0,
      data.can_edit_inventory || 0,
      data.can_delete_inventory || 0,
      data.can_view_invoices !== undefined ? data.can_view_invoices : 1,
      data.can_delete_invoices || 0,
      data.can_view_customers || 0,
      data.can_add_customer || 0,
      data.can_edit_customer || 0,
      data.can_delete_customer || 0,
      data.can_view_reports || 0,
      data.can_view_accounting || 0,
      data.can_manage_users || 0,
      data.can_access_settings || 0,
      data.can_view_returns || 0,
      data.can_view_expenses || 0,
      data.can_view_suppliers || 0,
      data.can_view_coupons || 0,
      data.can_view_tables || 0,
      data.can_view_attendance || 0,
      data.can_view_advanced_reports || 0,
      data.can_view_system_logs || 0,
      data.can_view_dcf || 0,
      data.can_cancel_invoices || 0,
      data.can_view_branches || 0,
      data.can_view_cross_branch_stock || 0,
      data.can_view_xbrl || 0,
      data.shift_id || null,
      data.can_edit_completed_invoices || 0,
      data.can_create_transfer || 0,
      data.can_approve_transfer || 0,
      data.can_deliver_transfer || 0,
      data.can_view_transfers || 0,
      data.can_view_subscriptions || 0,
      data.can_manage_subscriptions || 0
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

    // Ensure new permission columns exist
    ensureUserPermissionColumns(db);

    // Build dynamic update query
    const updates = [];
    const params = [];

    if (data.password) {
      updates.push('password = ?');
      params.push(hashPassword(data.password));
    }
    if ('full_name' in data) {
      updates.push('full_name = ?');
      params.push(data.full_name);
    }
    if ('role' in data) {
      updates.push('role = ?');
      params.push(data.role);
    }
    if ('invoice_prefix' in data) {
      updates.push('invoice_prefix = ?');
      params.push(data.invoice_prefix);
    }
    if ('branch_id' in data) {
      updates.push('branch_id = ?');
      params.push(data.branch_id);
    }
    if ('can_view_products' in data) {
      updates.push('can_view_products = ?');
      params.push(data.can_view_products);
    }
    if ('can_add_products' in data) {
      updates.push('can_add_products = ?');
      params.push(data.can_add_products);
    }
    if ('can_edit_products' in data) {
      updates.push('can_edit_products = ?');
      params.push(data.can_edit_products);
    }
    if ('can_delete_products' in data) {
      updates.push('can_delete_products = ?');
      params.push(data.can_delete_products);
    }
    if ('can_view_inventory' in data) {
      updates.push('can_view_inventory = ?');
      params.push(data.can_view_inventory);
    }
    if ('can_add_inventory' in data) {
      updates.push('can_add_inventory = ?');
      params.push(data.can_add_inventory);
    }
    if ('can_edit_inventory' in data) {
      updates.push('can_edit_inventory = ?');
      params.push(data.can_edit_inventory);
    }
    if ('can_delete_inventory' in data) {
      updates.push('can_delete_inventory = ?');
      params.push(data.can_delete_inventory);
    }
    if ('can_view_invoices' in data) {
      updates.push('can_view_invoices = ?');
      params.push(data.can_view_invoices);
    }
    if ('can_delete_invoices' in data) {
      updates.push('can_delete_invoices = ?');
      params.push(data.can_delete_invoices);
    }
    if ('can_view_customers' in data) {
      updates.push('can_view_customers = ?');
      params.push(data.can_view_customers);
    }
    if ('can_add_customer' in data) {
      updates.push('can_add_customer = ?');
      params.push(data.can_add_customer);
    }
    if ('can_edit_customer' in data) {
      updates.push('can_edit_customer = ?');
      params.push(data.can_edit_customer);
    }
    if ('can_delete_customer' in data) {
      updates.push('can_delete_customer = ?');
      params.push(data.can_delete_customer);
    }
    if ('can_view_reports' in data) {
      updates.push('can_view_reports = ?');
      params.push(data.can_view_reports);
    }
    if ('can_view_accounting' in data) {
      updates.push('can_view_accounting = ?');
      params.push(data.can_view_accounting);
    }
    if ('can_manage_users' in data) {
      updates.push('can_manage_users = ?');
      params.push(data.can_manage_users);
    }
    if ('can_access_settings' in data) {
      updates.push('can_access_settings = ?');
      params.push(data.can_access_settings);
    }
    if ('can_view_returns' in data) {
      updates.push('can_view_returns = ?');
      params.push(data.can_view_returns);
    }
    if ('can_view_expenses' in data) {
      updates.push('can_view_expenses = ?');
      params.push(data.can_view_expenses);
    }
    if ('can_view_suppliers' in data) {
      updates.push('can_view_suppliers = ?');
      params.push(data.can_view_suppliers);
    }
    if ('can_view_coupons' in data) {
      updates.push('can_view_coupons = ?');
      params.push(data.can_view_coupons);
    }
    if ('can_view_tables' in data) {
      updates.push('can_view_tables = ?');
      params.push(data.can_view_tables);
    }
    if ('can_view_attendance' in data) {
      updates.push('can_view_attendance = ?');
      params.push(data.can_view_attendance);
    }
    if ('can_view_advanced_reports' in data) {
      updates.push('can_view_advanced_reports = ?');
      params.push(data.can_view_advanced_reports);
    }
    if ('can_view_system_logs' in data) {
      updates.push('can_view_system_logs = ?');
      params.push(data.can_view_system_logs);
    }
    if ('can_view_dcf' in data) {
      updates.push('can_view_dcf = ?');
      params.push(data.can_view_dcf);
    }
    if ('can_cancel_invoices' in data) {
      updates.push('can_cancel_invoices = ?');
      params.push(data.can_cancel_invoices);
    }
    if ('can_view_branches' in data) {
      updates.push('can_view_branches = ?');
      params.push(data.can_view_branches);
    }
    if ('can_view_cross_branch_stock' in data) {
      updates.push('can_view_cross_branch_stock = ?');
      params.push(data.can_view_cross_branch_stock);
    }
    if ('can_view_xbrl' in data) {
      updates.push('can_view_xbrl = ?');
      params.push(data.can_view_xbrl);
    }
    if ('shift_id' in data) {
      updates.push('shift_id = ?');
      params.push(data.shift_id);
    }
    if ('can_edit_completed_invoices' in data) {
      updates.push('can_edit_completed_invoices = ?');
      params.push(data.can_edit_completed_invoices);
    }
    if ('can_create_transfer' in data) {
      updates.push('can_create_transfer = ?');
      params.push(data.can_create_transfer);
    }
    if ('can_approve_transfer' in data) {
      updates.push('can_approve_transfer = ?');
      params.push(data.can_approve_transfer);
    }
    if ('can_deliver_transfer' in data) {
      updates.push('can_deliver_transfer = ?');
      params.push(data.can_deliver_transfer);
    }
    if ('can_view_transfers' in data) {
      updates.push('can_view_transfers = ?');
      params.push(data.can_view_transfers);
    }
    if ('can_view_subscriptions' in data) {
      updates.push('can_view_subscriptions = ?');
      params.push(data.can_view_subscriptions);
    }
    if ('can_manage_subscriptions' in data) {
      updates.push('can_manage_subscriptions = ?');
      params.push(data.can_manage_subscriptions);
    }
    if ('is_active' in data) {
      updates.push('is_active = ?');
      params.push(data.is_active);
    }

    if (updates.length > 0) {
      params.push(userId);
      const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
      db.prepare(query).run(...params);
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

    // Cannot delete admin user
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

// ===== Static file serving: GET / =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ===== GET /sw.js - Service Worker (no cache) =====
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'frontend', 'sw.js'));
});

// ===== GET /clear-cache =====
app.get('/clear-cache', (req, res) => {
  res.send(`<!DOCTYPE html>
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
        // 1. Unregister all Service Workers
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) { await reg.unregister(); }
        status.textContent += '\\n✅ تم إلغاء Service Workers (' + regs.length + ')';
        // 2. Delete all caches
        const keys = await caches.keys();
        for (const key of keys) { await caches.delete(key); }
        status.textContent += '\\n✅ تم حذف الكاشات (' + keys.length + ')';
        // 3. Clear localStorage
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
</body></html>`);
});

// ===== Catch-all static files: GET /:path =====
// NOTE: Register this AFTER all /api routes to avoid conflicts
app.get('/:path(*)', (req, res, next) => {
  // Skip API routes
  if (req.params.path.startsWith('api/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'frontend', req.params.path), (err) => {
    if (err) {
      next(err);
    }
  });
});

// ===== GET /api/products =====
app.get('/api/products', (req, res) => {
  try {
    const branchId = req.query.branch_id;
    const db = getDb(req);

    // Fetch products from branch_stock with inventory info
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
      // If distribution is for a specific variant, use its name and price
      if (p.variant_id && p.variant_name) {
        p.display_name = `${p.name} (${p.variant_name})`;
        p.price = p.variant_price || p.price;
        p.cost = p.variant_cost || p.cost;
        if (p.variant_barcode) {
          p.barcode = p.variant_barcode;
        }
      } else {
        p.display_name = p.name;
      }
      return p;
    });

    // Fetch full variants for each product (for POS)
    const seenInv = new Set();
    for (const p of products) {
      const invId = p.inventory_id;
      if (invId && !seenInv.has(invId)) {
        const variants = db.prepare('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id').all(invId);
        for (const pp of products) {
          if (pp.inventory_id === invId) {
            pp.variants = variants;
          }
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
    `).run(
      data.name,
      data.barcode,
      data.price || 0,
      data.cost || 0,
      data.stock || 0,
      data.category || '',
      data.image_data || '',
      data.branch_id || 1
    );

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
      UPDATE products
      SET name=?, barcode=?, price=?, cost=?, stock=?, category=?, image_data=?, branch_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      data.name,
      data.barcode,
      data.price,
      data.cost,
      data.stock,
      data.category,
      data.image_data,
      data.branch_id || 1,
      productId
    );

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ===== DELETE /api/products/:product_id =====
app.delete('/api/products/:product_id', (req, res) => {
  try {
    const productId = req.params.product_id;
    const db = getDb(req);
    db.prepare('DELETE FROM products WHERE id=?').run(productId);
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

    // Fetch variants for each product
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
      INSERT INTO inventory (name, barcode, category, price, cost, image_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.name,
      data.barcode,
      data.category || '',
      data.price || 0,
      data.cost || 0,
      data.image_data || ''
    );

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
    const inventoryId = req.params.inventory_id;
    const data = req.body;
    const db = getDb(req);

    db.prepare(`
      UPDATE inventory
      SET name=?, barcode=?, category=?, price=?, cost=?, image_data=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      data.name,
      data.barcode,
      data.category,
      data.price,
      data.cost,
      data.image_data,
      inventoryId
    );

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
    // Delete variants and distributions first
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
    const inventoryId = req.params.inventory_id;
    const db = getDb(req);
    const variants = db.prepare('SELECT * FROM product_variants WHERE inventory_id = ? ORDER BY id').all(inventoryId);
    return res.json({ success: true, variants });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ===== POST /api/inventory/:inventory_id/variants =====
app.post('/api/inventory/:inventory_id/variants', (req, res) => {
  try {
    const inventoryId = req.params.inventory_id;
    const data = req.body;
    const variants = data.variants || [];
    const db = getDb(req);

    // Use transaction for atomicity
    const saveVariants = db.transaction(() => {
      // Delete old variants
      db.prepare('DELETE FROM product_variants WHERE inventory_id = ?').run(inventoryId);

      // Insert new ones
      const insertStmt = db.prepare(`
        INSERT INTO product_variants (inventory_id, variant_name, price, cost, barcode)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const v of variants) {
        insertStmt.run(
          inventoryId,
          v.variant_name || '',
          v.price || 0,
          v.cost || 0,
          v.barcode || ''
        );
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

    if (branchId) {
      query += ' AND bs.branch_id = ?';
      params.push(branchId);
    }

    if (inventoryId) {
      query += ' AND bs.inventory_id = ?';
      params.push(inventoryId);
    }

    query += ' ORDER BY i.name';

    const stock = db.prepare(query).all(...params);

    return res.json({ success: true, stock });
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

    // Build note entry with date and quantity
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

    // Check if distribution already exists (with variant_id)
    let existing;
    if (variantId) {
      existing = db.prepare(`
        SELECT id, stock, notes FROM branch_stock
        WHERE inventory_id = ? AND branch_id = ? AND variant_id = ?
      `).get(data.inventory_id, data.branch_id, variantId);
    } else {
      existing = db.prepare(`
        SELECT id, stock, notes FROM branch_stock
        WHERE inventory_id = ? AND branch_id = ? AND (variant_id IS NULL OR variant_id = 0)
      `).get(data.inventory_id, data.branch_id);
    }

    let stockId;

    if (existing) {
      const newStock = existing.stock + addedStock;
      // Append new note to old notes
      const oldNotes = existing.notes || '';
      let combinedNotes;
      if (noteEntry) {
        combinedNotes = oldNotes ? (oldNotes + '\n' + noteEntry).trim() : noteEntry;
      } else {
        combinedNotes = oldNotes;
      }
      db.prepare(`
        UPDATE branch_stock SET stock = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newStock, combinedNotes, existing.id);
      stockId = existing.id;
    } else {
      const result = db.prepare(`
        INSERT INTO branch_stock (inventory_id, branch_id, variant_id, stock, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        data.inventory_id,
        data.branch_id,
        variantId,
        addedStock,
        noteEntry
      );
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
    const stockId = req.params.stock_id;
    const data = req.body;
    const db = getDb(req);

    db.prepare(`
      UPDATE branch_stock
      SET stock = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(data.stock || 0, stockId);

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ===== DELETE /api/branch-stock/:stock_id =====
app.delete('/api/branch-stock/:stock_id', (req, res) => {
  try {
    const stockId = req.params.stock_id;
    const db = getDb(req);
    db.prepare('DELETE FROM branch_stock WHERE id = ?').run(stockId);
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
        if (p.variant_barcode) {
          p.barcode = p.variant_barcode;
        }
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

    if (startDate) {
      query += ' AND date(created_at) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND date(created_at) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const invoices = db.prepare(query).all(...params);

    return res.json({ success: true, invoices });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ===== GET /api/invoices/:invoice_id =====
app.get('/api/invoices/:invoice_id', (req, res) => {
  try {
    const invoiceId = req.params.invoice_id;
    const db = getDb(req);

    // Fetch the invoice
    const invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    }

    // Fetch invoice items
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(invoiceId);
    invoice.items = items;

    return res.json({ success: true, invoice });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ===== DELETE /api/invoices/clear-all =====
app.delete('/api/invoices/clear-all', (req, res) => {
  try {
    const db = getDb(req);

    // Delete invoice items first
    db.prepare('DELETE FROM invoice_items').run();

    // Delete invoices
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

    // Get branch name
    const branchId = data.branch_id || 1;
    const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId);
    const branchName = branch ? branch.name : 'الفرع الرئيسي';

    // Modify invoice number to include branch number (e.g., AHM-001-B1)
    const originalInvoiceNumber = data.invoice_number || '';
    const invoiceNumberWithBranch = `${originalInvoiceNumber}-B${branchId}`;

    // Fetch shift name if available
    const shiftId = data.shift_id;
    let shiftName = '';
    if (shiftId) {
      const shiftRow = db.prepare('SELECT name FROM shifts WHERE id = ?').get(shiftId);
      shiftName = shiftRow ? shiftRow.name : '';
    }

    // Insert the invoice
    const invoiceResult = db.prepare(`
      INSERT INTO invoices
      (invoice_number, customer_id, customer_name, customer_phone, customer_address,
       subtotal, discount, total, payment_method, employee_name, notes, transaction_number, branch_id, branch_name, delivery_fee,
       coupon_discount, coupon_code, loyalty_discount, loyalty_points_earned, loyalty_points_redeemed,
       table_id, table_name, shift_id, shift_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invoiceNumberWithBranch,
      data.customer_id || null,
      data.customer_name || '',
      data.customer_phone || '',
      data.customer_address || '',
      data.subtotal || 0,
      data.discount || 0,
      data.total || 0,
      data.payment_method || 'نقداً',
      data.employee_name || '',
      data.notes || '',
      data.transaction_number || '',
      branchId,
      branchName,
      data.delivery_fee || 0,
      data.coupon_discount || 0,
      data.coupon_code || '',
      data.loyalty_discount || 0,
      data.loyalty_points_earned || 0,
      data.loyalty_points_redeemed || 0,
      data.table_id || null,
      data.table_name || '',
      shiftId || null,
      shiftName
    );

    const invoiceId = Number(invoiceResult.lastInsertRowid);

    // Link table to invoice
    const tableId = data.table_id;
    if (tableId) {
      db.prepare('UPDATE restaurant_tables SET status = ?, current_invoice_id = ? WHERE id = ?')
        .run('occupied', invoiceId, tableId);
    }

    // Insert invoice items and update stock
    const items = data.items || [];
    const insertItemStmt = db.prepare(`
      INSERT INTO invoice_items
      (invoice_id, product_id, product_name, quantity, price, total, branch_stock_id, variant_id, variant_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStockStmt = db.prepare(`
      UPDATE branch_stock
      SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    for (const item of items) {
      // Get branch_stock_id
      const branchStockId = item.branch_stock_id || item.product_id;

      insertItemStmt.run(
        invoiceId,
        item.product_id,
        item.product_name,
        item.quantity,
        item.price,
        item.total,
        branchStockId,
        item.variant_id || null,
        item.variant_name || null
      );

      // Update stock in branch_stock
      if (branchStockId) {
        updateStockStmt.run(item.quantity, branchStockId);
      }
    }

    // Save multiple payments as JSON
    const payments = data.payments || [];
    if (payments.length > 0) {
      const paymentsJson = JSON.stringify(payments);
      db.prepare('UPDATE invoices SET transaction_number = ? WHERE id = ?').run(paymentsJson, invoiceId);
    }

    // Update customer loyalty points
    const customerId = data.customer_id;
    if (customerId) {
      const pointsEarned = data.loyalty_points_earned || 0;
      const pointsRedeemed = data.loyalty_points_redeemed || 0;
      const netPoints = pointsEarned - pointsRedeemed;
      if (netPoints !== 0) {
        db.prepare(`
          UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?)
          WHERE id = ?
        `).run(netPoints, customerId);
      }
    }

    // Check for low stock products after sale
    const lowStockWarnings = [];
    try {
      const thresholdRow = db.prepare("SELECT value FROM settings WHERE key = 'low_stock_threshold'").get();
      const threshold = thresholdRow ? parseInt(thresholdRow.value) : 5;

      for (const item of items) {
        const bsId = item.branch_stock_id || item.product_id;
        if (bsId) {
          const row = db.prepare(`
            SELECT bs.stock, inv.name as product_name, pv.variant_name
            FROM branch_stock bs
            LEFT JOIN inventory inv ON inv.id = bs.inventory_id
            LEFT JOIN product_variants pv ON pv.id = bs.variant_id
            WHERE bs.id = ?
          `).get(bsId);
          if (row && row.stock <= threshold) {
            let pname = row.product_name || item.product_name || '';
            if (row.variant_name) {
              pname += ` (${row.variant_name})`;
            }
            lowStockWarnings.push({
              product_name: pname,
              stock: row.stock
            });
          }
        }
      }
    } catch (lowStockErr) {
      console.log(`[LowStock] Warning check error: ${lowStockErr.message}`);
    }

    const result = { success: true, id: invoiceId, invoice_number: invoiceNumberWithBranch };
    if (lowStockWarnings.length > 0) {
      result.low_stock_warnings = lowStockWarnings;
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ===== PUT /api/invoices/:invoice_id/status =====
app.put('/api/invoices/:invoice_id/status', (req, res) => {
  try {
    const invoiceId = req.params.invoice_id;
    const data = req.body;
    const newStatus = data.order_status;

    const validStatuses = ['قيد التنفيذ', 'قيد التوصيل', 'منجز'];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
    }

    const db = getDb(req);
    db.prepare('UPDATE invoices SET order_status = ? WHERE id = ?').run(newStatus, invoiceId);

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

    // Add columns if they don't exist
    const alterStatements = [
      "ALTER TABLE invoices ADD COLUMN cancelled INTEGER DEFAULT 0",
      "ALTER TABLE invoices ADD COLUMN cancel_reason TEXT",
      "ALTER TABLE invoices ADD COLUMN cancelled_at TIMESTAMP",
      "ALTER TABLE invoices ADD COLUMN stock_returned INTEGER DEFAULT 0"
    ];
    for (const sql of alterStatements) {
      try {
        db.exec(sql);
      } catch (e) {
        // Column already exists - ignore
      }
    }

    // Check the invoice
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    }

    if (invoice.cancelled) {
      return res.status(400).json({ success: false, error: 'الفاتورة ملغية مسبقاً' });
    }

    // Return stock if requested
    let stockReturned = 0;
    if (returnStock) {
      const invoiceItems = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
      for (const item of invoiceItems) {
        const bsid = item.branch_stock_id;
        const qty = item.quantity;
        if (bsid && qty) {
          db.prepare(`
            UPDATE branch_stock
            SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(qty, bsid);
        }
      }
      stockReturned = 1;
    }

    // Update the invoice
    db.prepare(`
      UPDATE invoices
      SET cancelled = 1, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP,
          stock_returned = ?, order_status = 'ملغية'
      WHERE id = ?
    `).run(cancelReason, stockReturned, invoiceId);

    // Reverse customer loyalty points
    const customerId = invoice.customer_id;
    if (customerId) {
      const pointsEarned = invoice.loyalty_points_earned || 0;
      const pointsRedeemed = invoice.loyalty_points_redeemed || 0;
      const netReverse = pointsRedeemed - pointsEarned;
      if (netReverse !== 0) {
        db.prepare(`
          UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) + ?)
          WHERE id = ?
        `).run(netReverse, customerId);
      }
    }

    return res.json({ success: true, stock_returned: Boolean(stockReturned) });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});
