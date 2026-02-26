// ========================================
// Service Worker - PWA + Offline Support
// ========================================

const CACHE_NAME = 'pos-cache-v51';
const STATIC_CACHE = 'pos-static-v40';

// الملفات الأساسية
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/style.css',
    '/products-search.js',
    '/localdb.js',
    '/sync-manager.js',
    '/manifest.json'
];

// التثبيت
self.addEventListener('install', (event) => {
    console.log('[SW] Installing v40...');
    event.waitUntil(
        caches.open(STATIC_CACHE).then(cache => {
            return Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    cache.add(url).catch(err => {
                        console.warn('[SW] Failed to cache:', url, err.message);
                    })
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// التفعيل - حذف الكاشات القديمة
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating v40...');
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.map(key => {
                    if (key !== STATIC_CACHE && key !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Strategy
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // طلبات فحص الاتصال - شبكة فقط
    if (url.searchParams.has('_ping')) {
        event.respondWith(fetch(request));
        return;
    }

    // Sync API - شبكة فقط (لا تكاش)
    if (url.pathname.startsWith('/api/sync/')) {
        event.respondWith(fetch(request));
        return;
    }

    // API Requests - Network First
    if (url.pathname.startsWith('/api/')) {
        // POST/PUT/DELETE - شبكة فقط
        if (request.method !== 'GET') {
            event.respondWith(fetch(request));
            return;
        }
        // GET - Network First مع كاش
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    return caches.match(request);
                })
        );
    }
    // ملفات JS/CSS/HTML - Network First ثم Cache
    else if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html') || url.pathname === '/') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const responseClone = response.clone();
                        caches.open(STATIC_CACHE).then(cache => {
                            cache.put(request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    return caches.match(request);
                })
        );
    }
    // باقي الملفات - Cache First
    else {
        event.respondWith(
            caches.match(request)
                .then(cached => cached || fetch(request))
        );
    }
});

console.log('[SW] Service Worker loaded v40');
