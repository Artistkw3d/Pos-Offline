// ========================================
// Local Database (IndexedDB) - Offline POS
// ========================================

class LocalDB {
    constructor() {
        this.dbName = 'POS_DB';
        this.version = 6; // v6: دعم مزامنة الفروع والفواتير
        this.db = null;
        this.isReady = false;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => {
                console.error('[LocalDB] Error:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                this.isReady = true;
                console.log('[LocalDB] Ready');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Products - المنتجات المحلية
                if (!db.objectStoreNames.contains('products')) {
                    db.createObjectStore('products', { keyPath: 'id' });
                }

                // Pending Invoices - فواتير في انتظار الرفع
                if (!db.objectStoreNames.contains('pending_invoices')) {
                    db.createObjectStore('pending_invoices', { keyPath: 'local_id', autoIncrement: true });
                }

                // Local Invoices - الفواتير المحلية للعرض والطباعة
                if (!db.objectStoreNames.contains('local_invoices')) {
                    db.createObjectStore('local_invoices', { keyPath: 'id' });
                }

                // User Data - بيانات المستخدم
                if (!db.objectStoreNames.contains('user_data')) {
                    db.createObjectStore('user_data', { keyPath: 'key' });
                }

                // Pending Customers - عملاء في انتظار الرفع
                if (!db.objectStoreNames.contains('pending_customers')) {
                    db.createObjectStore('pending_customers', { keyPath: 'id' });
                }

                // Customers - العملاء المحليون (نسخة كاملة)
                if (!db.objectStoreNames.contains('customers')) {
                    db.createObjectStore('customers', { keyPath: 'id' });
                }

                // Settings - الإعدادات المحلية
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }

                // Sync Log - سجل المزامنة
                if (!db.objectStoreNames.contains('sync_log')) {
                    db.createObjectStore('sync_log', { keyPath: 'id', autoIncrement: true });
                }

                // Categories - الفئات
                if (!db.objectStoreNames.contains('categories')) {
                    db.createObjectStore('categories', { keyPath: 'name' });
                }

                // Coupons - الكوبونات
                if (!db.objectStoreNames.contains('coupons')) {
                    db.createObjectStore('coupons', { keyPath: 'id' });
                }

                // Branches - الفروع
                if (!db.objectStoreNames.contains('branches')) {
                    db.createObjectStore('branches', { keyPath: 'id' });
                }

                // Invoices - الفواتير (من السيرفر)
                if (!db.objectStoreNames.contains('invoices')) {
                    db.createObjectStore('invoices', { keyPath: 'id' });
                }

                // Returns - المرتجعات
                if (!db.objectStoreNames.contains('returns')) {
                    db.createObjectStore('returns', { keyPath: 'id' });
                }

                // Expenses - المصروفات
                if (!db.objectStoreNames.contains('expenses')) {
                    db.createObjectStore('expenses', { keyPath: 'id' });
                }

                console.log('[LocalDB] All stores created (v6)');
            };
        });
    }

    // حفظ
    async save(storeName, data) {
        if (!this.isReady) return null;

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.put(data);

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // إضافة (للجداول مع autoIncrement)
    async add(storeName, data) {
        if (!this.isReady) return null;

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.add(data);

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // حفظ متعدد
    async saveAll(storeName, dataArray) {
        if (!this.isReady || !dataArray || dataArray.length === 0) return;

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);

                dataArray.forEach(item => store.put(item));

                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // جلب
    async get(storeName, id) {
        if (!this.isReady) return null;

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readonly');
                const store = tx.objectStore(storeName);
                const request = store.get(id);

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // جلب الكل
    async getAll(storeName) {
        if (!this.isReady) return [];

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readonly');
                const store = tx.objectStore(storeName);
                const request = store.getAll();

                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // عدد العناصر
    async count(storeName) {
        if (!this.isReady) return 0;

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readonly');
                const store = tx.objectStore(storeName);
                const request = store.count();

                request.onsuccess = () => resolve(request.result || 0);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // حذف
    async delete(storeName, id) {
        if (!this.isReady) return;

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.delete(id);

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // مسح الكل
    async clear(storeName) {
        if (!this.isReady) return;

        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.clear();

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    // حفظ آخر وقت مزامنة
    async setLastSync(timestamp) {
        await this.save('user_data', { key: 'last_sync', value: timestamp });
    }

    async getLastSync() {
        const data = await this.get('user_data', 'last_sync');
        return data ? data.value : null;
    }

    // حفظ سجل مزامنة
    async addSyncLog(entry) {
        await this.add('sync_log', {
            ...entry,
            timestamp: new Date().toISOString()
        });
    }

    // جلب آخر سجلات المزامنة
    async getRecentSyncLogs(limit = 20) {
        const all = await this.getAll('sync_log');
        return all.slice(-limit).reverse();
    }
}

// Instance
const localDB = new LocalDB();

console.log('[LocalDB] Loaded v6');
