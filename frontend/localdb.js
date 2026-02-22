// ========================================
// 💾 Local Database (IndexedDB)
// ========================================

class LocalDB {
    constructor() {
        this.dbName = 'POS_DB';
        this.version = 3; // v3: إضافة pending_customers
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
                console.log('[LocalDB] Ready ✅');
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Products
                if (!db.objectStoreNames.contains('products')) {
                    db.createObjectStore('products', { keyPath: 'id' });
                }
                
                // Pending Invoices (للرفع)
                if (!db.objectStoreNames.contains('pending_invoices')) {
                    db.createObjectStore('pending_invoices', { keyPath: 'local_id', autoIncrement: true });
                }
                
                // Local Invoices (للعرض والطباعة)
                if (!db.objectStoreNames.contains('local_invoices')) {
                    db.createObjectStore('local_invoices', { keyPath: 'id' });
                }
                
                // User Data
                if (!db.objectStoreNames.contains('user_data')) {
                    db.createObjectStore('user_data', { keyPath: 'key' });
                }

                // Pending Customers (للمزامنة عند العودة أونلاين)
                if (!db.objectStoreNames.contains('pending_customers')) {
                    db.createObjectStore('pending_customers', { keyPath: 'id' });
                }

                console.log('[LocalDB] Tables created');
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
}

// Instance عام
const localDB = new LocalDB();

console.log('[LocalDB] Loaded');
