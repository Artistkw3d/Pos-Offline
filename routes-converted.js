const path = require('path');
const fs = require('fs');
const https = require('https');
const querystring = require('querystring');
const Database = require('better-sqlite3');

// These will be set from helpers when module.exports is called
let DB_PATH, TENANTS_DB_DIR, BACKUPS_DIR;
let getDb, getMasterDb, hashPassword, getBackupDir, createBackupFile, createTenantDatabase, upload;

// ===== Google Drive Constants =====
const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const GOOGLE_DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ===== Helper: HTTP request (replaces urllib.request) =====
function httpsRequest(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = data;
          reject(err);
        } else {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// Binary version for file uploads
function httpsRequestBinary(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = data;
          reject(err);
        } else {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ===== Helper: get tenant slug from request =====
function getTenantSlug(req) {
  return (req.headers['x-tenant-id'] || '').trim();
}

// ===== Helper: get tenant db path =====
function getTenantDbPath(slug) {
  if (!slug) return DB_PATH;
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(TENANTS_DB_DIR, `${safeSlug}.db`);
}

// ===== Helper: refresh Google Drive token =====
function refreshGdriveToken(dbPath) {
  const db = new Database(dbPath);
  const rowClientId = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_client_id'").get();
  const clientId = rowClientId ? rowClientId.value : null;
  const rowClientSecret = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_client_secret'").get();
  const clientSecret = rowClientSecret ? rowClientSecret.value : null;
  const rowRefreshToken = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'").get();
  const refreshToken = rowRefreshToken ? rowRefreshToken.value : null;
  db.close();

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const tokenData = querystring.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  // Synchronous approach: we return a promise. Callers in async routes must await.
  return httpsRequest(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenData
  }).then(response => {
    const tokens = JSON.parse(response.body);
    const newToken = tokens.access_token;
    if (newToken) {
      const db2 = new Database(dbPath);
      db2.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        'gdrive_access_token', newToken, new Date().toISOString()
      );
      db2.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        'gdrive_token_expiry', String(Date.now() / 1000 + (tokens.expires_in || 3600)), new Date().toISOString()
      );
      db2.close();
      return newToken;
    }
    return null;
  }).catch(() => null);
}

// ===== Helper: get Google Drive token =====
async function getGdriveToken(dbPath) {
  const db = new Database(dbPath);
  const rowToken = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_access_token'").get();
  const accessToken = rowToken ? rowToken.value : null;
  const rowExpiry = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_token_expiry'").get();
  const expiry = rowExpiry ? parseFloat(rowExpiry.value) : 0;
  db.close();

  if (!accessToken) return null;

  // Refresh if expired
  if (Date.now() / 1000 >= expiry - 60) {
    return await refreshGdriveToken(dbPath);
  }

  return accessToken;
}

// ===== Helper: exchange auth code for token =====
async function gdriveExchangeCode(authCode, tenantSlug) {
  const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

  const db = new Database(dbPath);
  const rowClientId = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_client_id'").get();
  const clientId = rowClientId ? rowClientId.value : null;
  const rowClientSecret = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_client_secret'").get();
  const clientSecret = rowClientSecret ? rowClientSecret.value : null;
  const rowRedirectUri = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_redirect_uri'").get();
  const redirectUri = rowRedirectUri ? rowRedirectUri.value : null;
  db.close();

  if (!clientId || !clientSecret) {
    throw new Error('لم يتم العثور على بيانات الاعتماد');
  }
  if (!redirectUri) {
    throw new Error('لم يتم العثور على redirect_uri - أعد إدخال بيانات الاعتماد');
  }

  const tokenData = querystring.stringify({
    code: authCode,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const response = await httpsRequest(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenData
  });

  const tokens = JSON.parse(response.body);
  if (!tokens.access_token) {
    throw new Error('فشل الحصول على التوكن');
  }

  const db2 = new Database(dbPath);
  db2.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'gdrive_access_token', tokens.access_token, new Date().toISOString()
  );
  db2.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'gdrive_refresh_token', tokens.refresh_token || '', new Date().toISOString()
  );
  db2.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'gdrive_token_expiry', String(Date.now() / 1000 + (tokens.expires_in || 3600)), new Date().toISOString()
  );
  db2.close();

  return tokens;
}

// ===== Helper: find or create Google Drive folder =====
async function gdriveFindOrCreateFolder(token, tenantSlug) {
  const folderName = tenantSlug ? `POS-Backups-${tenantSlug}` : 'POS-Backups';
  try {
    const query = encodeURIComponent(`name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const response = await httpsRequest(`${GOOGLE_DRIVE_FILES_URL}?q=${query}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = JSON.parse(response.body);
    if (result.files && result.files.length > 0) {
      return result.files[0].id;
    }

    // Create folder
    const metadata = JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    });
    const createResponse = await httpsRequest(GOOGLE_DRIVE_FILES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: metadata
    });
    const createResult = JSON.parse(createResponse.body);
    return createResult.id || null;
  } catch (e) {
    return null;
  }
}

// ===== Helper: cleanup old backups =====
function cleanupOldBackups(tenantSlug, keepDays) {
  const backupDir = getBackupDir(tenantSlug);
  const cutoff = Date.now() - (keepDays * 86400 * 1000);
  if (fs.existsSync(backupDir)) {
    const files = fs.readdirSync(backupDir);
    for (const f of files) {
      if (f.endsWith('.db')) {
        const fpath = path.join(backupDir, f);
        const stat = fs.statSync(fpath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fpath);
          console.log(`[Backup Cleanup] تم حذف نسخة قديمة: ${f}`);
        }
      }
    }
  }
}


module.exports = function(app, helpers) {
  // Assign helpers to module-level variables
  getDb = helpers.getDb;
  getMasterDb = helpers.getMasterDb;
  hashPassword = helpers.hashPassword;
  getBackupDir = helpers.getBackupDir;
  createBackupFile = helpers.createBackupFile;
  createTenantDatabase = helpers.createTenantDatabase;
  upload = helpers.upload;
  DB_PATH = helpers.DB_PATH;
  TENANTS_DB_DIR = helpers.TENANTS_DB_DIR;
  BACKUPS_DIR = helpers.BACKUPS_DIR;

  // ===================================================================
  // ===== Restaurant Tables API =====
  // ===================================================================

  // GET /api/tables
  app.get('/api/tables', (req, res) => {
    try {
      const db = getDb(req);
      const tables = db.prepare(`
        SELECT rt.*, i.invoice_number, i.total as invoice_total, i.customer_name as invoice_customer
        FROM restaurant_tables rt
        LEFT JOIN invoices i ON rt.current_invoice_id = i.id
        ORDER BY rt.id
      `).all();
      return res.json({ success: true, tables });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/tables
  app.post('/api/tables', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO restaurant_tables (name, seats, pos_x, pos_y)
        VALUES (?, ?, ?, ?)
      `).run(
        data.name || 'طاولة',
        data.seats || 4,
        data.pos_x || 50,
        data.pos_y || 50
      );
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/tables/:table_id
  app.put('/api/tables/:table_id', (req, res) => {
    try {
      const tableId = req.params.table_id;
      const data = req.body;
      const db = getDb(req);
      const fields = [];
      const values = [];
      for (const key of ['name', 'seats', 'pos_x', 'pos_y', 'status', 'current_invoice_id']) {
        if (key in data) {
          fields.push(`${key} = ?`);
          values.push(data[key]);
        }
      }
      if (fields.length > 0) {
        values.push(tableId);
        db.prepare(`UPDATE restaurant_tables SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/tables/:table_id
  app.delete('/api/tables/:table_id', (req, res) => {
    try {
      const tableId = req.params.table_id;
      const db = getDb(req);
      db.prepare('DELETE FROM restaurant_tables WHERE id = ?').run(tableId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/tables/:table_id/assign
  app.post('/api/tables/:table_id/assign', (req, res) => {
    try {
      const tableId = req.params.table_id;
      const data = req.body;
      const invoiceId = data.invoice_id;
      const db = getDb(req);
      db.prepare('UPDATE restaurant_tables SET status = ?, current_invoice_id = ? WHERE id = ?')
        .run('occupied', invoiceId, tableId);
      if (invoiceId) {
        const tbl = db.prepare('SELECT name FROM restaurant_tables WHERE id = ?').get(tableId);
        const tableName = tbl ? tbl.name : '';
        db.prepare('UPDATE invoices SET table_id = ?, table_name = ? WHERE id = ?')
          .run(tableId, tableName, invoiceId);
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/tables/:table_id/release
  app.post('/api/tables/:table_id/release', (req, res) => {
    try {
      const tableId = req.params.table_id;
      const db = getDb(req);
      db.prepare('UPDATE restaurant_tables SET status = ?, current_invoice_id = NULL WHERE id = ?')
        .run('available', tableId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/tables/:table_id/reserve
  app.post('/api/tables/:table_id/reserve', (req, res) => {
    try {
      const tableId = req.params.table_id;
      const db = getDb(req);
      const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(tableId);
      if (!table) {
        return res.status(404).json({ success: false, error: 'الطاولة غير موجودة' });
      }
      if (table.status === 'occupied') {
        return res.status(400).json({ success: false, error: 'لا يمكن حجز طاولة مشغولة' });
      }
      db.prepare('UPDATE restaurant_tables SET status = ? WHERE id = ?')
        .run('reserved', tableId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===================================================================
  // ===== Coupons API =====
  // ===================================================================

  // GET /api/coupons
  app.get('/api/coupons', (req, res) => {
    try {
      const db = getDb(req);
      const coupons = db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
      return res.json({ success: true, coupons });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/coupons
  app.post('/api/coupons', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO coupons (code, discount_type, discount_value, min_amount, max_uses, expiry_date, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        (data.code || '').toUpperCase(),
        data.discount_type || 'amount',
        data.discount_value || 0,
        data.min_amount || 0,
        data.max_uses || 0,
        data.expiry_date || '',
        data.notes || ''
      );
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ success: false, error: 'كود الكوبون موجود مسبقاً' });
      }
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/coupons/:coupon_id
  app.put('/api/coupons/:coupon_id', (req, res) => {
    try {
      const couponId = req.params.coupon_id;
      const data = req.body;
      const db = getDb(req);
      db.prepare(`
        UPDATE coupons SET code=?, discount_type=?, discount_value=?, min_amount=?,
               max_uses=?, is_active=?, expiry_date=?, notes=?
        WHERE id=?
      `).run(
        (data.code || '').toUpperCase(),
        data.discount_type || 'amount',
        data.discount_value || 0,
        data.min_amount || 0,
        data.max_uses || 0,
        data.is_active !== undefined ? data.is_active : 1,
        data.expiry_date || '',
        data.notes || '',
        couponId
      );
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/coupons/:coupon_id
  app.delete('/api/coupons/:coupon_id', (req, res) => {
    try {
      const couponId = req.params.coupon_id;
      const db = getDb(req);
      db.prepare('DELETE FROM coupons WHERE id = ?').run(couponId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/coupons/validate
  app.post('/api/coupons/validate', (req, res) => {
    try {
      const data = req.body;
      const code = (data.code || '').toUpperCase();
      const subtotal = data.subtotal || 0;
      const db = getDb(req);
      const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);

      if (!coupon) {
        return res.json({ success: false, error: 'كود الكوبون غير صحيح' });
      }
      if (!coupon.is_active) {
        return res.json({ success: false, error: 'الكوبون غير مفعّل' });
      }
      if (coupon.expiry_date && coupon.expiry_date < new Date().toISOString().slice(0, 10)) {
        return res.json({ success: false, error: 'الكوبون منتهي الصلاحية' });
      }
      if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) {
        return res.json({ success: false, error: 'تم استخدام الكوبون الحد الأقصى من المرات' });
      }
      if (subtotal < coupon.min_amount) {
        return res.json({ success: false, error: `الحد الأدنى للطلب ${coupon.min_amount.toFixed(3)} د.ك` });
      }

      // Calculate discount
      let discount;
      if (coupon.discount_type === 'percent') {
        discount = subtotal * (coupon.discount_value / 100);
      } else {
        discount = coupon.discount_value;
      }

      return res.json({ success: true, discount: Math.round(discount * 1000) / 1000, coupon });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/coupons/use
  app.post('/api/coupons/use', (req, res) => {
    try {
      const data = req.body;
      const code = (data.code || '').toUpperCase();
      const db = getDb(req);
      db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?').run(code);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===================================================================
  // ===== Suppliers API =====
  // ===================================================================

  // GET /api/suppliers
  app.get('/api/suppliers', (req, res) => {
    try {
      const db = getDb(req);
      const suppliers = db.prepare(`
        SELECT s.*,
               (SELECT COUNT(*) FROM supplier_invoices WHERE supplier_id = s.id) as invoice_count,
               (SELECT SUM(amount) FROM supplier_invoices WHERE supplier_id = s.id) as total_amount
        FROM suppliers s ORDER BY s.created_at DESC
      `).all();
      return res.json({ success: true, suppliers });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/suppliers
  app.post('/api/suppliers', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO suppliers (name, phone, email, address, company, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        data.name,
        data.phone || '',
        data.email || '',
        data.address || '',
        data.company || '',
        data.notes || ''
      );
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/suppliers/:supplier_id
  app.put('/api/suppliers/:supplier_id', (req, res) => {
    try {
      const supplierId = req.params.supplier_id;
      const data = req.body;
      const db = getDb(req);
      db.prepare(`
        UPDATE suppliers SET name=?, phone=?, email=?, address=?, company=?, notes=?
        WHERE id=?
      `).run(
        data.name,
        data.phone || '',
        data.email || '',
        data.address || '',
        data.company || '',
        data.notes || '',
        supplierId
      );
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/suppliers/:supplier_id
  app.delete('/api/suppliers/:supplier_id', (req, res) => {
    try {
      const supplierId = req.params.supplier_id;
      const db = getDb(req);
      db.prepare('DELETE FROM supplier_invoices WHERE supplier_id = ?').run(supplierId);
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(supplierId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/suppliers/:supplier_id/invoices
  app.get('/api/suppliers/:supplier_id/invoices', (req, res) => {
    try {
      const supplierId = req.params.supplier_id;
      const db = getDb(req);
      const invoices = db.prepare(
        'SELECT id, supplier_id, invoice_number, amount, file_name, file_type, notes, invoice_date, created_at FROM supplier_invoices WHERE supplier_id = ? ORDER BY created_at DESC'
      ).all(supplierId);
      return res.json({ success: true, invoices });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/suppliers/invoices
  app.post('/api/suppliers/invoices', (req, res) => {
    try {
      const data = req.body;
      const fileData = data.file_data || '';

      // Check file size (1 MB ~ 1.37 MB base64)
      if (fileData && fileData.length > 1400000) {
        return res.status(400).json({ success: false, error: 'حجم الملف يتجاوز 1 ميجابايت' });
      }

      const db = getDb(req);
      const result = db.prepare(`
        INSERT INTO supplier_invoices (supplier_id, invoice_number, amount, file_name, file_data, file_type, notes, invoice_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.supplier_id,
        data.invoice_number || '',
        data.amount || 0,
        data.file_name || '',
        fileData,
        data.file_type || '',
        data.notes || '',
        data.invoice_date || ''
      );
      return res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/suppliers/invoices/:invoice_id
  app.delete('/api/suppliers/invoices/:invoice_id', (req, res) => {
    try {
      const invoiceId = req.params.invoice_id;
      const db = getDb(req);
      db.prepare('DELETE FROM supplier_invoices WHERE id = ?').run(invoiceId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/suppliers/invoices/:invoice_id/file
  app.get('/api/suppliers/invoices/:invoice_id/file', (req, res) => {
    try {
      const invoiceId = req.params.invoice_id;
      const db = getDb(req);
      const row = db.prepare('SELECT file_data, file_name, file_type FROM supplier_invoices WHERE id = ?').get(invoiceId);
      if (row) {
        return res.json({ success: true, file_data: row.file_data, file_name: row.file_name, file_type: row.file_type });
      }
      return res.status(404).json({ success: false, error: 'الملف غير موجود' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===================================================================
  // ===== Multi-Tenancy Super Admin API =====
  // ===================================================================

  // POST /api/super-admin/login
  app.post('/api/super-admin/login', (req, res) => {
    try {
      const data = req.body;
      const username = data.username || '';
      const password = data.password || '';
      const db = getMasterDb();
      const admin = db.prepare('SELECT * FROM super_admins WHERE username = ? AND password = ?')
        .get(username, hashPassword(password));
      if (admin) {
        return res.json({
          success: true,
          admin: {
            id: admin.id,
            username: admin.username,
            full_name: admin.full_name,
            role: 'super_admin'
          }
        });
      }
      return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/super-admin/tenants
  app.get('/api/super-admin/tenants', (req, res) => {
    try {
      const db = getMasterDb();
      const tenants = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();

      // Add stats for each tenant
      for (const tenant of tenants) {
        try {
          const tDb = new Database(tenant.db_path);
          tenant.users_count = tDb.prepare('SELECT COUNT(*) as c FROM users').get().c;
          tenant.invoices_count = tDb.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
          tenant.products_count = tDb.prepare('SELECT COUNT(*) as c FROM products').get().c;
          tDb.close();
        } catch (e2) {
          tenant.users_count = 0;
          tenant.invoices_count = 0;
          tenant.products_count = 0;
        }
      }

      return res.json({ success: true, tenants });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/super-admin/tenants
  app.post('/api/super-admin/tenants', (req, res) => {
    try {
      const data = req.body;
      const name = (data.name || '').trim();
      let slug = (data.slug || '').trim().toLowerCase();
      const ownerName = (data.owner_name || '').trim();
      const ownerEmail = (data.owner_email || '').trim();
      const ownerPhone = (data.owner_phone || '').trim();
      const adminUsername = (data.admin_username || 'admin').trim();
      const adminPassword = (data.admin_password || 'admin123').trim();
      const plan = data.plan || 'basic';
      const maxUsers = data.max_users || 5;
      const maxBranches = data.max_branches || 3;
      const subscriptionAmount = data.subscription_amount || 0;
      const subscriptionPeriod = data.subscription_period || 30;

      if (!name || !slug || !ownerName) {
        return res.status(400).json({ success: false, error: 'الاسم والمعرف واسم المالك مطلوبة' });
      }

      // Clean slug
      slug = slug.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) {
        return res.status(400).json({ success: false, error: 'المعرف (slug) غير صالح' });
      }

      const dbPath = getTenantDbPath(slug);

      // Check slug uniqueness
      const db = getMasterDb();
      const existing = db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
      if (existing) {
        return res.status(400).json({ success: false, error: 'هذا المعرف مستخدم بالفعل' });
      }

      // Create tenant database
      createTenantDatabase(slug);

      // Add admin user for the tenant
      const tDb = new Database(dbPath);
      tDb.prepare(`
        INSERT INTO users (username, password, full_name, role, invoice_prefix, is_active, branch_id)
        VALUES (?, ?, ?, 'admin', 'INV', 1, 1)
      `).run(adminUsername, adminPassword, ownerName);
      tDb.close();

      // Register tenant in master database
      const result = db.prepare(`
        INSERT INTO tenants (name, slug, owner_name, owner_email, owner_phone, db_path, plan, max_users, max_branches, subscription_amount, subscription_period)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, slug, ownerName, ownerEmail, ownerPhone, dbPath, plan, maxUsers, maxBranches, subscriptionAmount, subscriptionPeriod);

      return res.json({ success: true, id: Number(result.lastInsertRowid), slug });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/super-admin/tenants/:tenant_id
  app.put('/api/super-admin/tenants/:tenant_id', (req, res) => {
    try {
      const tenantId = req.params.tenant_id;
      const data = req.body;
      const db = getMasterDb();
      const fields = [];
      const values = [];
      for (const key of ['name', 'owner_name', 'owner_email', 'owner_phone', 'is_active', 'plan', 'max_users', 'max_branches', 'expires_at', 'subscription_amount', 'subscription_period']) {
        if (key in data) {
          fields.push(`${key} = ?`);
          values.push(data[key]);
        }
      }
      if (fields.length > 0) {
        values.push(tenantId);
        db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/super-admin/tenants/:tenant_id
  app.delete('/api/super-admin/tenants/:tenant_id', (req, res) => {
    try {
      const tenantId = req.params.tenant_id;
      const db = getMasterDb();
      const tenant = db.prepare('SELECT db_path, slug FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, error: 'المستأجر غير موجود' });
      }

      // Delete tenant database file
      const dbPath = tenant.db_path;
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }

      db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/super-admin/tenants/:tenant_id/stats
  app.get('/api/super-admin/tenants/:tenant_id/stats', (req, res) => {
    try {
      const tenantId = req.params.tenant_id;
      const db = getMasterDb();
      const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, error: 'المستأجر غير موجود' });
      }

      const tDb = new Database(tenant.db_path);
      const stats = {};
      stats.users_count = tDb.prepare('SELECT COUNT(*) as c FROM users').get().c;
      stats.invoices_count = tDb.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
      stats.products_count = tDb.prepare('SELECT COUNT(*) as c FROM products').get().c;
      stats.customers_count = tDb.prepare('SELECT COUNT(*) as c FROM customers').get().c;
      stats.total_sales = tDb.prepare('SELECT COALESCE(SUM(total), 0) as t FROM invoices').get().t;
      stats.branches_count = tDb.prepare('SELECT COUNT(*) as c FROM branches').get().c;
      tDb.close();

      return res.json({ success: true, stats, tenant });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/super-admin/subscriptions/:tenant_id
  app.get('/api/super-admin/subscriptions/:tenant_id', (req, res) => {
    try {
      const tenantId = req.params.tenant_id;
      const db = getMasterDb();
      const invoices = db.prepare('SELECT * FROM subscription_invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
      return res.json({ success: true, invoices });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/super-admin/subscriptions
  app.post('/api/super-admin/subscriptions', (req, res) => {
    try {
      const data = req.body;
      const tenantId = data.tenant_id;
      const amount = parseFloat(data.amount || 0);
      const periodDays = parseInt(data.period_days || 30);
      const notes = data.notes || '';
      const paymentMethod = data.payment_method || 'cash';

      if (!tenantId || amount <= 0 || periodDays <= 0) {
        return res.status(400).json({ success: false, error: 'بيانات الفاتورة غير مكتملة' });
      }

      const db = getMasterDb();
      const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, error: 'المستأجر غير موجود' });
      }

      // Calculate start and end dates
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let startDate = new Date(today);

      // If subscription is still active, add from current expiry date
      if (tenant.expires_at) {
        try {
          const currentExpiry = new Date(tenant.expires_at.substring(0, 10));
          if (currentExpiry > today) {
            startDate = currentExpiry;
          }
        } catch (e2) {
          // keep startDate as today
        }
      }

      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + periodDays);

      const startDateStr = startDate.toISOString().slice(0, 10);
      const endDateStr = endDate.toISOString().slice(0, 10);

      // Create subscription invoice
      const result = db.prepare(`
        INSERT INTO subscription_invoices (tenant_id, amount, period_days, start_date, end_date, notes, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(tenantId, amount, periodDays, startDateStr, endDateStr, notes, paymentMethod);

      // Update expiry date and activate store
      db.prepare('UPDATE tenants SET expires_at = ?, is_active = 1 WHERE id = ?')
        .run(endDateStr, tenantId);

      return res.json({
        success: true,
        id: Number(result.lastInsertRowid),
        start_date: startDateStr,
        end_date: endDateStr
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/super-admin/subscriptions/:invoice_id
  app.delete('/api/super-admin/subscriptions/:invoice_id', (req, res) => {
    try {
      const invoiceId = req.params.invoice_id;
      const db = getMasterDb();
      db.prepare('DELETE FROM subscription_invoices WHERE id = ?').run(invoiceId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/super-admin/change-password
  app.post('/api/super-admin/change-password', (req, res) => {
    try {
      const data = req.body;
      const adminId = data.admin_id;
      const oldPassword = data.old_password || '';
      const newPassword = data.new_password || '';
      const newUsername = (data.new_username || '').trim();
      const newFullName = (data.new_full_name || '').trim();

      const db = getMasterDb();
      const admin = db.prepare('SELECT * FROM super_admins WHERE id = ? AND password = ?')
        .get(adminId, hashPassword(oldPassword));
      if (!admin) {
        return res.status(400).json({ success: false, error: 'كلمة المرور القديمة غير صحيحة' });
      }

      // Update password
      if (newPassword) {
        db.prepare('UPDATE super_admins SET password = ? WHERE id = ?')
          .run(hashPassword(newPassword), adminId);
      }

      // Update username
      if (newUsername && newUsername !== admin.username) {
        const existingUser = db.prepare('SELECT id FROM super_admins WHERE username = ? AND id != ?').get(newUsername, adminId);
        if (existingUser) {
          return res.status(400).json({ success: false, error: 'اسم المستخدم مستخدم بالفعل' });
        }
        db.prepare('UPDATE super_admins SET username = ? WHERE id = ?').run(newUsername, adminId);
      }

      // Update full name
      if (newFullName) {
        db.prepare('UPDATE super_admins SET full_name = ? WHERE id = ?').run(newFullName, adminId);
      }

      // Return updated data
      const updated = db.prepare('SELECT id, username, full_name FROM super_admins WHERE id = ?').get(adminId);
      return res.json({
        success: true,
        admin: {
          id: updated.id,
          username: updated.username,
          full_name: updated.full_name,
          role: 'super_admin'
        }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/super-admin/backup/tenant/:tenant_id
  app.post('/api/super-admin/backup/tenant/:tenant_id', (req, res) => {
    try {
      const tenantId = req.params.tenant_id;
      const db = getMasterDb();
      const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, error: 'المتجر غير موجود' });
      }
      const slug = tenant.slug;
      const { backupInfo, error } = createBackupFile(getTenantDbPath(slug), getBackupDir(req), slug);
      if (error) {
        return res.status(500).json({ success: false, error });
      }
      backupInfo.tenant_name = tenant.name;
      return res.json({ success: true, backup: backupInfo });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/super-admin/backup/all
  app.post('/api/super-admin/backup/all', (req, res) => {
    try {
      const db = getMasterDb();
      const tenants = db.prepare('SELECT * FROM tenants WHERE is_active = 1 ORDER BY id').all();

      const results = [];
      const errors = [];

      // Backup default database
      const defaultResult = createBackupFile(DB_PATH, getBackupDir(req), 'default');
      if (defaultResult.error) {
        errors.push({ tenant: 'default', error: defaultResult.error });
      } else {
        defaultResult.backupInfo.tenant_name = 'القاعدة الرئيسية';
        results.push(defaultResult.backupInfo);
      }

      // Backup each tenant
      for (const tenant of tenants) {
        const tenantResult = createBackupFile(getTenantDbPath(tenant.slug), getBackupDir(req), tenant.slug);
        if (tenantResult.error) {
          errors.push({ tenant: tenant.name, error: tenantResult.error });
        } else {
          tenantResult.backupInfo.tenant_name = tenant.name;
          results.push(tenantResult.backupInfo);
        }
      }

      return res.json({
        success: true,
        backups: results,
        errors,
        total: results.length,
        failed: errors.length
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/super-admin/backup/list
  app.get('/api/super-admin/backup/list', (req, res) => {
    try {
      const db = getMasterDb();
      const tenants = db.prepare('SELECT id, name, slug FROM tenants ORDER BY id').all();

      const allBackups = {};

      // Default database backups
      const defaultDir = getBackupDir(req);
      const defaultBackups = [];
      if (fs.existsSync(defaultDir)) {
        const files = fs.readdirSync(defaultDir).sort().reverse();
        for (const f of files) {
          if (f.endsWith('.db')) {
            const fp = path.join(defaultDir, f);
            const stat = fs.statSync(fp);
            defaultBackups.push({
              filename: f,
              size: stat.size,
              created_at: new Date(stat.mtimeMs).toISOString()
            });
          }
        }
      }
      allBackups['default'] = { name: 'القاعدة الرئيسية', backups: defaultBackups };

      // Each tenant's backups
      for (const tenant of tenants) {
        const tenantDir = getBackupDir(req, tenant.slug);
        const tenantBackups = [];
        if (fs.existsSync(tenantDir)) {
          const files = fs.readdirSync(tenantDir).sort().reverse();
          for (const f of files) {
            if (f.endsWith('.db')) {
              const fp = path.join(tenantDir, f);
              const stat = fs.statSync(fp);
              tenantBackups.push({
                filename: f,
                size: stat.size,
                created_at: new Date(stat.mtimeMs).toISOString()
              });
            }
          }
        }
        allBackups[tenant.slug] = { name: tenant.name, backups: tenantBackups };
      }

      return res.json({ success: true, all_backups: allBackups });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===================================================================
  // ===== Backup System API =====
  // ===================================================================

  // POST /api/backup/create
  app.post('/api/backup/create', (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;
      const backupDir = getBackupDir(req);
      const { backupInfo, error } = createBackupFile(dbPath, backupDir, tenantSlug || 'default');
      if (error) {
        return res.status(500).json({ success: false, error });
      }
      return res.json({ success: true, backup: backupInfo });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/backup/list
  app.get('/api/backup/list', (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const backupDir = getBackupDir(req);
      const backups = [];

      if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir).sort().reverse();
        for (const f of files) {
          if (f.endsWith('.db')) {
            const fpath = path.join(backupDir, f);
            const stat = fs.statSync(fpath);
            backups.push({
              filename: f,
              size: stat.size,
              created_at: new Date(stat.mtimeMs).toISOString()
            });
          }
        }
      }

      // Get schedule settings
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;
      const schedule = { enabled: false, time: '03:00', keep_days: 30, gdrive_auto: false };
      try {
        const db = new Database(dbPath);
        const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'backup_%'").all();
        for (const row of rows) {
          const k = row.key.replace('backup_', '');
          if (k === 'schedule_enabled') {
            schedule.enabled = row.value === 'true';
          } else if (k === 'schedule_time') {
            schedule.time = row.value;
          } else if (k === 'keep_days') {
            schedule.keep_days = parseInt(row.value);
          } else if (k === 'gdrive_auto') {
            schedule.gdrive_auto = row.value === 'true';
          }
        }
        db.close();
      } catch (e2) {
        // ignore
      }

      return res.json({ success: true, backups, schedule });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/backup/download/:filename
  app.get('/api/backup/download/:filename', (req, res) => {
    try {
      const filename = req.params.filename;
      // Prevent path traversal
      const safeFilename = filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
      if (safeFilename !== filename || filename.includes('..')) {
        return res.status(400).json({ success: false, error: 'اسم ملف غير صالح' });
      }

      const backupDir = getBackupDir(req);
      const filepath = path.join(backupDir, safeFilename);

      if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'الملف غير موجود' });
      }

      return res.download(filepath, safeFilename);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/backup/delete/:filename
  app.delete('/api/backup/delete/:filename', (req, res) => {
    try {
      const filename = req.params.filename;
      const safeFilename = filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
      if (safeFilename !== filename || filename.includes('..')) {
        return res.status(400).json({ success: false, error: 'اسم ملف غير صالح' });
      }

      const backupDir = getBackupDir(req);
      const filepath = path.join(backupDir, safeFilename);

      if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'الملف غير موجود' });
      }

      fs.unlinkSync(filepath);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/backup/restore (with multer for file upload)
  app.post('/api/backup/restore', upload.single('file'), (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      if (req.file) {
        // File upload restore
        if (!req.file.originalname.endsWith('.db')) {
          // Clean up uploaded file
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ success: false, error: 'يجب أن يكون الملف بصيغة .db' });
        }

        // Create backup before restore
        const backupDir = getBackupDir(req);
        createBackupFile(dbPath, backupDir, tenantSlug || 'default');

        const tmpPath = req.file.path;

        // Validate the database file
        try {
          const testDb = new Database(tmpPath, { readonly: true });
          testDb.prepare('SELECT count(*) FROM sqlite_master').get();
          testDb.close();
        } catch (e2) {
          fs.unlinkSync(tmpPath);
          return res.status(400).json({ success: false, error: 'الملف ليس قاعدة بيانات صالحة' });
        }

        // Restore: copy uploaded file over existing database
        // Use better-sqlite3 backup API
        const source = new Database(tmpPath, { readonly: true });
        source.backup(dbPath).then(() => {
          source.close();
          fs.unlinkSync(tmpPath);
          return res.json({ success: true, message: 'تمت الاستعادة بنجاح. تم إنشاء نسخة احتياطية تلقائية قبل الاستعادة.' });
        }).catch((err) => {
          source.close();
          fs.unlinkSync(tmpPath);
          return res.status(500).json({ success: false, error: err.message });
        });

      } else if (req.body && req.body.filename) {
        // Restore from existing backup file
        const filename = req.body.filename;
        const safeFilename = filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
        const backupDir = getBackupDir(req);
        const filepath = path.join(backupDir, safeFilename);

        if (!fs.existsSync(filepath)) {
          return res.status(404).json({ success: false, error: 'النسخة الاحتياطية غير موجودة' });
        }

        // Create backup before restore
        createBackupFile(dbPath, backupDir, tenantSlug || 'default');

        // Restore using better-sqlite3 backup
        const source = new Database(filepath, { readonly: true });
        source.backup(dbPath).then(() => {
          source.close();
          return res.json({ success: true, message: 'تمت الاستعادة بنجاح. تم إنشاء نسخة احتياطية تلقائية قبل الاستعادة.' });
        }).catch((err) => {
          source.close();
          return res.status(500).json({ success: false, error: err.message });
        });

      } else {
        return res.status(400).json({ success: false, error: 'لم يتم تحديد ملف' });
      }
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/backup/schedule
  app.put('/api/backup/schedule', (req, res) => {
    try {
      const data = req.body;
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const db = new Database(dbPath);
      const settings = {
        backup_schedule_enabled: data.enabled ? 'true' : 'false',
        backup_schedule_time: data.time || '03:00',
        backup_keep_days: String(data.keep_days || 30),
        backup_gdrive_auto: data.gdrive_auto ? 'true' : 'false'
      };

      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
      for (const [key, value] of Object.entries(settings)) {
        stmt.run(key, value, new Date().toISOString());
      }
      db.close();

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===================================================================
  // ===== Google Drive Integration API =====
  // ===================================================================

  // POST /api/backup/gdrive/save-credentials
  app.post('/api/backup/gdrive/save-credentials', (req, res) => {
    try {
      const data = req.body;
      const clientId = (data.client_id || '').trim();
      const clientSecret = (data.client_secret || '').trim();
      const baseUrl = (data.base_url || '').trim().replace(/\/+$/, '');

      if (!clientId || !clientSecret) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال Client ID و Client Secret' });
      }

      // Build redirect_uri from app URL
      const redirectUri = baseUrl
        ? `${baseUrl}/api/backup/gdrive/callback`
        : `${req.protocol}://${req.get('host')}/api/backup/gdrive/callback`;

      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const db = new Database(dbPath);
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
      stmt.run('gdrive_client_id', clientId, new Date().toISOString());
      stmt.run('gdrive_client_secret', clientSecret, new Date().toISOString());
      stmt.run('gdrive_redirect_uri', redirectUri, new Date().toISOString());
      db.close();

      // Build auth URL with tenant_slug in state
      const params = querystring.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_DRIVE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state: tenantSlug || ''
      });
      const authUrl = `${GOOGLE_OAUTH_AUTH_URL}?${params}`;

      return res.json({ success: true, auth_url: authUrl, redirect_uri: redirectUri });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/backup/gdrive/callback
  app.get('/api/backup/gdrive/callback', async (req, res) => {
    const authCode = req.query.code || '';
    const error = req.query.error || '';

    if (error) {
      return res.status(400).send(`<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>خطأ في ربط Google Drive</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#ef4444;">❌ فشل ربط Google Drive</h2>
<p>الخطأ: ${error}</p>
<p>يمكنك إغلاق هذه النافذة والمحاولة مرة أخرى.</p>
<script>setTimeout(function(){ window.close(); }, 5000);</script>
</body></html>`);
    }

    if (!authCode) {
      return res.status(400).send(`<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>خطأ</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#ef4444;">❌ لم يتم استلام كود التفويض</h2>
<p>يمكنك إغلاق هذه النافذة والمحاولة مرة أخرى.</p>
</body></html>`);
    }

    try {
      // Extract tenant_slug from state parameter (callback redirect has no X-Tenant-ID header)
      const tenantSlug = (req.query.state || '').trim();
      await gdriveExchangeCode(authCode, tenantSlug);

      return res.send(`<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>تم ربط Google Drive</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#22c55e;">✅ تم ربط Google Drive بنجاح!</h2>
<p>سيتم إغلاق هذه النافذة تلقائياً...</p>
<script>
if (window.opener) { window.opener.postMessage('gdrive_connected', '*'); }
setTimeout(function(){ window.close(); }, 2000);
</script>
</body></html>`);
    } catch (e) {
      const errorMsg = e.body || e.message;
      return res.status(400).send(`<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>خطأ</title></head>
<body style="font-family:sans-serif;text-align:center;padding:50px;">
<h2 style="color:#ef4444;">❌ فشل ربط Google Drive</h2>
<p>${errorMsg}</p>
<script>setTimeout(function(){ window.close(); }, 8000);</script>
</body></html>`);
    }
  });

  // POST /api/backup/gdrive/connect
  app.post('/api/backup/gdrive/connect', async (req, res) => {
    try {
      const data = req.body;
      const authCode = (data.code || '').trim();

      if (!authCode) {
        return res.status(400).json({ success: false, error: 'يرجى إدخال كود التفويض' });
      }

      const tenantSlug = getTenantSlug(req);
      await gdriveExchangeCode(authCode, tenantSlug);

      return res.json({ success: true, message: 'تم ربط Google Drive بنجاح' });
    } catch (e) {
      if (e.statusCode) {
        return res.status(400).json({ success: false, error: `خطأ من Google: ${e.body}` });
      }
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/backup/gdrive/status
  app.get('/api/backup/gdrive/status', (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const db = new Database(dbPath);
      const rowToken = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_refresh_token'").get();
      const hasToken = !!(rowToken && rowToken.value);

      const rowCreds = db.prepare("SELECT value FROM settings WHERE key = 'gdrive_client_id'").get();
      const hasCredentials = !!(rowCreds && rowCreds.value);
      db.close();

      return res.json({
        success: true,
        connected: hasToken,
        has_credentials: hasCredentials
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/backup/gdrive/disconnect
  app.post('/api/backup/gdrive/disconnect', (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const db = new Database(dbPath);
      const keys = ['gdrive_client_id', 'gdrive_client_secret', 'gdrive_access_token', 'gdrive_refresh_token', 'gdrive_token_expiry'];
      const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
      for (const key of keys) {
        stmt.run(key);
      }
      db.close();

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/backup/gdrive/upload
  app.post('/api/backup/gdrive/upload', async (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const token = await getGdriveToken(dbPath);
      if (!token) {
        return res.status(400).json({ success: false, error: 'Google Drive غير متصل. يرجى الربط أولاً.' });
      }

      const data = req.body || {};
      const filename = data.filename;
      let filepath;
      let safeFilename;

      if (filename) {
        safeFilename = filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
        const backupDir = getBackupDir(req);
        filepath = path.join(backupDir, safeFilename);
        if (!fs.existsSync(filepath)) {
          return res.status(404).json({ success: false, error: 'الملف غير موجود' });
        }
      } else {
        // Create a new backup and upload it
        const backupDir = getBackupDir(req);
        const { backupInfo, error } = createBackupFile(dbPath, backupDir, tenantSlug || 'default');
        if (error) {
          return res.status(500).json({ success: false, error });
        }
        filepath = backupInfo.path;
        safeFilename = backupInfo.filename;
      }

      // Find or create POS-Backups folder in Google Drive
      const folderId = await gdriveFindOrCreateFolder(token, tenantSlug);

      // Upload the file
      const storeName = tenantSlug || 'default';
      const uploadName = `POS_${storeName}_${safeFilename}`;

      const boundary = '----BackupBoundary';
      const metadata = JSON.stringify({
        name: uploadName,
        parents: folderId ? [folderId] : []
      });

      const fileData = fs.readFileSync(filepath);

      const bodyParts = [
        `--${boundary}\r\n`,
        `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
        `${metadata}\r\n`,
        `--${boundary}\r\n`,
        `Content-Type: application/x-sqlite3\r\n\r\n`
      ];
      const bodyPrefix = Buffer.from(bodyParts.join(''));
      const bodySuffix = Buffer.from(`\r\n--${boundary}--`);
      const body = Buffer.concat([bodyPrefix, fileData, bodySuffix]);

      const response = await httpsRequestBinary(`${GOOGLE_DRIVE_UPLOAD_URL}?uploadType=multipart`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': body.length
        },
        body
      });

      const result = JSON.parse(response.body);

      return res.json({
        success: true,
        message: 'تم رفع النسخة إلى Google Drive بنجاح',
        file_id: result.id,
        file_name: uploadName
      });
    } catch (e) {
      if (e.statusCode === 401) {
        return res.status(401).json({ success: false, error: 'انتهت صلاحية التوكن. يرجى إعادة ربط Google Drive.' });
      }
      if (e.statusCode) {
        return res.status(500).json({ success: false, error: `خطأ في Google Drive: ${e.body}` });
      }
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/backup/gdrive/files
  app.get('/api/backup/gdrive/files', async (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const token = await getGdriveToken(dbPath);
      if (!token) {
        return res.status(400).json({ success: false, error: 'Google Drive غير متصل' });
      }

      const query = encodeURIComponent("name contains 'POS_' and trashed=false");
      const response = await httpsRequest(
        `${GOOGLE_DRIVE_FILES_URL}?q=${query}&orderBy=createdTime desc&fields=files(id,name,size,createdTime)`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      const result = JSON.parse(response.body);
      const files = [];
      for (const f of (result.files || [])) {
        files.push({
          id: f.id,
          name: f.name,
          size: parseInt(f.size || 0),
          created_at: f.createdTime || ''
        });
      }

      return res.json({ success: true, files });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===================================================================
  // ===== Admin Dashboard API =====
  // ===================================================================

  // GET /api/admin-dashboard/invoices-summary
  app.get('/api/admin-dashboard/invoices-summary', (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const db = new Database(dbPath);

      // Invoices summary per branch
      const branchesSummary = db.prepare(`
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
      `).all();

      // Overall summary
      const overall = db.prepare(`
        SELECT
            COUNT(id) as total_invoices,
            COALESCE(SUM(total), 0) as total_sales,
            COUNT(CASE WHEN cancelled = 1 THEN 1 END) as cancelled_invoices,
            COUNT(CASE WHEN DATE(created_at) = DATE('now') THEN 1 END) as today_invoices,
            COALESCE(SUM(CASE WHEN DATE(created_at) = DATE('now') THEN total ELSE 0 END), 0) as today_sales
        FROM invoices
      `).get();

      db.close();

      return res.json({
        success: true,
        branches: branchesSummary,
        overall
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/admin-dashboard/stock-summary
  app.get('/api/admin-dashboard/stock-summary', (req, res) => {
    try {
      const tenantSlug = getTenantSlug(req);
      const dbPath = tenantSlug ? getTenantDbPath(tenantSlug) : DB_PATH;

      const db = new Database(dbPath);

      // Get all active branches
      const branches = db.prepare('SELECT id, name FROM branches WHERE is_active = 1 ORDER BY id').all();

      // Get stock for each product in each branch with variants
      const rawData = db.prepare(`
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
      `).all();

      // Organize data: for each product (+variant) show stock in each branch
      const productsMap = {};
      for (const row of rawData) {
        const key = `${row.product_id}_${row.variant_id || 0}`;
        if (!productsMap[key]) {
          let displayName = row.product_name;
          if (row.variant_name) {
            displayName += ` - ${row.variant_name}`;
          }
          productsMap[key] = {
            product_id: row.product_id,
            variant_id: row.variant_id,
            name: displayName,
            category: row.category || '',
            branches: {}
          };
        }
        if (row.branch_id) {
          productsMap[key].branches[row.branch_id] = {
            stock: row.stock || 0,
            sales_count: row.sales_count || 0
          };
        }
      }

      const productsList = Object.values(productsMap);

      db.close();

      return res.json({
        success: true,
        branches,
        products: productsList
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

};
