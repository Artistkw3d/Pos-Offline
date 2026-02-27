// ========================================
// Sync Manager v3 - مدير المزامنة الشامل
// مزامنة كاملة لجميع البيانات
// ========================================

class SyncManager {
    constructor() {
        this.isSyncing = false;
        this.lastSync = null;
        this.autoSyncInterval = null;
        this.syncProgress = { total: 0, done: 0, step: '' };
        this.serverUrl = null;
        this._loadSyncMode();
    }

    _loadSyncMode() {
        const mode = localStorage.getItem('pos_sync_mode') || 'local';
        if (mode === 'server') {
            this.serverUrl = localStorage.getItem('pos_sync_server_url') || null;
        } else {
            this.serverUrl = null;
        }
    }

    getApiUrl() {
        if (this.serverUrl) return this.serverUrl;
        return typeof API_URL !== 'undefined' ? API_URL : '';
    }

    isServerMode() {
        return !!this.serverUrl;
    }

    // Get auto-sync interval from localStorage (default 5 minutes)
    getAutoSyncMinutes() {
        const val = parseInt(localStorage.getItem('pos_auto_sync_minutes') || '5', 10);
        return (val >= 1 && val <= 60) ? val : 5;
    }

    // Start auto-sync with configurable interval
    start(intervalMinutes) {
        this.stop();
        const minutes = intervalMinutes || this.getAutoSyncMinutes();
        this.autoSyncInterval = setInterval(() => {
            const isOnline = typeof _realOnlineStatus !== 'undefined' ? _realOnlineStatus : navigator.onLine;
            if (isOnline && !this.isSyncing) this.sync();
        }, minutes * 60 * 1000);
        console.log(`[Sync] Auto-sync started (every ${minutes} min)`);
    }

    stop() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
    }

    // Restart auto-sync (called when interval changes)
    restart() {
        this.stop();
        this.start();
    }

    // Helper: fetch with tenant header
    async _fetch(url, options = {}) {
        const headers = options.headers || {};
        const tenantId = localStorage.getItem('pos_tenant_slug') || '';
        if (tenantId) {
            headers['X-Tenant-ID'] = tenantId;
        }
        return fetch(url, { ...options, headers });
    }

    // Refresh license token from server
    async refreshLicenseToken() {
        try {
            const resp = await this._fetch(`${this.getApiUrl()}/api/license/refresh-token`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.success && data.token) {
                    // Store token metadata in localStorage for frontend grace period checks
                    try {
                        const parts = data.token.split('.');
                        const payload = JSON.parse(atob(parts[1]));
                        localStorage.setItem('pos_license_exp', String(payload.exp || ''));
                        localStorage.setItem('pos_license_iat', String(payload.iat || ''));
                        localStorage.setItem('pos_license_active', String(payload.is_active));
                        localStorage.setItem('pos_license_max_users', String(payload.max_users || ''));
                        localStorage.setItem('pos_license_max_branches', String(payload.max_branches || ''));
                    } catch (_) {}
                    console.log('[Sync] License token refreshed');
                    return true;
                }
            }
        } catch (e) {
            console.warn('[Sync] License refresh failed:', e.message);
        }
        return false;
    }

    // ========== MAIN SYNC ==========
    async sync() {
        if (this.isSyncing) {
            console.log('[Sync] Already syncing...');
            return { success: false, reason: 'already_syncing' };
        }

        this._loadSyncMode();

        const isOnline = typeof _realOnlineStatus !== 'undefined' ? _realOnlineStatus : navigator.onLine;
        if (!isOnline) {
            console.log('[Sync] Offline - skipped');
            return { success: false, reason: 'offline' };
        }

        // Ping server first
        if (this.isServerMode()) {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 5000);
                const resp = await fetch(`${this.getApiUrl()}/api/settings?_ping=1`, { signal: ctrl.signal, cache: 'no-store' });
                clearTimeout(t);
                if (!resp.ok) throw new Error('Server not reachable');
            } catch (e) {
                console.log('[Sync] Remote server unreachable - skipped');
                this.showStatus('السيرفر غير متاح', 'error');
                return { success: false, reason: 'server_unreachable', error: e.message };
            }
        }

        this.isSyncing = true;
        this.syncProgress = { total: 10, done: 0, step: '' };
        const targetUrl = this.getApiUrl();
        const modeLabel = this.isServerMode() ? `server: ${targetUrl}` : 'local';
        console.log(`[Sync] Starting full sync (${modeLabel})`);
        this.showStatus(this.isServerMode() ? 'جاري المزامنة مع السيرفر...' : 'جاري المزامنة...', 'info');
        this.updateSyncUI('syncing');

        const syncResult = {
            success: true,
            invoices_uploaded: 0,
            customers_uploaded: 0,
            branches: 0,
            products: 0,
            customers: 0,
            invoices: 0,
            categories: 0,
            settings: 0,
            returns: 0,
            expenses: 0,
            coupons: 0,
            errors: [],
            negative_stock: []
        };

        try {
            // 1. Refresh license token
            this.syncProgress.step = 'تجديد الترخيص...';
            this.updateProgressUI();
            await this.refreshLicenseToken();
            this.syncProgress.done = 1;

            // 2. Upload pending data
            this.syncProgress.step = 'رفع البيانات المعلقة...';
            this.updateProgressUI();
            const uploadResult = await this.uploadPendingData();
            syncResult.invoices_uploaded = uploadResult.invoices;
            syncResult.customers_uploaded = uploadResult.customers;
            if (uploadResult.errors.length) syncResult.errors.push(...uploadResult.errors);
            if (uploadResult.negative_stock && uploadResult.negative_stock.length) syncResult.negative_stock.push(...uploadResult.negative_stock);
            this.syncProgress.done = 2;

            // 3. Download branches
            this.syncProgress.step = 'تحديث الفروع...';
            this.updateProgressUI();
            syncResult.branches = await this.downloadBranches();
            this.syncProgress.done = 3;

            // 4. Download products
            this.syncProgress.step = 'تحديث المنتجات...';
            this.updateProgressUI();
            syncResult.products = await this.downloadProducts();
            this.syncProgress.done = 4;

            // 5. Download customers
            this.syncProgress.step = 'تحديث العملاء...';
            this.updateProgressUI();
            syncResult.customers = await this.downloadCustomers();
            this.syncProgress.done = 5;

            // 6. Download invoices
            this.syncProgress.step = 'تحديث الفواتير...';
            this.updateProgressUI();
            syncResult.invoices = await this.downloadInvoices();
            this.syncProgress.done = 6;

            // 7. Download settings
            this.syncProgress.step = 'تحديث الإعدادات...';
            this.updateProgressUI();
            syncResult.settings = await this.downloadSettings();
            this.syncProgress.done = 7;

            // 8. Download categories
            this.syncProgress.step = 'تحديث الفئات...';
            this.updateProgressUI();
            syncResult.categories = await this.downloadCategories();
            this.syncProgress.done = 8;

            // 9. Download returns
            this.syncProgress.step = 'تحديث المرتجعات...';
            this.updateProgressUI();
            syncResult.returns = await this.downloadReturns();
            this.syncProgress.done = 9;

            // 10. Download expenses
            this.syncProgress.step = 'تحديث المصروفات...';
            this.updateProgressUI();
            syncResult.expenses = await this.downloadExpenses();
            this.syncProgress.done = 10;

            // Save sync time
            this.lastSync = new Date();
            if (localDB.isReady) {
                await localDB.setLastSync(this.lastSync.toISOString());
                await localDB.addSyncLog({ type: 'sync_complete', ...syncResult });
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
                await localDB.addSyncLog({ type: 'sync_error', error: error.message });
            }
        } finally {
            this.isSyncing = false;
        }

        return syncResult;
    }

    // ========== FULL SYNC (admin) ==========
    async fullSync() {
        if (this.isSyncing) return { success: false, reason: 'already_syncing' };

        this._loadSyncMode();

        const isOnline = typeof _realOnlineStatus !== 'undefined' ? _realOnlineStatus : navigator.onLine;
        if (!isOnline) return { success: false, reason: 'offline' };

        this.isSyncing = true;
        this.showStatus('جاري المزامنة الكاملة...', 'info');
        this.updateSyncUI('syncing');

        try {
            // Upload pending first
            await this.uploadPendingData();

            let counts = {};

            if (this.isServerMode()) {
                console.log('[Sync] Full sync via standard API endpoints');
                counts.branches = await this.downloadBranches();
                counts.products = await this.downloadProducts();
                counts.customers = await this.downloadCustomers();
                counts.invoices = await this.downloadInvoices();
                counts.settings = await this.downloadSettings();
                counts.categories = await this.downloadCategories();
                counts.returns = await this.downloadReturns();
                counts.expenses = await this.downloadExpenses();
                counts.coupons = await this.downloadCoupons();
            } else {
                // Local mode: use /api/sync/full-download + individual endpoints for missing data
                const branchId = (typeof currentUser !== 'undefined' && currentUser?.branch_id) ? currentUser.branch_id : 1;
                const response = await fetch(`${this.getApiUrl()}/api/sync/full-download?branch_id=${branchId}`);
                if (!response.ok) throw new Error(`Server error: ${response.status}`);

                const result = await response.json();
                if (!result.success) throw new Error(result.error || 'Download failed');

                const data = result.data;

                if (data.products) {
                    await localDB.clear('products');
                    await localDB.saveAll('products', data.products);
                    counts.products = data.products.length;
                }
                if (data.customers) {
                    await localDB.clear('customers');
                    await localDB.saveAll('customers', data.customers);
                    counts.customers = data.customers.length;
                }
                if (data.settings) {
                    await localDB.clear('settings');
                    for (const [key, value] of Object.entries(data.settings)) {
                        await localDB.save('settings', { key, value });
                    }
                    counts.settings = Object.keys(data.settings).length;
                }
                if (data.categories) {
                    await localDB.clear('categories');
                    for (const cat of data.categories) {
                        await localDB.save('categories', { name: cat });
                    }
                    counts.categories = data.categories.length;
                }
                if (data.coupons) {
                    await localDB.clear('coupons');
                    await localDB.saveAll('coupons', data.coupons);
                    counts.coupons = data.coupons.length;
                }

                // Also download branches, invoices, returns, expenses (not in full-download)
                counts.branches = await this.downloadBranches();
                counts.invoices = await this.downloadInvoices();
                counts.returns = await this.downloadReturns();
                counts.expenses = await this.downloadExpenses();
            }

            // Refresh UI
            if (typeof allProducts !== 'undefined' && counts.products > 0) {
                const products = await localDB.getAll('products');
                if (products.length) {
                    allProducts = products;
                    if (typeof displayProducts === 'function') displayProducts(allProducts);
                }
            }

            this.lastSync = new Date();
            if (localDB.isReady) {
                await localDB.setLastSync(this.lastSync.toISOString());
                await localDB.addSyncLog({ type: 'full_sync_complete', ...counts });
            }
            localStorage.setItem('pos_last_sync', this.lastSync.toISOString());

            this.showStatus('تمت المزامنة الكاملة', 'success');
            this.updateSyncUI('idle');
            return { success: true, data_counts: counts };

        } catch (error) {
            console.error('[Sync] Full sync error:', error);
            this.showStatus('فشلت المزامنة الكاملة', 'error');
            this.updateSyncUI('error');
            return { success: false, error: error.message };
        } finally {
            this.isSyncing = false;
        }
    }

    // ========== UPLOAD ==========
    async uploadPendingData() {
        const result = { invoices: 0, customers: 0, errors: [], negative_stock: [] };

        try {
            const pendingInvoices = await localDB.getAll('pending_invoices');
            const pendingCustomers = await localDB.getAll('pending_customers');

            if (pendingInvoices.length === 0 && pendingCustomers.length === 0) {
                return result;
            }

            const apiUrl = this.getApiUrl();

            if (this.isServerMode()) {
                // Server mode: use individual CRUD endpoints
                for (const cust of pendingCustomers) {
                    try {
                        const resp = await this._fetch(`${apiUrl}/api/customers`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(cust)
                        });
                        if (resp.ok) {
                            const r = await resp.json();
                            if (r.success) {
                                await localDB.delete('pending_customers', cust.id);
                                result.customers++;
                            }
                        }
                    } catch (e) {
                        console.error('[Sync] Customer upload error:', e);
                        result.errors.push(`customer ${cust.name || cust.id}: ${e.message}`);
                    }
                }

                for (const inv of pendingInvoices) {
                    try {
                        const invoiceData = inv.data || inv;
                        const resp = await this._fetch(`${apiUrl}/api/invoices`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(invoiceData)
                        });
                        if (resp.ok) {
                            const r = await resp.json();
                            if (r.success) {
                                await localDB.delete('pending_invoices', inv.local_id);
                                if (inv.data?.id) await localDB.delete('local_invoices', inv.data.id);
                                if (r.duplicate) {
                                    console.log(`[Sync] Duplicate invoice removed: ${inv.local_id}`);
                                } else {
                                    result.invoices++;
                                }
                            }
                        } else {
                            result.errors.push(`invoice ${inv.local_id}: HTTP ${resp.status}`);
                        }
                    } catch (e) {
                        console.error('[Sync] Invoice upload error:', e);
                        result.errors.push(`invoice ${inv.local_id}: ${e.message}`);
                    }
                }

                console.log(`[Sync] Remote upload: ${result.invoices} invoices, ${result.customers} customers`);
                return result;
            }

            // Local mode: batch upload via /api/sync/upload
            const uploadData = {
                invoices: pendingInvoices.map(inv => inv.data || inv),
                customers: pendingCustomers
            };

            const response = await fetch(`${apiUrl}/api/sync/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(uploadData)
            });

            if (!response.ok) throw new Error(`Upload failed: ${response.status}`);

            const uploadResult = await response.json();

            if (uploadResult.success) {
                for (const inv of pendingInvoices) {
                    await localDB.delete('pending_invoices', inv.local_id);
                    if (inv.data?.id) await localDB.delete('local_invoices', inv.data.id);
                }
                for (const cust of pendingCustomers) {
                    await localDB.delete('pending_customers', cust.id);
                }

                result.invoices = uploadResult.results?.invoices_synced || pendingInvoices.length;
                result.customers = uploadResult.results?.customers_synced || pendingCustomers.length;

                if (uploadResult.results?.errors) {
                    result.errors = uploadResult.results.errors;
                }
                if (uploadResult.results?.negative_stock) {
                    result.negative_stock = uploadResult.results.negative_stock;
                }
            }
        } catch (error) {
            console.error('[Sync] Upload error:', error);
            result.errors.push(error.message);
        }

        return result;
    }

    // Legacy compat
    async uploadPendingInvoices() {
        const r = await this.uploadPendingData();
        return r;
    }
    async uploadPendingCustomers() {
        const r = await this.uploadPendingData();
        return r;
    }

    // ========== DOWNLOADS ==========

    async downloadBranches() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/branches`);
            if (!response.ok) return 0;
            const data = await response.json();
            const branches = data.branches || data.data || [];
            if (branches.length && localDB.isReady) {
                await localDB.clear('branches');
                await localDB.saveAll('branches', branches);
                console.log(`[Sync] Downloaded ${branches.length} branches`);
            }
            return branches.length;
        } catch (error) {
            console.error('[Sync] Branches download error:', error);
            return 0;
        }
    }

    async downloadProducts() {
        try {
            const branchId = (typeof currentUser !== 'undefined' && currentUser?.branch_id) ? currentUser.branch_id : 1;
            const response = await this._fetch(`${this.getApiUrl()}/api/products?branch_id=${branchId}`);
            if (!response.ok) return 0;

            const data = await response.json();

            if (data.success && data.products) {
                await localDB.clear('products');
                await localDB.saveAll('products', data.products);
                console.log(`[Sync] Downloaded ${data.products.length} products`);

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

    async downloadCustomers() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/customers`);
            if (!response.ok) return 0;
            const data = await response.json();
            const customers = data.customers || [];
            if (data.success && customers.length) {
                await localDB.clear('customers');
                await localDB.saveAll('customers', customers);
                console.log(`[Sync] Downloaded ${customers.length} customers`);
            }
            return customers.length;
        } catch (error) {
            console.error('[Sync] Customers download error:', error);
            return 0;
        }
    }

    async downloadInvoices() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/invoices?limit=500`);
            if (!response.ok) return 0;
            const data = await response.json();
            const invoices = data.invoices || [];
            if (invoices.length && localDB.isReady) {
                await localDB.clear('invoices');
                await localDB.saveAll('invoices', invoices);
                console.log(`[Sync] Downloaded ${invoices.length} invoices`);
            }
            return invoices.length;
        } catch (error) {
            console.error('[Sync] Invoices download error:', error);
            return 0;
        }
    }

    async downloadSettings() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/settings`);
            if (!response.ok) return 0;
            const data = await response.json();
            if (data.success && data.settings) {
                await localDB.clear('settings');
                let count = 0;
                if (Array.isArray(data.settings)) {
                    for (const s of data.settings) {
                        await localDB.save('settings', { key: s.key, value: s.value });
                        count++;
                    }
                } else {
                    for (const [key, value] of Object.entries(data.settings)) {
                        await localDB.save('settings', { key, value });
                        count++;
                    }
                }
                console.log(`[Sync] Downloaded ${count} settings`);
                return count;
            }
        } catch (error) {
            console.error('[Sync] Settings download error:', error);
        }
        return 0;
    }

    async downloadCategories() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/categories`);
            if (!response.ok) return 0;
            const data = await response.json();
            const categories = data.categories || [];
            if (categories.length && localDB.isReady) {
                await localDB.clear('categories');
                for (const cat of categories) {
                    if (typeof cat === 'string') {
                        await localDB.save('categories', { name: cat });
                    } else {
                        await localDB.save('categories', cat);
                    }
                }
                console.log(`[Sync] Downloaded ${categories.length} categories`);
            }
            return categories.length;
        } catch (error) {
            console.error('[Sync] Categories download error:', error);
            return 0;
        }
    }

    async downloadReturns() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/returns`);
            if (!response.ok) return 0;
            const data = await response.json();
            const returns = data.returns || [];
            if (returns.length && localDB.isReady) {
                await localDB.clear('returns');
                await localDB.saveAll('returns', returns);
                console.log(`[Sync] Downloaded ${returns.length} returns`);
            }
            return returns.length;
        } catch (error) {
            console.error('[Sync] Returns download error:', error);
            return 0;
        }
    }

    async downloadExpenses() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/expenses`);
            if (!response.ok) return 0;
            const data = await response.json();
            const expenses = data.expenses || [];
            if (expenses.length && localDB.isReady) {
                await localDB.clear('expenses');
                await localDB.saveAll('expenses', expenses);
                console.log(`[Sync] Downloaded ${expenses.length} expenses`);
            }
            return expenses.length;
        } catch (error) {
            console.error('[Sync] Expenses download error:', error);
            return 0;
        }
    }

    async downloadCoupons() {
        try {
            const response = await this._fetch(`${this.getApiUrl()}/api/coupons`);
            if (!response.ok) return 0;
            const data = await response.json();
            const coupons = data.coupons || [];
            if (coupons.length && localDB.isReady) {
                await localDB.clear('coupons');
                await localDB.saveAll('coupons', coupons);
                console.log(`[Sync] Downloaded ${coupons.length} coupons`);
            }
            return coupons.length;
        } catch (error) {
            console.error('[Sync] Coupons download error:', error);
            return 0;
        }
    }

    // ========== STATS ==========
    async getSyncStats() {
        const stats = {
            pendingInvoices: 0,
            pendingCustomers: 0,
            localProducts: 0,
            localCustomers: 0,
            localInvoices: 0,
            localBranches: 0,
            lastSync: localStorage.getItem('pos_last_sync') || null
        };

        try {
            if (localDB.isReady) {
                stats.pendingInvoices = await localDB.count('pending_invoices');
                stats.pendingCustomers = await localDB.count('pending_customers');
                stats.localProducts = await localDB.count('products');
                stats.localCustomers = await localDB.count('customers');
                stats.localInvoices = await localDB.count('local_invoices');
                stats.localBranches = await localDB.count('branches');
            }
        } catch (e) {
            console.error('[Sync] Stats error:', e);
        }

        return stats;
    }

    // ========== UI ==========
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

        const colors = { info: '#667eea', success: '#28a745', error: '#dc3545' };
        indicator.style.background = colors[type] || colors.info;
        indicator.textContent = message;
        indicator.style.display = 'block';

        if (type !== 'info') {
            setTimeout(() => { indicator.style.display = 'none'; }, 3000);
        }
    }

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

console.log('[Sync] Loaded v3');
