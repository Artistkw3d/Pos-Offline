// ========================================
// Sync Manager - مدير المزامنة
// يدعم المزامنة اليدوية والتلقائية
// ========================================

class SyncManager {
    constructor() {
        this.isSyncing = false;
        this.lastSync = null;
        this.autoSyncInterval = null;
        this.syncProgress = { total: 0, done: 0, step: '' };
        this.serverUrl = null; // عنوان السيرفر البعيد (null = محلي)
        this._loadSyncMode();
    }

    // تحميل وضع التزامن من localStorage
    _loadSyncMode() {
        const mode = localStorage.getItem('pos_sync_mode') || 'local';
        if (mode === 'server') {
            this.serverUrl = localStorage.getItem('pos_sync_server_url') || null;
        } else {
            this.serverUrl = null;
        }
    }

    // جلب عنوان API حسب الوضع الحالي
    getApiUrl() {
        if (this.serverUrl) return this.serverUrl;
        return typeof API_URL !== 'undefined' ? API_URL : '';
    }

    // هل الوضع سيرفر؟
    isServerMode() {
        return !!this.serverUrl;
    }

    // بدء المزامنة التلقائية
    start(intervalMinutes = 5) {
        this.autoSyncInterval = setInterval(() => {
            if (typeof _realOnlineStatus !== 'undefined' ? _realOnlineStatus : navigator.onLine) {
                if (!this.isSyncing) this.sync();
            }
        }, intervalMinutes * 60 * 1000);

        console.log(`[Sync] Auto-sync started (every ${intervalMinutes} min)`);
    }

    // إيقاف المزامنة التلقائية
    stop() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
    }

    // المزامنة الكاملة (يدوية أو تلقائية)
    async sync() {
        if (this.isSyncing) {
            console.log('[Sync] Already syncing...');
            return { success: false, reason: 'already_syncing' };
        }

        // إعادة تحميل وضع التزامن
        this._loadSyncMode();

        const isOnline = typeof _realOnlineStatus !== 'undefined' ? _realOnlineStatus : navigator.onLine;
        if (!isOnline) {
            console.log('[Sync] Offline - skipped');
            return { success: false, reason: 'offline' };
        }

        // في وضع السيرفر، تحقق من الاتصال بالسيرفر البعيد
        if (this.isServerMode()) {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 5000);
                const resp = await fetch(`${this.getApiUrl()}/api/sync/status`, { signal: ctrl.signal, cache: 'no-store' });
                clearTimeout(t);
                if (!resp.ok) throw new Error('Server not reachable');
            } catch (e) {
                console.log('[Sync] Remote server unreachable - skipped');
                this.showStatus('السيرفر غير متاح', 'error');
                return { success: false, reason: 'server_unreachable' };
            }
        }

        this.isSyncing = true;
        this.syncProgress = { total: 4, done: 0, step: '' };
        const targetUrl = this.getApiUrl();
        const modeLabel = this.isServerMode() ? `سيرفر: ${targetUrl}` : 'محلي';
        console.log(`[Sync] Starting sync (${modeLabel})`);
        this.showStatus(this.isServerMode() ? 'جاري المزامنة مع السيرفر...' : 'جاري المزامنة...', 'info');
        this.updateSyncUI('syncing');

        const syncResult = {
            success: true,
            invoices_uploaded: 0,
            customers_uploaded: 0,
            products_downloaded: 0,
            customers_downloaded: 0,
            errors: []
        };

        try {
            // 1. رفع الفواتير المعلقة
            this.syncProgress.step = 'رفع الفواتير...';
            this.updateProgressUI();
            const uploadResult = await this.uploadPendingData();
            syncResult.invoices_uploaded = uploadResult.invoices;
            syncResult.customers_uploaded = uploadResult.customers;
            if (uploadResult.errors.length) syncResult.errors.push(...uploadResult.errors);
            this.syncProgress.done = 1;

            // 2. تحميل المنتجات
            this.syncProgress.step = 'تحديث المنتجات...';
            this.updateProgressUI();
            const productsCount = await this.downloadProducts();
            syncResult.products_downloaded = productsCount;
            this.syncProgress.done = 2;

            // 3. تحميل العملاء
            this.syncProgress.step = 'تحديث العملاء...';
            this.updateProgressUI();
            const customersCount = await this.downloadCustomers();
            syncResult.customers_downloaded = customersCount;
            this.syncProgress.done = 3;

            // 4. تحميل الإعدادات والكوبونات
            this.syncProgress.step = 'تحديث الإعدادات...';
            this.updateProgressUI();
            await this.downloadSettings();
            this.syncProgress.done = 4;

            // حفظ وقت المزامنة
            this.lastSync = new Date();
            if (localDB.isReady) {
                await localDB.setLastSync(this.lastSync.toISOString());
                await localDB.addSyncLog({
                    type: 'sync_complete',
                    ...syncResult
                });
            }
            localStorage.setItem('pos_last_sync', this.lastSync.toISOString());

            this.showStatus('تمت المزامنة بنجاح', 'success');
            this.updateSyncUI('idle');
            console.log('[Sync] Completed', syncResult);

        } catch (error) {
            console.error('[Sync] Error:', error);
            syncResult.success = false;
            syncResult.errors.push(error.message);
            this.showStatus('فشلت المزامنة', 'error');
            this.updateSyncUI('error');

            if (localDB.isReady) {
                await localDB.addSyncLog({
                    type: 'sync_error',
                    error: error.message
                });
            }
        } finally {
            this.isSyncing = false;
        }

        return syncResult;
    }

    // المزامنة الكاملة - تحميل كل البيانات من الصفر (للأدمن)
    async fullSync() {
        if (this.isSyncing) return { success: false, reason: 'already_syncing' };

        // إعادة تحميل وضع التزامن
        this._loadSyncMode();

        const isOnline = typeof _realOnlineStatus !== 'undefined' ? _realOnlineStatus : navigator.onLine;
        if (!isOnline) return { success: false, reason: 'offline' };

        this.isSyncing = true;
        this.showStatus('جاري المزامنة الكاملة...', 'info');
        this.updateSyncUI('syncing');

        try {
            // 1. رفع أي بيانات معلقة أولاً
            await this.uploadPendingData();

            // 2. تحميل كل البيانات
            const branchId = (typeof currentUser !== 'undefined' && currentUser?.branch_id) ? currentUser.branch_id : 1;
            const response = await fetch(`${this.getApiUrl()}/api/sync/full-download?branch_id=${branchId}`);
            if (!response.ok) throw new Error(`Server error: ${response.status}`);

            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'Download failed');

            const data = result.data;

            // مسح وإعادة حفظ كل البيانات
            if (data.products) {
                await localDB.clear('products');
                await localDB.saveAll('products', data.products);
            }
            if (data.customers) {
                await localDB.clear('customers');
                await localDB.saveAll('customers', data.customers);
            }
            if (data.settings) {
                await localDB.clear('settings');
                for (const [key, value] of Object.entries(data.settings)) {
                    await localDB.save('settings', { key, value });
                }
            }
            if (data.categories) {
                await localDB.clear('categories');
                for (const cat of data.categories) {
                    await localDB.save('categories', { name: cat });
                }
            }
            if (data.coupons) {
                await localDB.clear('coupons');
                await localDB.saveAll('coupons', data.coupons);
            }

            this.lastSync = new Date();
            await localDB.setLastSync(this.lastSync.toISOString());
            localStorage.setItem('pos_last_sync', this.lastSync.toISOString());
            await localDB.addSyncLog({
                type: 'full_sync_complete',
                products: data.products?.length || 0,
                customers: data.customers?.length || 0
            });

            // تحديث العرض
            if (typeof allProducts !== 'undefined' && data.products) {
                allProducts = data.products;
                if (typeof displayProducts === 'function') displayProducts(allProducts);
            }

            this.showStatus('تمت المزامنة الكاملة', 'success');
            this.updateSyncUI('idle');
            return { success: true, data_counts: {
                products: data.products?.length || 0,
                customers: data.customers?.length || 0
            }};

        } catch (error) {
            console.error('[Sync] Full sync error:', error);
            this.showStatus('فشلت المزامنة الكاملة', 'error');
            this.updateSyncUI('error');
            return { success: false, error: error.message };
        } finally {
            this.isSyncing = false;
        }
    }

    // رفع البيانات المعلقة (فواتير + عملاء)
    async uploadPendingData() {
        const result = { invoices: 0, customers: 0, errors: [] };

        try {
            const pendingInvoices = await localDB.getAll('pending_invoices');
            const pendingCustomers = await localDB.getAll('pending_customers');

            if (pendingInvoices.length === 0 && pendingCustomers.length === 0) {
                return result;
            }

            // تجهيز البيانات للرفع
            const uploadData = {
                invoices: pendingInvoices.map(inv => inv.data || inv),
                customers: pendingCustomers
            };

            const response = await fetch(`${this.getApiUrl()}/api/sync/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(uploadData)
            });

            if (!response.ok) throw new Error(`Upload failed: ${response.status}`);

            const uploadResult = await response.json();

            if (uploadResult.success) {
                // حذف الفواتير المعلقة التي تم رفعها
                for (const inv of pendingInvoices) {
                    await localDB.delete('pending_invoices', inv.local_id);
                    if (inv.data?.id) await localDB.delete('local_invoices', inv.data.id);
                }
                // حذف العملاء المعلقين
                for (const cust of pendingCustomers) {
                    await localDB.delete('pending_customers', cust.id);
                }

                result.invoices = uploadResult.results?.invoices_synced || pendingInvoices.length;
                result.customers = uploadResult.results?.customers_synced || pendingCustomers.length;

                if (uploadResult.results?.errors) {
                    result.errors = uploadResult.results.errors;
                }
            }
        } catch (error) {
            console.error('[Sync] Upload error:', error);
            result.errors.push(error.message);
        }

        return result;
    }

    // رفع الفواتير المعلقة (للتوافق مع الكود القديم)
    async uploadPendingInvoices() {
        try {
            const pending = await localDB.getAll('pending_invoices');

            if (pending.length === 0) {
                console.log('[Sync] No pending invoices');
                return;
            }

            console.log(`[Sync] Uploading ${pending.length} invoices...`);

            for (const invoice of pending) {
                try {
                    const response = await fetch(`${this.getApiUrl()}/api/invoices`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(invoice.data)
                    });

                    if (!response.ok) {
                        console.error(`[Sync] Server returned ${response.status} for invoice ${invoice.local_id}`);
                        continue;
                    }

                    const result = await response.json();

                    if (result.success) {
                        await localDB.delete('pending_invoices', invoice.local_id);
                        if (invoice.data.id) {
                            await localDB.delete('local_invoices', invoice.data.id);
                        }
                        console.log(`[Sync] Uploaded invoice ${invoice.local_id}`);
                    }
                } catch (error) {
                    console.error(`[Sync] Failed to upload invoice:`, error);
                }
            }
        } catch (error) {
            console.error('[Sync] Upload error:', error);
        }
    }

    // رفع العملاء المعلقين (للتوافق)
    async uploadPendingCustomers() {
        try {
            const pending = await localDB.getAll('pending_customers');
            if (pending.length === 0) return;

            for (const customer of pending) {
                try {
                    const response = await fetch(`${this.getApiUrl()}/api/customers`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(customer)
                    });
                    if (!response.ok) continue;
                    const result = await response.json();
                    if (result.success) {
                        await localDB.delete('pending_customers', customer.id);
                    }
                } catch (error) {
                    console.error(`[Sync] Failed to upload customer:`, error);
                }
            }
        } catch (error) {
            console.error('[Sync] Customer upload error:', error);
        }
    }

    // تحديث المنتجات
    async downloadProducts() {
        try {
            const branchId = (typeof currentUser !== 'undefined' && currentUser?.branch_id) ? currentUser.branch_id : 1;
            const response = await fetch(`${this.getApiUrl()}/api/products?branch_id=${branchId}`);
            if (!response.ok) return 0;

            const data = await response.json();

            if (data.success && data.products) {
                await localDB.clear('products');
                await localDB.saveAll('products', data.products);
                console.log(`[Sync] Downloaded ${data.products.length} products`);

                // تحديث العرض
                if (typeof allProducts !== 'undefined') {
                    allProducts = data.products;
                    if (typeof displayProducts === 'function') {
                        displayProducts(allProducts);
                    }
                }
                return data.products.length;
            }
        } catch (error) {
            console.error('[Sync] Products download error:', error);
        }
        return 0;
    }

    // تحميل العملاء
    async downloadCustomers() {
        try {
            const response = await fetch(`${this.getApiUrl()}/api/customers`);
            if (!response.ok) return 0;

            const data = await response.json();

            if (data.success && data.customers) {
                await localDB.clear('customers');
                await localDB.saveAll('customers', data.customers);
                return data.customers.length;
            }
        } catch (error) {
            console.error('[Sync] Customers download error:', error);
        }
        return 0;
    }

    // تحميل الإعدادات
    async downloadSettings() {
        try {
            const response = await fetch(`${this.getApiUrl()}/api/settings`);
            if (!response.ok) return;

            const data = await response.json();
            if (data.success && data.settings) {
                await localDB.clear('settings');
                if (Array.isArray(data.settings)) {
                    for (const s of data.settings) {
                        await localDB.save('settings', { key: s.key, value: s.value });
                    }
                } else {
                    for (const [key, value] of Object.entries(data.settings)) {
                        await localDB.save('settings', { key, value });
                    }
                }
            }
        } catch (error) {
            console.error('[Sync] Settings download error:', error);
        }
    }

    // جلب حالة المزامنة (إحصائيات)
    async getSyncStats() {
        const stats = {
            pendingInvoices: 0,
            pendingCustomers: 0,
            localProducts: 0,
            localCustomers: 0,
            localInvoices: 0,
            lastSync: localStorage.getItem('pos_last_sync') || null
        };

        try {
            if (localDB.isReady) {
                stats.pendingInvoices = await localDB.count('pending_invoices');
                stats.pendingCustomers = await localDB.count('pending_customers');
                stats.localProducts = await localDB.count('products');
                stats.localCustomers = await localDB.count('customers');
                stats.localInvoices = await localDB.count('local_invoices');
            }
        } catch (e) {
            console.error('[Sync] Stats error:', e);
        }

        return stats;
    }

    // عرض الحالة
    showStatus(message, type = 'info') {
        let indicator = document.getElementById('syncStatus');

        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'syncStatus';
            indicator.style.cssText = `
                position: fixed;
                top: 70px;
                right: 20px;
                padding: 12px 20px;
                border-radius: 8px;
                color: white;
                font-weight: 600;
                z-index: 9999;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                animation: slideIn 0.3s ease;
                direction: rtl;
            `;
            document.body.appendChild(indicator);
        }

        const colors = {
            info: '#667eea',
            success: '#28a745',
            error: '#dc3545'
        };

        indicator.style.background = colors[type] || colors.info;
        indicator.textContent = message;
        indicator.style.display = 'block';

        if (type !== 'info') {
            setTimeout(() => {
                indicator.style.display = 'none';
            }, 3000);
        }
    }

    // تحديث واجهة المزامنة
    updateSyncUI(state) {
        const syncBtn = document.getElementById('manualSyncBtn');
        const syncStatusEl = document.getElementById('syncStatusText');

        if (syncBtn) {
            if (state === 'syncing') {
                syncBtn.disabled = true;
                syncBtn.innerHTML = '<span class="sync-spinner"></span> جاري المزامنة...';
            } else if (state === 'error') {
                syncBtn.disabled = false;
                syncBtn.innerHTML = 'اعادة المزامنة';
                syncBtn.style.background = '#dc3545';
                setTimeout(() => {
                    syncBtn.style.background = '';
                    syncBtn.innerHTML = 'مزامنة يدوية';
                }, 3000);
            } else {
                syncBtn.disabled = false;
                syncBtn.innerHTML = 'مزامنة يدوية';
            }
        }

        if (syncStatusEl) {
            const lastSync = localStorage.getItem('pos_last_sync');
            if (lastSync) {
                const d = new Date(lastSync);
                syncStatusEl.textContent = `اخر مزامنة: ${d.toLocaleDateString('ar-SA')} ${d.toLocaleTimeString('ar-SA')}`;
            }
        }
    }

    // تحديث شريط التقدم
    updateProgressUI() {
        const progressEl = document.getElementById('syncProgressText');
        if (progressEl) {
            progressEl.textContent = `${this.syncProgress.step} (${this.syncProgress.done}/${this.syncProgress.total})`;
        }
    }
}

// Instance
const syncManager = new SyncManager();

// CSS animation
const syncStyle = document.createElement('style');
syncStyle.textContent = `
@keyframes slideIn {
    from { transform: translateX(100px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
}
@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
.sync-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #fff;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-left: 5px;
}
`;
document.head.appendChild(syncStyle);

console.log('[Sync] Loaded v2');
