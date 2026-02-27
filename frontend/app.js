const API_URL = (function() {
    // Capacitor: no local backend, use remote server
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        return localStorage.getItem('pos_server_url') || 'https://my-pos.org';
    }
    // Electron file:// protocol: use local Express server
    if (window.location.protocol === 'file:') {
        return 'http://localhost:5050';
    }
    // Web/Docker: use current origin
    return window.location.origin;
})();

// === دالة حماية من XSS - تنظيف النصوص قبل إدراجها في HTML ===
function escHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// === HMAC anti-tamper for setup config ===
const _POS_APP_SALT = 'pos-offline-2024-anti-tamper';

async function _hmacSign(data, tenantSlug) {
    const keyStr = (tenantSlug || '') + ':' + _POS_APP_SALT;
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey(
                'raw', encoder.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
            );
            const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
            return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (_) { /* fallback below */ }
    }
    // Fallback for non-secure contexts (file:// without crypto.subtle)
    let hash = 0;
    const combined = keyStr + '|' + data;
    for (let i = 0; i < combined.length; i++) {
        hash = ((hash << 5) - hash) + combined.charCodeAt(i);
        hash |= 0;
    }
    return 'fb-' + Math.abs(hash).toString(16);
}

async function _hmacVerify(data, signature, tenantSlug) {
    const expected = await _hmacSign(data, tenantSlug);
    return expected === signature;
}

function _serializeConfig(config) {
    return JSON.stringify(config, Object.keys(config).sort());
}

async function saveSetupConfig(config) {
    const serialized = _serializeConfig(config);
    const sig = await _hmacSign(serialized, config.tenant_slug || '');
    localStorage.setItem('pos_setup_config', JSON.stringify({ data: config, sig: sig }));
}

async function loadAndVerifySetupConfig() {
    const raw = localStorage.getItem('pos_setup_config');
    if (!raw) return null;
    try {
        const { data, sig } = JSON.parse(raw);
        const serialized = _serializeConfig(data);
        const valid = await _hmacVerify(serialized, sig, data.tenant_slug || '');
        if (!valid) {
            console.warn('[Setup] Config HMAC verification failed - tampered?');
            return null;
        }
        return data;
    } catch (e) {
        console.warn('[Setup] Config parse error:', e);
        return null;
    }
}

// === HMAC-signed license storage ===
async function saveLicenseData(licenseObj) {
    if (!licenseObj) return;
    const tenantSlug = localStorage.getItem('pos_tenant_slug') || '';
    const serialized = _serializeConfig(licenseObj);
    const sig = await _hmacSign(serialized, tenantSlug);
    localStorage.setItem('pos_license_data', JSON.stringify({ data: licenseObj, sig: sig }));
    // Legacy keys for backward compat
    if (licenseObj.exp) localStorage.setItem('pos_license_exp', String(licenseObj.exp));
    if (licenseObj.iat) localStorage.setItem('pos_license_iat', String(licenseObj.iat));
    localStorage.setItem('pos_license_active', String(licenseObj.is_active ? 1 : 0));
    // Electron AppData persistence
    if (window.electronAPI && window.electronAPI.send) {
        try { window.electronAPI.send('license-save', JSON.stringify({ data: licenseObj, sig: sig })); } catch (_) {}
    }
}

async function loadAndVerifyLicenseData() {
    const tenantSlug = localStorage.getItem('pos_tenant_slug') || '';
    let raw = null;
    // Electron: try AppData first
    if (window.electronAPI && window.electronAPI.invoke) {
        try {
            const electronData = await window.electronAPI.invoke('license-load');
            if (electronData) raw = electronData;
        } catch (_) {}
    }
    // Fallback to localStorage
    if (!raw) raw = localStorage.getItem('pos_license_data');
    if (!raw) return null;
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const { data, sig } = parsed;
        const serialized = _serializeConfig(data);
        const valid = await _hmacVerify(serialized, sig, tenantSlug);
        if (!valid) {
            console.warn('[License] HMAC verification failed - tampered!');
            return { _tampered: true };
        }
        return data;
    } catch (e) {
        console.warn('[License] Parse error:', e);
        return null;
    }
}

// === License check & renewal ===
async function checkLicense() {
    const tenantSlug = localStorage.getItem('pos_tenant_slug') || '';
    if (!tenantSlug) return true; // local-only mode

    const overlay = document.getElementById('licenseExpiredOverlay');
    const banner = document.getElementById('licenseWarningBanner');
    const bannerText = document.getElementById('licenseWarningText');

    const licenseData = await loadAndVerifyLicenseData();

    // Tamper detected
    if (licenseData && licenseData._tampered) {
        console.error('[License] TAMPER DETECTED - wiping all data');
        localStorage.clear();
        if (window.electronAPI && window.electronAPI.send) {
            try { window.electronAPI.send('license-clear'); } catch (_) {}
        }
        try { const dbs = await indexedDB.databases(); for (const db of dbs) { indexedDB.deleteDatabase(db.name); } } catch (_) {}
        window.location.reload();
        return false;
    }

    // No license data - try migrate from legacy
    if (!licenseData) {
        const legacyRaw = localStorage.getItem('pos_offline_license');
        if (legacyRaw) {
            try {
                const legacy = JSON.parse(legacyRaw);
                await saveLicenseData(legacy);
                console.log('[License] Migrated legacy license to HMAC format');
                return await checkLicense(); // re-check with migrated data
            } catch (_) {}
        }
        // First use - no license yet, allow
        return true;
    }

    const now = Math.floor(Date.now() / 1000);

    // Inactive
    if (licenseData.is_active === 0 || licenseData.is_active === false) {
        if (overlay) {
            overlay.style.display = 'flex';
            const title = document.getElementById('licenseExpiredTitle');
            const msg = document.getElementById('licenseExpiredMessage');
            if (title) title.textContent = 'المتجر معطل';
            if (msg) msg.textContent = 'هذا المتجر معطل حالياً. تواصل مع إدارة النظام لتفعيل الاشتراك.';
        }
        return false;
    }

    // Expired
    const exp = licenseData.exp;
    if (exp && exp <= now) {
        if (overlay) {
            overlay.style.display = 'flex';
            const title = document.getElementById('licenseExpiredTitle');
            const msg = document.getElementById('licenseExpiredMessage');
            if (title) title.textContent = 'انتهت صلاحية الترخيص';
            const expDate = new Date(exp * 1000).toLocaleDateString('ar-EG');
            if (msg) msg.textContent = 'انتهت صلاحية الترخيص بتاريخ ' + expDate + '. يرجى تجديد الاشتراك للمتابعة.';
        }
        return false;
    }

    // Warning (7 days or less)
    if (exp) {
        const remaining = exp - now;
        const daysLeft = remaining / 86400;
        if (daysLeft <= 7) {
            if (banner && bannerText) {
                banner.style.display = 'block';
                if (daysLeft <= 1) {
                    banner.style.background = '#e74c3c';
                    banner.style.color = '#fff';
                    const hours = Math.floor(remaining / 3600);
                    bannerText.textContent = '⚠ ينتهي الترخيص خلال ' + hours + ' ساعة. يرجى تجديد الاشتراك فوراً!';
                } else {
                    banner.style.background = '#f39c12';
                    banner.style.color = '#333';
                    const days = Math.floor(daysLeft);
                    bannerText.textContent = '⚠ ينتهي الترخيص خلال ' + days + ' يوم. يرجى تجديد الاشتراك.';
                }
            }
        } else {
            if (banner) banner.style.display = 'none';
        }
    }

    // Valid - hide overlay
    if (overlay) overlay.style.display = 'none';
    return true;
}

async function attemptLicenseRenewal() {
    const status = document.getElementById('licenseRenewStatus');
    if (status) status.textContent = 'جاري التحقق من الاتصال...';

    const online = await checkRealConnection();
    if (!online) {
        if (status) status.textContent = '⛔ لا يوجد اتصال بالخادم. تأكد من اتصالك بالإنترنت.';
        return;
    }

    if (status) status.textContent = 'جاري تجديد الترخيص...';
    try {
        const resp = await fetch(API_URL + '/api/license/refresh-token');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (data.success && data.token) {
            const parts = data.token.split('.');
            const payload = JSON.parse(atob(parts[1]));
            await saveLicenseData(payload);
            if (status) status.textContent = 'تم تجديد الترخيص بنجاح!';
            await checkLicense();
            return;
        }
        if (status) status.textContent = '⛔ فشل تجديد الترخيص: ' + (data.error || 'خطأ غير معروف');
    } catch (e) {
        console.warn('[License] Renewal error:', e);
        if (status) status.textContent = '⛔ فشل الاتصال بالخادم. حاول مرة أخرى.';
    }
}

// حماية من عدم تحميل localDB في وضع أوفلاين
if (typeof localDB === 'undefined') {
    window.localDB = { isReady: false, init: async()=>{}, save:async()=>{}, saveAll:async()=>{}, getAll:async()=>[], get:async()=>null, add:async()=>{}, delete:async()=>{} };
}

// === فحص الاتصال الحقيقي (بدلاً من navigator.onLine غير الموثوق) ===
let _realOnlineStatus = navigator.onLine;
async function checkRealConnection() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`${API_URL}/api/settings?_ping=1`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal
        });
        clearTimeout(timeout);
        _realOnlineStatus = resp.ok || resp.status < 500;
        return _realOnlineStatus;
    } catch (e) {
        _realOnlineStatus = false;
        return false;
    }
}
// فحص دوري كل 5 ثواني
setInterval(async () => {
    const wasOnline = _realOnlineStatus;
    await checkRealConnection();
    // عند تغيير الحالة
    if (wasOnline !== _realOnlineStatus) {
        if (typeof updateLogoutButton === 'function') updateLogoutButton();
        // عند العودة أونلاين - مزامنة فورية!
        if (_realOnlineStatus && !wasOnline) {
            console.log('[Connection] Back online - syncing immediately...');
            if (typeof syncManager !== 'undefined') {
                try { syncManager.sync(); } catch(e) {}
            }
            if (typeof syncOfflineCustomers === 'function') {
                try { syncOfflineCustomers(); } catch(e) {}
            }
            if (typeof loadCustomersDropdown === 'function') {
                try { loadCustomersDropdown(); } catch(e) {}
            }
        }
    }
    // Check license grace period
    if (typeof checkLicenseGracePeriod === 'function') {
        try { checkLicenseGracePeriod(); } catch(e) {}
    }
}, 5000);

// === License grace period check (delegates to checkLicense) ===
function checkLicenseGracePeriod() {
    checkLicense().catch(e => console.warn('[License] Check error:', e));
}

async function forceLicenseRefresh() {
    const text = document.getElementById('licenseWarningText');
    if (text) text.textContent = 'جاري تجديد الترخيص...';
    try {
        const resp = await fetch(API_URL + '/api/license/refresh-token');
        if (resp.ok) {
            const data = await resp.json();
            if (data.success && data.token) {
                try {
                    const parts = data.token.split('.');
                    const payload = JSON.parse(atob(parts[1]));
                    await saveLicenseData(payload);
                } catch (_) {}
                await checkLicense();
                return;
            }
        }
        if (text) text.textContent = '⛔ فشل تجديد الترخيص. تأكد من الاتصال بالخادم.';
    } catch (e) {
        if (text) text.textContent = '⛔ فشل تجديد الترخيص. تأكد من الاتصال بالخادم.';
    }
}

let currentUser = null;
let cart = [];
let allProducts = [];
let allProductsTable = [];
let allInvoices = [];
let allCustomers = [];
let currentInvoice = null;
let categories = new Set();
let storeLogo = null;

// ===== نظام Multi-Tenancy =====
let currentTenantSlug = localStorage.getItem('pos_tenant_slug') || '';
let currentSuperAdmin = null;

// إعادة تعريف fetch لإضافة هيدر المستأجر + التوثيق تلقائياً
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
    if (typeof url === 'string' && url.includes('/api/')) {
        options.headers = options.headers || {};
        if (options.headers instanceof Headers) {
            if (currentTenantSlug) options.headers.set('X-Tenant-ID', currentTenantSlug);
            const authToken = localStorage.getItem('pos_auth_token');
            if (authToken) options.headers.set('Authorization', 'Bearer ' + authToken);
        } else {
            if (currentTenantSlug) options.headers['X-Tenant-ID'] = currentTenantSlug;
            const authToken = localStorage.getItem('pos_auth_token');
            if (authToken) options.headers['Authorization'] = 'Bearer ' + authToken;
        }
    }
    return originalFetch.call(this, url, options).then(response => {
        // Handle 401 - only redirect for critical API calls, not background tasks
        if (response.status === 401 && typeof url === 'string' && url.includes('/api/') && !url.includes('/api/login')) {
            // Don't redirect for background/non-critical calls
            const skipRedirect = ['/api/attendance/', '/api/system-logs', '/api/sync/', '/api/shifts/'];
            const isBackground = skipRedirect.some(p => url.includes(p));
            if (!isBackground) {
                localStorage.removeItem('pos_auth_token');
                localStorage.removeItem('pos_current_user');
                localStorage.removeItem('pos_super_admin');
                if (currentUser || currentSuperAdmin) {
                    currentUser = null;
                    currentSuperAdmin = null;
                    document.getElementById('loginOverlay').classList.remove('hidden');
                    document.getElementById('mainContainer').style.display = 'none';
                    document.getElementById('superAdminDashboard').style.display = 'none';
                }
            }
        }
        return response;
    });
};

// Helper for authenticated API calls (adds auth token to originalFetch)
function authFetch(url, options = {}) {
    options.headers = options.headers || {};
    const authToken = localStorage.getItem('pos_auth_token');
    if (authToken) options.headers['Authorization'] = 'Bearer ' + authToken;
    return originalFetch(url, options);
}

// استعادة معرف المتجر في حقل الإدخال عند فتح الصفحة
(function() {
    const input = document.getElementById('loginTenantSlug');
    if (input && currentTenantSlug) {
        input.value = currentTenantSlug;
    }
})();

// ===== وضع العرض (كمبيوتر / موبايل) =====
function selectViewMode(mode) {
    localStorage.setItem('pos_view_mode', mode);
    applyViewMode(mode);
    // تحديث الأزرار
    document.getElementById('desktopModeBtn')?.classList.toggle('active', mode === 'desktop');
    document.getElementById('mobileModeBtn')?.classList.toggle('active', mode === 'mobile');
}

function applyViewMode(mode) {
    if (mode === 'mobile') {
        document.body.classList.add('mobile-mode');
        // تحديث viewport للموبايل
        let viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            viewport.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes');
        }
    } else {
        document.body.classList.remove('mobile-mode');
        let viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            viewport.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
        }
    }
}

// استعادة وضع العرض المحفوظ
(function() {
    const savedMode = localStorage.getItem('pos_view_mode') || 'desktop';
    applyViewMode(savedMode);
    // تحديث الأزرار عند تحميل الصفحة
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('desktopModeBtn')?.classList.toggle('active', savedMode === 'desktop');
        document.getElementById('mobileModeBtn')?.classList.toggle('active', savedMode === 'mobile');
    });
})();

// ===== شاشة إعداد الخادم (أول تشغيل) =====
let _setupVerified = false;
let _setupVerifiedData = null;

async function checkFirstTimeSetup() {
    // 1) Check HMAC-verified config
    const config = await loadAndVerifySetupConfig();
    if (config) {
        // Restore legacy keys for backward compatibility
        if (config.server_url) {
            localStorage.setItem('pos_sync_server_url', config.server_url);
            localStorage.setItem('pos_server_url', config.server_url);
        }
        if (config.tenant_slug) {
            localStorage.setItem('pos_tenant_slug', config.tenant_slug);
            currentTenantSlug = config.tenant_slug;
        }
        return false;
    }
    // 2) Legacy check
    const configured = localStorage.getItem('pos_flask_server_url_configured');
    const skipped = localStorage.getItem('pos_setup_skipped');
    if (configured || skipped) return false;

    // 3) First run — show setup
    const setupOverlay = document.getElementById('serverSetupOverlay');
    const loginOverlay = document.getElementById('loginOverlay');
    if (setupOverlay) {
        setupOverlay.style.display = '';
        if (loginOverlay) loginOverlay.style.display = 'none';
        // Electron: auto-fill localhost, show skip
        if (window.location.protocol === 'file:') {
            const urlInput = document.getElementById('setupServerUrl');
            if (urlInput) { urlInput.value = 'http://localhost:5050'; urlInput.readOnly = true; urlInput.style.background = '#f1f5f9'; }
            const skipC = document.getElementById('setupSkipContainer');
            if (skipC) skipC.style.display = 'block';
        }
        // Capacitor: auto-fill remote
        if (window.Capacitor && window.Capacitor.isNativePlatform()) {
            const urlInput = document.getElementById('setupServerUrl');
            if (urlInput && !urlInput.value) urlInput.value = 'https://my-pos.org';
        }
        return true;
    }
    return false;
}

async function testSetupConnection() {
    const urlInput = document.getElementById('setupServerUrl');
    const slugInput = document.getElementById('setupTenantSlug');
    const resultDiv = document.getElementById('setupTestResult');
    const subInfoDiv = document.getElementById('setupSubscriptionInfo');
    const saveBtn = document.getElementById('setupSaveBtn');

    _setupVerified = false;
    _setupVerifiedData = null;
    if (saveBtn) { saveBtn.style.opacity = '0.5'; saveBtn.style.pointerEvents = 'none'; }
    if (subInfoDiv) subInfoDiv.style.display = 'none';

    let url = (urlInput ? urlInput.value : '').trim().replace(/\/+$/, '');
    let slug = (slugInput ? slugInput.value : '').trim();

    if (!url) {
        resultDiv.innerHTML = '<span style="color:#e74c3c;">الرجاء إدخال عنوان الخادم</span>';
        return;
    }

    // Step 1: Test basic connection
    resultDiv.innerHTML = '<span style="color:#888;">جاري الاتصال بالخادم...</span>';
    let serverVersion = '';
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(url + '/api/version', { method: 'GET', cache: 'no-store', signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error('status ' + resp.status);
        const vData = await resp.json();
        serverVersion = vData.version || vData.data || '';
        resultDiv.innerHTML = '<span style="color:#22c55e;">&#10003; متصل بنجاح' + (serverVersion ? ' &mdash; v' + escHTML(String(serverVersion)) : '') + '</span>';
    } catch (err) {
        resultDiv.innerHTML = '<span style="color:#e74c3c;">&#10007; فشل الاتصال: ' + escHTML(err.message) + '</span>';
        return;
    }

    // Step 2: Verify tenant subscription
    if (slug) {
        resultDiv.innerHTML += '<br><span style="color:#888;">جاري التحقق من المتجر...</span>';
        try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 5000);
            const resp2 = await fetch(url + '/api/tenant/check-status?slug=' + encodeURIComponent(slug), {
                method: 'GET', cache: 'no-store', signal: controller2.signal
            });
            clearTimeout(timeout2);
            const tenantData = await resp2.json();

            if (!tenantData.success) {
                resultDiv.innerHTML = '<span style="color:#e74c3c;">&#10007; ' + escHTML(tenantData.error || 'معرف المتجر غير صحيح') + '</span>';
                return;
            }
            if (!tenantData.is_active) {
                resultDiv.innerHTML = '<span style="color:#e74c3c;">&#10007; هذا المتجر معطل. تواصل مع إدارة النظام.</span>';
                return;
            }

            // Show subscription info
            const planNames = { 'basic': 'أساسية', 'premium': 'متقدمة', 'enterprise': 'مؤسسات' };
            if (subInfoDiv) {
                subInfoDiv.style.display = 'block';
                subInfoDiv.innerHTML = '<div style="font-weight:bold; margin-bottom:6px; color:#15803d;">&#9989; المتجر: ' + escHTML(tenantData.name) + '</div>'
                    + '<div>الخطة: <strong>' + escHTML(planNames[tenantData.plan] || tenantData.plan || 'basic') + '</strong></div>'
                    + '<div>الوضع: <strong>' + (tenantData.mode === 'offline' ? 'أوفلاين' : 'أونلاين') + '</strong></div>'
                    + (tenantData.expires_at ? '<div>ينتهي: <strong>' + escHTML(tenantData.expires_at.substring(0, 10)) + '</strong></div>' : '');
            }

            _setupVerifiedData = {
                server_url: url,
                tenant_slug: slug,
                tenant_name: tenantData.name || '',
                plan: tenantData.plan || 'basic',
                mode: tenantData.mode || 'online',
                is_active: tenantData.is_active ? 1 : 0,
                expires_at: tenantData.expires_at || '',
                verified_at: new Date().toISOString()
            };
            _setupVerified = true;
            if (saveBtn) { saveBtn.style.opacity = '1'; saveBtn.style.pointerEvents = 'auto'; }
            resultDiv.innerHTML = '<span style="color:#22c55e;">&#10003; تم التحقق بنجاح! اضغط "حفظ والمتابعة"</span>';
        } catch (err) {
            resultDiv.innerHTML = '<span style="color:#e74c3c;">&#10007; فشل التحقق من المتجر: ' + escHTML(err.message) + '</span>';
        }
    } else {
        // No slug — allow save with server URL only
        _setupVerifiedData = {
            server_url: url,
            tenant_slug: '',
            tenant_name: '',
            plan: '',
            mode: '',
            is_active: 1,
            expires_at: '',
            verified_at: new Date().toISOString()
        };
        _setupVerified = true;
        if (saveBtn) { saveBtn.style.opacity = '1'; saveBtn.style.pointerEvents = 'auto'; }
    }
}

async function saveServerSetup() {
    if (!_setupVerified || !_setupVerifiedData) {
        document.getElementById('setupTestResult').innerHTML = '<span style="color:#e74c3c;">يجب اختبار الاتصال أولاً</span>';
        return;
    }
    const config = _setupVerifiedData;
    // Save HMAC-signed config
    await saveSetupConfig(config);
    // Legacy keys for backward compat
    localStorage.setItem('pos_sync_server_url', config.server_url);
    localStorage.setItem('pos_server_url', config.server_url);
    localStorage.setItem('pos_sync_mode', 'server');
    localStorage.setItem('pos_flask_server_url_configured', '1');
    if (config.tenant_slug) {
        localStorage.setItem('pos_tenant_slug', config.tenant_slug);
        currentTenantSlug = config.tenant_slug;
    }
    if (config.expires_at) {
        localStorage.setItem('pos_license_active', config.is_active ? '1' : '0');
    }
    // Fire-and-forget: save to server settings
    fetch(API_URL + '/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flask_server_url: config.server_url })
    }).catch(() => {});
    // Transition to login
    document.getElementById('serverSetupOverlay').style.display = 'none';
    document.getElementById('loginOverlay').style.display = '';
    // Pre-fill tenant slug in login form
    if (config.tenant_slug) {
        const slugInput = document.getElementById('loginTenantSlug');
        if (slugInput) slugInput.value = config.tenant_slug;
    }
}

async function skipServerSetup() {
    const config = {
        server_url: '',
        tenant_slug: '',
        tenant_name: '',
        plan: '',
        mode: 'local',
        is_active: 1,
        expires_at: '',
        skipped: true,
        verified_at: new Date().toISOString()
    };
    await saveSetupConfig(config);
    localStorage.setItem('pos_setup_skipped', '1');
    document.getElementById('serverSetupOverlay').style.display = 'none';
    document.getElementById('loginOverlay').style.display = '';
}

function openServerSetup() {
    const setupOverlay = document.getElementById('serverSetupOverlay');
    const loginOverlay = document.getElementById('loginOverlay');
    if (setupOverlay) {
        const savedUrl = localStorage.getItem('pos_sync_server_url') || localStorage.getItem('pos_server_url') || '';
        const savedSlug = localStorage.getItem('pos_tenant_slug') || '';
        const urlInput = document.getElementById('setupServerUrl');
        const slugInput = document.getElementById('setupTenantSlug');
        if (urlInput && savedUrl) urlInput.value = savedUrl;
        if (slugInput && savedSlug) slugInput.value = savedSlug;
        document.getElementById('setupTestResult').innerHTML = '';
        const subInfoDiv = document.getElementById('setupSubscriptionInfo');
        if (subInfoDiv) subInfoDiv.style.display = 'none';
        const saveBtn = document.getElementById('setupSaveBtn');
        if (saveBtn) { saveBtn.style.opacity = '0.5'; saveBtn.style.pointerEvents = 'none'; }
        _setupVerified = false;
        _setupVerifiedData = null;
        setupOverlay.style.display = '';
        if (loginOverlay) loginOverlay.style.display = 'none';
    }
}

// استعادة المستخدم من localStorage
function restoreUser() {
    const savedUser = localStorage.getItem('pos_current_user');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            return true;
        } catch (e) {
            console.error('[App] Failed to restore user:', e);
            localStorage.removeItem('pos_current_user');
            return false;
        }
    }
    return false;
}

// تهيئة الواجهة بعد استعادة المستخدم
async function initializeUI() {
    if (!currentUser) return;
    
    // إخفاء شاشة Login وإظهار النظام
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('mainContainer').style.display = 'block';

    // تحديث حالة زر الخروج
    updateLogoutButton();
    
    // عرض اسم المستخدم
    const branchText = currentUser.branch_name ? ` - ${currentUser.branch_name}` : '';
    document.getElementById('userInfo').textContent = `${currentUser.full_name} (${currentUser.invoice_prefix || 'INV'})${branchText}`;
    
    // نظام الصلاحيات
    const isAdmin = currentUser.role === 'admin';
    const hasPerm = (perm) => isAdmin || currentUser[perm] === 1;
    
    window.userPermissions = {
        isAdmin: isAdmin,
        canViewProducts: hasPerm('can_view_products'),
        canAddProducts: hasPerm('can_add_products'),
        canEditProducts: hasPerm('can_edit_products'),
        canDeleteProducts: hasPerm('can_delete_products'),
        canViewInventory: hasPerm('can_view_inventory'),
        canAddInventory: hasPerm('can_add_inventory'),
        canEditInventory: hasPerm('can_edit_inventory'),
        canDeleteInventory: hasPerm('can_delete_inventory'),
        canViewInvoices: hasPerm('can_view_invoices'),
        canDeleteInvoices: hasPerm('can_delete_invoices'),
        canViewCustomers: hasPerm('can_view_customers'),
        canAddCustomer: hasPerm('can_add_customer'),
        canEditCustomer: hasPerm('can_edit_customer'),
        canDeleteCustomer: hasPerm('can_delete_customer'),
        canViewReports: hasPerm('can_view_reports'),
        canViewAccounting: hasPerm('can_view_accounting'),
        canManageUsers: hasPerm('can_manage_users'),
        canAccessSettings: hasPerm('can_access_settings'),
        canViewReturns: hasPerm('can_view_returns'),
        canViewExpenses: hasPerm('can_view_expenses'),
        canViewSuppliers: hasPerm('can_view_suppliers'),
        canViewCoupons: hasPerm('can_view_coupons'),
        canViewTables: hasPerm('can_view_tables'),
        canViewAttendance: hasPerm('can_view_attendance'),
        canViewAdvancedReports: hasPerm('can_view_advanced_reports'),
        canViewSystemLogs: hasPerm('can_view_system_logs'),
        canViewDcf: hasPerm('can_view_dcf'),
        canCancelInvoices: hasPerm('can_cancel_invoices'),
        canViewBranches: hasPerm('can_view_branches'),
        canViewCrossBranchStock: hasPerm('can_view_cross_branch_stock'),
        canViewXbrl: hasPerm('can_view_xbrl'),
        canEditCompletedInvoices: hasPerm('can_edit_completed_invoices'),
        canViewTransfers: hasPerm('can_view_transfers'),
        canCreateTransfer: hasPerm('can_create_transfer'),
        canApproveTransfer: hasPerm('can_approve_transfer'),
        canDeliverTransfer: hasPerm('can_deliver_transfer'),
        canViewSubscriptions: hasPerm('can_view_subscriptions'),
        canManageSubscriptions: hasPerm('can_manage_subscriptions')
    };

    // إخفاء/إظهار الأزرار والتبويبات
    document.getElementById('settingsBtn').style.display = window.userPermissions.canAccessSettings ? 'inline-block' : 'none';
    document.getElementById('backupBtn').style.display = window.userPermissions.canAccessSettings ? 'inline-block' : 'none';
    document.getElementById('usersBtn').style.display = window.userPermissions.canManageUsers ? 'inline-block' : 'none';
    document.getElementById('branchesBtn').style.display = window.userPermissions.canViewBranches ? 'inline-block' : 'none';
    document.getElementById('systemLogsBtn').style.display = window.userPermissions.canViewSystemLogs ? 'inline-block' : 'none';
    document.getElementById('clearInvoicesBtn').style.display = window.userPermissions.canDeleteInvoices ? 'inline-block' : 'none';
    document.getElementById('expensesBtn').style.display = window.userPermissions.canViewExpenses ? 'inline-block' : 'none';
    document.getElementById('dcfBtn').style.display = window.userPermissions.canViewDcf ? 'inline-block' : 'none';
    document.getElementById('advancedReportsBtn').style.display = window.userPermissions.canViewAdvancedReports ? 'inline-block' : 'none';
    document.getElementById('suppliersBtn').style.display = window.userPermissions.canViewSuppliers ? 'inline-block' : 'none';
    document.getElementById('couponsBtn').style.display = window.userPermissions.canViewCoupons ? 'inline-block' : 'none';
    document.getElementById('tablesBtn').style.display = window.userPermissions.canViewTables ? 'inline-block' : 'none';
    document.getElementById('returnsBtn').style.display = window.userPermissions.canViewReturns ? 'inline-block' : 'none';
    document.getElementById('attendanceBtn').style.display = window.userPermissions.canViewAttendance ? 'inline-block' : 'none';
    document.getElementById('xbrlBtn').style.display = window.userPermissions.canViewXbrl ? 'inline-block' : 'none';
    document.getElementById('adminDashboardBtn').style.display = window.userPermissions.isAdmin ? 'inline-block' : 'none';
    document.getElementById('transfersBtn').style.display = window.userPermissions.canViewTransfers ? 'inline-block' : 'none';
    document.getElementById('subscriptionsBtn').style.display = window.userPermissions.canViewSubscriptions ? 'inline-block' : 'none';
    const _mpBtn = document.getElementById('managePlansBtn');
    if (_mpBtn) _mpBtn.style.display = window.userPermissions.canManageSubscriptions ? 'inline-block' : 'none';
    // عرض خانة اختيار الطاولة في نقطة البيع
    loadTablesDropdown();

    // التبويبات
    const customersTab = document.querySelector('[data-tab="customers"]');
    if (customersTab) customersTab.style.display = window.userPermissions.canViewCustomers ? 'inline-block' : 'none';

    const productsTab = document.querySelector('[data-tab="products"]');
    if (productsTab) productsTab.style.display = window.userPermissions.canViewProducts ? 'inline-block' : 'none';

    const reportTab = document.querySelector('[data-tab="reports"]');
    if (reportTab) reportTab.style.display = window.userPermissions.canViewReports ? 'inline-block' : 'none';

    const accountingTab = document.querySelector('[data-tab="accounting"]');
    if (accountingTab) accountingTab.style.display = window.userPermissions.canViewAccounting ? 'inline-block' : 'none';

    const inventoryTab = document.querySelector('[data-tab="inventory"]');
    if (inventoryTab) inventoryTab.style.display = window.userPermissions.canViewInventory ? 'inline-block' : 'none';

    // إخفاء زر إضافة منتج إذا لم يكن لديه صلاحية
    if (!window.userPermissions.canAddProducts) {
        const addProductBtn = document.querySelector('.add-btn');
        if (addProductBtn && addProductBtn.textContent.includes('إضافة')) {
            addProductBtn.style.display = 'none';
        }
    }

    // تحميل البيانات
    await loadProducts();
    await loadSettings();
    loadUserCart();
    showTab('pos');

    // تشغيل فاحص قفل الشفت
    startShiftLockChecker();

    // تشغيل المزامنة التلقائية بالفترة المحفوظة
    if (typeof syncManager !== 'undefined') {
        syncManager.start(); // uses saved interval from localStorage
    }

    // فحص صلاحية الترخيص
    checkLicenseGracePeriod();

    console.log('[App] User restored from localStorage ✅');
}

// دوال إدارة السلة حسب المستخدم
function loadUserCart() {
    if (!currentUser) {
        cart = [];
        return;
    }
    const cartKey = `pos_cart_${currentUser.id}`;
    const savedCart = localStorage.getItem(cartKey);
    cart = savedCart ? JSON.parse(savedCart) : [];
    updateCart();
}

function saveUserCart() {
    if (!currentUser) return;
    const cartKey = `pos_cart_${currentUser.id}`;
    localStorage.setItem(cartKey, JSON.stringify(cart));
}

function clearUserCart() {
    if (!currentUser) return;
    const cartKey = `pos_cart_${currentUser.id}`;
    localStorage.removeItem(cartKey);
    cart = [];
}

// Icons

// Login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const rawUsername = document.getElementById('loginUsername').value;
        const password = document.getElementById('loginPassword').value;

        // === كشف دخول المدير الأعلى: username+superadmin# ===
        const saMatch = rawUsername.match(/^(.+)\+superadmin#$/);
        if (saMatch) {
            const saUsername = saMatch[1];
            const response = await originalFetch(`${API_URL}/api/super-admin/login`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: saUsername, password: password })
            });
            const data = await response.json();
            if (data.success) {
                currentSuperAdmin = data.admin;
                if (data.token) localStorage.setItem('pos_auth_token', data.token);
                localStorage.setItem('pos_super_admin', JSON.stringify(data.admin));
                document.getElementById('loginOverlay').classList.add('hidden');
                document.getElementById('mainContainer').style.display = 'none';
                document.getElementById('superAdminDashboard').style.display = 'block';
                document.getElementById('saUserInfo').textContent = currentSuperAdmin.full_name;
                document.getElementById('loginForm').reset();
                loadSuperAdminDashboard();
            } else {
                alert(data.error || 'فشل تسجيل الدخول');
            }
            return;
        }

        // === دخول عادي ===
        // حفظ المستأجر المختار - مطلوب
        const selectedTenant = (document.getElementById('loginTenantSlug')?.value || '').trim();
        if (!selectedTenant) {
            alert('معرف المتجر مطلوب');
            return;
        }
        currentTenantSlug = selectedTenant;
        localStorage.setItem('pos_tenant_slug', selectedTenant);

        const response = await fetch(`${API_URL}/api/login`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                username: rawUsername,
                password: password
            })
        });
        const data = await response.json();
        if (data.success) {
            currentUser = data.user;

            // حفظ التوكن والمستخدم في localStorage
            if (data.token) localStorage.setItem('pos_auth_token', data.token);
            localStorage.setItem('pos_current_user', JSON.stringify(data.user));

            // حفظ بيانات الترخيص للعمل بدون اتصال (HMAC-signed)
            if (data.license) {
                localStorage.setItem('pos_offline_license', JSON.stringify(data.license));
                await saveLicenseData(data.license);
            }
            
            document.getElementById('loginOverlay').classList.add('hidden');
            document.getElementById('mainContainer').style.display = 'block';
            
            // عرض اسم المستخدم مع الفرع
            const branchText = currentUser.branch_name ? ` - ${currentUser.branch_name}` : '';
            document.getElementById('userInfo').textContent = `${currentUser.full_name} (${currentUser.invoice_prefix || 'INV'})${branchText}`;
            
            // نظام الصلاحيات الكامل
            const isAdmin = currentUser.role === 'admin';
            const hasPerm = (perm) => isAdmin || currentUser[perm] === 1;
            
            // حفظ الصلاحيات عالمياً
            window.userPermissions = {
                isAdmin: isAdmin,
                canViewProducts: hasPerm('can_view_products'),
                canAddProducts: hasPerm('can_add_products'),
                canEditProducts: hasPerm('can_edit_products'),
                canDeleteProducts: hasPerm('can_delete_products'),
                canViewInventory: hasPerm('can_view_inventory'),
                canAddInventory: hasPerm('can_add_inventory'),
                canEditInventory: hasPerm('can_edit_inventory'),
                canDeleteInventory: hasPerm('can_delete_inventory'),
                canViewInvoices: hasPerm('can_view_invoices'),
                canDeleteInvoices: hasPerm('can_delete_invoices'),
                canViewCustomers: hasPerm('can_view_customers'),
                canAddCustomer: hasPerm('can_add_customer'),
                canEditCustomer: hasPerm('can_edit_customer'),
                canDeleteCustomer: hasPerm('can_delete_customer'),
                canViewReports: hasPerm('can_view_reports'),
                canViewAccounting: hasPerm('can_view_accounting'),
                canManageUsers: hasPerm('can_manage_users'),
                canAccessSettings: hasPerm('can_access_settings'),
                canViewReturns: hasPerm('can_view_returns'),
                canViewExpenses: hasPerm('can_view_expenses'),
                canViewSuppliers: hasPerm('can_view_suppliers'),
                canViewCoupons: hasPerm('can_view_coupons'),
                canViewTables: hasPerm('can_view_tables'),
                canViewAttendance: hasPerm('can_view_attendance'),
                canViewAdvancedReports: hasPerm('can_view_advanced_reports'),
                canViewSystemLogs: hasPerm('can_view_system_logs'),
                canViewDcf: hasPerm('can_view_dcf'),
                canCancelInvoices: hasPerm('can_cancel_invoices'),
                canViewBranches: hasPerm('can_view_branches'),
                canViewCrossBranchStock: hasPerm('can_view_cross_branch_stock'),
                canViewXbrl: hasPerm('can_view_xbrl'),
                canEditCompletedInvoices: hasPerm('can_edit_completed_invoices'),
                canViewTransfers: hasPerm('can_view_transfers'),
                canCreateTransfer: hasPerm('can_create_transfer'),
                canApproveTransfer: hasPerm('can_approve_transfer'),
                canDeliverTransfer: hasPerm('can_deliver_transfer'),
                canViewSubscriptions: hasPerm('can_view_subscriptions'),
                canManageSubscriptions: hasPerm('can_manage_subscriptions')
            };

            // إخفاء/إظهار الأزرار والتبويبات
            document.getElementById('settingsBtn').style.display = window.userPermissions.canAccessSettings ? 'inline-block' : 'none';
            document.getElementById('backupBtn').style.display = window.userPermissions.canAccessSettings ? 'inline-block' : 'none';
            document.getElementById('usersBtn').style.display = window.userPermissions.canManageUsers ? 'inline-block' : 'none';
            document.getElementById('branchesBtn').style.display = window.userPermissions.canViewBranches ? 'inline-block' : 'none';
            document.getElementById('systemLogsBtn').style.display = window.userPermissions.canViewSystemLogs ? 'inline-block' : 'none';
            document.getElementById('clearInvoicesBtn').style.display = window.userPermissions.canDeleteInvoices ? 'inline-block' : 'none';
            document.getElementById('expensesBtn').style.display = window.userPermissions.canViewExpenses ? 'inline-block' : 'none';
            document.getElementById('dcfBtn').style.display = window.userPermissions.canViewDcf ? 'inline-block' : 'none';
            document.getElementById('advancedReportsBtn').style.display = window.userPermissions.canViewAdvancedReports ? 'inline-block' : 'none';
            document.getElementById('suppliersBtn').style.display = window.userPermissions.canViewSuppliers ? 'inline-block' : 'none';
            document.getElementById('couponsBtn').style.display = window.userPermissions.canViewCoupons ? 'inline-block' : 'none';
            document.getElementById('tablesBtn').style.display = window.userPermissions.canViewTables ? 'inline-block' : 'none';
            document.getElementById('returnsBtn').style.display = window.userPermissions.canViewReturns ? 'inline-block' : 'none';
            document.getElementById('attendanceBtn').style.display = window.userPermissions.canViewAttendance ? 'inline-block' : 'none';
            document.getElementById('xbrlBtn').style.display = window.userPermissions.canViewXbrl ? 'inline-block' : 'none';
            document.getElementById('adminDashboardBtn').style.display = window.userPermissions.isAdmin ? 'inline-block' : 'none';
            document.getElementById('transfersBtn').style.display = window.userPermissions.canViewTransfers ? 'inline-block' : 'none';
            document.getElementById('subscriptionsBtn').style.display = window.userPermissions.canViewSubscriptions ? 'inline-block' : 'none';
            const _mpBtn2 = document.getElementById('managePlansBtn');
            if (_mpBtn2) _mpBtn2.style.display = window.userPermissions.canManageSubscriptions ? 'inline-block' : 'none';
            // عرض خانة اختيار الطاولة في نقطة البيع
            loadTablesDropdown();

            // التبويبات
            const customersTab = document.querySelector('[data-tab="customers"]');
            if (customersTab) customersTab.style.display = window.userPermissions.canViewCustomers ? 'inline-block' : 'none';

            // التبويبات
            const productsTab = document.querySelector('[data-tab="products"]');
            if (productsTab) productsTab.style.display = window.userPermissions.canViewProducts ? 'inline-block' : 'none';
            
            const reportTab = document.querySelector('[data-tab="reports"]');
            if (reportTab) reportTab.style.display = window.userPermissions.canViewReports ? 'inline-block' : 'none';
            
            const accountingTab = document.querySelector('[data-tab="accounting"]');
            if (accountingTab) accountingTab.style.display = window.userPermissions.canViewAccounting ? 'inline-block' : 'none';
            
            // تبويب المخزون
            const inventoryTab = document.querySelector('[data-tab="inventory"]');
            if (inventoryTab) inventoryTab.style.display = window.userPermissions.canViewInventory ? 'inline-block' : 'none';
            
            // إخفاء زر إضافة منتج إذا لم يكن لديه صلاحية
            if (!window.userPermissions.canAddProducts) {
                const addProductBtn = document.querySelector('.add-btn');
                if (addProductBtn && addProductBtn.textContent.includes('إضافة')) {
                    addProductBtn.style.display = 'none';
                }
            }
            
            // تسجيل الحضور (محاولة بدون تعطيل Login)
            recordCheckIn().catch(() => console.log('لم يتم تسجيل الحضور'));
            
            // تسجيل في سجل النظام
            setTimeout(() => {
                logAction('login', 'تسجيل دخول', null);
            }, 1000);

            await loadProducts();
            await loadSettings();
            loadUserCart(); // تحميل سلة المستخدم
            showTab('pos');

            // تشغيل فاحص قفل الشفت
            startShiftLockChecker();

            // فحص صلاحية الترخيص
            checkLicenseGracePeriod();
        } else {
            alert(data.error || 'فشل تسجيل الدخول');
        }
    } catch (error) {
        console.error('خطأ:', error);
        alert('فشل الاتصال');
    }
});

function updateLogoutButton() {
    // no-op: logout is always allowed
}
window.addEventListener('online', () => { checkRealConnection().then(updateLogoutButton); });
window.addEventListener('offline', () => { _realOnlineStatus = false; updateLogoutButton(); });
setInterval(updateLogoutButton, 3000);
document.addEventListener('DOMContentLoaded', () => { checkRealConnection().then(updateLogoutButton); });
setTimeout(() => { checkRealConnection().then(updateLogoutButton); }, 500);


async function logout() {
    // إيقاف فاحص قفل الشفت
    stopShiftLockChecker();

    if (!confirm('هل أنت متأكد من تسجيل الخروج؟')) return;
    
    // تسجيل في سجل النظام أولاً
    if (currentUser) {
        try {
            await logAction('logout', 'تسجيل خروج', null);
        } catch (e) {}
    }
    
    // تسجيل الانصراف (محاولة فقط)
    if (currentUser) {
        try {
            await fetch(`${API_URL}/api/attendance/check-out`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ user_id: currentUser.id })
            });
        } catch (e) {}
    }
    
    // مسح كل البيانات
    currentUser = null;
    cart = [];
    allProducts = [];
    allInvoices = [];
    
    // مسح localStorage
    try {
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith('pos_cart_')) {
                localStorage.removeItem(key);
            }
        });
        // مسح بيانات المستخدم والتوكن المحفوظة
        localStorage.removeItem('pos_current_user');
        localStorage.removeItem('pos_auth_token');
        localStorage.removeItem('pos_tenant_slug');
        currentTenantSlug = '';
    } catch (e) {}
    
    // إعادة تعيين الواجهة
    document.getElementById('cartItems').innerHTML = '<div class="empty-cart"><div class="empty-cart-icon">🛒</div><p>السلة فارغة</p></div>';
    document.getElementById('subtotal').textContent = '0.000 د.ك';
    document.getElementById('total').textContent = '0.000 د.ك';
    document.getElementById('mainContainer').style.display = 'none';
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('loginForm').reset();
    
    // إعادة تحميل الصفحة لضمان التنظيف الكامل
    setTimeout(() => {
        window.location.reload();
    }, 100);
}

// Tabs
function showTab(tabName) {
    document.querySelectorAll('.header-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.style.display = 'none';
        tab.classList.remove('active');
    });
    
    const tabMap = {
        'pos': 'posTab',
        'products': 'productsTab',
        'inventory': 'inventoryTab',
        'invoices': 'invoicesTab',
        'returns': 'returnsTab',
        'customers': 'customersTab',
        'reports': 'reportsTab',
        'expenses': 'expensesTab',
        'advancedreports': 'advancedreportsTab',
        'systemlogs': 'systemlogsTab',
        'accounting': 'accountingTab',
        'dcf': 'dcfTab',
        'users': 'usersTab',
        'branches': 'branchesTab',
        'attendance': 'attendanceTab',
        'suppliers': 'suppliersTab',
        'coupons': 'couponsTab',
        'tables': 'tablesTab',
        'settings': 'settingsTab',
        'backup': 'backupTab',
        'admindashboard': 'admindashboardTab',
        'xbrl': 'xbrlTab',
        'transfers': 'transfersTab',
        'subscriptions': 'subscriptionsTab'
    };
    
    const tabId = tabMap[tabName];
    if (tabId) {
        const tabElement = document.getElementById(tabId);
        tabElement.style.display = 'block';
        tabElement.classList.add('active');
        
        if (tabName === 'pos') {
            loadProducts();
        }
        if (tabName === 'products') {
            loadProductsTable();
            // إخفاء زر إضافة منتج إذا لم يكن لديه صلاحية
            const addBtn = document.querySelector('#productsTab .add-btn');
            if (addBtn && window.userPermissions) {
                addBtn.style.display = window.userPermissions.canAddProducts ? 'inline-block' : 'none';
            }
        }
        if (tabName === 'inventory') {
            loadInventory();
            // إخفاء أزرار المخزون حسب الصلاحيات
            if (!window.userPermissions?.canAddInventory) {
                document.querySelectorAll('#inventoryTab .add-btn').forEach(btn => btn.style.display = 'none');
            }
        }
        if (tabName === 'invoices') loadInvoicesTable();
        if (tabName === 'returns') loadReturns();
        if (tabName === 'customers') {
            loadCustomers();
            // إخفاء أزرار العملاء حسب الصلاحيات
            const addCustomerBtn = document.querySelector('#customersTab .add-btn');
            if (addCustomerBtn) {
                addCustomerBtn.style.display = window.userPermissions?.canAddCustomer ? 'inline-block' : 'none';
            }
        }
        if (tabName === 'reports') {
            loadReports();
            loadBranchesForReports();
        }
        if (tabName === 'expenses') {
            loadBranchesForExpenseFilter();
            // تعيين التواريخ الافتراضية
            const today = new Date();
            const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
            document.getElementById('expenseStartDate').valueAsDate = firstDay;
            document.getElementById('expenseEndDate').valueAsDate = today;
            loadExpenses();
        }
        if (tabName === 'advancedreports') {
            loadBranchesForAdvReports();
            // تعيين التواريخ الافتراضية
            const today = new Date();
            const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
            document.getElementById('advReportStartDate').valueAsDate = firstDay;
            document.getElementById('advReportEndDate').valueAsDate = today;
        }
        if (tabName === 'systemlogs') loadSystemLogs();
        if (tabName === 'suppliers') loadSuppliers();
        if (tabName === 'coupons') loadCoupons();
        if (tabName === 'tables') loadTables();
        if (tabName === 'users') loadUsersTable();
        if (tabName === 'branches') loadBranchesTable();
        if (tabName === 'attendance') loadAttendanceLog();
        if (tabName === 'settings') loadSettings();
        if (tabName === 'backup') loadBackupTab();
        if (tabName === 'accounting') loadAccounting();
        if (tabName === 'xbrl') loadXBRLTab();
        if (tabName === 'admindashboard') loadAdminDashboard();
        if (tabName === 'transfers') loadStockTransfers();
        if (tabName === 'subscriptions') loadSubscriptions();
    }
}

// Products
async function loadProducts() {
    try {
        const branchId = currentUser?.branch_id || 1;
        
        // محاولة التحميل من السيرفر
        if (_realOnlineStatus) {
            const response = await fetch(`${API_URL}/api/products?branch_id=${branchId}`);
            const data = await response.json();
            if (data.success) {
                allProducts = data.products;
                data.products.forEach(p => { if(p.category) categories.add(p.category); });
                displayProducts(allProducts);
                
                // حفظ في LocalDB - مسح القديم أولاً لتجنب خلط منتجات فروع مختلفة
                if (localDB.isReady) {
                    await localDB.clear('products');
                    await localDB.saveAll('products', data.products);
                    console.log('[App] Products saved locally');
                }
            }
        } else {
            // Offline: تحميل من LocalDB
            if (localDB.isReady) {
                const localProducts = await localDB.getAll('products');
                if (localProducts.length > 0) {
                    allProducts = localProducts;
                    localProducts.forEach(p => { if(p.category) categories.add(p.category); });
                    displayProducts(allProducts);
                    console.log('[App] Loaded from local cache (offline)');
                } else {
                    alert('لا توجد منتجات محفوظة محلياً. يرجى الاتصال بالإنترنت.');
                }
            }
        }
    } catch (error) {
        console.error('خطأ:', error);
        
        // تجربة التحميل من LocalDB كـ fallback
        if (localDB.isReady) {
            const localProducts = await localDB.getAll('products');
            if (localProducts.length > 0) {
                allProducts = localProducts;
                localProducts.forEach(p => { if(p.category) categories.add(p.category); });
                displayProducts(allProducts);
                console.log('[App] Loaded from local cache (fallback)');
            }
        }
    }
}

function displayProducts(products) {
    const grid = document.getElementById('productsGrid');
    if (products.length === 0) {
        grid.innerHTML = '<p style="text-align: center; padding: 40px;">لا توجد منتجات</p>';
        return;
    }
    grid.innerHTML = products.map(p => {
        let imgDisplay = '';
        if (p.image_data && p.image_data.startsWith('data:image')) {
            imgDisplay = `<div class="product-card-icon"><img src="${p.image_data}" style="width:60px; height:60px; object-fit:cover; border-radius:8px;"></div>`;
        } else {
            imgDisplay = '<div class="product-card-icon">🛍️</div>';
        }

        // حساب الكمية الإجمالية في السلة (شاملة جميع المتغيرات)
        const inCart = cart.filter(item => item.id === p.id).reduce((sum, item) => sum + item.quantity, 0);

        const hasVariants = p.variants && p.variants.length > 0;
        const variantBadge = hasVariants ? `<div style="font-size:11px; color:#38a169; font-weight:bold; margin-top:2px;">📐 ${p.variants.length} خاصية</div>` : '';

        let counterHTML = '';
        if (inCart > 0) {
            counterHTML = `
                <div class="product-counter">
                    <button class="counter-btn" onclick="event.stopPropagation(); removeLastFromCart(${p.id})" title="تقليل">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                    <span class="counter-value">${inCart}</span>
                    <button class="counter-btn" onclick="event.stopPropagation(); addToCart(${p.id})" title="زيادة">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                </div>
            `;
        } else {
            counterHTML = `
                <button class="add-to-cart-btn" onclick="event.stopPropagation(); addToCart(${p.id})">
                    إضافة للسلة
                </button>
            `;
        }

        // أيقونة عرض التوفر في الفروع الأخرى (مربوطة بصلاحية عرض مخزون الفروع)
        let crossBranchHTML = '';
        if (p.inventory_id && window.userPermissions.canViewCrossBranchStock) {
            crossBranchHTML = `<button class="branch-stock-btn" onclick="event.stopPropagation(); showBranchStock(${p.inventory_id}, '${escHTML((p.display_name || p.name).replace(/'/g, "\\'"))}')" title="عرض التوفر في الفروع الأخرى">🏢</button>`;
        }

        return `
        <div class="product-card" style="position:relative;">
            ${crossBranchHTML}
            ${imgDisplay}
            <div class="product-card-name">${escHTML(p.display_name || p.name)}</div>
            <div class="product-card-price">${p.price.toFixed(3)} د.ك</div>
            ${variantBadge}
            <div class="product-card-stock">المخزون: ${p.stock}</div>
            ${counterHTML}
        </div>
        `;
    }).join('');
}

// عرض توفر المنتج في الفروع الأخرى
async function showBranchStock(inventoryId, productName) {
    const branchId = currentUser?.branch_id || 1;

    // إنشاء المودال
    let modal = document.getElementById('branchStockModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'branchStockModal';
        modal.className = 'modal';
        modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('active'); };
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="modal-content" style="max-width:450px;">
            <div class="modal-header">
                <h2>🏢 التوفر في الفروع</h2>
                <button class="close-btn" onclick="document.getElementById('branchStockModal').classList.remove('active')">&times;</button>
            </div>
            <div class="modal-body" style="padding:20px;">
                <div style="text-align:center; font-weight:600; margin-bottom:15px; color:#333;">${escHTML(productName)}</div>
                <div style="text-align:center; padding:30px;"><div class="spinner"></div> جاري التحميل...</div>
            </div>
        </div>
    `;
    modal.classList.add('active');

    try {
        const response = await fetch(`${API_URL}/api/branch-stock?inventory_id=${inventoryId}`);
        const data = await response.json();

        if (data.success && data.stock) {
            // تصفية الفروع الأخرى فقط (استبعاد الفرع الحالي)
            const otherBranches = data.stock.filter(s => s.branch_id != branchId && s.stock > 0);

            let bodyHTML = `<div style="text-align:center; font-weight:600; margin-bottom:15px; color:#333;">${escHTML(productName)}</div>`;

            if (otherBranches.length === 0) {
                bodyHTML += `<div style="text-align:center; padding:20px; color:#999;">غير متوفر في فروع أخرى</div>`;
            } else {
                bodyHTML += `<div class="branch-stock-list">`;
                otherBranches.forEach(b => {
                    // نحتاج اسم الفرع - نجلبه من branches endpoint أو نستخدم branch_id
                    const stockClass = b.stock > 10 ? 'high' : b.stock > 3 ? 'medium' : 'low';
                    bodyHTML += `
                        <div class="branch-stock-item">
                            <span class="branch-stock-name">🏪 ${escHTML(b.branch_name) || 'فرع ' + b.branch_id}</span>
                            <span class="branch-stock-qty ${stockClass}">${b.stock}</span>
                        </div>
                    `;
                });
                bodyHTML += `</div>`;
            }

            modal.querySelector('.modal-body').innerHTML = `<div style="padding:20px;">${bodyHTML}</div>`;
        } else {
            modal.querySelector('.modal-body').innerHTML = `<div style="padding:20px; text-align:center; color:#999;">غير متوفر في فروع أخرى</div>`;
        }
    } catch (err) {
        modal.querySelector('.modal-body').innerHTML = `<div style="padding:20px; text-align:center; color:#e74c3c;">خطأ في تحميل البيانات</div>`;
    }
}

function removeLastFromCart(productId) {
    // إزالة آخر عنصر مضاف لهذا المنتج
    const items = cart.filter(item => item.id === productId);
    if (items.length > 0) {
        const lastItem = items[items.length - 1];
        if (lastItem.quantity > 1) {
            lastItem.quantity--;
        } else {
            const idx = cart.findIndex(item => item.cartKey === lastItem.cartKey);
            if (idx !== -1) cart.splice(idx, 1);
        }
        updateCart();
    }
}

function searchProducts() {
    const query = (document.getElementById('searchInput').value || '').trim().toLowerCase();
    if (!query) {
        displayProducts(allProducts);
        return;
    }
    const filtered = allProducts.filter(p =>
        (p.display_name || p.name || '').toLowerCase().includes(query) ||
        (p.barcode || '').toLowerCase().includes(query) ||
        (p.category || '').toLowerCase().includes(query)
    );
    displayProducts(filtered);
}

// Cart
function addToCart(productId, variantId = null) {
    const product = allProducts.find(p => p.id === productId);
    if (!product || product.stock <= 0) {
        alert('المنتج غير متوفر');
        return;
    }

    // إذا المنتج موزع كخاصية محددة، استخدم بياناتها مباشرة
    if (product.variant_id && !variantId) {
        variantId = product.variant_id;
    }

    // إذا المنتج له خصائص ولم يتم تحديد واحدة ولم يكن موزع كخاصية، اعرض نافذة الاختيار
    if (product.variants && product.variants.length > 0 && !variantId && !product.variant_id) {
        showVariantSelectModal(product);
        return;
    }

    // تحديد السعر والاسم حسب الخاصية المختارة
    let itemPrice = product.price;
    let itemName = product.display_name || product.name;
    let selectedVariantId = null;
    let selectedVariantName = null;

    if (variantId && product.variants) {
        const variant = product.variants.find(v => v.id === variantId);
        if (variant) {
            itemPrice = variant.price;
            itemName = `${product.name} (${variant.variant_name})`;
            selectedVariantId = variant.id;
            selectedVariantName = variant.variant_name;
        }
    }

    // المفتاح الفريد: product_id + variant_id
    const cartKey = variantId ? `${productId}_v${variantId}` : `${productId}`;
    const existingItem = cart.find(item => item.cartKey === cartKey);

    if (existingItem) {
        if (existingItem.quantity < product.stock) {
            existingItem.quantity++;
        } else {
            alert('الكمية أكبر من المخزون');
            return;
        }
    } else {
        cart.push({
            id: product.id,
            cartKey: cartKey,
            name: itemName,
            price: itemPrice,
            quantity: 1,
            stock: product.stock,
            variant_id: selectedVariantId,
            variant_name: selectedVariantName
        });
    }
    updateCart();
}

function showVariantSelectModal(product) {
    document.getElementById('variantSelectProductName').textContent = product.name;
    const container = document.getElementById('variantSelectOptions');

    // خيار السعر الأساسي
    let html = `
        <button onclick="selectVariantAndAdd(${product.id}, null)" style="display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 15px; background: white; border: 2px solid #e2e8f0; border-radius: 10px; cursor: pointer; font-size: 16px; transition: all 0.2s;"
            onmouseover="this.style.borderColor='#667eea'; this.style.background='#f0f4ff';"
            onmouseout="this.style.borderColor='#e2e8f0'; this.style.background='white';">
            <span style="font-weight: bold;">الأساسي</span>
            <span style="color: #667eea; font-weight: bold;">${product.price.toFixed(3)} د.ك</span>
        </button>
    `;

    // خيارات المتغيرات
    product.variants.forEach(v => {
        html += `
        <button onclick="selectVariantAndAdd(${product.id}, ${v.id})" style="display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 15px; background: white; border: 2px solid #c6f6d5; border-radius: 10px; cursor: pointer; font-size: 16px; transition: all 0.2s;"
            onmouseover="this.style.borderColor='#38a169'; this.style.background='#f0fff4';"
            onmouseout="this.style.borderColor='#c6f6d5'; this.style.background='white';">
            <span style="font-weight: bold;">📐 ${v.variant_name}</span>
            <span style="color: #38a169; font-weight: bold;">${v.price.toFixed(3)} د.ك</span>
        </button>
        `;
    });

    container.innerHTML = html;
    document.getElementById('variantSelectModal').classList.add('active');
}

function selectVariantAndAdd(productId, variantId) {
    closeVariantSelect();
    addToCart(productId, variantId);
}

function closeVariantSelect() {
    document.getElementById('variantSelectModal').classList.remove('active');
}

// مسح الباركود وإضافة المنتج تلقائياً
let barcodeTimeout = null;
function onBarcodeInput(value) {
    clearTimeout(barcodeTimeout);
    if (!value || value.length < 3) return;
    barcodeTimeout = setTimeout(() => {
        const barcode = value.trim();
        // بحث في المنتجات أولاً
        const product = allProducts.find(p => p.barcode && p.barcode === barcode);
        if (product) {
            addToCart(product.id);
            document.getElementById('barcodeInput').value = '';
            try { new Audio('data:audio/wav;base64,UklGRl9vT19teleVFQAAAABmbXQgEAAAAAEAAQBBIAAAQSAAAAEACABkYXRhAAAAAA==').play(); } catch(e) {}
            return;
        }
        // بحث في باركود المتغيرات
        for (const p of allProducts) {
            if (p.variants) {
                const variant = p.variants.find(v => v.barcode && v.barcode === barcode);
                if (variant) {
                    addToCart(p.id, variant.id);
                    document.getElementById('barcodeInput').value = '';
                    try { new Audio('data:audio/wav;base64,UklGRl9vT19teleVFQAAAABmbXQgEAAAAAEAAQBBIAAAQSAAAAEACABkYXRhAAAAAA==').play(); } catch(e) {}
                    return;
                }
            }
        }
    }, 300);
}

// التقاط الباركود من قارئ خارجي
let scanBuffer = '';
let scanTimeout = null;
document.addEventListener('keydown', function(e) {
    // تجاهل إذا كان المستخدم يكتب في حقل إدخال آخر
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (isInput && activeEl.id !== 'barcodeInput') return;

    if (e.key === 'Enter' && scanBuffer.length >= 3) {
        e.preventDefault();
        const barcode = scanBuffer.trim();
        const product = allProducts.find(p => p.barcode && p.barcode === barcode);
        if (product) {
            addToCart(product.id);
        }
        scanBuffer = '';
        document.getElementById('barcodeInput').value = '';
        return;
    }

    if (e.key && e.key.length === 1) {
        scanBuffer += e.key;
        document.getElementById('barcodeInput').value = scanBuffer;
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => { scanBuffer = ''; }, 500);
    }
});

function updateCart() {
    const cartItems = document.getElementById('cartItems');
    if (cart.length === 0) {
        cartItems.innerHTML = '<div class="empty-cart"><div class="empty-cart-icon">🛒</div><p>السلة فارغة</p></div>';
    } else {
        cartItems.innerHTML = cart.map(item => {
            const key = item.cartKey || item.id;
            return `
            <div class="cart-item-simple" style="display: flex; justify-content: space-between; align-items: center;">
                <div style="flex: 1;">
                    <div class="cart-item-name">${escHTML(item.name)}</div>
                    <div class="cart-item-price">${item.price.toFixed(3)} × ${item.quantity} = ${(item.price * item.quantity).toFixed(3)} د.ك</div>
                </div>
                <div style="display: flex; gap: 4px; align-items: center;">
                    <button onclick="updateQuantity('${escHTML(key)}', -1)" style="background: #e2e8f0; border: none; border-radius: 4px; width: 24px; height: 24px; cursor: pointer; font-weight: bold;">-</button>
                    <span style="min-width: 20px; text-align: center;">${item.quantity}</span>
                    <button onclick="updateQuantity('${escHTML(key)}', 1)" style="background: #e2e8f0; border: none; border-radius: 4px; width: 24px; height: 24px; cursor: pointer; font-weight: bold;">+</button>
                    <button onclick="removeFromCart('${escHTML(key)}')" style="background: #dc3545; color: white; border: none; border-radius: 4px; width: 24px; height: 24px; cursor: pointer; font-size: 12px;">✕</button>
                </div>
            </div>`;
        }).join('');
    }
    updateTotals();
    // تحديث عرض المنتجات لتحديث العدادات
    displayProducts(allProducts);
}

function updateQuantity(cartKey, change) {
    const item = cart.find(i => (i.cartKey || i.id) === cartKey);
    if (!item) return;
    const newQty = item.quantity + change;
    if (newQty <= 0) {
        removeFromCart(cartKey);
        return;
    }
    if (newQty > item.stock) {
        alert('الكمية أكبر من المخزون');
        return;
    }
    item.quantity = newQty;
    updateCart();
}

function removeFromCart(cartKey) {
    cart = cart.filter(item => (item.cartKey || item.id) !== cartKey);
    updateCart();
}

function clearCart() {
    if (cart.length === 0) return;
    if (confirm('مسح جميع المنتجات؟')) {
        cart = [];
        updateCart();
    }
}

// مسح نموذج البيع
function clearSaleForm() {
    document.getElementById('customerName').value = '';
    document.getElementById('customerPhone').value = '';
    document.getElementById('customerAddress').value = '';
    document.getElementById('discountInput').value = '0';
    document.getElementById('deliveryFee').value = '0';
    document.getElementById('paymentMethod').value = 'cash';
    document.getElementById('transactionNumber').value = '';
    // إعادة تعيين عمليات الدفع
    const pmList = document.getElementById('paymentMethodsList');
    if (pmList) {
        pmList.innerHTML = `
            <div class="payment-entry" data-index="0" style="display: flex; gap: 5px; align-items: center; margin-bottom: 8px;">
                <select class="pm-method" onchange="togglePaymentTxn(this)" style="flex: 1; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px;">
                    <option value="cash">💵 نقداً</option>
                    <option value="knet">💳 كي نت</option>
                    <option value="visa">💳 فيزا</option>
                    <option value="other">💰 أخرى</option>
                </select>
                <input type="number" class="pm-amount" placeholder="المبلغ" step="0.001" min="0" style="width: 100px; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px;">
                <input type="text" class="pm-txn" placeholder="رقم العملية" style="display: none; width: 110px; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px;">
            </div>
        `;
    }
    
    // مسح ملاحظات الطلب
    const orderNotesEl = document.getElementById('orderNotes');
    if (orderNotesEl) orderNotesEl.value = '';

    // مسح بيانات العميل والبحث
    document.getElementById('selectedCustomerId').value = '';
    const csInput = document.getElementById('customerSearchInput');
    if (csInput) csInput.value = '';
    const csResults = document.getElementById('customerSearchResults');
    if (csResults) csResults.style.display = 'none';
    document.getElementById('customerDetails').style.display = 'none';
    document.getElementById('pointsToRedeem').value = '';
    document.getElementById('loyaltySection').style.display = 'none';
    document.getElementById('loyaltyDiscountRow').style.display = 'none';
    currentCustomerData = null;

    // مسح بيانات الكوبون
    document.getElementById('couponCodeInput').value = '';
    document.getElementById('couponResult').style.display = 'none';
    document.getElementById('couponResult').innerHTML = '';
    document.getElementById('couponDiscountRow').style.display = 'none';
    document.getElementById('couponDiscountDisplay').textContent = '0.000 د.ك';
    appliedCouponDiscount = 0;
    appliedCouponId = null;

    // مسح بيانات الطاولة
    const tableSelect = document.getElementById('selectedTableId');
    if (tableSelect) tableSelect.value = '';
}

// تحديث المخزون المحلي
async function updateLocalStock(soldItems) {
    if (!localDB.isReady) return;
    
    try {
        const localProducts = await localDB.getAll('products');
        
        for (const soldItem of soldItems) {
            const product = localProducts.find(p => p.id === soldItem.id);
            if (product) {
                product.stock -= soldItem.quantity;
                if (product.stock < 0) product.stock = 0;
                await localDB.save('products', product);
            }
        }
        
        console.log('[App] Local stock updated');
    } catch (error) {
        console.error('[App] Failed to update local stock:', error);
    }
}

function updateTotals() {
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const discountValue = parseFloat(document.getElementById('discountInput').value) || 0;
    const discountType = document.getElementById('discountType').value;
    let discount = 0;
    if (discountType === 'percent') {
        discount = subtotal * (discountValue / 100);
    } else {
        discount = discountValue;
    }
    const couponDiscount = appliedCouponDiscount || 0;
    // حساب خصم الولاء
    const pointsToRedeem = parseInt(document.getElementById('pointsToRedeem')?.value) || 0;
    const pointValue = (window.loyaltyConfig && window.loyaltyConfig.pointValue) || 0.1;
    const loyaltyDiscount = pointsToRedeem * pointValue;
    const deliveryFee = parseFloat(document.getElementById('deliveryFee').value) || 0;
    const total = subtotal - discount - couponDiscount - loyaltyDiscount + deliveryFee;
    document.getElementById('subtotal').textContent = `${subtotal.toFixed(3)} د.ك`;
    // عرض زر استلام الاشتراك
    const subRedeemRow = document.getElementById('subscriptionRedeemRow');
    if (subRedeemRow) {
        subRedeemRow.style.display = window._activeSubscription ? 'flex' : 'none';
    }
    document.getElementById('total').textContent = `${Math.max(0, total).toFixed(3)} د.ك`;
    saveUserCart(); // حفظ السلة
}

function toggleTransactionNumber() {
    // backward compat - no-op now, handled by togglePaymentTxn
}

function togglePaymentTxn(selectEl) {
    const entry = selectEl.closest('.payment-entry');
    const txnInput = entry.querySelector('.pm-txn');
    const method = selectEl.value;
    if (method === 'knet' || method === 'visa') {
        txnInput.style.display = 'block';
    } else {
        txnInput.style.display = 'none';
        txnInput.value = '';
    }
}

function addPaymentMethod() {
    const list = document.getElementById('paymentMethodsList');
    const index = list.querySelectorAll('.payment-entry').length;
    const div = document.createElement('div');
    div.className = 'payment-entry';
    div.dataset.index = index;
    div.style.cssText = 'display: flex; gap: 5px; align-items: center; margin-bottom: 8px;';
    div.innerHTML = `
        <select class="pm-method" onchange="togglePaymentTxn(this)" style="flex: 1; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px;">
            <option value="cash">💵 نقداً</option>
            <option value="knet">💳 كي نت</option>
            <option value="visa">💳 فيزا</option>
            <option value="other">💰 أخرى</option>
        </select>
        <input type="number" class="pm-amount" placeholder="المبلغ" step="0.001" min="0" style="width: 100px; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px;">
        <input type="text" class="pm-txn" placeholder="رقم العملية" style="display: none; width: 110px; padding: 8px; border: 2px solid #e0e0e0; border-radius: 6px;">
        <button onclick="this.parentElement.remove()" type="button" style="background: #dc3545; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer;">✖</button>
    `;
    list.appendChild(div);
}

function getPaymentMethods() {
    const entries = document.querySelectorAll('#paymentMethodsList .payment-entry');
    const payments = [];
    entries.forEach(entry => {
        const method = entry.querySelector('.pm-method').value;
        const amount = parseFloat(entry.querySelector('.pm-amount').value) || 0;
        const txn = entry.querySelector('.pm-txn').value || '';
        payments.push({ method, amount, transaction_number: txn });
    });
    return payments;
}

// Complete Sale
// نسخة مبسطة من completeSale
let _isProcessingSale = false;
async function completeSale() {
    // منع الضغط المزدوج
    if (_isProcessingSale) return;
    if (cart.length === 0) {
        alert('السلة فارغة!');
        return;
    }
    _isProcessingSale = true;
    const completeBtn = document.querySelector('.complete-btn');
    if (completeBtn) { completeBtn.disabled = true; completeBtn.style.opacity = '0.5'; completeBtn.textContent = '⏳ جاري الحفظ...'; }

    try {

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const discountValue = parseFloat(document.getElementById('discountInput').value) || 0;
    const discountType = document.getElementById('discountType').value;
    let discount = 0;
    if (discountType === 'percent') {
        discount = subtotal * (discountValue / 100);
    } else {
        discount = discountValue;
    }
    const couponDiscount = appliedCouponDiscount || 0;
    const activeSub = window._activeSubscription || null;
    const loyaltyPointsInput = parseInt(document.getElementById('pointsToRedeem')?.value) || 0;
    const loyaltyPV = (window.loyaltyConfig && window.loyaltyConfig.pointValue) || 0.1;
    const loyaltyDiscountPre = loyaltyPointsInput * loyaltyPV;
    const deliveryFee = parseFloat(document.getElementById('deliveryFee').value) || 0;
    const total = subtotal - discount - couponDiscount - loyaltyDiscountPre + deliveryFee;

    if (total <= 0) {
        alert('الإجمالي يجب أن يكون أكبر من صفر');
        return;
    }

    // جمع عمليات الدفع المتعددة
    const payments = getPaymentMethods();
    // التحقق من أرقام العمليات للعمليات غير النقدية
    for (const p of payments) {
        if ((p.method === 'knet' || p.method === 'visa') && !p.transaction_number) {
            alert('الرجاء إدخال رقم العملية لكل عملية كي نت أو فيزا');
            return;
        }
    }
    // تحديث الحقول المخفية للتوافق
    const paymentMethod = payments.length > 0 ? payments[0].method : 'cash';
    const transactionNumber = payments.length > 0 ? payments[0].transaction_number : '';
    document.getElementById('paymentMethod').value = paymentMethod;
    document.getElementById('transactionNumber').value = transactionNumber;

    const _ts = Date.now().toString(36).toUpperCase();
    const _rnd = Math.random().toString(36).substring(2, 5).toUpperCase();
    const invoiceNumber = `${currentUser.invoice_prefix || 'INV'}-${_ts}${_rnd}`;

    const customerName = document.getElementById('customerName').value || '';
    const customerPhone = document.getElementById('customerPhone').value || '';
    const customerAddress = document.getElementById('customerAddress').value || '';
    
    // حفظ العميل إذا كان لديه بيانات (فقط online)
    let customerId = document.getElementById('selectedCustomerId').value || null;
    if (!customerId && (customerName || customerPhone) && _realOnlineStatus) {
        try {
            const customerResponse = await fetch(`${API_URL}/api/customers`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    name: customerName,
                    phone: customerPhone,
                    address: customerAddress
                })
            });
            const customerData = await customerResponse.json();
            if (customerData.success) {
                customerId = customerData.id;
            }
        } catch (error) {
            console.log('[App] Customer save skipped (offline or error)');
        }
    }
    
    // بيانات الولاء
    const pointsToRedeem = parseInt(document.getElementById('pointsToRedeem').value) || 0;
    const pointValue = (window.loyaltyConfig && window.loyaltyConfig.pointValue) || 0.1;
    const pointsPerInvoice = (window.loyaltyConfig && window.loyaltyConfig.pointsPerInvoice) || 10;
    const loyaltyDiscount = pointsToRedeem * pointValue;
    const loyaltyMultiplier = activeSub ? (activeSub.loyalty_multiplier || 1) : 1;
    const pointsEarned = customerId ? Math.round(pointsPerInvoice * loyaltyMultiplier) : 0;
    
    const invoiceData = {
        invoice_number: invoiceNumber,
        customer_id: customerId,
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_address: customerAddress,
        subtotal: subtotal,
        discount: discount,
        delivery_fee: deliveryFee,
        total: total,
        payment_method: paymentMethod,
        transaction_number: transactionNumber,
        employee_name: currentUser.full_name,
        branch_id: currentUser.branch_id || 1,
        loyalty_points_earned: pointsEarned,
        loyalty_points_redeemed: pointsToRedeem,
        loyalty_discount: loyaltyDiscount,
        coupon_discount: couponDiscount,
        coupon_code: appliedCouponId ? document.getElementById('couponCodeInput').value : null,
        payments: payments,
        table_id: document.getElementById('selectedTableId')?.value || null,
        table_name: document.getElementById('selectedTableId')?.selectedOptions[0]?.textContent || '',
        shift_id: currentUser.shift_id || null,
        notes: (document.getElementById('orderNotes')?.value?.trim() || '') + (activeSub ? ` | مشترك: ${activeSub.subscription_code}` : ''),
        subscription_code: activeSub ? activeSub.subscription_code : null,
        items: cart.map(item => ({
            product_id: item.id,
            product_name: item.name,
            quantity: item.quantity,
            price: item.price,
            total: item.price * item.quantity,
            branch_stock_id: item.id,
            variant_id: item.variant_id || null,
            variant_name: item.variant_name || null
        }))
    };
    
    // === حفظ الفاتورة ===
    if (_realOnlineStatus) {
        // Online: محاولة إرسال للسيرفر
        try {
            const response = await fetch(`${API_URL}/api/invoices`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(invoiceData)
            });
            const data = await response.json();
            
            if (data.success) {
                // فحص التكرار
                if (data.duplicate) {
                    alert('هذه الفاتورة مسجلة مسبقاً');
                    return;
                }
                // نجح الحفظ - تشغيل صوت النجاح
                playInvoiceSound();

                try {
                    await logAction('sale', `فاتورة ${data.invoice_number || invoiceNumber} - ${total.toFixed(3)} د.ك`, data.id);
                } catch (e) {
                    console.log('[App] Log action skipped');
                }

                currentInvoice = {...invoiceData, id: data.id, created_at: new Date().toISOString(), items: invoiceData.items};

                // إذا وضع التزامن "سيرفر" → حفظ في pending_invoices للرفع للسيرفر المركزي
                if (typeof syncManager !== 'undefined' && syncManager.isServerMode() && localDB.isReady) {
                    try {
                        await localDB.add('pending_invoices', {
                            data: { ...invoiceData, invoice_number: data.invoice_number || invoiceNumber, created_at: new Date().toISOString() },
                            timestamp: new Date().toISOString()
                        });
                    } catch (e) {
                        console.log('[App] Pending sync queue skipped:', e.message);
                    }
                }

                // تسجيل استخدام الكوبون
                if (appliedCouponId) {
                    try {
                        await fetch(`${API_URL}/api/coupons/use`, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ coupon_id: appliedCouponId })
                        });
                    } catch (e) {
                        console.log('[App] Coupon use tracking skipped');
                    }
                }

                showSuccess(`تم حفظ الفاتورة! رقم: ${data.invoice_number || invoiceNumber}`);

                // تنبيه المخزون المنخفض
                if (data.low_stock_warnings && data.low_stock_warnings.length > 0) {
                    const warningLines = data.low_stock_warnings.map(w =>
                        `• ${escHTML(w.product_name)}: متبقي ${w.stock} فقط`
                    ).join('<br>');
                    setTimeout(() => showWarning(warningLines, 8000), 1500);
                }

                // تحديث المخزون المحلي
                if (localDB.isReady) {
                    try {
                        await updateLocalStock(cart);
                    } catch (e) {
                        console.log('[App] Local stock update skipped');
                    }
                }

                // مسح السلة
                cart = [];
                if (currentUser) {
                    localStorage.removeItem(`pos_cart_${currentUser.id}`);
                }

                clearSaleForm();
                updateCart();

                // إعادة تحميل
                loadProducts();
                loadInventory();
                loadCustomersDropdown();

                // عرض الفاتورة
                setTimeout(() => {
                    displayInvoiceView(currentInvoice);
                    document.getElementById('invoiceViewModal').classList.add('active');
                }, 300);
            } else {
                alert('خطأ: ' + data.error);
            }
        } catch (error) {
            // فشل الاتصال - حفظ محلياً
            console.error('[App] Server error, saving offline:', error);
            await saveInvoiceOffline(invoiceData, invoiceNumber);
        }
    } else {
        // Offline: حفظ محلياً مباشرة
        await saveInvoiceOffline(invoiceData, invoiceNumber);
    }

    } finally {
        // إعادة تفعيل زر الإتمام
        _isProcessingSale = false;
        const _btn = document.querySelector('.complete-btn');
        if (_btn) { _btn.disabled = false; _btn.style.opacity = '1'; _btn.textContent = '✅ إتمام'; }
    }
}

// دالة منفصلة لحفظ الفاتورة offline
async function saveInvoiceOffline(invoiceData, invoiceNumber) {
    if (!localDB.isReady) {
        alert('خطأ: قاعدة البيانات المحلية غير جاهزة.\nالرجاء إعادة تحميل الصفحة.');
        return;
    }
    
    try {
        // التحقق من عدم وجود فاتورة بنفس الرقم محلياً
        const existingPending = await localDB.getAll('pending_invoices');
        const isDuplicate = existingPending.some(p => p.data && p.data.invoice_number === invoiceData.invoice_number);
        if (isDuplicate) {
            console.warn('[App] Duplicate invoice prevented:', invoiceData.invoice_number);
            alert('هذه الفاتورة محفوظة مسبقاً');
            return;
        }

        const offlineInvoice = {
            ...invoiceData,
            created_at: new Date().toISOString(),
            id: 'offline_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)
        };

        // حفظ في pending_invoices للرفع
        await localDB.add('pending_invoices', {
            data: offlineInvoice,
            timestamp: new Date().toISOString()
        });

        // حفظ في local_invoices للعرض
        await localDB.save('local_invoices', offlineInvoice);
        
        // تحديث المخزون المحلي
        await updateLocalStock(cart);
        
        // حفظ الفاتورة الحالية
        currentInvoice = offlineInvoice;

        // تشغيل صوت النجاح
        playInvoiceSound();
        showSuccess(`تم حفظ الفاتورة محلياً! رقم: ${invoiceNumber} - سيتم رفعها عند الاتصال`);
        
        // مسح السلة
        cart = [];
        if (currentUser) {
            localStorage.removeItem(`pos_cart_${currentUser.id}`);
        }
        
        clearSaleForm();
        updateCart();
        
        // إعادة تحميل المنتجات من المخزون المحلي المحدث
        const localProducts = await localDB.getAll('products');
        if (localProducts.length > 0) {
            allProducts = localProducts;
            displayProducts(allProducts);
        }
        
        // عرض الفاتورة
        setTimeout(() => {
            displayInvoiceView(currentInvoice);
            document.getElementById('invoiceViewModal').classList.add('active');
        }, 300);
        
        console.log('[App] Invoice saved offline ✅');
    } catch (error) {
        console.error('[App] Failed to save offline:', error);
        alert('فشل حفظ الفاتورة محلياً.\nالخطأ: ' + error.message + '\n\nالرجاء إعادة المحاولة.');
    }
}

// باقي الكود في الجزء التالي...

// Invoice View & Print
async function viewInvoiceDetails(invoiceId) {
    try {
        const response = await fetch(`${API_URL}/api/invoices/${invoiceId}`);
        const data = await response.json();
        if (data.success) {
            currentInvoice = data.invoice;
            displayInvoiceView(currentInvoice);
            document.getElementById('invoiceViewModal').classList.add('active');
            logAction('view_invoice', `عرض فاتورة ${currentInvoice.invoice_number}`, currentInvoice.id);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function displayInvoiceView(inv) {
    const paymentMethods = {'cash':'💵 نقداً','knet':'💳 كي نت','visa':'💳 فيزا','other':'💰 أخرى'};
    // محاولة تحليل عمليات الدفع المتعددة من حقل transaction_number
    if (!inv.payments && inv.transaction_number) {
        try {
            const parsed = JSON.parse(inv.transaction_number);
            if (Array.isArray(parsed)) { inv.payments = parsed; }
        } catch(e) { /* not JSON, single payment */ }
    }
    // إخفاء/إظهار زر الإلغاء
    const cancelBtn = document.getElementById('cancelInvoiceBtn');
    if (cancelBtn) cancelBtn.style.display = (inv.cancelled || !window.userPermissions.canCancelInvoices) ? 'none' : '';

    // إخفاء/إظهار زر التعديل
    const editBtn = document.getElementById('editInvoiceBtn');
    if (editBtn) {
        const isCompleted = inv.order_status === 'منجز';
        const canEdit = !inv.cancelled && (!isCompleted || window.userPermissions.canEditCompletedInvoices);
        editBtn.style.display = canEdit ? '' : 'none';
    }

    const content = document.getElementById('invoiceViewContent');
    const isCancelled = inv.cancelled;
    content.innerHTML = `
        <div style="padding: 20px; ${isCancelled ? 'opacity: 0.7;' : ''}">
            ${isCancelled ? `
            <div style="background: #dc3545; color: white; padding: 12px 15px; border-radius: 8px; margin-bottom: 15px; text-align: center;">
                <div style="font-size: 18px; font-weight: bold;">🚫 فاتورة ملغية</div>
                <div style="font-size: 13px; margin-top: 5px;">السبب: ${escHTML(inv.cancel_reason) || '-'}</div>
                ${inv.stock_returned ? '<div style="font-size: 12px; margin-top: 3px;">📦 تم إرجاع المنتجات إلى المخزون</div>' : ''}
                ${inv.cancelled_at ? `<div style="font-size: 11px; margin-top: 3px;">تاريخ الإلغاء: ${new Date(inv.cancelled_at).toLocaleDateString('ar')}</div>` : ''}
            </div>` : ''}
            <div style="text-align: center; margin-bottom: 20px;">
                ${storeLogo ? `<img src="${storeLogo}" style="max-width: 150px; max-height: 80px; margin-bottom: 10px;">` : ''}
                <h2 style="margin: 5px 0;">فاتورة مبيعات</h2>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; margin-bottom: 15px;">
                <div><strong>رقم:</strong> ${escHTML(inv.invoice_number)}</div>
                <div><strong>التاريخ:</strong> ${new Date(inv.created_at).toLocaleDateString('ar')}</div>
                <div><strong>العميل:</strong> ${escHTML(inv.customer_name) || '-'}</div>
                <div><strong>الهاتف:</strong> ${escHTML(inv.customer_phone) || '-'}</div>
                <div><strong>العنوان:</strong> ${escHTML(inv.customer_address) || '-'}</div>
                <div><strong>الدفع:</strong> ${inv.payments && inv.payments.length > 0 ? inv.payments.map(p => `${paymentMethods[p.method] || escHTML(p.method)} (${parseFloat(p.amount).toFixed(3)})`).join(' + ') : paymentMethods[inv.payment_method]}</div>
                ${inv.payments && inv.payments.length > 0 ? inv.payments.filter(p => p.transaction_number).map(p => `<div><strong>رقم العملية (${paymentMethods[p.method]}):</strong> ${escHTML(p.transaction_number)}</div>`).join('') : (inv.transaction_number ? `<div style="grid-column: 1/-1;"><strong>رقم العملية:</strong> ${escHTML(inv.transaction_number)}</div>` : '')}
                <div style="grid-column: 1/-1;"><strong>حالة الطلب:</strong> <span class="order-status-badge status-${(inv.order_status || 'قيد التنفيذ') === 'قيد التنفيذ' ? 'processing' : (inv.order_status === 'قيد التوصيل' ? 'delivering' : 'completed')}">${inv.order_status === 'قيد التنفيذ' ? '⏳' : inv.order_status === 'قيد التوصيل' ? '🚚' : '✅'} ${inv.order_status || 'قيد التنفيذ'}</span></div>
                ${inv.table_name ? `<div><strong>🍽️ الطاولة:</strong> ${escHTML(inv.table_name)}</div>` : ''}
                ${inv.shift_name ? `<div><strong>🕐 الشفت:</strong> ${escHTML(inv.shift_name)}</div>` : ''}
                ${inv.edit_count > 0 ? `<div style="grid-column: 1/-1; color: #e67e22;"><strong>✏️ معدّلة:</strong> ${inv.edit_count} مرة - آخر تعديل: ${inv.edited_by || ''} ${inv.edited_at ? new Date(inv.edited_at).toLocaleDateString('ar') : ''}</div>` : ''}
                ${inv.notes ? `<div style="grid-column: 1/-1; background: #fff3cd; border-right: 4px solid #ffc107; padding: 10px !important;"><strong>📝 ملاحظات:</strong> ${escHTML(inv.notes)}</div>` : ''}
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:11px; margin:15px 0;">
                <thead><tr style="background:#667eea; color:white;">
                    <th style="padding:6px; text-align:right;">#</th>
                    <th style="padding:6px; text-align:right;">المنتج</th>
                    <th style="padding:6px; text-align:center;">الكمية</th>
                    <th style="padding:6px; text-align:right;">السعر</th>
                    <th style="padding:6px; text-align:right;">الإجمالي</th>
                </tr></thead>
                <tbody>
                    ${inv.items.map((item, i) => `
                        <tr style="border-bottom:1px solid #ddd;">
                            <td style="padding:5px;">${i+1}</td>
                            <td style="padding:5px;">${escHTML(item.product_name)}</td>
                            <td style="padding:5px; text-align:center;">${item.quantity}</td>
                            <td style="padding:5px;">${item.price.toFixed(3)}</td>
                            <td style="padding:5px;">${item.total.toFixed(3)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            <div style="font-size:12px; margin-top:15px;">
                <div style="display:flex; justify-content:space-between; margin:5px 0;"><span>المجموع:</span><span>${inv.subtotal.toFixed(3)} د.ك</span></div>
                <div style="display:flex; justify-content:space-between; margin:5px 0; color:#dc3545;"><span>الخصم:</span><span>-${inv.discount.toFixed(3)} د.ك</span></div>
                ${(inv.coupon_discount || 0) > 0 ? `<div style="display:flex; justify-content:space-between; margin:5px 0; color:#eab308;"><span>🎟️ خصم الكوبون:</span><span>-${inv.coupon_discount.toFixed(3)} د.ك</span></div>` : ''}
                ${inv.subscription_code ? `<div style="display:flex; justify-content:space-between; margin:5px 0; color:#764ba2;"><span>💳 اشتراك:</span><span>${escHTML(inv.subscription_code)}</span></div>` : ''}
                ${(inv.loyalty_discount || 0) > 0 ? `<div style="display:flex; justify-content:space-between; margin:5px 0; color:#0ea5e9;"><span>💎 خصم الولاء:</span><span>-${inv.loyalty_discount.toFixed(3)} د.ك</span></div>` : ''}
                ${inv.delivery_fee > 0 ? `<div style="display:flex; justify-content:space-between; margin:5px 0;"><span>رسوم التوصيل:</span><span>${inv.delivery_fee.toFixed(3)} د.ك</span></div>` : ''}
                <div style="display:flex; justify-content:space-between; margin-top:10px; padding-top:10px; border-top:2px solid #667eea; font-size:16px; font-weight:bold; color:#667eea;"><span>الإجمالي:</span><span>${inv.total.toFixed(3)} د.ك</span></div>
            </div>
            <div style="text-align:center; margin-top:20px; font-size:11px; color:#6c757d;"><p>شكراً لتعاملكم معنا 🌟</p></div>
        </div>
    `;
}

function closeInvoiceView() {
    document.getElementById('invoiceViewModal').classList.remove('active');
}

function printInvoiceFromView() {
    if (!currentInvoice) return;
    const printWindow = window.open('', '', 'width=800,height=600');
    printWindow.document.write(generateCompactInvoiceHTML(currentInvoice));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); printWindow.close(); }, 250);
    logAction('print_invoice', `طباعة فاتورة ${currentInvoice.invoice_number}`, currentInvoice.id);
}

// طباعة فاتورة حرارية 57×40 ملم
function printThermalInvoice() {
    if (!currentInvoice) return;
    const printWindow = window.open('', '', 'width=820,height=600');
    printWindow.document.write(generateThermalInvoiceHTML(currentInvoice));
    printWindow.document.close();
    logAction('print_thermal', `طباعة حرارية فاتورة ${currentInvoice.invoice_number}`, currentInvoice.id);
}

// ===== نظام إلغاء الفواتير =====

function showCancelInvoiceModal() {
    if (!currentInvoice) return;
    if (currentInvoice.cancelled) {
        alert('هذه الفاتورة ملغية مسبقاً');
        return;
    }
    document.getElementById('cancelInvoiceId').value = currentInvoice.id;
    document.getElementById('cancelReasonSelect').value = '';
    document.getElementById('customReasonInput').value = '';
    document.getElementById('customReasonDiv').style.display = 'none';
    document.getElementById('returnStockCheckbox').checked = true;
    document.getElementById('cancelInvoiceModal').classList.add('active');
}

function closeCancelInvoiceModal() {
    document.getElementById('cancelInvoiceModal').classList.remove('active');
}

function toggleCustomReason() {
    const select = document.getElementById('cancelReasonSelect');
    document.getElementById('customReasonDiv').style.display = select.value === 'custom' ? 'block' : 'none';
}

async function confirmCancelInvoice() {
    const invoiceId = document.getElementById('cancelInvoiceId').value;
    const selectVal = document.getElementById('cancelReasonSelect').value;
    const customVal = document.getElementById('customReasonInput').value.trim();
    const returnStock = document.getElementById('returnStockCheckbox').checked;

    const reason = selectVal === 'custom' ? customVal : selectVal;
    if (!reason) {
        alert('يجب تحديد سبب الإلغاء');
        return;
    }

    if (!confirm(`هل أنت متأكد من إلغاء الفاتورة؟\n\nالسبب: ${reason}\nإرجاع المخزون: ${returnStock ? 'نعم' : 'لا'}`)) return;

    try {
        const response = await fetch(`${API_URL}/api/invoices/${invoiceId}/cancel`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ reason, return_stock: returnStock })
        });
        const data = await response.json();

        if (data.success) {
            alert(`✅ تم إلغاء الفاتورة بنجاح${data.stock_returned ? '\n📦 تم إرجاع المنتجات إلى المخزون' : ''}`);
            await logAction('cancel_invoice', `إلغاء فاتورة ${currentInvoice?.invoice_number || invoiceId} - السبب: ${reason}${returnStock ? ' (مع إرجاع المخزون)' : ''}`, invoiceId);
            closeCancelInvoiceModal();
            closeInvoiceView();
            loadInvoicesTable();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الاتصال بالسيرفر');
    }
}

function generateThermalInvoiceHTML(inv) {
    const paymentMethods = {'cash':'نقداً','knet':'كي نت','visa':'فيزا','other':'أخرى'};
    if (!inv.payments && inv.transaction_number) {
        try {
            const parsed = JSON.parse(inv.transaction_number);
            if (Array.isArray(parsed)) { inv.payments = parsed; }
        } catch(e) {}
    }
    const storeName = document.getElementById('storeName')?.value || 'متجر';
    const payText = inv.payments && inv.payments.length > 0
        ? inv.payments.map(p => `${paymentMethods[p.method] || p.method} ${parseFloat(p.amount).toFixed(3)}`).join(' + ')
        : (paymentMethods[inv.payment_method] || 'نقداً');
    return `<!DOCTYPE html>
<html dir="rtl">
<head>
<meta charset="UTF-8">
<title>فاتورة ${inv.invoice_number}</title>
<style>
@page { size: 57mm 40mm; margin: 1mm; }
@media print {
    .toolbar { display: none !important; }
    .preview-wrapper { box-shadow: none !important; border: none !important; margin: 0 !important; }
    body { background: white !important; padding: 0 !important; }
    .receipt { width: 55mm; font-size: 7px; padding: 1mm; }
    .receipt table th, .receipt table td { font-size: 6.5px; padding: 0.5mm 0; }
    .receipt .r-header { font-size: 9px; }
    .receipt .r-sub { font-size: 6px; }
    .receipt .r-total { font-size: 9px; }
    .receipt .r-small { font-size: 6px; }
    .receipt .r-mid { font-size: 6.5px; }
    .receipt table th { font-size: 6px; }
}
@media screen {
    body { background: #f0f0f0; font-family: Arial, sans-serif; direction: rtl; margin: 0; padding: 20px; }
    .toolbar { background: #333; color: white; padding: 15px 25px; display: flex; justify-content: space-between; align-items: center; position: fixed; top: 0; left: 0; right: 0; z-index: 100; border-radius: 0; }
    .toolbar h3 { margin: 0; font-size: 16px; }
    .toolbar-btns { display: flex; gap: 10px; }
    .toolbar button { padding: 10px 25px; border: none; border-radius: 8px; font-size: 15px; cursor: pointer; font-weight: bold; }
    .btn-print { background: #28a745; color: white; }
    .btn-print:hover { background: #218838; }
    .btn-close { background: #dc3545; color: white; }
    .btn-close:hover { background: #c82333; }
    .preview-wrapper { max-width: 280px; margin: 80px auto 20px; background: white; border: 2px solid #ccc; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); padding: 15px; }
    .receipt { width: 100%; font-size: 13px; line-height: 1.5; }
    .receipt .r-header { font-size: 18px; font-weight: bold; }
    .receipt .r-sub { font-size: 11px; }
    .receipt .r-total { font-size: 17px; font-weight: bold; }
    .receipt .r-small { font-size: 11px; }
    .receipt .r-mid { font-size: 12px; }
    .receipt table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    .receipt table th, .receipt table td { padding: 4px 2px; text-align: right; font-size: 12px; }
    .receipt table th { border-bottom: 2px solid #000; font-size: 11px; font-weight: bold; }
    .receipt table td { border-bottom: 1px solid #eee; }
}
.receipt .center { text-align: center; }
.receipt .bold { font-weight: bold; }
.receipt .sep { border-top: 1px dashed #000; margin: 6px 0; }
.receipt .row { display: flex; justify-content: space-between; }
</style>
</head>
<body>
<div class="toolbar">
    <h3>معاينة الفاتورة الحرارية (57×40 ملم)</h3>
    <div class="toolbar-btns">
        <button class="btn-print" onclick="window.print()">🖨️ طباعة</button>
        <button class="btn-close" onclick="window.close()">✖ إغلاق</button>
    </div>
</div>
<div class="preview-wrapper">
<div class="receipt">
<div class="center r-header">${escHTML(storeName)}</div>
<div class="center r-sub">فاتورة مبيعات</div>
<div class="sep"></div>
<div class="row r-mid"><span>${escHTML(inv.invoice_number)}</span><span>${typeof formatKuwaitTime === 'function' ? formatKuwaitTime(inv.created_at) : new Date(inv.created_at).toLocaleDateString('ar')}</span></div>
${inv.customer_name ? `<div class="r-small">العميل: ${escHTML(inv.customer_name)}</div>` : ''}
<div class="sep"></div>
<table>
<thead><tr><th>المنتج</th><th>ك</th><th>السعر</th><th>المجموع</th></tr></thead>
<tbody>
${inv.items.map(item => `<tr><td>${escHTML(item.product_name)}</td><td style="text-align:center;">${item.quantity}</td><td>${item.price.toFixed(3)}</td><td>${item.total.toFixed(3)}</td></tr>`).join('')}
</tbody>
</table>
<div class="sep"></div>
${inv.discount > 0 ? `<div class="row r-small"><span>الخصم:</span><span>-${inv.discount.toFixed(3)}</span></div>` : ''}
${(inv.coupon_discount || 0) > 0 ? `<div class="row r-small"><span>كوبون:</span><span>-${inv.coupon_discount.toFixed(3)}</span></div>` : ''}
${(inv.loyalty_discount || 0) > 0 ? `<div class="row r-small"><span>ولاء:</span><span>-${inv.loyalty_discount.toFixed(3)}</span></div>` : ''}
${inv.delivery_fee > 0 ? `<div class="row r-small"><span>توصيل:</span><span>+${inv.delivery_fee.toFixed(3)}</span></div>` : ''}
<div class="row r-total"><span>الإجمالي:</span><span>${inv.total.toFixed(3)} د.ك</span></div>
<div class="r-small" style="margin-top:4px;">الدفع: ${payText}</div>
${inv.notes ? `<div class="sep"></div><div class="r-small"><b>ملاحظات:</b> ${escHTML(inv.notes)}</div>` : ''}
<div class="sep"></div>
<div class="center r-small">شكراً لتعاملكم معنا</div>
</div>
</div>
</body>
</html>`;
}

function generateCompactInvoiceHTML(inv) {
    const paymentMethods = {'cash':'💵 نقداً','knet':'💳 كي نت','visa':'💳 فيزا','other':'💰 أخرى'};
    if (!inv.payments && inv.transaction_number) {
        try {
            const parsed = JSON.parse(inv.transaction_number);
            if (Array.isArray(parsed)) { inv.payments = parsed; }
        } catch(e) {}
    }
    return `
<!DOCTYPE html>
<html dir="rtl">
<head>
<meta charset="UTF-8">
<title>فاتورة ${inv.invoice_number}</title>
<style>
@page{size:A4;margin:15mm;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:Arial;padding:20px;font-size:13px;}
.header{text-align:center;margin-bottom:20px;padding-bottom:15px;border-bottom:2px solid #667eea;}
.header img{max-width:150px;max-height:80px;margin-bottom:8px;}
.header h1{font-size:24px;margin:8px 0;color:#2d3748;}
.header p{font-size:15px;color:#667eea;margin:5px 0;}
.info{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:15px 0;font-size:13px;}
.info div{padding:8px;background:#f8f9fa;border-radius:6px;}
table{width:100%;border-collapse:collapse;margin:15px 0;}
th,td{border:1px solid #ddd;padding:10px;text-align:right;font-size:13px;}
th{background:#667eea;color:white;font-weight:bold;}
tbody tr:nth-child(even){background:#f8f9fa;}
.totals{margin-top:15px;font-size:14px;}
.totals div{display:flex;justify-content:space-between;margin:8px 0;padding:5px 0;}
.total-final{font-size:18px;font-weight:bold;border-top:3px solid #667eea;padding-top:10px;margin-top:10px;color:#667eea;}
.footer{text-align:center;margin-top:25px;font-size:12px;color:#6c757d;border-top:2px solid #dee2e6;padding-top:15px;}
</style>
</head>
<body>
<div class="header">
${storeLogo ? `<img src="${storeLogo}">` : ''}
<h1>${document.getElementById('storeName')?.value || 'متجر العطور والبخور'}</h1>
<p>فاتورة مبيعات</p>
</div>
<div class="info">
<div><b>رقم الفاتورة:</b> ${escHTML(inv.invoice_number)}</div>
<div><b>التاريخ:</b> ${formatKuwaitTime(inv.created_at)}</div>
<div><b>العميل:</b> ${escHTML(inv.customer_name) || '-'}</div>
<div><b>الهاتف:</b> ${escHTML(inv.customer_phone) || '-'}</div>
<div><b>العنوان:</b> ${escHTML(inv.customer_address) || '-'}</div>
<div><b>طريقة الدفع:</b> ${inv.payments && inv.payments.length > 0 ? inv.payments.map(p => `${paymentMethods[p.method] || escHTML(p.method)} (${parseFloat(p.amount).toFixed(3)})`).join(' + ') : paymentMethods[inv.payment_method]}</div>
${inv.payments && inv.payments.length > 0 ? inv.payments.filter(p => p.transaction_number).map(p => `<div><b>رقم العملية (${paymentMethods[p.method]}):</b> ${escHTML(p.transaction_number)}</div>`).join('') : (inv.transaction_number ? `<div style="grid-column:1/-1;"><b>رقم العملية:</b> ${escHTML(inv.transaction_number)}</div>` : '')}
<div style="grid-column:1/-1;"><b>حالة الطلب:</b> <span style="padding:4px 12px; border-radius:12px; font-weight:bold; ${(inv.order_status || 'قيد التنفيذ') === 'قيد التنفيذ' ? 'background:#fff3cd; color:#856404;' : inv.order_status === 'قيد التوصيل' ? 'background:#cce5ff; color:#004085;' : 'background:#d4edda; color:#155724;'}">${inv.order_status === 'قيد التنفيذ' ? '⏳' : inv.order_status === 'قيد التوصيل' ? '🚚' : '✅'} ${escHTML(inv.order_status) || 'قيد التنفيذ'}</span></div>
${inv.table_name ? `<div><b>🍽️ الطاولة:</b> ${escHTML(inv.table_name)}</div>` : ''}
${inv.notes ? `<div style="grid-column:1/-1; background:#fff3cd; border-right:4px solid #ffc107; padding:10px !important;"><b>📝 ملاحظات:</b> ${escHTML(inv.notes)}</div>` : ''}
</div>
<table>
<thead><tr><th style="width:40px;">#</th><th>المنتج</th><th style="width:80px;">الكمية</th><th style="width:100px;">السعر</th><th style="width:100px;">الإجمالي</th></tr></thead>
<tbody>
${inv.items.map((item, i) => `<tr><td>${i+1}</td><td>${escHTML(item.product_name)}</td><td style="text-align:center;">${item.quantity}</td><td>${item.price.toFixed(3)} د.ك</td><td>${item.total.toFixed(3)} د.ك</td></tr>`).join('')}
</tbody>
</table>
<div class="totals">
<div><span>المجموع الفرعي:</span><span>${inv.subtotal.toFixed(3)} د.ك</span></div>
<div style="color:#dc3545;"><span>الخصم:</span><span>-${inv.discount.toFixed(3)} د.ك</span></div>
${(inv.coupon_discount || 0) > 0 ? `<div style="color:#b45309;"><span>🎟️ خصم الكوبون:</span><span>-${inv.coupon_discount.toFixed(3)} د.ك</span></div>` : ''}
${(inv.loyalty_discount || 0) > 0 ? `<div style="color:#0284c7;"><span>💎 خصم الولاء:</span><span>-${inv.loyalty_discount.toFixed(3)} د.ك</span></div>` : ''}
${inv.delivery_fee > 0 ? `<div><span>رسوم التوصيل:</span><span>+${inv.delivery_fee.toFixed(3)} د.ك</span></div>` : ''}
<div class="total-final"><span>الإجمالي النهائي:</span><span>${inv.total.toFixed(3)} د.ك</span></div>
</div>
<div class="footer">
<p style="font-size:16px;margin-bottom:8px;">شكراً لتعاملكم معنا 🌟</p>
<p>نتمنى لكم يوماً سعيداً</p>
</div>
</body>
</html>`;
}

// Products Management
async function loadProductsTable() {
    try {
        // الأدمن يشوف كل المنتجات، الكاشير يشوف منتجات فرعه فقط
        const branchParam = window.userPermissions?.isAdmin ? 'all' : (currentUser?.branch_id || 1);
        const response = await fetch(`${API_URL}/api/products?branch_id=${branchParam}`);
        const data = await response.json();
        if (data.success) {
            // حفظ المنتجات للتعديل
            allProductsTable = data.products;

            // تحديث فلتر الفئات في البحث المتقدم
            const catSelect = document.getElementById('searchProductCategory');
            if (catSelect) {
                const categories = [...new Set(data.products.map(p => p.category || 'بدون فئة'))].sort();
                catSelect.innerHTML = '<option value="">كل الفئات</option>' + categories.map(c => `<option value="${c}">${c}</option>`).join('');
            }

            // تجميع حسب الفئة
            const byCategory = {};
            data.products.forEach(p => {
                const cat = p.category || 'بدون فئة';
                if (!byCategory[cat]) byCategory[cat] = [];
                byCategory[cat].push(p);
            });
            
            const container = document.getElementById('productsTableContainer');
            let html = '';
            
            Object.keys(byCategory).sort().forEach(category => {
                html += `
                    <div style="margin-bottom: 30px;">
                        <h3 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 20px; border-radius: 10px; margin-bottom: 20px; font-size: 18px;">
                            📁 ${category}
                        </h3>
                        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px;">
                            ${byCategory[category].map(p => {
                                let imgDisplay = '🛍️';
                                if (p.image_data) {
                                    if (p.image_data.startsWith('data:image')) {
                                        imgDisplay = `<img src="${p.image_data}" style="width:60px; height:60px; object-fit:cover; border-radius:8px;">`;
                                    } else {
                                        imgDisplay = `<div style="font-size:50px;">${p.image_data}</div>`;
                                    }
                                }
                                return `
                                    <div style="border:2px solid #e2e8f0; padding:15px; border-radius:12px; background:white; text-align:center; transition:all 0.3s; cursor:pointer;" 
                                         onmouseover="this.style.boxShadow='0 4px 12px rgba(102,126,234,0.3)'; this.style.transform='translateY(-2px)';"
                                         onmouseout="this.style.boxShadow='none'; this.style.transform='translateY(0)';">
                                        <div style="margin-bottom:10px;">${imgDisplay}</div>
                                        <div style="font-weight:bold; margin-bottom:5px; color:#2d3748;">${escHTML(p.name)}</div>
                                        <div style="color:#667eea; font-size:18px; font-weight:bold; margin:8px 0;">${p.price.toFixed(3)} د.ك</div>
                                        <div style="color:#6c757d; font-size:13px; margin-bottom:10px;">المخزون: ${p.stock}</div>
                                        ${p.barcode ? `<div style="color:#6c757d; font-size:11px; margin-bottom:10px;">📊 ${escHTML(p.barcode)}</div>` : ''}
                                        
                                        <!-- عرض إجمالي التكلفة فقط -->
                                        ${p.cost && p.cost > 0 ? `
                                            <div style="background:#f0f9ff; padding:10px; border-radius:6px; margin:10px 0; border:1px solid #bae6fd;">
                                                <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
                                                    <span style="color:#0369a1; font-weight:600;">💰 التكلفة:</span>
                                                    <span style="color:#0c4a6e; font-weight:700;">${p.cost.toFixed(3)} د.ك</span>
                                                </div>
                                                <div style="margin-top:5px; font-size:11px; color:#0284c7;">
                                                    📊 الربح: ${(p.price - p.cost).toFixed(3)} د.ك (${((p.price - p.cost) / p.price * 100).toFixed(1)}%)
                                                </div>
                                            </div>
                                        ` : ''}

                                        ${p.variants && p.variants.length > 0 ? `
                                            <div style="background:#f0fff4; padding:8px; border-radius:6px; margin:8px 0; border:1px solid #c6f6d5;">
                                                <div style="font-size:12px; color:#38a169; font-weight:bold; margin-bottom:5px;">📐 ${p.variants.length} خاصية</div>
                                                ${p.variants.map(v => `
                                                    <div style="display:flex; justify-content:space-between; font-size:11px; padding:2px 0; border-bottom:1px solid #e8f5e9;">
                                                        <span>${escHTML(v.variant_name)}</span>
                                                        <span style="font-weight:bold;">${v.price.toFixed(3)} د.ك</span>
                                                    </div>
                                                `).join('')}
                                            </div>
                                        ` : ''}

                                        <div style="display:flex; gap:5px; justify-content:center; margin-top:10px;">
                                            <button onclick="editProduct(${p.id})" class="btn-sm" style="flex:1;">✏️ تعديل</button>
                                            <button onclick="deleteProduct(${p.id})" class="btn-sm btn-danger" style="flex:1;">🗑️</button>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function advancedSearchProducts() {
    const nameFilter = (document.getElementById('searchProductName')?.value || '').toLowerCase();
    const barcodeFilter = (document.getElementById('searchProductBarcode')?.value || '').toLowerCase();
    const categoryFilter = document.getElementById('searchProductCategory')?.value || '';
    const priceMin = parseFloat(document.getElementById('searchPriceMin')?.value) || 0;
    const priceMax = parseFloat(document.getElementById('searchPriceMax')?.value) || Infinity;

    const filtered = allProductsTable.filter(p => {
        if (nameFilter && !p.name.toLowerCase().includes(nameFilter)) return false;
        if (barcodeFilter && !(p.barcode || '').toLowerCase().includes(barcodeFilter)) return false;
        if (categoryFilter && (p.category || 'بدون فئة') !== categoryFilter) return false;
        if (p.price < priceMin) return false;
        if (priceMax !== Infinity && p.price > priceMax) return false;
        return true;
    });

    const container = document.getElementById('productsTableContainer');
    if (filtered.length === 0) {
        container.innerHTML = '<p style="text-align:center; padding:40px; color:#6c757d;">لا توجد نتائج</p>';
        return;
    }

    const byCategory = {};
    filtered.forEach(p => {
        const cat = p.category || 'بدون فئة';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(p);
    });

    let html = '';
    Object.keys(byCategory).sort().forEach(category => {
        html += `<div style="margin-bottom: 30px;">
            <h3 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 20px; border-radius: 10px; margin-bottom: 20px; font-size: 18px;">📁 ${category} (${byCategory[category].length})</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px;">
                ${byCategory[category].map(p => {
                    let imgDisplay = '🛍️';
                    if (p.image_data) {
                        imgDisplay = p.image_data.startsWith('data:image')
                            ? `<img src="${p.image_data}" style="width:60px; height:60px; object-fit:cover; border-radius:8px;">`
                            : `<div style="font-size:50px;">${p.image_data}</div>`;
                    }
                    return `<div style="border:2px solid #e2e8f0; padding:15px; border-radius:12px; background:white; text-align:center;">
                        <div style="margin-bottom:10px;">${imgDisplay}</div>
                        <div style="font-weight:bold; margin-bottom:5px; color:#2d3748;">${escHTML(p.name)}</div>
                        <div style="color:#667eea; font-size:18px; font-weight:bold; margin:8px 0;">${p.price.toFixed(3)} د.ك</div>
                        <div style="color:#6c757d; font-size:13px; margin-bottom:10px;">المخزون: ${p.stock}</div>
                        ${p.barcode ? `<div style="color:#6c757d; font-size:11px; margin-bottom:10px;">📊 ${escHTML(p.barcode)}</div>` : ''}
                        <div style="display:flex; gap:5px; justify-content:center; margin-top:10px;">
                            <button onclick="editProduct(${p.id})" class="btn-sm" style="flex:1;">✏️ تعديل</button>
                            <button onclick="deleteProduct(${p.id})" class="btn-sm btn-danger" style="flex:1;">🗑️</button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function clearAdvancedSearch() {
    document.getElementById('searchProductName').value = '';
    document.getElementById('searchProductBarcode').value = '';
    document.getElementById('searchProductCategory').value = '';
    document.getElementById('searchPriceMin').value = '';
    document.getElementById('searchPriceMax').value = '';
    loadProductsTable();
}

function showAddProduct() {
    // التحقق من الصلاحية
    if (!window.userPermissions?.canAddProducts) {
        alert('❌ ليس لديك صلاحية إضافة المنتجات');
        return;
    }
    
    updateCategoryDropdown();
    loadBranchesDropdowns(); // تحميل الفروع
    document.getElementById('productModalTitle').textContent = '➕ إضافة منتج';
    document.getElementById('productForm').reset();
    document.getElementById('productId').value = '';
    document.getElementById('productImageData').value = '';
    document.getElementById('productImagePreview').style.display = 'none';
    
    // تعيين الفرع الافتراضي للمستخدم
    if (currentUser && document.getElementById('productBranch')) {
        document.getElementById('productBranch').value = currentUser.branch_id || 1;
    }
    
    document.getElementById('addProductModal').classList.add('active');
}

function closeAddProduct() {
    document.getElementById('addProductModal').classList.remove('active');
}

function updateCategoryDropdown() {
    // تحديث select المنتجات
    const productSelect = document.getElementById('productCategory');
    if (productSelect) {
        productSelect.innerHTML = '<option value="">-- اختر فئة --</option>' + 
            Array.from(categories).map(cat => `<option value="${cat}">${cat}</option>`).join('');
    }
    
    // تحديث select المخزون
    const inventorySelect = document.getElementById('inventoryCategory');
    if (inventorySelect) {
        inventorySelect.innerHTML = '<option value="">-- اختر فئة --</option>' + 
            Array.from(categories).map(cat => `<option value="${cat}">${cat}</option>`).join('');
    }
}

document.getElementById('productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const productId = document.getElementById('productId').value;
    const newCat = document.getElementById('newCategory').value.trim();
    const category = newCat || document.getElementById('productCategory').value;
    if (newCat) categories.add(newCat);
    
    const productData = {
        name: document.getElementById('productName').value,
        barcode: document.getElementById('productBarcode').value,
        price: parseFloat(document.getElementById('productPrice').value),
        stock: parseInt(document.getElementById('productStock').value) || 0,
        category: category,
        image_data: document.getElementById('productImageData').value,
        branch_id: parseInt(document.getElementById('productBranch')?.value || currentUser?.branch_id || 1)
    };
    
    try {
        const url = productId ? `${API_URL}/api/products/${productId}` : `${API_URL}/api/products`;
        const method = productId ? 'PUT' : 'POST';
        const response = await fetch(url, {
            method: method,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(productData)
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحفظ');
            closeAddProduct();
            await loadProducts();
            await loadProductsTable();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('خطأ:', error);
        alert('فشل الحفظ');
    }
});

async function editProduct(id) {
    // التحقق من الصلاحية
    if (!window.userPermissions?.canEditProducts) {
        alert('❌ ليس لديك صلاحية تعديل المنتجات');
        return;
    }
    
    const product = allProductsTable.find(p => p.id === id) || allProducts.find(p => p.id === id);
    if (!product) return;
    updateCategoryDropdown();
    loadBranchesDropdowns();
    document.getElementById('productModalTitle').textContent = '✏️ تعديل منتج';
    document.getElementById('productId').value = product.id;
    document.getElementById('productName').value = product.name;
    document.getElementById('productBarcode').value = product.barcode || '';
    document.getElementById('productPrice').value = product.price;
    document.getElementById('productStock').value = product.stock;
    document.getElementById('productCategory').value = product.category || '';
    document.getElementById('productImageData').value = product.image_data || '';
    
    // تعيين الفرع
    if (document.getElementById('productBranch')) {
        document.getElementById('productBranch').value = product.branch_id || 1;
    }
    
    if (product.image_data && product.image_data.startsWith('data:image')) {
        document.getElementById('productImageDisplay').innerHTML = `<img src="${product.image_data}" style="max-width:80px; max-height:80px; border-radius:8px;">`;
        document.getElementById('productImagePreview').style.display = 'block';
    } else {
        document.getElementById('productImagePreview').style.display = 'none';
    }
    
    document.getElementById('addProductModal').classList.add('active');
}

async function deleteProduct(id) {
    // التحقق من الصلاحية
    if (!window.userPermissions?.canDeleteProducts) {
        alert('❌ ليس لديك صلاحية حذف المنتجات');
        return;
    }
    
    if (!confirm('حذف المنتج؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/products/${id}`, {method: 'DELETE'});
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            await loadProducts();
            await loadProductsTable();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// Product Image Upload
function handleProductImage(input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        if (file.size > 500000) {
            if (confirm('الصورة كبيرة. تصغير أم قص؟\nOK = تصغير\nCancel = قص')) {
                resizeImage(file, 100, 100, false);
            } else {
                resizeImage(file, 100, 100, true);
            }
        } else {
            resizeImage(file, 100, 100, false);
        }
    }
}

function resizeImage(file, maxW, maxH, crop) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            let w = img.width, h = img.height;
            if (crop) {
                const size = Math.min(w, h);
                canvas.width = maxW;
                canvas.height = maxH;
                ctx.drawImage(img, (w-size)/2, (h-size)/2, size, size, 0, 0, maxW, maxH);
            } else {
                const ratio = Math.min(maxW/w, maxH/h);
                canvas.width = w * ratio;
                canvas.height = h * ratio;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            document.getElementById('productImageData').value = dataUrl;
            document.getElementById('productImageDisplay').innerHTML = `<img src="${dataUrl}" style="max-width:80px; max-height:80px; border-radius:8px;">`;
            document.getElementById('productImagePreview').style.display = 'block';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function removeProductImage() {
    document.getElementById('productImageData').value = '';
    document.getElementById('productImagePreview').style.display = 'none';
    document.getElementById('productImageInput').value = '';
}

// المزيد في الجزء التالي...

// Invoices
async function loadInvoicesTable() {
    try {
        let invoices = [];
        
        // Online: جلب من السيرفر
        if (_realOnlineStatus) {
            const response = await fetch(`${API_URL}/api/invoices?limit=200`);
            const data = await response.json();
            if (data.success) {
                invoices = data.invoices;
            }
        }
        
        // Offline أو Fallback: جلب من المحلي
        if (!_realOnlineStatus || invoices.length === 0) {
            if (localDB.isReady) {
                const localInvoices = await localDB.getAll('local_invoices');
                if (localInvoices.length > 0) {
                    invoices = localInvoices.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                    console.log('[App] Loaded invoices from local cache');
                }
            }
        }
        
        allInvoices = invoices;
        const container = document.getElementById('invoicesListContainer');
        
        if (invoices.length === 0) {
            container.innerHTML = '<p style="text-align:center; padding:40px;">لا توجد فواتير</p>';
            return;
        }
        
        // إضافة badge للفواتير offline
        container.innerHTML = `
            <table class="data-table">
                <thead><tr><th>رقم الفاتورة</th><th>العميل</th><th>الموظف</th><th>الإجمالي</th><th>حالة الطلب</th><th>التاريخ</th><th>عرض</th></tr></thead>
                <tbody>
                    ${invoices.map(inv => {
                        const isOffline = inv.id && inv.id.toString().startsWith('offline_');
                        const isCancelled = inv.cancelled;
                        const status = inv.order_status || 'قيد التنفيذ';
                        return `
                        <tr style="${isCancelled ? 'opacity:0.5; background:#fff5f5;' : ''}">
                            <td>
                                <strong${isCancelled ? ' style="text-decoration:line-through;"' : ''}>${escHTML(inv.invoice_number)}</strong>
                                ${isCancelled ? ' <span style="background:#dc3545; color:white; padding:2px 6px; border-radius:4px; font-size:10px;">🚫 ملغية</span>' : ''}
                                ${isOffline ? ' <span style="background:#dc3545; color:white; padding:2px 6px; border-radius:4px; font-size:10px;">📴 معلقة</span>' : ''}
                            </td>
                            <td>${escHTML(inv.customer_name) || 'عميل'}</td>
                            <td>${escHTML(inv.employee_name)}</td>
                            <td style="color:${isCancelled ? '#dc3545' : '#28a745'}; font-weight:bold;${isCancelled ? ' text-decoration:line-through;' : ''}">${inv.total.toFixed(3)} د.ك</td>
                            <td>
                                ${isCancelled ? '<span style="color:#dc3545; font-weight:bold; font-size:12px;">🚫 ملغية</span>' : `
                                <select class="order-status-select status-${status === 'قيد التنفيذ' ? 'processing' : status === 'قيد التوصيل' ? 'delivering' : 'completed'}"
                                        onchange="updateOrderStatus(${inv.id}, this.value)" ${isOffline ? 'disabled' : ''}>
                                    <option value="قيد التنفيذ" ${status === 'قيد التنفيذ' ? 'selected' : ''}>⏳ قيد التنفيذ</option>
                                    <option value="قيد التوصيل" ${status === 'قيد التوصيل' ? 'selected' : ''}>🚚 قيد التوصيل</option>
                                    <option value="منجز" ${status === 'منجز' ? 'selected' : ''}>✅ منجز</option>
                                </select>`}
                            </td>
                            <td>${formatKuwaitTime(inv.created_at)}</td>
                            <td><button onclick="viewLocalInvoice('${inv.id}')" class="btn-sm">👁️</button></td>
                        </tr>
                    `;
                    }).join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        console.error('خطأ:', error);
        
        // Fallback للمحلي
        if (localDB.isReady) {
            const localInvoices = await localDB.getAll('local_invoices');
            if (localInvoices.length > 0) {
                allInvoices = localInvoices.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                const container = document.getElementById('invoicesListContainer');
                container.innerHTML = `
                    <table class="data-table">
                        <thead><tr><th>رقم الفاتورة</th><th>العميل</th><th>الموظف</th><th>الإجمالي</th><th>حالة الطلب</th><th>التاريخ</th><th>عرض</th></tr></thead>
                        <tbody>
                            ${allInvoices.map(inv => {
                                const status = inv.order_status || 'قيد التنفيذ';
                                return `
                                <tr>
                                    <td><strong>${escHTML(inv.invoice_number)}</strong> <span style="background:#dc3545; color:white; padding:2px 6px; border-radius:4px; font-size:10px;">📴 معلقة</span></td>
                                    <td>${escHTML(inv.customer_name) || 'عميل'}</td>
                                    <td>${escHTML(inv.employee_name)}</td>
                                    <td style="color:#28a745; font-weight:bold;">${inv.total.toFixed(3)} د.ك</td>
                                    <td>
                                        <span class="order-status-badge status-processing">⏳ ${status}</span>
                                    </td>
                                    <td>${formatKuwaitTime(inv.created_at)}</td>
                                    <td><button onclick="viewLocalInvoice('${inv.id}')" class="btn-sm">👁️</button></td>
                                </tr>
                            `;
                            }).join('')}
                        </tbody>
                    </table>
                `;
            }
        }
    }
}

// عرض فاتورة محلية
async function viewLocalInvoice(invoiceId) {
    try {
        // محاولة من السيرفر أولاً (إذا online ورقم عادي)
        if (_realOnlineStatus && !invoiceId.toString().startsWith('offline_')) {
            const response = await fetch(`${API_URL}/api/invoices/${invoiceId}`);
            const data = await response.json();
            if (data.success) {
                currentInvoice = data.invoice;
                displayInvoiceView(currentInvoice);
                document.getElementById('invoiceViewModal').classList.add('active');
                return;
            }
        }
        
        // من المحلي
        if (localDB.isReady) {
            const invoice = await localDB.get('local_invoices', invoiceId);
            if (invoice) {
                currentInvoice = invoice;
                displayInvoiceView(currentInvoice);
                document.getElementById('invoiceViewModal').classList.add('active');
            } else {
                alert('لم يتم العثور على الفاتورة');
            }
        }
    } catch (error) {
        console.error('خطأ:', error);
        
        // Fallback للمحلي
        if (localDB.isReady) {
            const invoice = await localDB.get('local_invoices', invoiceId);
            if (invoice) {
                currentInvoice = invoice;
                displayInvoiceView(currentInvoice);
                document.getElementById('invoiceViewModal').classList.add('active');
            } else {
                alert('لم يتم العثور على الفاتورة');
            }
        }
    }
}

async function exportInvoicesExcel() {
    if (allInvoices.length === 0) {
        alert('لا توجد فواتير للتصدير');
        return;
    }
    const data = allInvoices.map(inv => ({
        'رقم الفاتورة': inv.invoice_number,
        'العميل': inv.customer_name || '',
        'الهاتف': inv.customer_phone || '',
        'الموظف': inv.employee_name,
        'المجموع الفرعي': inv.subtotal,
        'الخصم': inv.discount,
        'رسوم التوصيل': inv.delivery_fee || 0,
        'الإجمالي': inv.total,
        'طريقة الدفع': inv.payment_method,
        'حالة الطلب': inv.order_status || 'قيد التنفيذ',
        'رقم العملية': inv.transaction_number || '',
        'التاريخ': formatKuwaitTime(inv.created_at)
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'الفواتير');
    XLSX.writeFile(wb, `invoices_${Date.now()}.xlsx`);
    alert('✅ تم تصدير الفواتير');
}

async function clearAllInvoices() {
    if (!confirm('⚠️ حذف جميع الفواتير؟\nلا يمكن التراجع!')) return;
    if (!confirm('تأكيد نهائي؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/invoices/clear-all`, {method: 'DELETE'});
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            await loadInvoicesTable();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// Reports
async function loadReports() {
    const startDate = document.getElementById('reportStartDate').value;
    const endDate = document.getElementById('reportEndDate').value;
    let url = `${API_URL}/api/reports/sales`;
    const params = [];
    if (startDate) params.push(`start_date=${startDate}`);
    if (endDate) params.push(`end_date=${endDate}`);
    if (params.length > 0) url += '?' + params.join('&');
    
    try {
        const [salesResponse, topProductsResponse] = await Promise.all([
            fetch(url),
            fetch(`${API_URL}/api/reports/top-products?limit=10`)
        ]);
        const salesData = await salesResponse.json();
        const topProductsData = await topProductsResponse.json();
        if (salesData.success && topProductsData.success) {
            displayReports(salesData.report, topProductsData.products);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function displayReports(report, topProducts) {
    const content = document.getElementById('reportsContent');
    content.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:15px; margin:20px 0;">
            <div class="stat-card"><div class="stat-icon">🧾</div><div class="stat-value">${report.total_invoices || 0}</div><div class="stat-label">الفواتير</div></div>
            <div class="stat-card"><div class="stat-icon">💰</div><div class="stat-value">${(report.total_sales || 0).toFixed(3)}</div><div class="stat-label">المبيعات (د.ك)</div></div>
            <div class="stat-card"><div class="stat-icon">🎁</div><div class="stat-value">${(report.total_discount || 0).toFixed(3)}</div><div class="stat-label">الخصومات (د.ك)</div></div>
            <div class="stat-card"><div class="stat-icon">📊</div><div class="stat-value">${(report.average_sale || 0).toFixed(3)}</div><div class="stat-label">متوسط الفاتورة (د.ك)</div></div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">
            <div class="report-card">
                <h3>💳 طرق الدفع</h3>
                ${report.payment_methods && report.payment_methods.length > 0 ? `
                    <div style="display:flex; flex-direction:column; gap:10px; margin-top:15px;">
                        ${report.payment_methods.map(pm => {
                            const pct = report.total_invoices > 0 ? ((pm.count / report.total_invoices) * 100).toFixed(1) : 0;
                            return `
                                <div>
                                    <div style="display:flex; justify-content:space-between; margin-bottom:5px;"><span>${getPaymentMethodName(pm.payment_method)}</span><span style="color:#28a745; font-weight:bold;">${pm.total.toFixed(3)} د.ك</span></div>
                                    <div style="display:flex; align-items:center; gap:10px;">
                                        <div style="flex:1; height:8px; background:#e2e8f0; border-radius:4px; overflow:hidden;"><div style="width:${pct}%; height:100%; background:linear-gradient(90deg, #667eea, #764ba2);"></div></div>
                                        <span style="font-size:11px; color:#6c757d;">${pm.count} (${pct}%)</span>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                ` : '<p style="text-align:center; color:#6c757d;">لا توجد بيانات</p>'}
            </div>
            <div class="report-card">
                <h3>🏆 أفضل المنتجات</h3>
                ${topProducts && topProducts.length > 0 ? `
                    <div style="margin-top:15px;">
                        ${topProducts.map((p, i) => `
                            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; margin-bottom:5px; background:#f8f9fa; border-radius:6px;">
                                <div style="display:flex; align-items:center; gap:8px;"><span style="font-weight:bold; color:#667eea; font-size:16px;">#${i+1}</span><span style="font-size:13px;">${escHTML(p.product_name)}</span></div>
                                <div style="text-align:left;"><div style="font-weight:bold; color:#28a745; font-size:13px;">${p.total_sales.toFixed(3)} د.ك</div><div style="font-size:10px; color:#6c757d;">${p.total_quantity} قطعة</div></div>
                            </div>
                        `).join('')}
                    </div>
                ` : '<p style="text-align:center; color:#6c757d;">لا توجد بيانات</p>'}
            </div>
        </div>
    `;
}

function getPaymentMethodName(m) {
    const names = {'cash':'💵 نقداً','knet':'💳 كي نت','visa':'💳 فيزا','other':'💰 أخرى'};
    return names[m] || m;
}

// Accounting - Load as iframe
function loadAccounting() {
    const iframe = document.getElementById('accountingFrame');
    if (!iframe) {
        document.getElementById('accountingContent').innerHTML = `
            <iframe src="accounting.html" style="width:100%; height:calc(100vh - 150px); border:none; border-radius:10px;"></iframe>
        `;
    } else {
        iframe.src = 'accounting.html';
    }
}

// Users
async function loadUsersTable() {
    if (currentUser.role !== 'admin') return;
    try {
        // تحميل المستخدمين والفروع والشفتات
        const [usersResponse, branchesResponse, shiftsResponse] = await Promise.all([
            fetch(`${API_URL}/api/users`),
            fetch(`${API_URL}/api/branches`),
            fetch(`${API_URL}/api/shifts`)
        ]);
        const usersData = await usersResponse.json();
        const branchesData = await branchesResponse.json();
        const shiftsData = await shiftsResponse.json();

        if (usersData.success && branchesData.success) {
            // إنشاء map للفروع
            const branchesMap = {};
            branchesData.branches.forEach(b => {
                branchesMap[b.id] = b.name;
            });
            // إنشاء map للشفتات
            const shiftsMap = {};
            if (shiftsData.success) {
                shiftsData.shifts.forEach(s => {
                    shiftsMap[s.id] = s.name;
                });
            }

            const container = document.getElementById('usersTableContainer');
            container.innerHTML = `
                <table class="data-table">
                    <thead><tr><th>المستخدم</th><th>الاسم</th><th>الصلاحية</th><th>الفرع</th><th>الشفت</th><th>البادئة</th><th>الحالة</th><th>إجراءات</th></tr></thead>
                    <tbody>
                        ${usersData.users.map(u => `
                            <tr>
                                <td><strong>${escHTML(u.username)}</strong></td>
                                <td>${escHTML(u.full_name)}</td>
                                <td>${u.role === 'admin' ? '👑 مدير' : '💼 كاشير'}</td>
                                <td><span style="background:#38a169; color:white; padding:4px 8px; border-radius:4px;">${escHTML(branchesMap[u.branch_id] || 'الفرع الرئيسي')}</span></td>
                                <td>${u.shift_id ? `<span style="background:#e67e22; color:white; padding:4px 8px; border-radius:4px;">🕐 ${escHTML(shiftsMap[u.shift_id] || '-')}</span>` : '<span style="color:#a0aec0;">-</span>'}</td>
                                <td><span style="background:#667eea; color:white; padding:4px 8px; border-radius:4px; font-weight:bold;">${escHTML(u.invoice_prefix || '-')}</span></td>
                                <td>${u.is_active ? '✅' : '❌'}</td>
                                <td>
                                    <button onclick="editUser(${u.id})" class="btn-sm">✏️</button>
                                    ${u.role !== 'admin' ? `<button onclick="deleteUser(${u.id})" class="btn-sm btn-danger">🗑️</button>` : ''}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function showAddUser() {
    loadBranchesForUserForm(); // تحميل الفروع
    loadShiftsForUserForm(); // تحميل الشفتات
    document.getElementById('userModalTitle').textContent = '➕ إضافة مستخدم';
    document.getElementById('userForm').reset();
    document.getElementById('userId').value = '';
    document.getElementById('username').disabled = false;
    document.getElementById('userPassword').required = true;
    document.getElementById('addUserModal').classList.add('active');
}

function closeAddUser() {
    document.getElementById('addUserModal').classList.remove('active');
}

document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('userId').value;
    const role = document.getElementById('userRole').value;
    
    const userData = {
        username: document.getElementById('username').value,
        password: document.getElementById('userPassword').value,
        full_name: document.getElementById('fullName').value,
        role: role,
        invoice_prefix: document.getElementById('invoicePrefix').value,
        branch_id: parseInt(document.getElementById('userBranch').value) || 1,
        shift_id: parseInt(document.getElementById('userShift').value) || null
    };
    
    // إضافة الصلاحيات إذا كان كاشير
    if (role === 'cashier') {
        const permCheckboxes = document.querySelectorAll('#permissionsSection input[type="checkbox"]');
        permCheckboxes.forEach(cb => {
            const permName = cb.getAttribute('name');
            userData[permName] = cb.checked ? 1 : 0;
        });
    } else {
        // المدير - كل الصلاحيات = 1
        userData.can_view_products = 1;
        userData.can_add_products = 1;
        userData.can_edit_products = 1;
        userData.can_delete_products = 1;
        userData.can_view_inventory = 1;
        userData.can_add_inventory = 1;
        userData.can_edit_inventory = 1;
        userData.can_delete_inventory = 1;
        userData.can_view_invoices = 1;
        userData.can_delete_invoices = 1;
        userData.can_view_customers = 1;
        userData.can_add_customer = 1;
        userData.can_edit_customer = 1;
        userData.can_delete_customer = 1;
        userData.can_view_reports = 1;
        userData.can_view_accounting = 1;
        userData.can_manage_users = 1;
        userData.can_access_settings = 1;
        userData.can_view_returns = 1;
        userData.can_view_expenses = 1;
        userData.can_view_suppliers = 1;
        userData.can_view_coupons = 1;
        userData.can_view_tables = 1;
        userData.can_view_attendance = 1;
        userData.can_view_advanced_reports = 1;
        userData.can_view_system_logs = 1;
        userData.can_view_dcf = 1;
        userData.can_cancel_invoices = 1;
        userData.can_view_branches = 1;
        userData.can_view_cross_branch_stock = 1;
        userData.can_edit_completed_invoices = 1;
        userData.can_view_transfers = 1;
        userData.can_create_transfer = 1;
        userData.can_approve_transfer = 1;
        userData.can_deliver_transfer = 1;
        userData.can_view_subscriptions = 1;
        userData.can_manage_subscriptions = 1;
    }
    
    if (userId && !userData.password) delete userData.password;
    
    try {
        const url = userId ? `${API_URL}/api/users/${userId}` : `${API_URL}/api/users`;
        const method = userId ? 'PUT' : 'POST';
        const response = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(userData)});
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحفظ');
            await logAction(userId ? 'edit_user' : 'add_user', `${userId ? 'تعديل' : 'إضافة'} مستخدم: ${userData.full_name} (${userData.role})`, data.id || userId);
            closeAddUser();
            await loadUsersTable();

            // إذا تم تعديل المستخدم الحالي، حدّث userInfo
            if (userId && parseInt(userId) === currentUser.id) {
                // تحديث بيانات المستخدم الحالي
                const updatedResponse = await fetch(`${API_URL}/api/users`);
                const updatedData = await updatedResponse.json();
                if (updatedData.success) {
                    const updatedUser = updatedData.users.find(u => u.id === currentUser.id);
                    if (updatedUser) {
                        // تحديث currentUser
                        Object.assign(currentUser, updatedUser);
                        
                        // جلب اسم الفرع
                        const branchResponse = await fetch(`${API_URL}/api/branches`);
                        const branchData = await branchResponse.json();
                        if (branchData.success) {
                            const branch = branchData.branches.find(b => b.id === currentUser.branch_id);
                            currentUser.branch_name = branch ? branch.name : '';
                            
                            // تحديث العرض
                            const branchText = currentUser.branch_name ? ` - ${currentUser.branch_name}` : '';
                            document.getElementById('userInfo').textContent = `${currentUser.full_name} (${currentUser.invoice_prefix || 'INV'})${branchText}`;
                        }
                    }
                }
            }
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
});

async function editUser(id) {
    try {
        // تحميل الفروع والشفتات أولاً
        await loadBranchesForUserForm();
        await loadShiftsForUserForm();

        const response = await fetch(`${API_URL}/api/users`);
        const data = await response.json();
        if (data.success) {
            const user = data.users.find(u => u.id === id);
            if (!user) return;
            document.getElementById('userModalTitle').textContent = '✏️ تعديل مستخدم';
            document.getElementById('userId').value = user.id;
            document.getElementById('username').value = user.username;
            document.getElementById('username').disabled = true;
            document.getElementById('userPassword').required = false;
            document.getElementById('userPassword').placeholder = 'اتركها فارغة إذا لم تريد تغييرها';
            document.getElementById('fullName').value = user.full_name;
            document.getElementById('userRole').value = user.role;
            document.getElementById('invoicePrefix').value = user.invoice_prefix || '';
            document.getElementById('userBranch').value = user.branch_id || 1;
            document.getElementById('userShift').value = user.shift_id || '';
            
            // إظهار/إخفاء قسم الصلاحيات
            const permSection = document.getElementById('permissionsSection');
            if (user.role === 'cashier') {
                permSection.style.display = 'block';
                
                // تحديد الصلاحيات الحالية
                const permCheckboxes = document.querySelectorAll('#permissionsSection input[type="checkbox"]');
                permCheckboxes.forEach(cb => {
                    const permName = cb.getAttribute('name');
                    cb.checked = user[permName] === 1;
                });
            } else {
                permSection.style.display = 'none';
            }
            
            document.getElementById('addUserModal').classList.add('active');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function deleteUser(id) {
    if (!confirm('حذف المستخدم؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/users/${id}`, {method: 'DELETE'});
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            await logAction('delete_user', `حذف مستخدم رقم ${id}`, id);
            await loadUsersTable();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// Settings
async function loadSettings() {
    try {
        const response = await fetch(`${API_URL}/api/settings`);
        const data = await response.json();
        if (data.success) {
            document.getElementById('storeName').value = data.settings.store_name || '';
            document.getElementById('storePhone').value = data.settings.store_phone || '';
            document.getElementById('storeAddress').value = data.settings.store_address || '';
            
            // العملة
            if (document.getElementById('storeCurrency')) {
                document.getElementById('storeCurrency').value = data.settings.store_currency || 'KWD';
            }
            
            // شعار المتجر
            if (data.settings.store_logo) {
                storeLogo = data.settings.store_logo;
                document.getElementById('logoPreviewImg').src = storeLogo;
                document.getElementById('logoPreview').style.display = 'block';
            }
            
            // أيقونة Login
            if (data.settings.login_icon) {
                document.querySelector('.login-logo').innerHTML = `<img src="${data.settings.login_icon}" style="width: 100px; height: 100px; border-radius: 50%; object-fit: cover;">`;
                if (document.getElementById('loginIconPreviewImg')) {
                    document.getElementById('loginIconPreviewImg').src = data.settings.login_icon;
                    document.getElementById('loginIconPreview').style.display = 'block';
                }
            }

            // إعدادات الولاء
            window.loyaltyConfig = {
                enabled: data.settings.loyalty_enabled !== 'false',
                pointsPerInvoice: parseInt(data.settings.loyalty_points_per_invoice) || 10,
                pointValue: parseFloat(data.settings.loyalty_point_value) || 0.1
            };
            if (document.getElementById('loyaltyEnabled')) {
                document.getElementById('loyaltyEnabled').value = data.settings.loyalty_enabled || 'true';
            }
            if (document.getElementById('loyaltyPointsPerInvoice')) {
                document.getElementById('loyaltyPointsPerInvoice').value = window.loyaltyConfig.pointsPerInvoice;
            }
            if (document.getElementById('loyaltyPointValue')) {
                document.getElementById('loyaltyPointValue').value = window.loyaltyConfig.pointValue.toFixed(3);
            }
            if (document.getElementById('pointValueHint')) {
                document.getElementById('pointValueHint').textContent = window.loyaltyConfig.pointValue.toFixed(3);
            }
            updateLoyaltyPreview();

            // إعدادات المخزون المنخفض
            window.lowStockThreshold = parseInt(data.settings.low_stock_threshold) || 5;
            if (document.getElementById('lowStockThreshold')) {
                document.getElementById('lowStockThreshold').value = window.lowStockThreshold;
            }
        }

    } catch (error) {
        console.error('خطأ:', error);
    }
}

function previewLogo(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('logoPreviewImg').src = e.target.result;
            document.getElementById('logoPreview').style.display = 'block';
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function removeLogo() {
    document.getElementById('storeLogo').value = '';
    document.getElementById('logoPreview').style.display = 'none';
    storeLogo = null;
}

function previewLoginIcon(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('loginIconPreviewImg').src = e.target.result;
            document.getElementById('loginIconPreview').style.display = 'block';
            // تحديث الأيقونة في شاشة Login مباشرة
            document.querySelector('.login-logo').innerHTML = `<img src="${e.target.result}" style="width: 100px; height: 100px; border-radius: 50%; object-fit: cover;">`;
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function removeLoginIcon() {
    document.getElementById('loginIcon').value = '';
    document.getElementById('loginIconPreview').style.display = 'none';
    // استعادة الأيقونة الافتراضية
    document.querySelector('.login-logo').textContent = '🛍️';
}

async function saveSettings() {
    const logoInput = document.getElementById('storeLogo');
    let logoData = storeLogo;
    if (logoInput.files && logoInput.files[0]) {
        logoData = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(logoInput.files[0]);
        });
    }
    
    // أيقونة Login
    const loginIconInput = document.getElementById('loginIcon');
    let loginIconData = null;
    if (loginIconInput && loginIconInput.files && loginIconInput.files[0]) {
        loginIconData = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(loginIconInput.files[0]);
        });
    }
    
    const settings = {
        store_name: document.getElementById('storeName').value,
        store_phone: document.getElementById('storePhone').value,
        store_address: document.getElementById('storeAddress').value,
        store_currency: document.getElementById('storeCurrency')?.value || 'KWD',
        store_logo: logoData || '',
        login_icon: loginIconData
    };
    
    try {
        const response = await fetch(`${API_URL}/api/settings`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(settings)
        });
        const data = await response.json();
        if (data.success) {
            storeLogo = logoData;
            alert('✅ تم الحفظ');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function saveLoyaltySettings() {
    const settings = {
        loyalty_enabled: document.getElementById('loyaltyEnabled').value,
        loyalty_points_per_invoice: document.getElementById('loyaltyPointsPerInvoice').value,
        loyalty_point_value: document.getElementById('loyaltyPointValue').value
    };
    try {
        const response = await fetch(`${API_URL}/api/settings`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(settings)
        });
        const data = await response.json();
        if (data.success) {
            window.loyaltyConfig = {
                enabled: settings.loyalty_enabled !== 'false',
                pointsPerInvoice: parseInt(settings.loyalty_points_per_invoice) || 10,
                pointValue: parseFloat(settings.loyalty_point_value) || 0.1
            };
            if (document.getElementById('pointValueHint')) {
                document.getElementById('pointValueHint').textContent = window.loyaltyConfig.pointValue.toFixed(3);
            }
            alert('✅ تم حفظ إعدادات الولاء');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الحفظ');
    }
}

async function saveLowStockSettings() {
    const threshold = document.getElementById('lowStockThreshold').value;
    if (!threshold || parseInt(threshold) < 1) {
        alert('الرجاء إدخال رقم صحيح أكبر من صفر');
        return;
    }
    try {
        const response = await fetch(`${API_URL}/api/settings`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ low_stock_threshold: threshold })
        });
        const data = await response.json();
        if (data.success) {
            window.lowStockThreshold = parseInt(threshold);
            alert('✅ تم حفظ إعدادات المخزون');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الحفظ');
    }
}

function updateLoyaltyPreview() {
    const el = document.getElementById('loyaltyPreviewText');
    if (!el) return;
    const cfg = window.loyaltyConfig || { pointsPerInvoice: 10, pointValue: 0.1 };
    el.innerHTML = `
        <div>🎯 كل فاتورة يحصل العميل على: <strong style="color: #0ea5e9;">${cfg.pointsPerInvoice} نقطة</strong></div>
        <div>💰 قيمة كل نقطة: <strong style="color: #38a169;">${cfg.pointValue.toFixed(3)} د.ك</strong></div>
        <div>📊 يعني كل فاتورة قيمة النقاط: <strong style="color: #667eea;">${(cfg.pointsPerInvoice * cfg.pointValue).toFixed(3)} د.ك</strong></div>
        <div>📌 مثال: عميل عنده ${cfg.pointsPerInvoice * 5} نقطة = <strong style="color: #e53e3e;">${(cfg.pointsPerInvoice * 5 * cfg.pointValue).toFixed(3)} د.ك</strong> خصم</div>
    `;
}

// ===== نظام الفروع =====

async function loadBranchesDropdowns() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            // تحديث dropdown المستخدمين
            const userBranchSelect = document.getElementById('userBranch');
            if (userBranchSelect) {
                userBranchSelect.innerHTML = data.branches.map(b => 
                    `<option value="${b.id}">${escHTML(b.name)}</option>`
                ).join('');
            }
            
            // تحديث dropdown المنتجات
            const productBranchSelect = document.getElementById('productBranch');
            if (productBranchSelect) {
                productBranchSelect.innerHTML = data.branches.map(b => 
                    `<option value="${b.id}">${escHTML(b.name)}</option>`
                ).join('');
            }
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function loadBranchesTable() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const container = document.getElementById('branchesTableContainer');
            let html = '<table class="data-table"><thead><tr><th>رقم الفرع</th><th>الاسم</th><th>الموقع</th><th>الهاتف</th><th>إجراءات</th></tr></thead><tbody>';
            
            data.branches.forEach(b => {
                html += `
                    <tr>
                        <td><strong style="background: #667eea; color: white; padding: 5px 10px; border-radius: 5px;">B${b.id}</strong></td>
                        <td>${escHTML(b.name)}</td>
                        <td>${escHTML(b.location) || '-'}</td>
                        <td>${escHTML(b.phone) || '-'}</td>
                        <td>
                            <button onclick="editBranch(${b.id})" class="btn-sm">✏️</button>
                            <button onclick="deleteBranch(${b.id})" class="btn-sm btn-danger">🗑️</button>
                        </td>
                    </tr>
                `;
            });
            
            html += '</tbody></table>';
            container.innerHTML = html;
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function showAddBranch() {
    document.getElementById('branchModalTitle').textContent = '➕ إضافة فرع';
    document.getElementById('branchForm').reset();
    document.getElementById('branchId').value = '';
    document.getElementById('addBranchModal').classList.add('active');
}

function closeAddBranch() {
    document.getElementById('addBranchModal').classList.remove('active');
}

document.getElementById('branchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const branchId = document.getElementById('branchId').value;
    const branchData = {
        name: document.getElementById('branchName').value,
        location: document.getElementById('branchLocation').value,
        phone: document.getElementById('branchPhone').value
    };
    
    try {
        const url = branchId ? `${API_URL}/api/branches/${branchId}` : `${API_URL}/api/branches`;
        const method = branchId ? 'PUT' : 'POST';
        const response = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(branchData)});
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحفظ');
            closeAddBranch();
            await loadBranchesTable();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
});

async function editBranch(id) {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const branch = data.branches.find(b => b.id === id);
            if (!branch) return;
            
            document.getElementById('branchModalTitle').textContent = '✏️ تعديل فرع';
            document.getElementById('branchId').value = branch.id;
            document.getElementById('branchName').value = branch.name;
            document.getElementById('branchLocation').value = branch.location || '';
            document.getElementById('branchPhone').value = branch.phone || '';
            document.getElementById('addBranchModal').classList.add('active');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function deleteBranch(id) {
    if (!confirm('حذف الفرع؟ (سيتم إخفاؤه فقط)')) return;
    try {
        const response = await fetch(`${API_URL}/api/branches/${id}`, {method: 'DELETE'});
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            await loadBranchesTable();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// ===== سجل الحضور والانصراف =====

let currentAttendanceId = null;

async function recordCheckIn() {
    if (!currentUser) return;
    
    try {
        const response = await fetch(`${API_URL}/api/attendance/check-in`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                user_id: currentUser.id,
                user_name: currentUser.full_name,
                branch_id: currentUser.branch_id || 1
            })
        });
        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                console.log('✅ تم تسجيل الحضور');
            }
        }
    } catch (error) {
        // لا نعطل Login إذا فشل تسجيل الحضور
        console.log('تحذير: لم يتم تسجيل الحضور');
    }
}

async function checkOut() {
    if (!currentUser) return;
    
    if (!confirm('هل تريد تسجيل الخروج من النظام؟')) return;
    
    try {
        const response = await fetch(`${API_URL}/api/attendance/check-out`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                user_id: currentUser.id
            })
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم تسجيل الخروج');
            logout();
        } else {
            alert('⚠️ ' + (data.error || 'حدث خطأ'));
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function loadAttendanceLog() {
    try {
        const userId = document.getElementById('filterAttendanceUser').value;
        const date = document.getElementById('filterAttendanceDate').value;
        
        const params = new URLSearchParams();
        if (userId) params.append('user_id', userId);
        if (date) params.append('date', date);

        const response = await fetch(`${API_URL}/api/attendance?${params}`);
        const data = await response.json();
        
        if (data.success) {
            // تحميل الفروع لعرض الأسماء
            const branchesResponse = await fetch(`${API_URL}/api/branches`);
            const branchesData = await branchesResponse.json();
            const branches = {};
            if (branchesData.success) {
                branchesData.branches.forEach(b => branches[b.id] = b.name);
            }
            
            const container = document.getElementById('attendanceTableContainer');
            let html = '<table class="data-table" style="font-size: 14px;"><thead><tr><th>الموظف</th><th>الفرع</th><th>تاريخ الحضور</th><th>وقت الدخول</th><th>وقت الخروج</th><th>المدة</th></tr></thead><tbody>';
            
            data.records.forEach(r => {
                const checkIn = new Date(r.check_in);
                const checkOut = r.check_out ? new Date(r.check_out) : null;
                
                const dateStr = checkIn.toLocaleDateString('ar-EG');
                const checkInTime = checkIn.toLocaleTimeString('ar-EG', {hour: '2-digit', minute: '2-digit'});
                const checkOutTime = checkOut ? checkOut.toLocaleTimeString('ar-EG', {hour: '2-digit', minute: '2-digit'}) : '-';
                
                let duration = '-';
                if (checkOut) {
                    const diff = checkOut - checkIn;
                    const hours = Math.floor(diff / 3600000);
                    const minutes = Math.floor((diff % 3600000) / 60000);
                    duration = `${hours}س ${minutes}د`;
                }
                
                const statusColor = checkOut ? '#38a169' : '#e53e3e';
                const statusIcon = checkOut ? '✅' : '⏳';
                const branchName = branches[r.branch_id] || 'غير محدد';
                
                html += `
                    <tr style="background: ${checkOut ? '#f0fff4' : '#fff5f5'};">
                        <td><strong>${escHTML(r.user_name)}</strong></td>
                        <td>🏢 ${branchName}</td>
                        <td>${dateStr}</td>
                        <td>${statusIcon} ${checkInTime}</td>
                        <td style="color: ${statusColor};">${checkOutTime}</td>
                        <td><strong>${duration}</strong></td>
                    </tr>
                `;
            });
            
            html += '</tbody></table>';
            
            if (data.records.length === 0) {
                html = '<p style="text-align: center; padding: 40px; color: #6c757d;">لا توجد سجلات</p>';
            }
            
            container.innerHTML = html;
            
            // تحديث قائمة الموظفين في الفلتر
            await updateAttendanceUserFilter();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function updateAttendanceUserFilter() {
    try {
        const response = await fetch(`${API_URL}/api/users`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('filterAttendanceUser');
            const currentValue = select.value;
            select.innerHTML = '<option value="">كل الموظفين</option>';
            data.users.forEach(u => {
                select.innerHTML += `<option value="${u.id}">${u.full_name}</option>`;
            });
            select.value = currentValue;
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function clearAttendanceFilters() {
    document.getElementById('filterAttendanceUser').value = '';
    document.getElementById('filterAttendanceDate').value = '';
    loadAttendanceLog();
}


// ===== نظام المخزون الجديد =====

let allInventory = [];

async function loadInventory() {
    try {
        const response = await fetch(`${API_URL}/api/inventory`);
        const data = await response.json();
        if (data.success) {
            allInventory = data.inventory;
            // تحديث الفئات من المخزون
            data.inventory.forEach(item => {
                if (item.category) categories.add(item.category);
            });
            updateCategoryDropdown();
            await displayInventory();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function displayInventory() {
    const container = document.getElementById('inventoryTableContainer');
    if (allInventory.length === 0) {
        container.innerHTML = '<p style="text-align: center; padding: 40px; color: #6c757d;">لا توجد منتجات في المخزون</p>';
        return;
    }
    
    // جلب كل التوزيعات والمبيعات والتالف
    let allDistributions = {};
    let branchDistributions = {}; // {inventory_id: {branch_name: stock}}
    let allSold = {};
    let allDamaged = {};

    try {
        // جلب التوزيعات الحالية (تشمل branch_name من الجوين)
        const stockResponse = await fetch(`${API_URL}/api/branch-stock`);
        const stockData = await stockResponse.json();
        if (stockData.success) {
            stockData.stock.forEach(s => {
                const invId = s.inventory_id;
                if (!allDistributions[invId]) allDistributions[invId] = 0;
                allDistributions[invId] += s.stock;
                // تجميع حسب اسم الفرع مباشرة
                if (!branchDistributions[invId]) branchDistributions[invId] = {};
                const bName = s.branch_name || `فرع ${s.branch_id}`;
                if (!branchDistributions[invId][bName]) branchDistributions[invId][bName] = 0;
                branchDistributions[invId][bName] += s.stock;
            });
        }
        
        // جلب المبيعات
        const invoicesResponse = await fetch(`${API_URL}/api/invoices`);
        const invoicesData = await invoicesResponse.json();
        if (invoicesData.success) {
            invoicesData.invoices.forEach(inv => {
                if (inv.items) {
                    inv.items.forEach(item => {
                        // نحتاج inventory_id من branch_stock
                        // سنحسب من اسم المنتج (مؤقتاً)
                        const product = allInventory.find(p => p.name === item.product_name);
                        if (product) {
                            if (!allSold[product.id]) {
                                allSold[product.id] = 0;
                            }
                            allSold[product.id] += item.quantity;
                        }
                    });
                }
            });
        }
        
        // جلب التالف
        const damagedResponse = await fetch(`${API_URL}/api/damaged-items`);
        const damagedData = await damagedResponse.json();
        if (damagedData.success) {
            damagedData.damaged.forEach(d => {
                if (!allDamaged[d.inventory_id]) {
                    allDamaged[d.inventory_id] = 0;
                }
                allDamaged[d.inventory_id] += d.quantity;
            });
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
    
    let html = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>الصورة</th>
                    <th>اسم المنتج</th>
                    <th>الباركود</th>
                    <th>الفئة</th>
                    <th>السعر</th>
                    <th>التكلفة</th>
                    <th>الفروع</th>
                    <th>الموزع</th>
                    <th>المباع</th>
                    <th>التالف</th>
                    <th>إجراءات</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    allInventory.forEach(item => {
        let imgDisplay = '🛍️';
        if (item.image_data && item.image_data.startsWith('data:image/')) {
            imgDisplay = `<img src="${escHTML(item.image_data)}" style="width:40px; height:40px; object-fit:cover; border-radius:5px;">`;
        }
        
        const distributed = allDistributions[item.id] || 0;
        const sold = allSold[item.id] || 0;
        const damaged = allDamaged[item.id] || 0;
        const itemBranches = branchDistributions[item.id] || {};

        // عرض الفروع (الاسم: الكمية)
        const branchEntries = Object.entries(itemBranches);
        let branchesDisplay = '<span style="color:#999;">-</span>';
        if (branchEntries.length > 0) {
            branchesDisplay = branchEntries.map(([bName, bStock]) => {
                return `<div style="font-size:11px; white-space:nowrap;"><span style="color:#3182ce;">🏢 ${escHTML(bName)}</span>: <strong>${bStock}</strong></div>`;
            }).join('');
        }

        const distributedDisplay = distributed > 0
            ? `<span style="background: #d4edda; padding: 5px 10px; border-radius: 5px; font-weight: bold;">${distributed}</span>`
            : `<span style="color: #999;">0</span>`;

        const soldDisplay = sold > 0
            ? `<span style="background: #fff3cd; padding: 5px 10px; border-radius: 5px; font-weight: bold;">${sold}</span>`
            : `<span style="color: #999;">0</span>`;

        const damagedDisplay = damaged > 0
            ? `<span style="background: #f8d7da; padding: 5px 10px; border-radius: 5px; font-weight: bold;">${damaged}</span>`
            : `<span style="color: #999;">0</span>`;
        
        const hasVariants = item.variants && item.variants.length > 0;
        const variantBadge = hasVariants
            ? ` <button onclick="toggleInventoryVariants(${item.id})" class="btn-sm" style="background:#38a169;color:white;padding:2px 8px;font-size:11px;border-radius:6px;cursor:pointer;">📐 ${item.variants.length} خاصية</button>`
            : '';

        html += `
            <tr>
                <td style="text-align: center;">${imgDisplay}</td>
                <td><strong>${escHTML(item.name)}</strong>${variantBadge}</td>
                <td>${escHTML(item.barcode) || '-'}</td>
                <td>${escHTML(item.category) || '-'}</td>
                <td>${item.price.toFixed(3)} د.ك</td>
                <td>${(item.cost || 0).toFixed(3)} د.ك</td>
                <td>${branchesDisplay}</td>
                <td style="text-align: center;">${distributedDisplay}</td>
                <td style="text-align: center;">${soldDisplay}</td>
                <td style="text-align: center;">${damagedDisplay}</td>
                <td>
                    <button onclick="editInventory(${item.id})" class="btn-sm">✏️</button>
                    <button onclick="deleteInventory(${item.id})" class="btn-sm btn-danger">🗑️</button>
                    <button onclick="distributeToBranch(${item.id})" class="btn-sm" style="background: #3182ce;">📤</button>
                    <button onclick="reportDamage(${item.id})" class="btn-sm" style="background: #e53e3e;">💔</button>
                </td>
            </tr>
        `;

        if (hasVariants) {
            html += `
            <tr id="invVariants_${item.id}" style="display: none;">
                <td colspan="11" style="padding: 0;">
                    <div style="background: #f0fff4; padding: 12px; border-radius: 8px; margin: 5px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <thead>
                                <tr style="background: #38a169; color: white;">
                                    <th style="padding: 8px; border-radius: 0 6px 0 0;">الخاصية</th>
                                    <th style="padding: 8px;">السعر</th>
                                    <th style="padding: 8px;">التكلفة</th>
                                    <th style="padding: 8px; border-radius: 6px 0 0 0;">الباركود</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${item.variants.map(v => `
                                <tr style="border-bottom: 1px solid #c6f6d5;">
                                    <td style="padding: 8px; text-align: center; font-weight: bold;">${escHTML(v.variant_name)}</td>
                                    <td style="padding: 8px; text-align: center; color: #38a169; font-weight: bold;">${v.price.toFixed(3)} د.ك</td>
                                    <td style="padding: 8px; text-align: center; color: #e53e3e;">${(v.cost || 0).toFixed(3)} د.ك</td>
                                    <td style="padding: 8px; text-align: center; color: #666;">${escHTML(v.barcode) || '-'}</td>
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                </td>
            </tr>`;
        }
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function toggleInventoryVariants(inventoryId) {
    const row = document.getElementById('invVariants_' + inventoryId);
    if (row) {
        row.style.display = row.style.display === 'none' ? '' : 'none';
    }
}

// ===== نظام خصائص/متغيرات المنتجات =====
let variantRowCounter = 0;

function addVariantRow(data = {}) {
    variantRowCounter++;
    const container = document.getElementById('variantsContainer');
    const emptyMsg = document.getElementById('variantsEmptyMsg');
    if (emptyMsg) emptyMsg.style.display = 'none';

    const row = document.createElement('div');
    row.id = `variantRow_${variantRowCounter}`;
    row.style.cssText = 'display: grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap: 8px; align-items: center; margin-bottom: 8px; background: white; padding: 10px; border-radius: 8px; border: 1px solid #c6f6d5;';
    row.innerHTML = `
        <input type="text" placeholder="الاسم (مثل: صغير، وسط، كبير، 500مل)" value="${data.variant_name || ''}" class="variant-name" style="padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: right;">
        <input type="number" placeholder="السعر" step="0.001" value="${data.price || ''}" class="variant-price" style="padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: right;">
        <input type="number" placeholder="التكلفة" step="0.001" value="${data.cost || ''}" class="variant-cost" style="padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: right;">
        <input type="text" placeholder="باركود" value="${data.barcode || ''}" class="variant-barcode" style="padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: right;">
        <button type="button" onclick="removeVariantRow('variantRow_${variantRowCounter}')" style="background: #dc3545; color: white; border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer;">🗑️</button>
    `;
    container.appendChild(row);
}

function removeVariantRow(rowId) {
    document.getElementById(rowId)?.remove();
    const container = document.getElementById('variantsContainer');
    const emptyMsg = document.getElementById('variantsEmptyMsg');
    if (container.children.length === 0 && emptyMsg) {
        emptyMsg.style.display = 'block';
    }
}

function getVariantsData() {
    const rows = document.querySelectorAll('#variantsContainer > div');
    const variants = [];
    rows.forEach(row => {
        const name = row.querySelector('.variant-name')?.value?.trim();
        const price = parseFloat(row.querySelector('.variant-price')?.value) || 0;
        const cost = parseFloat(row.querySelector('.variant-cost')?.value) || 0;
        const barcode = row.querySelector('.variant-barcode')?.value?.trim() || '';
        if (name) {
            variants.push({ variant_name: name, price, cost, barcode });
        }
    });
    return variants;
}

function loadVariantsToForm(variants) {
    const container = document.getElementById('variantsContainer');
    const emptyMsg = document.getElementById('variantsEmptyMsg');
    container.innerHTML = '';
    variantRowCounter = 0;

    if (variants && variants.length > 0) {
        if (emptyMsg) emptyMsg.style.display = 'none';
        variants.forEach(v => addVariantRow(v));
    } else {
        if (emptyMsg) emptyMsg.style.display = 'block';
    }
}

function showAddInventory() {
    updateCategoryDropdown();
    document.getElementById('inventoryModalTitle').textContent = '➕ إضافة منتج للمخزون';
    document.getElementById('inventoryForm').reset();
    document.getElementById('inventoryId').value = '';
    document.getElementById('inventoryImageData').value = '';
    document.getElementById('inventoryImagePreview').style.display = 'none';

    // تهيئة نظام التكاليف
    initializeInventoryCosts();

    // تهيئة المتغيرات
    loadVariantsToForm([]);

    document.getElementById('addInventoryModal').classList.add('active');
}

function closeAddInventory() {
    document.getElementById('addInventoryModal').classList.remove('active');
}

// حفظ منتج المخزون
document.getElementById('inventoryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inventoryId = document.getElementById('inventoryId').value;
    const newCat = document.getElementById('inventoryNewCategory').value.trim();
    const category = newCat || document.getElementById('inventoryCategory').value;
    
    const inventoryData = {
        name: document.getElementById('inventoryName').value,
        barcode: document.getElementById('inventoryBarcode').value,
        category: category,
        price: parseFloat(document.getElementById('inventoryPrice').value),
        cost: parseFloat(document.getElementById('inventoryCost').value) || 0,
        costs: JSON.stringify(getInventoryCostsData()),
        image_data: document.getElementById('inventoryImageData').value
    };
    
    // زر الحفظ
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn ? submitBtn.textContent : '';
    
    try {
        // تعطيل الزر
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '🔄 جاري الحفظ...';
        }
        
        const url = inventoryId ? `${API_URL}/api/inventory/${inventoryId}` : `${API_URL}/api/inventory`;
        const method = inventoryId ? 'PUT' : 'POST';
        
        // بدون AbortController - فقط fetch عادي
        const response = await fetch(url, {
            method: method,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(inventoryData)
        });
        
        if (!response.ok) {
            throw new Error(`خطأ في الاتصال: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            // حفظ المتغيرات
            const savedId = data.id || inventoryId;
            const variants = getVariantsData();
            try {
                await fetch(`${API_URL}/api/inventory/${savedId}/variants`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ variants })
                });
            } catch (e) {
                console.error('خطأ حفظ المتغيرات:', e);
            }

            // تسجيل في السجل
            try {
                const action = inventoryId ? 'edit_inventory' : 'add_inventory';
                const description = inventoryId ? `تعديل منتج: ${inventoryData.name}` : `إضافة منتج: ${inventoryData.name}`;
                await logAction(action, description, savedId);
            } catch (e) {
                // تجاهل خطأ السجل
            }

            // رسالة نجاح
            if (typeof showSuccess === 'function') {
                showSuccess('✅ تم حفظ المنتج بنجاح');
            } else {
                alert('✅ تم الحفظ');
            }

            closeAddInventory();
            await loadInventory();
        } else {
            throw new Error(data.error || 'فشل الحفظ');
        }
        
    } catch (error) {
        // تجاهل الأخطاء المتعلقة بـ runtime
        if (error && error.message && error.message.includes('runtime')) {
            return;
        }
        
        console.error('خطأ في حفظ المخزون:', error);
        
        // رسالة خطأ بسيطة
        let errorMessage = '⚠️ حدث خطأ أثناء الحفظ';
        
        if (error.message && error.message.includes('Failed to fetch')) {
            errorMessage = '🌐 لا يوجد اتصال بالسيرفر\n\nتحقق من:\n• الاتصال بالإنترنت\n• في البيت؟ استخدم: 192.168.8.21:8080';
        } else if (error.message && !error.message.includes('AbortError')) {
            errorMessage = `⚠️ ${error.message}`;
        }
        
        // عرض الخطأ
        if (typeof showError === 'function') {
            showError(errorMessage, 6000);
        } else {
            alert(errorMessage);
        }
        
    } finally {
        // إعادة تفعيل الزر دائماً
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
});

async function editInventory(id) {
    const item = allInventory.find(i => i.id === id);
    if (!item) return;
    
    updateCategoryDropdown();
    document.getElementById('inventoryModalTitle').textContent = '✏️ تعديل منتج';
    document.getElementById('inventoryId').value = item.id;
    document.getElementById('inventoryName').value = item.name;
    document.getElementById('inventoryBarcode').value = item.barcode || '';
    document.getElementById('inventoryPrice').value = item.price;
    document.getElementById('inventoryCost').value = item.cost || 0;
    document.getElementById('inventoryCategory').value = item.category || '';
    document.getElementById('inventoryImageData').value = item.image_data || '';
    
    // تحميل التكاليف التفصيلية
    let costs = [];
    if (item.costs) {
        try {
            costs = JSON.parse(item.costs);
        } catch (e) {
            console.error('Error parsing costs:', e);
        }
    }
    loadInventoryCosts(costs);
    
    if (item.image_data && item.image_data.startsWith('data:image')) {
        document.getElementById('inventoryImageDisplay').innerHTML = `<img src="${item.image_data}" style="max-width:80px; max-height:80px; border-radius:8px;">`;
        document.getElementById('inventoryImagePreview').style.display = 'block';
    } else {
        document.getElementById('inventoryImagePreview').style.display = 'none';
    }

    // تحميل المتغيرات
    loadVariantsToForm(item.variants || []);

    document.getElementById('addInventoryModal').classList.add('active');
}

async function deleteInventory(id) {
    if (!confirm('حذف هذا المنتج من المخزون؟\n(سيتم حذف جميع التوزيعات على الفروع)')) return;
    try {
        const response = await fetch(`${API_URL}/api/inventory/${id}`, {method: 'DELETE'});
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            await loadInventory();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

let currentDistributionProduct = null;

async function distributeToBranch(inventoryId) {
    const product = allInventory.find(p => p.id === inventoryId);
    if (!product) return;

    currentDistributionProduct = product;

    // عرض معلومات المنتج
    let variantsInfo = '';
    if (product.variants && product.variants.length > 0) {
        variantsInfo = `
            <div style="margin-top: 10px; background: #f0fff4; padding: 10px; border-radius: 8px; border: 1px solid #c6f6d5;">
                <strong style="color: #38a169;">📐 الخصائص:</strong>
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
                    ${product.variants.map(v => `<span style="background: #38a169; color: white; padding: 4px 10px; border-radius: 20px; font-size: 12px;">${escHTML(v.variant_name)} - ${v.price.toFixed(3)} د.ك</span>`).join('')}
                </div>
            </div>
        `;
    }

    document.getElementById('distributionProductInfo').innerHTML = `
        <div style="display: flex; align-items: center; gap: 15px;">
            <div style="font-size: 50px;">🛍️</div>
            <div style="flex: 1;">
                <h3 style="margin: 0;">${escHTML(product.name)}</h3>
                <p style="margin: 5px 0 0; color: #666;">السعر: ${product.price.toFixed(3)} د.ك | التكلفة: ${(product.cost || 0).toFixed(3)} د.ك</p>
                ${variantsInfo}
            </div>
        </div>
    `;

    // تحميل قائمة الخصائص في التوزيع
    const variantGroup = document.getElementById('distributionVariantGroup');
    const variantSelect = document.getElementById('distributionVariant');
    if (product.variants && product.variants.length > 0) {
        variantGroup.style.display = 'block';
        variantSelect.innerHTML = '<option value="">المنتج الأساسي</option>' +
            product.variants.map(v => `<option value="${v.id}">${escHTML(v.variant_name)} (${v.price.toFixed(3)} د.ك)</option>`).join('');
    } else {
        variantGroup.style.display = 'none';
        variantSelect.innerHTML = '<option value="">المنتج الأساسي</option>';
    }

    // تحميل الفروع
    await loadBranchesForDistribution();

    // تحميل التوزيعات الحالية
    await loadCurrentDistributions(inventoryId);

    // فتح modal
    document.getElementById('distributionModal').classList.add('active');
}

async function loadBranchesForDistribution() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('distributionBranch');
            select.innerHTML = data.branches.map(b => 
                `<option value="${b.id}">${escHTML(b.name)}</option>`
            ).join('');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function loadCurrentDistributions(inventoryId) {
    try {
        const response = await fetch(`${API_URL}/api/branch-stock?inventory_id=${inventoryId}`);
        const data = await response.json();
        
        const container = document.getElementById('currentDistributions');
        
        if (data.success && data.stock.length > 0) {
            // تحميل أسماء الفروع
            const branchesResponse = await fetch(`${API_URL}/api/branches`);
            const branchesData = await branchesResponse.json();
            const branches = {};
            if (branchesData.success) {
                branchesData.branches.forEach(b => branches[b.id] = b.name);
            }
            
            let html = '<table class="data-table"><thead><tr><th>الفرع</th><th>الخاصية</th><th>الكمية</th><th>ملاحظات</th><th>إجراءات</th></tr></thead><tbody>';

            data.stock.forEach(s => {
                const branchName = branches[s.branch_id] || 'غير محدد';
                const variantLabel = s.variant_name
                    ? `<span style="background:#38a169; color:white; padding:2px 8px; border-radius:12px; font-size:12px;">📐 ${s.variant_name}</span>`
                    : '<span style="color:#999;">الأساسي</span>';
                html += `
                    <tr>
                        <td>🏢 ${branchName}</td>
                        <td>${variantLabel}</td>
                        <td><strong>${s.stock}</strong></td>
                        <td style="max-width:250px;">${s.notes ? `<div style="font-size:11px; line-height:1.6; max-height:80px; overflow-y:auto; white-space:pre-line; background:#f8f9fa; padding:5px 8px; border-radius:6px; border:1px solid #e0e0e0;">${escHTML(s.notes)}</div>` : '<span style="color:#999;">-</span>'}</td>
                        <td>
                            <button onclick="editDistribution(${s.id}, ${s.stock})" class="btn-sm">✏️ تعديل</button>
                            <button onclick="deleteDistribution(${s.id})" class="btn-sm btn-danger">🗑️ حذف</button>
                        </td>
                    </tr>
                `;
            });
            
            html += '</tbody></table>';
            container.innerHTML = html;
        } else {
            container.innerHTML = '<p style="text-align: center; padding: 20px; color: #999;">لا توجد توزيعات حالياً</p>';
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function closeDistribution() {
    document.getElementById('distributionModal').classList.remove('active');
    currentDistributionProduct = null;
}

// حفظ توزيع جديد
document.getElementById('distributionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!currentDistributionProduct) return;
    
    const variantVal = document.getElementById('distributionVariant')?.value;
    const distributionData = {
        inventory_id: currentDistributionProduct.id,
        branch_id: parseInt(document.getElementById('distributionBranch').value),
        stock: parseInt(document.getElementById('distributionStock').value),
        variant_id: variantVal ? parseInt(variantVal) : null,
        notes: document.getElementById('distributionNotes')?.value?.trim() || ''
    };
    
    try {
        const response = await fetch(`${API_URL}/api/branch-stock`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(distributionData)
        });
        const data = await response.json();
        if (data.success) {
            // تسجيل في السجل
            const variantName = document.getElementById('distributionVariant')?.selectedOptions[0]?.textContent || '';
            await logAction('distribute', `توزيع ${distributionData.stock} من ${currentDistributionProduct.name} ${variantName}`, data.id);
            alert('✅ تم التوزيع');
            document.getElementById('distributionForm').reset();
            await loadCurrentDistributions(currentDistributionProduct.id);
            // تحديث المخزون
            await loadInventory();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('خطأ:', error);
        alert('حدث خطأ');
    }
});

async function editDistribution(stockId, currentStock) {
    const newStock = prompt('الكمية الجديدة:', currentStock);
    if (newStock === null) return;
    
    const stock = parseInt(newStock);
    if (isNaN(stock) || stock < 0) {
        alert('الرجاء إدخال رقم صحيح');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/branch-stock/${stockId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ stock })
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم التحديث');
            await loadCurrentDistributions(currentDistributionProduct.id);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function deleteDistribution(stockId) {
    if (!confirm('حذف هذا التوزيع؟')) return;
    
    try {
        const response = await fetch(`${API_URL}/api/branch-stock/${stockId}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            await loadCurrentDistributions(currentDistributionProduct.id);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// معالجة صورة المخزون
function handleInventoryImage(input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        if (file.size > 500000) {
            if (confirm('الصورة كبيرة. تصغير؟')) {
                resizeInventoryImage(file, 100, 100);
            } else {
                return;
            }
        } else {
            resizeInventoryImage(file, 100, 100);
        }
    }
}

function resizeInventoryImage(file, maxW, maxH) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const ratio = Math.min(maxW/img.width, maxH/img.height);
            canvas.width = img.width * ratio;
            canvas.height = img.height * ratio;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            document.getElementById('inventoryImageData').value = dataUrl;
            document.getElementById('inventoryImageDisplay').innerHTML = `<img src="${dataUrl}" style="max-width:80px; max-height:80px; border-radius:8px;">`;
            document.getElementById('inventoryImagePreview').style.display = 'block';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function removeInventoryImage() {
    document.getElementById('inventoryImageData').value = '';
    document.getElementById('inventoryImagePreview').style.display = 'none';
}

// ===== نظام التالف =====

let currentDamageProduct = null;
let branchStockData = {};

async function reportDamage(inventoryId) {
    const product = allInventory.find(p => p.id === inventoryId);
    if (!product) return;
    
    currentDamageProduct = product;
    
    // عرض معلومات المنتج
    document.getElementById('damageProductInfo').innerHTML = `
        <div style="display: flex; align-items: center; gap: 15px;">
            <div style="font-size: 40px;">⚠️</div>
            <div>
                <h3 style="margin: 0;">${escHTML(product.name)}</h3>
                <p style="margin: 5px 0 0; color: #666;">سعر القطعة: ${product.price.toFixed(3)} د.ك</p>
            </div>
        </div>
    `;
    
    // تحميل الفروع
    await loadBranchesForDamage();
    
    // فتح modal
    document.getElementById('damageModal').classList.add('active');
}

async function loadBranchesForDamage() {
    try {
        // جلب الفروع
        const branchesResponse = await fetch(`${API_URL}/api/branches`);
        const branchesData = await branchesResponse.json();
        
        // جلب التوزيعات
        const stockResponse = await fetch(`${API_URL}/api/branch-stock?inventory_id=${currentDamageProduct.id}`);
        const stockData = await stockResponse.json();
        
        branchStockData = {};
        if (stockData.success) {
            stockData.stock.forEach(s => {
                branchStockData[s.branch_id] = s.stock;
            });
        }
        
        // تعبئة select
        if (branchesData.success) {
            const select = document.getElementById('damageBranch');
            select.innerHTML = branchesData.branches
                .filter(b => branchStockData[b.id] > 0)
                .map(b => `<option value="${b.id}">${escHTML(b.name)} (متاح: ${branchStockData[b.id]})</option>`)
                .join('');
            
            if (select.options.length === 0) {
                select.innerHTML = '<option value="">لا توجد توزيعات متاحة</option>';
            } else {
                updateDamageStock();
            }
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function updateDamageStock() {
    const branchId = document.getElementById('damageBranch').value;
    const available = branchStockData[branchId] || 0;
    document.getElementById('availableStock').textContent = `${available} قطعة`;
}

function closeDamageModal() {
    document.getElementById('damageModal').classList.remove('active');
    currentDamageProduct = null;
}

// حفظ التالف
document.getElementById('damageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!currentDamageProduct) return;
    
    const branchId = parseInt(document.getElementById('damageBranch').value);
    const quantity = parseInt(document.getElementById('damageQuantity').value);
    const reason = document.getElementById('damageReason').value;
    
    // التحقق من الكمية
    const available = branchStockData[branchId] || 0;
    if (quantity > available) {
        alert(`الكمية المتاحة: ${available} فقط`);
        return;
    }
    
    const damageData = {
        inventory_id: currentDamageProduct.id,
        branch_id: branchId,
        quantity: quantity,
        reason: reason,
        reported_by: currentUser.id
    };
    
    try {
        const response = await fetch(`${API_URL}/api/damaged-items`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(damageData)
        });
        const data = await response.json();
        if (data.success) {
            // تسجيل في السجل
            await logAction('damage', `تالف: ${quantity} من ${currentDamageProduct.name} (${reason || 'بدون سبب'})`, data.id);
            alert('✅ تم تسجيل التالف وخصمه من المخزون');
            closeDamageModal();
            await loadInventory();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('خطأ:', error);
        alert('حدث خطأ');
    }
});

// ===== دوال التقارير =====

async function loadBranchesForReports() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('reportBranch');
            if (select) {
                select.innerHTML = '<option value="">كل الفروع</option>';
                data.branches.forEach(b => {
                    select.innerHTML += `<option value="${b.id}">${escHTML(b.name)}</option>`;
                });
            }
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function loadSalesReport() {
    const startDate = document.getElementById('reportStartDate').value;
    const endDate = document.getElementById('reportEndDate').value;
    const branchId = document.getElementById('reportBranch').value;
    
    try {
        const params = new URLSearchParams();
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        if (branchId) params.append('branch_id', branchId);

        const response = await fetch(`${API_URL}/api/reports/sales?${params}`);
        const data = await response.json();
        
        if (data.success) {
            const report = data.report;
            window.currentSalesReport = report; // حفظ للتصدير
            let html = `
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; border-radius: 10px; margin-bottom: 20px;">
                    <h2 style="margin: 0 0 20px;">📊 تقرير المبيعات</h2>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">عدد الفواتير</div>
                            <div style="font-size: 32px; font-weight: bold;">${report.total_invoices || 0}</div>
                        </div>
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">إجمالي المبيعات</div>
                            <div style="font-size: 32px; font-weight: bold;">${(report.total_sales || 0).toFixed(3)} د.ك</div>
                        </div>
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">متوسط الفاتورة</div>
                            <div style="font-size: 32px; font-weight: bold;">${(report.average_sale || 0).toFixed(3)} د.ك</div>
                        </div>
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">الخصومات</div>
                            <div style="font-size: 32px; font-weight: bold;">${(report.total_discount || 0).toFixed(3)} د.ك</div>
                        </div>
                    </div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <h3>طرق الدفع:</h3>
                    <table class="data-table">
                        <thead><tr><th>الطريقة</th><th>العدد</th><th>الإجمالي</th></tr></thead>
                        <tbody>
            `;
            
            (report.payment_methods || []).forEach(pm => {
                html += `<tr><td>${pm.payment_method}</td><td>${pm.count}</td><td>${pm.total.toFixed(3)} د.ك</td></tr>`;
            });
            
            html += `</tbody></table></div>`;
            
            if (report.branches && report.branches.length > 0) {
                html += `
                    <div style="margin-bottom: 20px;">
                        <h3>حسب الفرع:</h3>
                        <table class="data-table">
                            <thead><tr><th>الفرع</th><th>العدد</th><th>الإجمالي</th></tr></thead>
                            <tbody>
                `;
                
                report.branches.forEach(b => {
                    html += `<tr><td>${escHTML(b.branch_name)}</td><td>${b.count}</td><td>${b.total.toFixed(3)} د.ك</td></tr>`;
                });
                
                html += `</tbody></table></div>`;
            }
            
            html += `<button onclick="exportSalesReport()" class="btn" style="background: #38a169;">📊 تصدير Excel</button>`;
            
            document.getElementById('reportsContent').innerHTML = html;
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function loadInventoryReport() {
    const branchId = document.getElementById('reportBranch').value;
    
    try {
        const params = new URLSearchParams();
        if (branchId) params.append('branch_id', branchId);

        const response = await fetch(`${API_URL}/api/reports/inventory?${params}`);
        const data = await response.json();
        
        if (data.success) {
            const report = data.report;
            window.currentInventoryReport = report; // حفظ للتصدير
            let html = `
                <div style="background: linear-gradient(135deg, #38a169 0%, #2c7a7b 100%); color: white; padding: 25px; border-radius: 10px; margin-bottom: 20px;">
                    <h2 style="margin: 0 0 20px;">📦 تقرير المخزون</h2>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">عدد المنتجات</div>
                            <div style="font-size: 32px; font-weight: bold;">${report.total_items || 0}</div>
                        </div>
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">إجمالي الكميات</div>
                            <div style="font-size: 32px; font-weight: bold;">${report.total_stock || 0}</div>
                        </div>
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">قيمة المخزون</div>
                            <div style="font-size: 32px; font-weight: bold;">${(report.total_value || 0).toFixed(3)} د.ك</div>
                        </div>
                    </div>
                </div>
                
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>المنتج</th>
                            <th>الفرع</th>
                            <th>الكمية</th>
                            <th>التكلفة</th>
                            <th>القيمة</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            (report.items || []).forEach(item => {
                if (item.stock > 0) {
                    html += `
                        <tr>
                            <td>${escHTML(item.name)}</td>
                            <td>${escHTML(item.branch_name) || '-'}</td>
                            <td>${item.stock}</td>
                            <td>${(item.cost || 0).toFixed(3)} د.ك</td>
                            <td><strong>${(item.stock_value || 0).toFixed(3)} د.ك</strong></td>
                        </tr>
                    `;
                }
            });
            
            html += `</tbody></table>`;
            html += `<button onclick="exportInventoryReport()" class="btn" style="background: #38a169; margin-top: 20px;">📊 تصدير Excel</button>`;
            
            document.getElementById('reportsContent').innerHTML = html;
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function loadDamagedReport() {
    const startDate = document.getElementById('reportStartDate').value;
    const endDate = document.getElementById('reportEndDate').value;
    const branchId = document.getElementById('reportBranch').value;
    
    try {
        const params = new URLSearchParams();
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        if (branchId) params.append('branch_id', branchId);

        const response = await fetch(`${API_URL}/api/reports/damaged?${params}`);
        const data = await response.json();
        
        if (data.success) {
            const report = data.report;
            window.currentDamagedReport = report; // حفظ للتصدير
            let html = `
                <div style="background: linear-gradient(135deg, #e53e3e 0%, #c53030 100%); color: white; padding: 25px; border-radius: 10px; margin-bottom: 20px;">
                    <h2 style="margin: 0 0 20px;">💔 تقرير التالف</h2>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">إجمالي الكميات</div>
                            <div style="font-size: 32px; font-weight: bold;">${report.total_damaged || 0}</div>
                        </div>
                        <div>
                            <div style="font-size: 14px; opacity: 0.9;">قيمة التالف</div>
                            <div style="font-size: 32px; font-weight: bold;">${(report.total_value || 0).toFixed(3)} د.ك</div>
                        </div>
                    </div>
                </div>
                
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>التاريخ</th>
                            <th>المنتج</th>
                            <th>الفرع</th>
                            <th>الكمية</th>
                            <th>السبب</th>
                            <th>القيمة</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            (report.items || []).forEach(item => {
                const date = new Date(item.created_at).toLocaleDateString('ar-EG');
                html += `
                    <tr>
                        <td>${date}</td>
                        <td>${escHTML(item.product_name)}</td>
                        <td>${escHTML(item.branch_name) || '-'}</td>
                        <td>${item.quantity}</td>
                        <td>${escHTML(item.reason) || '-'}</td>
                        <td><strong>${(item.damage_value || 0).toFixed(3)} د.ك</strong></td>
                    </tr>
                `;
            });
            
            html += `</tbody></table>`;
            html += `<button onclick="exportDamagedReport()" class="btn" style="background: #e53e3e; margin-top: 20px;">📊 تصدير Excel</button>`;
            
            document.getElementById('reportsContent').innerHTML = html;
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// دوال تصدير التقارير (مبسطة - CSV)
function exportSalesReport() {
    alert('سيتم تصدير تقرير المبيعات قريباً');
}

function exportInventoryReport() {
    alert('سيتم تصدير تقرير المخزون قريباً');
}

function exportDamagedReport() {
    alert('سيتم تصدير تقرير التالف قريباً');
}

// ===== سجل النظام =====

let _systemLogsPage = 1;
const _systemLogsPerPage = 50;

async function loadSystemLogs(page) {
    if (page) _systemLogsPage = page;
    try {
        // بناء معلمات البحث
        const params = new URLSearchParams();
        params.set('limit', 500);

        const actionFilter = document.getElementById('logFilterAction')?.value;
        const userFilter = document.getElementById('logFilterUser')?.value;
        const dateFrom = document.getElementById('logFilterDateFrom')?.value;
        const dateTo = document.getElementById('logFilterDateTo')?.value;

        if (actionFilter) params.set('action_type', actionFilter);
        if (userFilter) params.set('user_id', userFilter);
        if (dateFrom) params.set('date_from', dateFrom);
        if (dateTo) params.set('date_to', dateTo);

        const response = await fetch(`${API_URL}/api/system-logs?${params.toString()}`);
        const data = await response.json();

        if (data.success) {
            // تحميل قائمة المستخدمين لفلتر المستخدم
            _populateLogUsersFilter(data.logs);

            const container = document.getElementById('systemLogsContent');
            const statsEl = document.getElementById('systemLogsStats');
            const paginationEl = document.getElementById('systemLogsPagination');

            const actionLabels = {
                'login': '🔐 تسجيل دخول',
                'logout': '🚪 تسجيل خروج',
                'sale': '💰 بيع',
                'edit_invoice': '✏️ تعديل فاتورة',
                'cancel_invoice': '❌ إلغاء فاتورة',
                'print_invoice': '🖨️ طباعة فاتورة',
                'print_thermal': '🧾 طباعة حرارية',
                'view_invoice': '👁️ عرض فاتورة',
                'status_change': '🔄 تغيير حالة',
                'return': '↩️ مرتجع',
                'add_product': '➕ إضافة منتج',
                'edit_product': '✏️ تعديل منتج',
                'delete_product': '🗑️ حذف منتج',
                'add_inventory': '📦 إضافة مخزون',
                'edit_inventory': '📦 تعديل مخزون',
                'distribute': '📤 توزيع',
                'damage': '💔 تالف',
                'add_user': '👤 إضافة مستخدم',
                'edit_user': '👤 تعديل مستخدم',
                'delete_user': '🗑️ حذف مستخدم',
                'add_customer': '👥 إضافة عميل',
                'edit_customer': '👥 تعديل عميل',
                'delete_customer': '🗑️ حذف عميل',
                'add_expense': '💸 إضافة مصروف',
                'delete_expense': '🗑️ حذف مصروف',
                'shift_lock': '🔒 قفل شفت',
                'create_transfer': '🚚 طلب نقل',
                'approve_transfer': '✅ موافقة نقل',
                'reject_transfer': '❌ رفض نقل',
                'pickup_transfer': '🚗 استلام سائق',
                'receive_transfer': '📦 تأكيد استلام نقل',
                'delete_transfer': '🗑️ حذف طلب نقل',
                'add_subscription': '💳 اشتراك جديد',
                'cancel_subscription': '🚫 إلغاء اشتراك',
                'delete_subscription': '🗑️ حذف اشتراك',
                'renew_subscription': '🔄 تجديد اشتراك',
                'subscription_redeem': '📦 استلام منتجات اشتراك'
            };

            // تطبيق فلتر التاريخ على العميل (الـ API يدعمها أيضاً)
            let logs = data.logs;
            if (dateFrom) {
                logs = logs.filter(l => l.created_at >= dateFrom);
            }
            if (dateTo) {
                const toDate = dateTo + 'T23:59:59';
                logs = logs.filter(l => l.created_at <= toDate);
            }

            // إحصائيات
            if (statsEl) {
                statsEl.textContent = `إجمالي السجلات: ${logs.length}`;
            }

            // تقسيم الصفحات
            const totalPages = Math.ceil(logs.length / _systemLogsPerPage);
            if (_systemLogsPage > totalPages) _systemLogsPage = 1;
            const startIdx = (_systemLogsPage - 1) * _systemLogsPerPage;
            const pageLogs = logs.slice(startIdx, startIdx + _systemLogsPerPage);

            let html = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th style="width:160px;">التاريخ</th>
                            <th style="width:150px;">نوع العملية</th>
                            <th>الوصف</th>
                            <th style="width:120px;">المستخدم</th>
                            <th style="width:60px;">الفرع</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            pageLogs.forEach(log => {
                const date = new Date(log.created_at).toLocaleString('ar-EG');
                const label = actionLabels[log.action_type] || `📝 ${escHTML(log.action_type)}`;

                // لون الخلفية حسب نوع العملية
                let rowColor = '';
                if (log.action_type === 'login') rowColor = 'background:#e8f5e9;';
                else if (log.action_type === 'logout') rowColor = 'background:#fff3e0;';
                else if (log.action_type === 'sale') rowColor = 'background:#e3f2fd;';
                else if (log.action_type.includes('delete') || log.action_type === 'cancel_invoice') rowColor = 'background:#ffebee;';
                else if (log.action_type === 'edit_invoice') rowColor = 'background:#fff8e1;';
                else if (log.action_type === 'shift_lock') rowColor = 'background:#f3e5f5;';

                html += `
                    <tr style="${rowColor}">
                        <td style="font-size: 12px; white-space:nowrap;">${date}</td>
                        <td style="font-size: 13px;">${label}</td>
                        <td style="font-size: 13px;">${escHTML(log.description || '-')}</td>
                        <td>${escHTML(log.user_name || '-')}</td>
                        <td style="text-align:center;">${log.branch_id ? `B${log.branch_id}` : '-'}</td>
                    </tr>
                `;
            });

            html += '</tbody></table>';

            if (logs.length === 0) {
                html = '<p style="text-align: center; padding: 40px; color: #999;">لا توجد سجلات</p>';
            }

            container.innerHTML = html;

            // أزرار الصفحات
            if (paginationEl && totalPages > 1) {
                let pagHtml = '';
                if (_systemLogsPage > 1) {
                    pagHtml += `<button onclick="loadSystemLogs(${_systemLogsPage - 1})" style="margin:0 3px; padding:6px 12px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">السابق</button>`;
                }
                pagHtml += `<span style="margin:0 10px; font-size:14px;">صفحة ${_systemLogsPage} من ${totalPages}</span>`;
                if (_systemLogsPage < totalPages) {
                    pagHtml += `<button onclick="loadSystemLogs(${_systemLogsPage + 1})" style="margin:0 3px; padding:6px 12px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">التالي</button>`;
                }
                paginationEl.innerHTML = pagHtml;
            } else if (paginationEl) {
                paginationEl.innerHTML = '';
            }
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function _populateLogUsersFilter(logs) {
    const select = document.getElementById('logFilterUser');
    if (!select) return;
    const currentVal = select.value;
    const usersSet = new Map();
    logs.forEach(l => {
        if (l.user_id && l.user_name) usersSet.set(String(l.user_id), l.user_name);
    });
    // لا تعيد بناء القائمة إذا كانت موجودة
    if (select.options.length > 1) {
        select.value = currentVal;
        return;
    }
    usersSet.forEach((name, id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        select.appendChild(opt);
    });
    select.value = currentVal;
}

function clearLogFilters() {
    const el1 = document.getElementById('logFilterAction');
    const el2 = document.getElementById('logFilterUser');
    const el3 = document.getElementById('logFilterDateFrom');
    const el4 = document.getElementById('logFilterDateTo');
    if (el1) el1.value = '';
    if (el2) el2.value = '';
    if (el3) el3.value = '';
    if (el4) el4.value = '';
    _systemLogsPage = 1;
    loadSystemLogs();
}

// دالة تسجيل العمليات
async function logAction(actionType, description, targetId = null) {
    if (!currentUser) return;
    
    try {
        await fetch(`${API_URL}/api/system-logs`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                action_type: actionType,
                description: description,
                user_id: currentUser.id,
                user_name: currentUser.full_name,
                branch_id: currentUser.branch_id,
                target_id: targetId
            })
        });
    } catch (error) {
        console.log('لم يتم تسجيل العملية');
    }
}

// ===== دوال تصدير التقارير CSV =====

function exportSalesReport() {
    if (!window.currentSalesReport) {
        alert('الرجاء تحميل التقرير أولاً');
        return;
    }
    
    const report = window.currentSalesReport;
    let csv = '\ufeffرقم الفاتورة,التاريخ,العميل,الهاتف,الفرع,الإجمالي,طريقة الدفع\n';
    
    (report.invoices || []).forEach(inv => {
        const date = new Date(inv.created_at).toLocaleDateString('ar-EG');
        csv += `"${inv.invoice_number}","${date}","${inv.customer_name || '-'}","${inv.customer_phone || '-'}","${inv.branch_name || '-'}",${inv.total.toFixed(3)},"${inv.payment_method}"\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sales_report_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

function exportInventoryReport() {
    if (!window.currentInventoryReport) {
        alert('الرجاء تحميل التقرير أولاً');
        return;
    }
    
    const report = window.currentInventoryReport;
    let csv = '\ufeffالمنتج,الفرع,الكمية,التكلفة,القيمة\n';
    
    (report.items || []).forEach(item => {
        if (item.stock > 0) {
            csv += `"${item.name}","${item.branch_name || '-'}",${item.stock},${(item.cost || 0).toFixed(3)},${(item.stock_value || 0).toFixed(3)}\n`;
        }
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `inventory_report_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

function exportDamagedReport() {
    if (!window.currentDamagedReport) {
        alert('الرجاء تحميل التقرير أولاً');
        return;
    }
    
    const report = window.currentDamagedReport;
    let csv = '\ufeffالتاريخ,المنتج,الفرع,الكمية,السبب,القيمة\n';
    
    (report.items || []).forEach(item => {
        const date = new Date(item.created_at).toLocaleDateString('ar-EG');
        csv += `"${date}","${item.product_name}","${item.branch_name || '-'}",${item.quantity},"${item.reason || '-'}",${(item.damage_value || 0).toFixed(3)}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `damaged_report_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

// ===== دالة تحميل الفروع في المستخدمين =====

async function loadBranchesForUserForm() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('userBranch');
            if (select) {
                select.innerHTML = data.branches.map(b => 
                    `<option value="${b.id}">${escHTML(b.name)}</option>`
                ).join('');
            }
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// ===== التكاليف (Expenses) =====

async function loadExpenses() {
    try {
        const startDate = document.getElementById('expenseStartDate').value;
        const endDate = document.getElementById('expenseEndDate').value;
        const branchId = document.getElementById('expenseBranchFilter').value;
        
        const params = new URLSearchParams();
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        if (branchId) params.append('branch_id', branchId);

        const response = await fetch(`${API_URL}/api/expenses?${params}`);
        const data = await response.json();
        
        if (data.success) {
            displayExpenses(data.expenses);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function displayExpenses(expenses) {
    const container = document.getElementById('expensesContainer');

    if (expenses.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #6c757d;">لا توجد تكاليف</div>';
        return;
    }

    // حساب الإجمالي
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);

    let html = `
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
            <h3 style="margin: 0 0 10px 0;">📊 إجمالي التكاليف</h3>
            <div style="font-size: 32px; font-weight: bold;">${total.toFixed(3)} د.ك</div>
            <div style="opacity: 0.9; margin-top: 5px;">${expenses.length} تكلفة</div>
        </div>

        <table class="data-table">
            <thead>
                <tr>
                    <th>التاريخ</th>
                    <th>النوع</th>
                    <th>المبلغ</th>
                    <th>الوصف</th>
                    <th>الفرع</th>
                    <th>إجراءات</th>
                </tr>
            </thead>
            <tbody>
                ${expenses.map(e => {
                    const hasSalary = e.expense_type === 'رواتب' && e.salary_details && e.salary_details.length > 0;
                    let row = `
                    <tr>
                        <td>${new Date(e.expense_date).toLocaleDateString('ar')}</td>
                        <td><strong>${escHTML(e.expense_type)}</strong>${hasSalary ? ` <button onclick="toggleSalaryExpand(${e.id})" class="btn-sm" style="background:#667eea;color:white;padding:2px 8px;font-size:11px;border-radius:6px;cursor:pointer;">👥 ${e.salary_details.length} موظف</button>` : ''}</td>
                        <td style="color: #dc3545; font-weight: bold;">${e.amount.toFixed(3)} د.ك</td>
                        <td>${escHTML(e.description) || '-'}</td>
                        <td>${e.branch_id || 'عام'}</td>
                        <td>
                            <button onclick="deleteExpense(${e.id})" class="btn-sm btn-danger">🗑️</button>
                        </td>
                    </tr>`;
                    if (hasSalary) {
                        row += `
                    <tr id="salaryExpand_${e.id}" style="display: none;">
                        <td colspan="6" style="padding: 0;">
                            <div style="background: #f0f4ff; padding: 12px; border-radius: 8px; margin: 5px;">
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr style="background: #667eea; color: white;">
                                            <th style="padding: 8px; border-radius: 0 6px 0 0;">اسم الموظف</th>
                                            <th style="padding: 8px; border-radius: 6px 0 0 0;">الراتب الشهري</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${e.salary_details.map(s => `
                                        <tr style="border-bottom: 1px solid #e2e8f0;">
                                            <td style="padding: 8px; text-align: center;">${escHTML(s.employee_name)}</td>
                                            <td style="padding: 8px; text-align: center; color: #dc3545; font-weight: bold;">${s.monthly_salary.toFixed(3)} د.ك</td>
                                        </tr>`).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </td>
                    </tr>`;
                    }
                    return row;
                }).join('')}
            </tbody>
        </table>
    `;

    container.innerHTML = html;
}

function toggleSalaryExpand(expenseId) {
    const row = document.getElementById('salaryExpand_' + expenseId);
    if (row) {
        row.style.display = row.style.display === 'none' ? '' : 'none';
    }
}

// ===== نظام تفاصيل الرواتب =====
let salaryRowCounter = 0;

function toggleSalaryDetails() {
    const type = document.getElementById('expenseType').value;
    const section = document.getElementById('salaryDetailsSection');
    const amountInput = document.getElementById('expenseAmount');

    if (type === 'رواتب') {
        section.style.display = 'block';
        amountInput.readOnly = true;
        amountInput.style.background = '#e9ecef';
        // إضافة صف أول تلقائياً إذا فارغ
        if (document.getElementById('salaryRowsContainer').children.length === 0) {
            addSalaryRow();
        }
    } else {
        section.style.display = 'none';
        amountInput.readOnly = false;
        amountInput.style.background = '';
    }
}

function addSalaryRow() {
    salaryRowCounter++;
    const container = document.getElementById('salaryRowsContainer');
    const row = document.createElement('div');
    row.id = `salaryRow_${salaryRowCounter}`;
    row.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 8px; background: white; padding: 10px; border-radius: 8px; border: 1px solid #e2e8f0;';
    row.innerHTML = `
        <div style="flex: 1;">
            <input type="text" placeholder="اسم الموظف" class="salary-emp-name" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: right;">
        </div>
        <div style="flex: 1;">
            <input type="number" placeholder="الراتب الشهري" step="0.001" class="salary-emp-amount" oninput="calcSalaryTotal()" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: right;">
        </div>
        <button type="button" onclick="removeSalaryRow('salaryRow_${salaryRowCounter}')" style="background: #dc3545; color: white; border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer;">🗑️</button>
    `;
    container.appendChild(row);
}

function removeSalaryRow(rowId) {
    document.getElementById(rowId)?.remove();
    calcSalaryTotal();
}

function calcSalaryTotal() {
    const amounts = document.querySelectorAll('#salaryRowsContainer .salary-emp-amount');
    let total = 0;
    amounts.forEach(inp => {
        total += parseFloat(inp.value) || 0;
    });
    document.getElementById('salaryTotalDisplay').textContent = total.toFixed(3) + ' د.ك';
    document.getElementById('expenseAmount').value = total.toFixed(3);
}

function getSalaryDetails() {
    const rows = document.querySelectorAll('#salaryRowsContainer > div');
    const details = [];
    rows.forEach(row => {
        const name = row.querySelector('.salary-emp-name')?.value?.trim();
        const salary = parseFloat(row.querySelector('.salary-emp-amount')?.value) || 0;
        if (name && salary > 0) {
            details.push({ employee_name: name, monthly_salary: salary });
        }
    });
    return details;
}

function showAddExpense() {
    document.getElementById('expenseModalTitle').textContent = '➕ إضافة تكلفة';
    document.getElementById('expenseForm').reset();
    document.getElementById('expenseDate').valueAsDate = new Date();
    // إعادة تعيين قسم الرواتب
    document.getElementById('salaryDetailsSection').style.display = 'none';
    document.getElementById('salaryRowsContainer').innerHTML = '';
    document.getElementById('salaryTotalDisplay').textContent = '0.000 د.ك';
    document.getElementById('expenseAmount').readOnly = false;
    document.getElementById('expenseAmount').style.background = '';
    salaryRowCounter = 0;
    loadBranchesForExpense();
    document.getElementById('addExpenseModal').classList.add('active');
}

function closeAddExpense() {
    document.getElementById('addExpenseModal').classList.remove('active');
}

async function loadBranchesForExpense() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('expenseBranch');
            select.innerHTML = '<option value="">عام</option>' + 
                data.branches.map(b => `<option value="${b.id}">${escHTML(b.name)}</option>`).join('');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function loadBranchesForExpenseFilter() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('expenseBranchFilter');
            select.innerHTML = '<option value="">كل الفروع</option>' + 
                data.branches.map(b => `<option value="${b.id}">${escHTML(b.name)}</option>`).join('');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

document.getElementById('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const expenseType = document.getElementById('expenseType').value;
    const expenseData = {
        expense_type: expenseType,
        amount: parseFloat(document.getElementById('expenseAmount').value),
        description: document.getElementById('expenseDescription').value,
        expense_date: document.getElementById('expenseDate').value,
        branch_id: parseInt(document.getElementById('expenseBranch').value) || null,
        created_by: currentUser.id
    };

    // إضافة تفاصيل الرواتب إذا كان النوع رواتب
    if (expenseType === 'رواتب') {
        const salaryDetails = getSalaryDetails();
        if (salaryDetails.length === 0) {
            alert('يرجى إضافة موظف واحد على الأقل مع الراتب');
            return;
        }
        expenseData.salary_details = salaryDetails;
    }

    try {
        const response = await fetch(`${API_URL}/api/expenses`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(expenseData)
        });

        const data = await response.json();
        if (data.success) {
            logAction('add_expense', `إضافة مصروف: ${expenseData.expense_type} - ${expenseData.amount}`, data.id);
            alert('✅ تم الحفظ');
            closeAddExpense();
            await loadExpenses();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
});

async function deleteExpense(id) {
    if (!confirm('هل أنت متأكد من حذف هذه التكلفة؟')) return;
    
    try {
        const response = await fetch(`${API_URL}/api/expenses/${id}`, {method: 'DELETE'});
        const data = await response.json();
        if (data.success) {
            logAction('delete_expense', `حذف مصروف رقم ${id}`, id);
            alert('✅ تم الحذف');
            await loadExpenses();
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// ===== التقارير المتقدمة (Advanced Reports) =====

async function loadProductReport() {
    try {
        const startDate = document.getElementById('advReportStartDate').value;
        const endDate = document.getElementById('advReportEndDate').value;
        const branchId = document.getElementById('advReportBranchFilter').value;
        
        const params = new URLSearchParams();
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        if (branchId) params.append('branch_id', branchId);

        const response = await fetch(`${API_URL}/api/reports/sales-by-product?${params}`);
        const data = await response.json();
        
        if (data.success) {
            displayProductReport(data);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function displayProductReport(data) {
    const container = document.getElementById('advancedReportContent');
    
    let html = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(102,126,234,0.3);">
                <div style="opacity: 0.9; margin-bottom: 5px;">إجمالي المبيعات</div>
                <div style="font-size: 32px; font-weight: bold;">${data.summary.total_sales.toFixed(3)} د.ك</div>
            </div>
            <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(240,147,251,0.3);">
                <div style="opacity: 0.9; margin-bottom: 5px;">الكمية المباعة</div>
                <div style="font-size: 32px; font-weight: bold;">${data.summary.total_quantity}</div>
            </div>
            <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(79,172,254,0.3);">
                <div style="opacity: 0.9; margin-bottom: 5px;">عدد المنتجات</div>
                <div style="font-size: 32px; font-weight: bold;">${data.summary.products_count}</div>
            </div>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <canvas id="productChart" style="max-height: 400px;"></canvas>
        </div>
        
        <table class="data-table">
            <thead>
                <tr>
                    <th>المنتج</th>
                    <th>الكمية</th>
                    <th>المبيعات</th>
                    <th>عدد الفواتير</th>
                    <th>متوسط السعر</th>
                </tr>
            </thead>
            <tbody>
                ${data.products.map(p => `
                    <tr>
                        <td><strong>${escHTML(p.product_name)}</strong></td>
                        <td>${p.total_quantity}</td>
                        <td style="color: #28a745; font-weight: bold;">${p.total_sales.toFixed(3)} د.ك</td>
                        <td>${p.invoice_count}</td>
                        <td>${p.avg_price.toFixed(3)} د.ك</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    
    container.innerHTML = html;
    
    // رسم Chart
    setTimeout(() => {
        const ctx = document.getElementById('productChart').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.products.map(p => escHTML(p.product_name)),
                datasets: [{
                    label: 'المبيعات (د.ك)',
                    data: data.products.map(p => p.total_sales),
                    backgroundColor: 'rgba(102, 126, 234, 0.8)',
                    borderColor: 'rgba(102, 126, 234, 1)',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {display: true, position: 'top'}
                },
                scales: {
                    y: {beginAtZero: true}
                }
            }
        });
    }, 100);
}

async function loadBranchReport() {
    try {
        const startDate = document.getElementById('advReportStartDate').value;
        const endDate = document.getElementById('advReportEndDate').value;
        
        const params = new URLSearchParams();
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);

        const response = await fetch(`${API_URL}/api/reports/sales-by-branch?${params}`);
        const data = await response.json();
        
        if (data.success) {
            displayBranchReport(data);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function displayBranchReport(data) {
    const container = document.getElementById('advancedReportContent');
    
    let html = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px;">
            <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(240,147,251,0.3);">
                <div style="opacity: 0.9; margin-bottom: 5px;">إجمالي المبيعات</div>
                <div style="font-size: 32px; font-weight: bold;">${data.summary.total_sales.toFixed(3)} د.ك</div>
            </div>
            <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(79,172,254,0.3);">
                <div style="opacity: 0.9; margin-bottom: 5px;">عدد الفواتير</div>
                <div style="font-size: 32px; font-weight: bold;">${data.summary.total_invoices}</div>
            </div>
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(102,126,234,0.3);">
                <div style="opacity: 0.9; margin-bottom: 5px;">عدد الفروع</div>
                <div style="font-size: 32px; font-weight: bold;">${data.summary.branches_count}</div>
            </div>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <canvas id="branchChart" style="max-height: 400px;"></canvas>
        </div>
        
        <table class="data-table">
            <thead>
                <tr>
                    <th>الفرع</th>
                    <th>عدد الفواتير</th>
                    <th>المبيعات</th>
                    <th>الخصم</th>
                    <th>متوسط الفاتورة</th>
                </tr>
            </thead>
            <tbody>
                ${data.branches.map(b => `
                    <tr>
                        <td><strong>${escHTML(b.branch_name)}</strong></td>
                        <td>${b.invoice_count}</td>
                        <td style="color: #28a745; font-weight: bold;">${b.total_sales.toFixed(3)} د.ك</td>
                        <td style="color: #dc3545;">${b.total_discount.toFixed(3)} د.ك</td>
                        <td>${b.avg_sale.toFixed(3)} د.ك</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    
    container.innerHTML = html;
    
    // رسم Chart
    setTimeout(() => {
        const ctx = document.getElementById('branchChart').getContext('2d');
        new Chart(ctx, {
            type: 'pie',
            data: {
                labels: data.branches.map(b => b.branch_name),
                datasets: [{
                    label: 'المبيعات',
                    data: data.branches.map(b => b.total_sales),
                    backgroundColor: [
                        'rgba(102, 126, 234, 0.8)',
                        'rgba(240, 147, 251, 0.8)',
                        'rgba(79, 172, 254, 0.8)',
                        'rgba(245, 87, 108, 0.8)',
                        'rgba(118, 75, 162, 0.8)'
                    ]
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {display: true, position: 'right'}
                }
            }
        });
    }, 100);
}

async function loadProfitLossReport() {
    try {
        const startDate = document.getElementById('advReportStartDate').value;
        const endDate = document.getElementById('advReportEndDate').value;
        const branchId = document.getElementById('advReportBranchFilter').value;
        
        const params = new URLSearchParams();
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        if (branchId) params.append('branch_id', branchId);

        const response = await fetch(`${API_URL}/api/reports/profit-loss?${params}`);
        const data = await response.json();
        
        if (data.success) {
            displayProfitLossReport(data.report);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

function displayProfitLossReport(report) {
    const container = document.getElementById('advancedReportContent');
    
    let html = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px;">
            <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(79,172,254,0.3);">
                <div style="opacity: 0.9; font-size: 14px; margin-bottom: 5px;">إجمالي المبيعات</div>
                <div style="font-size: 28px; font-weight: bold;">${report.total_revenue.toFixed(3)}</div>
                <div style="opacity: 0.9; font-size: 12px;">د.ك</div>
            </div>
            <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(240,147,251,0.3);">
                <div style="opacity: 0.9; font-size: 14px; margin-bottom: 5px;">تكلفة البضاعة</div>
                <div style="font-size: 28px; font-weight: bold;">${report.total_cogs.toFixed(3)}</div>
                <div style="opacity: 0.9; font-size: 12px;">د.ك</div>
            </div>
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(102,126,234,0.3);">
                <div style="opacity: 0.9; font-size: 14px; margin-bottom: 5px;">الربح الإجمالي</div>
                <div style="font-size: 28px; font-weight: bold;">${report.gross_profit.toFixed(3)}</div>
                <div style="opacity: 0.9; font-size: 12px;">د.ك</div>
            </div>
            <div style="background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); color: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(250,112,154,0.3);">
                <div style="opacity: 0.9; font-size: 14px; margin-bottom: 5px;">التكاليف</div>
                <div style="font-size: 28px; font-weight: bold;">${report.total_expenses.toFixed(3)}</div>
                <div style="opacity: 0.9; font-size: 12px;">د.ك</div>
            </div>
            <div style="background: linear-gradient(135deg, #30cfd0 0%, #330867 100%); color: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(48,207,208,0.3);">
                <div style="opacity: 0.9; font-size: 14px; margin-bottom: 5px;">الربح الصافي</div>
                <div style="font-size: 28px; font-weight: bold;">${report.net_profit.toFixed(3)}</div>
                <div style="opacity: 0.9; font-size: 12px;">د.ك</div>
            </div>
            <div style="background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%); color: #2d3748; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(168,237,234,0.3);">
                <div style="opacity: 0.8; font-size: 14px; margin-bottom: 5px;">هامش الربح</div>
                <div style="font-size: 28px; font-weight: bold;">${report.profit_margin.toFixed(2)}%</div>
            </div>
        </div>
        
        <div style="background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <canvas id="profitChart" style="max-height: 400px;"></canvas>
        </div>
    `;
    
    container.innerHTML = html;
    
    // رسم Chart
    setTimeout(() => {
        const ctx = document.getElementById('profitChart').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['المبيعات', 'تكلفة البضاعة', 'الربح الإجمالي', 'التكاليف', 'الربح الصافي'],
                datasets: [{
                    label: 'المبالغ (د.ك)',
                    data: [
                        report.total_revenue,
                        report.total_cogs,
                        report.gross_profit,
                        report.total_expenses,
                        report.net_profit
                    ],
                    backgroundColor: [
                        'rgba(79, 172, 254, 0.8)',
                        'rgba(245, 87, 108, 0.8)',
                        'rgba(102, 126, 234, 0.8)',
                        'rgba(250, 112, 154, 0.8)',
                        'rgba(48, 207, 208, 0.8)'
                    ]
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {display: false}
                },
                scales: {
                    y: {beginAtZero: true}
                }
            }
        });
    }, 100);
}

async function loadBranchesForAdvReports() {
    try {
        const response = await fetch(`${API_URL}/api/branches`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('advReportBranchFilter');
            select.innerHTML = '<option value="">كل الفروع</option>' + 
                data.branches.map(b => `<option value="${b.id}">${escHTML(b.name)}</option>`).join('');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}


// ===== العملاء (CRM) - عرض فواتير عميل =====

async function viewCustomerInvoices(customerId) {
    try {
        const response = await fetch(`${API_URL}/api/customers/${customerId}/invoices`);
        const data = await response.json();
        
        if (data.success) {
            // عرض الفواتير في modal
            let html = `
                <div style="max-height: 500px; overflow-y: auto;">
                    <h3 style="margin-bottom: 20px;">📋 فواتير العميل</h3>
                    ${data.invoices.length === 0 ? '<p>لا توجد فواتير</p>' : `
                        <table class="data-table">
                            <thead>
                                <tr>
                                    <th>رقم الفاتورة</th>
                                    <th>التاريخ</th>
                                    <th>الإجمالي</th>
                                    <th>إجراءات</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${data.invoices.map(inv => `
                                    <tr>
                                        <td><strong>${inv.invoice_number}</strong></td>
                                        <td>${new Date(inv.created_at).toLocaleDateString('ar')}</td>
                                        <td style="color: #28a745; font-weight: bold;">${inv.total.toFixed(3)} د.ك</td>
                                        <td>
                                            <button onclick="viewInvoiceDetails(${inv.id})" class="btn-sm">👁️</button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    `}
                </div>
            `;
            
            document.getElementById('invoiceViewContent').innerHTML = html;
            document.getElementById('invoiceViewModal').classList.add('active');
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

async function exportCustomersExcel() {
    try {
        const response = await fetch(`${API_URL}/api/customers`);
        const data = await response.json();
        
        if (data.success) {
            const customers = data.customers.map(c => ({
                'الاسم': c.name || '-',
                'الهاتف': c.phone || '-',
                'العنوان': c.address || '-',
                'عدد الطلبات': c.total_orders || 0,
                'إجمالي الإنفاق': (c.total_spent || 0).toFixed(3),
                'تاريخ الإنشاء': new Date(c.created_at).toLocaleDateString('ar')
            }));
            
            const ws = XLSX.utils.json_to_sheet(customers);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'العملاء');
            XLSX.writeFile(wb, `customers_${Date.now()}.xlsx`);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
}

// ===== Dropdown العملاء في الفاتورة =====
let allCustomersDropdown = [];

async function loadCustomersDropdown() {
    try {
        const response = await fetch(`${API_URL}/api/customers`);
        const data = await response.json();
        
        if (data.success) {
            allCustomersDropdown = data.customers || [];
            updateCustomerSelect();
        }
    } catch (error) {
        console.error('[Customers] خطأ في تحميل العملاء:', error);
    }
}

function updateCustomerSelect() {
    // التوافق - لم نعد نستخدم select بل حقل بحث
}

// بحث العميل في نقطة البيع
function searchCustomerInPOS(query) {
    const container = document.getElementById('customerSearchResults');
    if (!container) return;

    const q = (query || '').trim().toLowerCase();
    if (!q) {
        // عرض آخر 10 عملاء
        const recent = allCustomersDropdown.slice(0, 10);
        if (recent.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.innerHTML = recent.map(c => customerResultItem(c)).join('');
        container.style.display = 'block';
        return;
    }

    const filtered = allCustomersDropdown.filter(c => {
        const name = (c.name || '').toLowerCase();
        const phone = (c.phone || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
    }).slice(0, 15);

    if (filtered.length === 0) {
        container.innerHTML = '<div style="padding:10px; text-align:center; color:#6c757d; font-size:13px;">لا توجد نتائج</div>';
        container.style.display = 'block';
        return;
    }

    container.innerHTML = filtered.map(c => customerResultItem(c)).join('');
    container.style.display = 'block';
}

function customerResultItem(c) {
    return `<div onclick="pickCustomerFromSearch('${c.id}')" style="padding:10px 12px; cursor:pointer; border-bottom:1px solid #eee; font-size:13px; display:flex; justify-content:space-between; align-items:center;"
        onmouseover="this.style.background='#f0f0ff'" onmouseout="this.style.background='white'">
        <span><strong>${escHTML(c.name)}</strong></span>
        <span style="color:#667eea; font-size:12px; direction:ltr;">${escHTML(c.phone) || ''}</span>
    </div>`;
}

function pickCustomerFromSearch(id) {
    const customer = allCustomersDropdown.find(c => c.id == id);
    if (!customer) return;

    document.getElementById('selectedCustomerId').value = customer.id;
    document.getElementById('customerName').value = customer.name;
    document.getElementById('customerPhone').value = customer.phone || '';
    document.getElementById('customerAddress').value = customer.address || '';

    document.getElementById('displayCustomerName').textContent = customer.name;
    document.getElementById('displayCustomerPhone').textContent = customer.phone || '-';
    document.getElementById('displayCustomerAddress').textContent = customer.address || '-';
    document.getElementById('customerDetails').style.display = 'block';

    // تحديث حقل البحث
    document.getElementById('customerSearchInput').value = customer.name;
    document.getElementById('customerSearchResults').style.display = 'none';

    // عرض قسم الولاء
    currentCustomerData = customer;
    document.getElementById('loyaltySection').style.display = 'block';
    document.getElementById('customerLoyaltyPoints').textContent = customer.loyalty_points || customer.points || 0;
    updatePointsToEarn();

    // التحقق من الاشتراك
    if (typeof checkCustomerSubscription === 'function') {
        checkCustomerSubscription(customer.id).then(sub => {
            if (sub) updateTotals();
        });
    }
}

// إغلاق نتائج البحث عند الضغط خارجها
document.addEventListener('click', (e) => {
    const input = document.getElementById('customerSearchInput');
    const results = document.getElementById('customerSearchResults');
    if (input && results && !input.contains(e.target) && !results.contains(e.target)) {
        results.style.display = 'none';
    }
});

function showAddCustomerFromPOS() {
    showAddCustomer();
}

function clearCustomerSelection() {
    document.getElementById('customerSearchInput').value = '';
    document.getElementById('customerSearchResults').style.display = 'none';
    document.getElementById('selectedCustomerId').value = '';
    document.getElementById('customerName').value = '';
    document.getElementById('customerPhone').value = '';
    document.getElementById('customerAddress').value = '';
    document.getElementById('customerDetails').style.display = 'none';
    document.getElementById('loyaltySection').style.display = 'none';
    document.getElementById('loyaltyDiscountRow').style.display = 'none';
    document.getElementById('pointsToRedeem').value = '';
    currentCustomerData = null;
    if (typeof hideSubscriptionBadge === 'function') hideSubscriptionBadge();
    const subRedeemRow = document.getElementById('subscriptionRedeemRow');
    if (subRedeemRow) subRedeemRow.style.display = 'none';
}



// ========================================
// 🔔 Helper Functions للإشعارات
// ========================================

/**
 * عرض رسالة خطأ
 */
function showError(message, duration = 5000) {
    const oldNotif = document.getElementById('errorNotification');
    if (oldNotif) oldNotif.remove();
    
    const notification = document.createElement('div');
    notification.id = 'errorNotification';
    notification.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        left: 20px;
        max-width: 500px;
        margin: 0 auto;
        padding: 16px 24px;
        background: #dc3545;
        color: white;
        border-radius: 12px;
        font-weight: bold;
        z-index: 10001;
        box-shadow: 0 4px 20px rgba(220, 53, 69, 0.4);
        animation: slideInDown 0.3s ease;
        text-align: center;
    `;
    
    notification.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
            <span style="font-size: 24px;">⚠️</span>
            <span>${message}</span>
        </div>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOutUp 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

/**
 * عرض رسالة نجاح
 */
function showSuccess(message, duration = 3000) {
    const oldNotif = document.getElementById('successNotification');
    if (oldNotif) oldNotif.remove();
    
    const notification = document.createElement('div');
    notification.id = 'successNotification';
    notification.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        left: 20px;
        max-width: 500px;
        margin: 0 auto;
        padding: 16px 24px;
        background: #28a745;
        color: white;
        border-radius: 12px;
        font-weight: bold;
        z-index: 10001;
        box-shadow: 0 4px 20px rgba(40, 167, 69, 0.4);
        animation: slideInDown 0.3s ease;
        text-align: center;
    `;
    
    notification.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
            <span style="font-size: 24px;">✅</span>
            <span>${message}</span>
        </div>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOutUp 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

// CSS للـ animations
const notifStyle = document.createElement('style');
notifStyle.textContent = `
@keyframes slideInDown {
    from {
        transform: translateY(-100px);
        opacity: 0;
    }
    to {
        transform: translateY(0);
        opacity: 1;
    }
}

@keyframes slideOutUp {
    from {
        transform: translateY(0);
        opacity: 1;
    }
    to {
        transform: translateY(-100px);
        opacity: 0;
    }
}
`;
document.head.appendChild(notifStyle);

console.log('✅ Notification helpers جاهزة');

/**
 * عرض تنبيه تحذيري (برتقالي)
 */
function showWarning(message, duration = 6000) {
    const oldNotif = document.getElementById('warningNotification');
    if (oldNotif) oldNotif.remove();

    const notification = document.createElement('div');
    notification.id = 'warningNotification';
    notification.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        left: 20px;
        max-width: 500px;
        margin: 0 auto;
        padding: 16px 24px;
        background: linear-gradient(135deg, #f6ad55, #ed8936);
        color: white;
        border-radius: 12px;
        font-weight: bold;
        z-index: 10001;
        box-shadow: 0 4px 20px rgba(237, 137, 54, 0.4);
        animation: slideInDown 0.3s ease;
        text-align: right;
        direction: rtl;
    `;

    notification.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 10px; flex-direction: column;">
            <span style="font-size: 18px;">📦 تنبيه مخزون منخفض</span>
            <div style="font-size: 14px; font-weight: normal; line-height: 1.8;">${message}</div>
        </div>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOutUp 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

/**
 * تشغيل صوت إتمام الفاتورة
 */
function playInvoiceSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const now = ctx.currentTime;

        // نغمة نجاح: 3 نوتات صاعدة
        const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
        const durations = [0.12, 0.12, 0.25];
        let time = now;

        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.3, time);
            gain.gain.exponentialRampToValueAtTime(0.01, time + durations[i]);

            osc.start(time);
            osc.stop(time + durations[i]);
            time += durations[i] * 0.8;
        });

        // إغلاق السياق بعد انتهاء الصوت
        setTimeout(() => ctx.close(), 1000);
    } catch(e) {
        console.log('[Sound] Could not play invoice sound:', e);
    }
}

// ===== استعادة المستخدم عند تحميل الصفحة =====
// === جلب رقم الإصدار ===
async function fetchVersion() {
    try {
        const res = await fetch(`${API_URL}/api/version`, {cache: 'no-store'});
        const data = await res.json();
        if (data.success) {
            const vText = `v${data.version}`;
            const hv = document.getElementById('headerVersion');
            const lv = document.getElementById('loginVersion');
            if (hv) hv.textContent = vText;
            if (lv) lv.textContent = vText;
        }
    } catch(e) { console.log('[Version] fetch failed:', e); }
}
fetchVersion();

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[App] DOMContentLoaded - checking for saved user...');

    // First-time setup check (async for HMAC verification)
    if (await checkFirstTimeSetup()) {
        console.log('[App] First-time setup screen shown');
        return;
    }

    // License check (HMAC-verified)
    const licenseOk = await checkLicense();
    if (!licenseOk) {
        console.log('[App] License check failed - overlay shown');
    }

    // Auto-sync on launch if server is configured
    if (typeof getSyncServerUrl === 'function' && getSyncServerUrl() && typeof syncManager !== 'undefined') {
        console.log('[App] Server configured, triggering background sync...');
        try { syncManager.sync(); } catch(e) {}
    }

    // إذا كان المدير الأعلى مسجل دخوله، لا نستعيد جلسة المستخدم العادي
    const savedSA = localStorage.getItem('pos_super_admin');
    if (savedSA) {
        console.log('[App] Super Admin session found, skipping regular user restore');
        return;
    }

    if (restoreUser()) {
        console.log('[App] User found in localStorage, restoring session...');
        initializeUI();
    } else {
        console.log('[App] No saved user, showing login screen');
    }
});

// ===== منع التحديث العرضي =====
// تحذير المستخدم إذا فيه فواتير معلقة أو سلة
window.addEventListener('beforeunload', (e) => {
    // لا نمنع التحديث، فقط نحذر إذا فيه بيانات مهمة
    if (cart.length > 0) {
        e.preventDefault();
        e.returnValue = 'لديك منتجات في السلة. هل تريد المتابعة؟';
        return e.returnValue;
    }
});

console.log('[App] Page refresh protection enabled ✅');

// ========================================
// 📈 DCF Valuation (التدفقات النقدية المخصومة)
// ========================================

let dcfChart = null; // لحفظ مرجع الرسم البياني

function calculateDCF() {
    // قراءة المدخلات
    const initialCF = parseFloat(document.getElementById('dcf_initial_cf').value) || 0;
    const growthRate = parseFloat(document.getElementById('dcf_growth_rate').value) / 100 || 0;
    const discountRate = parseFloat(document.getElementById('dcf_discount_rate').value) / 100 || 0;
    const years = parseInt(document.getElementById('dcf_years').value) || 5;
    const terminalGrowth = parseFloat(document.getElementById('dcf_terminal_growth').value) / 100 || 0;
    
    // التحقق
    if (initialCF <= 0) {
        alert('الرجاء إدخال تدفق نقدي موجب');
        return;
    }
    
    if (discountRate <= terminalGrowth) {
        alert('⚠️ معدل الخصم يجب أن يكون أكبر من معدل النمو الدائم');
        return;
    }
    
    // حساب التدفقات السنوية
    const cashFlows = [];
    let totalPVCashFlows = 0;
    
    for (let year = 1; year <= years; year++) {
        const cf = initialCF * Math.pow(1 + growthRate, year);
        const pv = cf / Math.pow(1 + discountRate, year);
        totalPVCashFlows += pv;
        
        cashFlows.push({
            year: year,
            cashFlow: cf,
            presentValue: pv,
            discountFactor: 1 / Math.pow(1 + discountRate, year)
        });
    }
    
    // حساب القيمة المتبقية (Terminal Value)
    const lastCF = initialCF * Math.pow(1 + growthRate, years);
    const terminalCF = lastCF * (1 + terminalGrowth);
    const terminalValue = terminalCF / (discountRate - terminalGrowth);
    const pvTerminalValue = terminalValue / Math.pow(1 + discountRate, years);
    
    // القيمة الإجمالية
    const totalValue = totalPVCashFlows + pvTerminalValue;
    
    // عرض النتائج
    displayDCFResults(totalValue, totalPVCashFlows, pvTerminalValue, cashFlows, terminalValue);
}

function displayDCFResults(totalValue, pvCashFlows, pvTerminalValue, cashFlows, terminalValue) {
    // إظهار قسم النتائج
    document.getElementById('dcfResults').style.display = 'block';
    
    // الحصول على العملة
    const currency = document.getElementById('storeCurrency')?.value || 'KWD';
    const currencySymbol = getCurrencySymbol(currency);
    
    // القيمة الإجمالية
    document.getElementById('dcfTotalValue').textContent = `${totalValue.toLocaleString('ar', {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${currencySymbol}`;
    
    // التدفقات المخصومة
    document.getElementById('dcfPVCashFlows').textContent = `${pvCashFlows.toLocaleString('ar', {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${currencySymbol}`;
    
    // القيمة المتبقية
    document.getElementById('dcfTerminalValue').textContent = `${pvTerminalValue.toLocaleString('ar', {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${currencySymbol}`;
    
    // جدول التفاصيل
    let tableHTML = `
        <table style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr style="background: #667eea; color: white;">
                    <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">السنة</th>
                    <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">التدفق النقدي</th>
                    <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">معامل الخصم</th>
                    <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">القيمة الحالية</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    cashFlows.forEach(cf => {
        tableHTML += `
            <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 10px; text-align: center;">${cf.year}</td>
                <td style="padding: 10px; text-align: center;">${cf.cashFlow.toLocaleString('ar', {minimumFractionDigits: 2})}</td>
                <td style="padding: 10px; text-align: center;">${cf.discountFactor.toFixed(4)}</td>
                <td style="padding: 10px; text-align: center; font-weight: bold; color: #667eea;">${cf.presentValue.toLocaleString('ar', {minimumFractionDigits: 2})}</td>
            </tr>
        `;
    });
    
    // إضافة القيمة المتبقية
    const years = cashFlows.length;
    tableHTML += `
        <tr style="background: #f7fafc; font-weight: bold;">
            <td style="padding: 10px; text-align: center;">${years}+</td>
            <td style="padding: 10px; text-align: center;">${terminalValue.toLocaleString('ar', {minimumFractionDigits: 2})}</td>
            <td style="padding: 10px; text-align: center;">${(1 / Math.pow(1 + parseFloat(document.getElementById('dcf_discount_rate').value) / 100, years)).toFixed(4)}</td>
            <td style="padding: 10px; text-align: center; font-weight: bold; color: #764ba2;">${pvTerminalValue.toLocaleString('ar', {minimumFractionDigits: 2})}</td>
        </tr>
        <tr style="background: #667eea; color: white; font-weight: bold; font-size: 16px;">
            <td colspan="3" style="padding: 12px; text-align: center;">الإجمالي</td>
            <td style="padding: 12px; text-align: center;">${totalValue.toLocaleString('ar', {minimumFractionDigits: 2})}</td>
        </tr>
    `;
    
    tableHTML += '</tbody></table>';
    document.getElementById('dcfTable').innerHTML = tableHTML;
    
    // الرسم البياني
    drawDCFChart(cashFlows, pvTerminalValue);
}

function drawDCFChart(cashFlows, terminalValue) {
    const ctx = document.getElementById('dcfChart').getContext('2d');
    
    // حذف الرسم القديم
    if (dcfChart) {
        dcfChart.destroy();
    }
    
    const labels = cashFlows.map(cf => `السنة ${cf.year}`);
    labels.push('القيمة المتبقية');
    
    const data = cashFlows.map(cf => cf.presentValue);
    data.push(terminalValue);
    
    dcfChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'القيمة الحالية',
                data: data,
                backgroundColor: cashFlows.map((_, i) => i < cashFlows.length ? 'rgba(102, 126, 234, 0.7)' : 'rgba(118, 75, 162, 0.7)'),
                borderColor: cashFlows.map((_, i) => i < cashFlows.length ? 'rgba(102, 126, 234, 1)' : 'rgba(118, 75, 162, 1)'),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return 'القيمة: ' + context.parsed.y.toLocaleString('ar', {minimumFractionDigits: 2});
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return value.toLocaleString('ar');
                        }
                    }
                }
            }
        }
    });
}

function getCurrencySymbol(code) {
    const currencies = {
        'KWD': 'د.ك',
        'USD': '$',
        'EUR': '€',
        'GBP': '£',
        'SAR': 'ر.س',
        'AED': 'د.إ',
        'QAR': 'ر.ق',
        'OMR': 'ر.ع',
        'BHD': 'د.ب',
        'EGP': 'ج.م',
        'JOD': 'د.أ',
        'IQD': 'د.ع',
        'LBP': 'ل.ل',
        'TRY': '₺'
    };
    return currencies[code] || code;
}

console.log('[DCF] Module loaded ✅');

// ========================================
// ⏰ عرض الوقت والتاريخ الحالي
// ========================================

function updateDateTime() {
    const now = new Date();
    const dateTimeElement = document.getElementById('datetime');
    if (dateTimeElement) {
        const options = {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        };
        const formatted = now.toLocaleDateString('ar-SA', options);
        dateTimeElement.textContent = formatted;
    }
}

// تحديث الوقت كل ثانية
setInterval(updateDateTime, 1000);

// تحديث أولي
updateDateTime();

console.log('[DateTime] Clock started ✅');

// ========================================
// ⏰ تحويل الوقت لتوقيت الكويت (UTC+3)
// ========================================

function formatKuwaitTime(dateString) {
    if (!dateString) return '-';
    
    try {
        // إنشاء التاريخ من النص
        const date = new Date(dateString);
        
        // السيرفر يحفظ بـ UTC، نحتاج نضيف 3 ساعات (الكويت = UTC+3)
        const kuwaitOffset = 3 * 60 * 60 * 1000; // 3 ساعات بالميلي ثانية
        const kuwaitTime = new Date(date.getTime() + kuwaitOffset);
        
        // تنسيق عربي
        const options = {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        };
        
        return kuwaitTime.toLocaleString('ar-SA', options);
    } catch (e) {
        console.error('Error formatting date:', e);
        return new Date(dateString).toLocaleString('ar');
    }
}

console.log('[Timezone] Kuwait time formatter loaded ✅');

// ========================================
// 💰 نظام التكاليف الديناميكي المرن
// ========================================

let costRowCounter = 0;

// إضافة صف تكلفة جديد
function addCostRow(name = '', value = 0) {
    costRowCounter++;
    const container = document.getElementById('costsContainer');
    
    const rowDiv = document.createElement('div');
    rowDiv.className = 'cost-row';
    rowDiv.id = `costRow${costRowCounter}`;
    rowDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; margin-bottom: 10px; padding: 12px; background: white; border-radius: 8px; border: 1px solid #e2e8f0;';
    
    rowDiv.innerHTML = `
        <div class="form-group" style="margin: 0;">
            <input type="text" 
                   class="cost-name" 
                   placeholder="اسم التكلفة (مثال: الباكج)"
                   value="${name}"
                   style="padding: 10px; border: 2px solid #cbd5e0; border-radius: 6px; width: 100%; font-size: 14px;">
        </div>
        <div class="form-group" style="margin: 0;">
            <input type="number" 
                   class="cost-value" 
                   placeholder="0.000"
                   value="${value}"
                   step="0.001"
                   oninput="calculateTotalCost()"
                   style="padding: 10px; border: 2px solid #cbd5e0; border-radius: 6px; width: 100%; font-size: 14px;">
        </div>
        <button type="button" 
                onclick="removeCostRow('costRow${costRowCounter}')" 
                class="btn-sm btn-danger"
                title="حذف"
                style="padding: 10px 15px; height: 42px;">
            🗑️
        </button>
    `;
    
    container.appendChild(rowDiv);
    calculateTotalCost();
    
    return rowDiv;
}

// حذف صف تكلفة
function removeCostRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) {
        row.remove();
        calculateTotalCost();
    }
}

// حساب إجمالي التكلفة
function calculateTotalCost() {
    const costInputs = document.querySelectorAll('.cost-value');
    let total = 0;
    
    costInputs.forEach(input => {
        const value = parseFloat(input.value) || 0;
        total += value;
    });
    
    // تحديث العرض
    const display = document.getElementById('totalCostDisplay');
    if (display) {
        display.textContent = `${total.toFixed(3)} د.ك`;
    }
    
    // تحديث الحقل المخفي
    const costField = document.getElementById('productCost');
    if (costField) {
        costField.value = total.toFixed(3);
    }
    
    return total;
}

// جمع بيانات التكاليف
function getCostsData() {
    const costRows = document.querySelectorAll('.cost-row');
    const costs = [];
    
    costRows.forEach(row => {
        const nameInput = row.querySelector('.cost-name');
        const valueInput = row.querySelector('.cost-value');
        
        const name = nameInput?.value?.trim() || '';
        const value = parseFloat(valueInput?.value) || 0;
        
        if (name && value > 0) {
            costs.push({ name, value });
        }
    });
    
    return costs;
}

// تحميل بيانات التكاليف
function loadCostsData(costs) {
    // مسح الصفوف القديمة
    const container = document.getElementById('costsContainer');
    if (container) {
        container.innerHTML = '';
        costRowCounter = 0;
    }
    
    // إضافة التكاليف
    if (costs && Array.isArray(costs) && costs.length > 0) {
        costs.forEach(cost => {
            addCostRow(cost.name, cost.value);
        });
    } else {
        // إضافة صف واحد فارغ كبداية
        addCostRow('', 0);
    }
    
    calculateTotalCost();
}

// تهيئة نظام التكاليف
function initializeCostSystem() {
    const container = document.getElementById('costsContainer');
    if (container && container.children.length === 0) {
        // إضافة صف واحد افتراضي
        addCostRow('', 0);
    }
    calculateTotalCost();
}

console.log('[Costs] Dynamic flexible cost system loaded ✅');

// ========================================
// 📋 نظام التكاليف في المخزون (مدمج)
// ========================================

let inventoryCostCounter = 0;

// إضافة صف تكلفة في نموذج المخزون
function addInventoryCostRow(name = '', value = 0) {
    inventoryCostCounter++;
    const container = document.getElementById('inventoryCostsContainer');
    if (!container) return;
    
    const rowDiv = document.createElement('div');
    rowDiv.className = 'inventory-cost-row';
    rowDiv.id = `inventoryCostRow${inventoryCostCounter}`;
    rowDiv.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; margin-bottom: 10px; padding: 12px; background: white; border-radius: 8px; border: 1px solid #e2e8f0;';
    
    rowDiv.innerHTML = `
        <div class="form-group" style="margin: 0;">
            <input type="text" 
                   class="inventory-cost-name" 
                   placeholder="اسم التكلفة (مثال: الباكج)"
                   value="${name}"
                   style="padding: 10px; border: 2px solid #cbd5e0; border-radius: 6px; width: 100%; font-size: 14px;">
        </div>
        <div class="form-group" style="margin: 0;">
            <input type="number" 
                   class="inventory-cost-value" 
                   placeholder="0.000"
                   value="${value}"
                   step="0.001"
                   oninput="calculateInventoryTotalCost()"
                   style="padding: 10px; border: 2px solid #cbd5e0; border-radius: 6px; width: 100%; font-size: 14px;">
        </div>
        <button type="button" 
                onclick="removeInventoryCostRow('inventoryCostRow${inventoryCostCounter}')" 
                class="btn-sm btn-danger"
                title="حذف"
                style="padding: 10px 15px; height: 42px;">
            🗑️
        </button>
    `;
    
    container.appendChild(rowDiv);
    calculateInventoryTotalCost();
    
    return rowDiv;
}

// حذف صف تكلفة
function removeInventoryCostRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) {
        row.remove();
        calculateInventoryTotalCost();
    }
}

// حساب إجمالي التكلفة
function calculateInventoryTotalCost() {
    const costInputs = document.querySelectorAll('.inventory-cost-value');
    let total = 0;
    
    costInputs.forEach(input => {
        const value = parseFloat(input.value) || 0;
        total += value;
    });
    
    const display = document.getElementById('inventoryTotalCostDisplay');
    if (display) {
        display.textContent = `${total.toFixed(3)} د.ك`;
    }
    
    // تحديث حقل التكلفة المخفي
    const costField = document.getElementById('inventoryCost');
    if (costField) {
        costField.value = total.toFixed(3);
    }
    
    // حساب هامش الربح (تمرير القيمة بدلاً من الاستدعاء)
    const priceInput = document.getElementById('inventoryPrice');
    const price = parseFloat(priceInput?.value) || 0;
    updateInventoryProfitDisplay(price, total);
    
    return total;
}

// تحديث عرض هامش الربح
function updateInventoryProfitDisplay(price, cost) {
    const profit = price - cost;
    const profitPercent = price > 0 ? ((profit / price) * 100).toFixed(1) : 0;
    
    const display = document.getElementById('inventoryProfitDisplay');
    if (display) {
        const color = profit > 0 ? '#38a169' : '#f56565';
        display.style.color = color;
        display.innerHTML = `${profit.toFixed(3)} د.ك (<span style="font-size: 16px;">${profitPercent}%</span>)`;
    }
}

// حساب هامش الربح (عند تغيير السعر)
function calculateInventoryProfit() {
    const costInputs = document.querySelectorAll('.inventory-cost-value');
    let totalCost = 0;
    
    costInputs.forEach(input => {
        const value = parseFloat(input.value) || 0;
        totalCost += value;
    });
    
    const priceInput = document.getElementById('inventoryPrice');
    const price = parseFloat(priceInput?.value) || 0;
    
    updateInventoryProfitDisplay(price, totalCost);
}

// جمع بيانات التكاليف
function getInventoryCostsData() {
    const costRows = document.querySelectorAll('.inventory-cost-row');
    const costs = [];
    
    costRows.forEach(row => {
        const nameInput = row.querySelector('.inventory-cost-name');
        const valueInput = row.querySelector('.inventory-cost-value');
        
        const name = nameInput?.value?.trim() || '';
        const value = parseFloat(valueInput?.value) || 0;
        
        if (name && value > 0) {
            costs.push({ name, value });
        }
    });
    
    return costs;
}

// تحميل بيانات التكاليف
function loadInventoryCosts(costs) {
    const container = document.getElementById('inventoryCostsContainer');
    if (container) {
        container.innerHTML = '';
        inventoryCostCounter = 0;
    }
    
    if (costs && Array.isArray(costs) && costs.length > 0) {
        costs.forEach(cost => {
            addInventoryCostRow(cost.name, cost.value);
        });
    } else {
        addInventoryCostRow('', 0);
    }
    
    calculateInventoryTotalCost();
}

// تهيئة نظام التكاليف في المخزون
function initializeInventoryCosts() {
    const container = document.getElementById('inventoryCostsContainer');
    if (container && container.children.length === 0) {
        addInventoryCostRow('', 0);
    }
    calculateInventoryTotalCost();
}

console.log('[Inventory Costs] System loaded ✅');

// ===============================================
// 🎯 نظام الولاء (Loyalty System)
// ===============================================

let currentCustomerData = null;

// تحميل جميع العملاء
async function loadCustomers() {
    try {
        const response = await fetch(`${API_URL}/api/customers`);
        const data = await response.json();
        
        if (data.success) {
            allCustomers = data.customers;
            displayCustomersTable(allCustomers);
        }
    } catch (error) {
        console.error('Error loading customers:', error);
    }
}

// عرض جدول العملاء
function displayCustomersTable(customers) {
    const container = document.getElementById('customersContainer');
    if (!container) return;
    
    if (!customers || customers.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">لا يوجد عملاء</div>';
        return;
    }
    
    let html = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>الاسم</th>
                    <th>الهاتف</th>
                    <th>💎 النقاط</th>
                    <th>💰 إجمالي المشتريات</th>
                    <th>📅 آخر زيارة</th>
                    <th>إجراءات</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    customers.forEach(c => {
        const lastVisit = c.last_visit ? new Date(c.last_visit).toLocaleDateString('ar-EG') : 'لا يوجد';
        const points = c.loyalty_points || c.points || 0;
        const pointValue = (window.loyaltyConfig && window.loyaltyConfig.pointValue) || 0.1;
        const pointsValueKd = (points * pointValue).toFixed(3);
        html += `
            <tr>
                <td>${escHTML(c.name)}</td>
                <td>${escHTML(c.phone)}</td>
                <td>
                    <span style="font-weight: bold; color: #0ea5e9; font-size: 16px;">${points}</span>
                    <div style="font-size: 10px; color: #64748b;">= ${pointsValueKd} د.ك</div>
                </td>
                <td>${(c.total_spent || 0).toFixed(3)} د.ك</td>
                <td>${lastVisit}</td>
                <td>
                    <button onclick="editCustomer(${c.id})" class="btn-sm">✏️</button>
                    <button onclick="viewCustomerDetails(${c.id})" class="btn-sm" style="background: #0ea5e9;">👁️</button>
                    <button onclick="deleteCustomer(${c.id})" class="btn-sm btn-danger">🗑️</button>
                </td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
}

// البحث عن عملاء
function searchCustomers() {
    const searchTerm = document.getElementById('customerSearch').value.toLowerCase();
    if (!searchTerm) {
        displayCustomersTable(allCustomers);
        return;
    }
    
    const filtered = allCustomers.filter(c => 
        c.name.toLowerCase().includes(searchTerm) ||
        c.phone.includes(searchTerm) ||
        (c.email && c.email.toLowerCase().includes(searchTerm))
    );
    
    displayCustomersTable(filtered);
}

// إظهار نموذج إضافة عميل
function showAddCustomer() {
    document.getElementById('customerModalTitle').textContent = '➕ إضافة عميل';
    document.getElementById('customerForm').reset();
    document.getElementById('customerId').value = '';
    document.getElementById('loyaltyPointsSection').style.display = 'none';
    document.getElementById('addCustomerModal').classList.add('active');
}

// إغلاق نموذج العميل
function closeAddCustomer() {
    document.getElementById('addCustomerModal').classList.remove('active');
}

// حفظ العميل
document.getElementById('customerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const customerId = document.getElementById('customerId').value;
    const customerData = {
        name: document.getElementById('customerNameField').value,
        phone: document.getElementById('customerPhoneField').value,
        email: document.getElementById('customerEmailField').value,
        notes: document.getElementById('customerNotes').value
    };
    
    // دالة مساعدة لحفظ العميل محلياً
    async function _saveCustomerLocally() {
        const offlineCustomer = {
            id: 'offline_' + Date.now(),
            ...customerData,
            loyalty_points: 0,
            created_at: new Date().toISOString(),
            _offline: true
        };
        allCustomersDropdown.push(offlineCustomer);
        try { await localDB.save('pending_customers', offlineCustomer); } catch(e) {}
        alert('✅ تم حفظ العميل محلياً (سيتم مزامنته عند الاتصال)');
        closeAddCustomer();
    }

    try {
        const url = customerId ? `${API_URL}/api/customers/${customerId}` : `${API_URL}/api/customers`;
        const method = customerId ? 'PUT' : 'POST';

        // فحص الاتصال الفعلي (ليس فقط navigator.onLine)
        const reallyOnline = await checkRealConnection();
        if (!reallyOnline) {
            await _saveCustomerLocally();
            return;
        }

        const response = await fetch(url, {
            method: method,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(customerData)
        });

        const data = await response.json();

        if (data.success) {
            alert('✅ تم حفظ العميل بنجاح');
            await logAction(customerId ? 'edit_customer' : 'add_customer', `${customerId ? 'تعديل' : 'إضافة'} عميل: ${customerData.name}`, data.id || customerId);
            closeAddCustomer();
            loadCustomers();
            await loadCustomersDropdown();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        // حفظ محلي كـ fallback عند فشل الشبكة
        await _saveCustomerLocally();
    }
});

// تعديل عميل
async function editCustomer(id) {
    try {
        const response = await fetch(`${API_URL}/api/customers/${id}`);
        const data = await response.json();
        
        if (data.success) {
            const c = data.customer;
            document.getElementById('customerModalTitle').textContent = '✏️ تعديل عميل';
            document.getElementById('customerId').value = c.id;
            document.getElementById('customerNameField').value = c.name;
            document.getElementById('customerPhoneField').value = c.phone;
            document.getElementById('customerEmailField').value = c.email || '';
            document.getElementById('customerNotes').value = c.notes || '';
            
            // عرض النقاط
            document.getElementById('loyaltyPointsSection').style.display = 'block';
            document.getElementById('customerCurrentPoints').textContent = c.points || 0;
            document.getElementById('customerTotalSpent').textContent = (c.total_spent || 0).toFixed(3);
            
            currentCustomerData = c;
            document.getElementById('addCustomerModal').classList.add('active');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل تحميل بيانات العميل');
    }
}

// عرض تفاصيل عميل
async function viewCustomerDetails(id) {
    try {
        const response = await fetch(`${API_URL}/api/customers/${id}`);
        const data = await response.json();

        if (data.success) {
            const c = data.customer;
            const html = `
                <div style="padding: 20px;">
                    <h3 style="margin-bottom: 20px;">👤 تفاصيل العميل</h3>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; font-size: 14px;">
                        <div><strong>الاسم:</strong> ${c.name || '-'}</div>
                        <div><strong>الهاتف:</strong> ${c.phone || '-'}</div>
                        <div><strong>البريد:</strong> ${c.email || '-'}</div>
                        <div><strong>العنوان:</strong> ${c.address || '-'}</div>
                        <div><strong>النقاط:</strong> <span style="color: #0ea5e9; font-weight: bold;">${c.points || 0}</span></div>
                        <div><strong>إجمالي المشتريات:</strong> <span style="color: #28a745; font-weight: bold;">${(c.total_spent || 0).toFixed(3)} د.ك</span></div>
                        <div><strong>عدد الطلبات:</strong> ${c.total_orders || 0}</div>
                        <div><strong>تاريخ التسجيل:</strong> ${c.created_at ? new Date(c.created_at).toLocaleDateString('ar') : '-'}</div>
                    </div>
                    ${c.notes ? `<div style="margin-top: 15px; padding: 10px; background: #f8f9fa; border-radius: 8px;"><strong>ملاحظات:</strong> ${c.notes}</div>` : ''}
                </div>
            `;
            document.getElementById('invoiceViewContent').innerHTML = html;
            document.getElementById('invoiceViewModal').classList.add('active');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل تحميل بيانات العميل');
    }
}

// حذف عميل
async function deleteCustomer(id) {
    if (!confirm('هل أنت متأكد من حذف هذا العميل؟')) return;
    
    try {
        const response = await fetch(`${API_URL}/api/customers/${id}`, {method: 'DELETE'});
        const data = await response.json();
        
        if (data.success) {
            alert('✅ تم حذف العميل');
            await logAction('delete_customer', `حذف عميل رقم ${id}`, id);
            loadCustomers();
            loadCustomersDropdown();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الحذف');
    }
}

// إظهار نموذج تعديل النقاط
function showAdjustPoints() {
    if (!currentCustomerData) return;
    
    document.getElementById('adjustCurrentPoints').textContent = currentCustomerData.points || 0;
    document.getElementById('pointsAdjustment').value = '';
    document.getElementById('adjustReason').value = '';
    document.getElementById('adjustPointsModal').classList.add('active');
}

// إغلاق نموذج تعديل النقاط
function closeAdjustPoints() {
    document.getElementById('adjustPointsModal').classList.remove('active');
}

// حفظ تعديل النقاط
document.getElementById('adjustPointsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!currentCustomerData) return;
    
    const points = parseInt(document.getElementById('pointsAdjustment').value);
    const reason = document.getElementById('adjustReason').value;
    
    try {
        const response = await fetch(`${API_URL}/api/customers/${currentCustomerData.id}/points/adjust`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({points, reason})
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('✅ تم تعديل النقاط بنجاح');
            closeAdjustPoints();
            
            // تحديث النقاط المعروضة
            const newPoints = (currentCustomerData.points || 0) + points;
            document.getElementById('customerCurrentPoints').textContent = newPoints;
            currentCustomerData.points = newPoints;
            
            loadCustomers();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل التعديل');
    }
});

// البحث عن عميل بالهاتف (في الفاتورة)
async function searchCustomerByPhone() {
    const phone = document.getElementById('customerPhone').value.trim();
    if (!phone || phone.length < 8) {
        document.getElementById('loyaltySection').style.display = 'none';
        document.getElementById('selectedCustomerId').value = '';
        currentCustomerData = null;
        return;
    }

    if (!_realOnlineStatus) {
        // أوفلاين: البحث في القائمة المحملة مسبقاً
        const found = allCustomersDropdown.find(c => c.phone === phone);
        if (found) {
            currentCustomerData = found;
            document.getElementById('customerName').value = found.name;
            document.getElementById('selectedCustomerId').value = found.id;
            document.getElementById('loyaltySection').style.display = 'block';
            document.getElementById('customerLoyaltyPoints').textContent = found.loyalty_points || found.points || 0;
            updatePointsToEarn();
        }
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/customers/search?phone=${encodeURIComponent(phone)}`);
        const data = await response.json();
        
        if (data.success && data.customer) {
            const c = data.customer;
            currentCustomerData = c;
            
            // ملء البيانات
            document.getElementById('customerName').value = c.name;
            document.getElementById('selectedCustomerId').value = c.id;
            
            // عرض قسم الولاء
            document.getElementById('loyaltySection').style.display = 'block';
            document.getElementById('customerLoyaltyPoints').textContent = c.points || 0;
            
            // حساب النقاط التي سيربحها
            updatePointsToEarn();
        } else {
            document.getElementById('loyaltySection').style.display = 'none';
            document.getElementById('selectedCustomerId').value = '';
            currentCustomerData = null;
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

// تحديث النقاط التي سيربحها العميل
function updatePointsToEarn() {
    const pointsPerInvoice = (window.loyaltyConfig && window.loyaltyConfig.pointsPerInvoice) || 10;
    document.getElementById('pointsToEarn').textContent = pointsPerInvoice;
}

// حساب خصم الولاء
function calculateLoyaltyDiscount() {
    const pointsToRedeem = parseInt(document.getElementById('pointsToRedeem').value) || 0;
    const availablePoints = currentCustomerData ? (currentCustomerData.loyalty_points || currentCustomerData.points || 0) : 0;

    if (pointsToRedeem > availablePoints) {
        alert('⚠️ النقاط المطلوبة أكبر من النقاط المتاحة');
        document.getElementById('pointsToRedeem').value = availablePoints;
        return;
    }

    const pointValue = (window.loyaltyConfig && window.loyaltyConfig.pointValue) || 0.1;
    const discount = pointsToRedeem * pointValue;

    // عرض الخصم
    if (discount > 0) {
        document.getElementById('loyaltyDiscountRow').style.display = 'flex';
        document.getElementById('loyaltyDiscountAmount').textContent = discount.toFixed(3) + ' د.ك';
    } else {
        document.getElementById('loyaltyDiscountRow').style.display = 'none';
    }

    updateTotals();
}

// استخدام كل النقاط
function applyMaxPoints() {
    if (!currentCustomerData) return;

    const availablePoints = currentCustomerData.loyalty_points || currentCustomerData.points || 0;
    const subtotal = calculateSubtotal();
    const pointValue = (window.loyaltyConfig && window.loyaltyConfig.pointValue) || 0.1;
    // أقصى نقاط = أقل من (نقاطه المتاحة، نقاط تعادل المجموع)
    const maxPointsForTotal = Math.floor(subtotal / pointValue);
    const maxPointsToUse = Math.min(availablePoints, maxPointsForTotal);

    document.getElementById('pointsToRedeem').value = maxPointsToUse;
    calculateLoyaltyDiscount();
}

// تحديث دالة updateTotals لدعم خصم الولاء
const originalUpdateTotals = updateTotals;
updateTotals = function() {
    originalUpdateTotals();
    
    // إضافة خصم الولاء
    const pointsToRedeem = parseInt(document.getElementById('pointsToRedeem').value) || 0;
    const loyaltyDiscount = pointsToRedeem / 100;
    
    if (loyaltyDiscount > 0) {
        const currentTotal = parseFloat(document.getElementById('total').textContent.replace(/[^\d.]/g, ''));
        const newTotal = Math.max(0, currentTotal - loyaltyDiscount);
        document.getElementById('total').textContent = newTotal.toFixed(3) + ' د.ك';
    }
    
    // تحديث النقاط التي سيربحها
    if (currentCustomerData) {
        updatePointsToEarn();
    }
};

// تحديث دالة completeSale لدعم الولاء
const originalCompleteSale = completeSale;
completeSale = async function() {
    // جمع بيانات الولاء
    const customerId = document.getElementById('selectedCustomerId').value;
    const pointsToRedeem = parseInt(document.getElementById('pointsToRedeem').value) || 0;
    const loyaltyDiscount = pointsToRedeem / 100;
    
    // حساب النقاط المكتسبة
    const finalTotal = parseFloat(document.getElementById('total').textContent.replace(/[^\d.]/g, ''));
    const pointsEarned = Math.floor(finalTotal);
    
    // إضافة البيانات للفاتورة
    if (customerId) {
        // تعديل invoiceData في الدالة الأصلية
        window.loyaltyData = {
            customer_id: parseInt(customerId),
            loyalty_points_earned: pointsEarned,
            loyalty_points_redeemed: pointsToRedeem,
            loyalty_discount: loyaltyDiscount
        };
    }
    
    // استدعاء الدالة الأصلية
    await originalCompleteSale();
    
    // مسح بيانات الولاء بعد الحفظ
    document.getElementById('loyaltySection').style.display = 'none';
    document.getElementById('selectedCustomerId').value = '';
    document.getElementById('pointsToRedeem').value = '';
    document.getElementById('loyaltyDiscountRow').style.display = 'none';
    currentCustomerData = null;
};

console.log('[Loyalty System] Loaded ✅');


// ===============================================
// 🔐 إصلاح تسجيل الخروج (Offline Protection)
// ===============================================

// التحقق من الاتصال
console.log('[Logout Protection] Loaded ✅');

// === زر خروج طوارئ - يعمل حتى بدون اتصال ===
async function emergencyLogout() {
    const confirmed = confirm('⚠️ خروج طوارئ!\n\nهذا الخروج بدون اتصال بالسيرفر.\nبيانات الحضور والانصراف ممكن ما تتسجل.\n\nمتأكد تبي تطلع؟');
    if (!confirmed) return;

    // إيقاف فاحص قفل الشفت
    if (typeof stopShiftLockChecker === 'function') {
        try { stopShiftLockChecker(); } catch(e) {}
    }

    // محاولة تسجيل الخروج على السيرفر (لو متصل)
    if (currentUser) {
        try {
            await logAction('logout', 'خروج طوارئ (أوفلاين)', null);
        } catch (e) {}
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            await fetch(`${API_URL}/api/attendance/check-out`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ user_id: currentUser.id }),
                signal: controller.signal
            });
            clearTimeout(timeout);
        } catch (e) {}
    }

    // مسح كل البيانات
    currentUser = null;
    cart = [];
    allProducts = [];
    allInvoices = [];

    // مسح localStorage
    try {
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith('pos_cart_')) {
                localStorage.removeItem(key);
            }
        });
        localStorage.removeItem('pos_current_user');
        localStorage.removeItem('pos_tenant_slug');
        currentTenantSlug = '';
    } catch (e) {}

    // إعادة تعيين الواجهة
    try {
        document.getElementById('cartItems').innerHTML = '<div class="empty-cart"><div class="empty-cart-icon">🛒</div><p>السلة فارغة</p></div>';
        document.getElementById('subtotal').textContent = '0.000 د.ك';
        document.getElementById('total').textContent = '0.000 د.ك';
        document.getElementById('mainContainer').style.display = 'none';
        document.getElementById('loginOverlay').classList.remove('hidden');
        document.getElementById('loginForm').reset();
    } catch (e) {}

    // إعادة تحميل الصفحة
    setTimeout(() => {
        window.location.reload();
    }, 100);
}
console.log('[Emergency Logout] Loaded ✅');


// ===============================================
// 🔄 نظام المسترجع (Returns System)
// ===============================================

let allReturns = [];

// تحميل المرتجعات
async function loadReturns(status = '') {
    try {
        const params = new URLSearchParams();
        if (status) params.append('status', status);
        let url = `${API_URL}/api/returns?${params}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.success) {
            allReturns = data.returns;
            displayReturnsTable(allReturns);
        }
    } catch (error) {
        console.error('Error loading returns:', error);
    }
}

// عرض جدول المرتجعات
function displayReturnsTable(returns) {
    const container = document.getElementById('returnsTableContainer');
    if (!container) return;
    
    if (!returns || returns.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">لا توجد مرتجعات</div>';
        return;
    }
    
    let html = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>رقم المرتجع</th>
                    <th>رقم الفاتورة</th>
                    <th>المنتج</th>
                    <th>الكمية</th>
                    <th>السعر</th>
                    <th>الإجمالي</th>
                    <th>السبب</th>
                    <th>الموظف</th>
                    <th>التاريخ</th>
                    <th>إجراءات</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    returns.forEach(r => {
        const date = r.created_at ? new Date(r.created_at).toLocaleString('ar-EG', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }) : '-';
        
        html += `
            <tr>
                <td><strong>#${r.id}</strong></td>
                <td>${escHTML(r.invoice_number) || '-'}</td>
                <td><strong>${escHTML(r.product_name)}</strong></td>
                <td>${r.quantity}</td>
                <td>${(r.price || 0).toFixed(3)} د.ك</td>
                <td><strong style="color: #dc3545;">${(r.total || 0).toFixed(3)} د.ك</strong></td>
                <td style="max-width: 200px; white-space: normal;">${escHTML(r.reason) || '-'}</td>
                <td>${escHTML(r.employee_name) || '-'}</td>
                <td style="font-size: 12px;">${date}</td>
                <td>
                    <button onclick="viewReturnDetails(${r.id})" class="btn-sm" style="background: #0ea5e9;" title="عرض التفاصيل">👁️</button>
                    <button onclick="printReturn(${r.id})" class="btn-sm" style="background: #667eea;" title="طباعة">🖨️</button>
                    <button onclick="printThermalReturn(${r.id})" class="btn-sm" style="background: #e67e22; font-size:10px;" title="طباعة 57×40">🧾</button>
                    <button onclick="deleteReturnConfirm(${r.id})" class="btn-sm btn-danger" title="حذف">🗑️</button>
                </td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
}

// فلترة المرتجعات (تبسيط)
function filterReturns(status) {
    // حالياً كل المرتجعات بنفس الحالة
    displayReturnsTable(allReturns);
}

// إضافة مرتجع
function showAddReturn() {
    const modal = document.getElementById('returnModal');
    if (!modal) {
        // إنشاء Modal إذا لم يكن موجود
        createReturnModal();
    }
    
    // مسح الحقول
    document.getElementById('returnInvoiceNumber').value = '';
    document.getElementById('returnProductName').value = '';
    document.getElementById('returnQuantity').value = '1';
    document.getElementById('returnPrice').value = '';
    document.getElementById('returnEmployeeName').value = currentUser?.name || '';
    document.getElementById('returnReason').value = '';
    
    // فتح Modal
    document.getElementById('returnModal').classList.add('active');
}

// إنشاء Modal المرتجعات
function createReturnModal() {
    const modalHTML = `
        <div id="returnModal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>🔄 إضافة مرتجع</h2>
                    <button class="close-btn" onclick="closeReturnModal()">✖️</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label>رقم الفاتورة:</label>
                        <input type="text" id="returnInvoiceNumber" placeholder="اختياري">
                    </div>
                    <div class="form-group">
                        <label>المنتج:</label>
                        <input type="text" id="returnProductName" placeholder="اسم المنتج" required>
                    </div>
                    <div class="form-group">
                        <label>الكمية:</label>
                        <input type="number" id="returnQuantity" min="1" value="1" required>
                    </div>
                    <div class="form-group">
                        <label>السعر:</label>
                        <input type="number" id="returnPrice" step="0.001" placeholder="0.000" required>
                    </div>
                    <div class="form-group">
                        <label>الموظف:</label>
                        <input type="text" id="returnEmployeeName" placeholder="اسم الموظف" value="${currentUser?.name || ''}" required>
                    </div>
                    <div class="form-group">
                        <label>سبب الإرجاع:</label>
                        <textarea id="returnReason" placeholder="سبب الإرجاع..."></textarea>
                    </div>
                    <button class="btn" style="width: 100%; margin-top: 15px;" onclick="submitReturn()">
                        💾 حفظ المرتجع
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// إغلاق Modal المرتجعات
function closeReturnModal() {
    document.getElementById('returnModal').classList.remove('active');
}

// حفظ المرتجع
async function submitReturn() {
    try {
        const invoiceNumber = document.getElementById('returnInvoiceNumber').value;
        const productName = document.getElementById('returnProductName').value.trim();
        const quantity = parseInt(document.getElementById('returnQuantity').value);
        const price = parseFloat(document.getElementById('returnPrice').value);
        const employeeName = document.getElementById('returnEmployeeName').value.trim();
        const reason = document.getElementById('returnReason').value.trim();
        
        if (!productName) {
            alert('⚠️ يرجى إدخال اسم المنتج');
            return;
        }
        
        if (!price || price <= 0) {
            alert('⚠️ يرجى إدخال سعر صحيح');
            return;
        }
        
        if (!employeeName) {
            alert('⚠️ يرجى إدخال اسم الموظف');
            return;
        }
        
        const total = quantity * price;
        
        const returnData = {
            invoice_number: invoiceNumber || null,
            product_name: productName,
            quantity: quantity,
            price: price,
            total: total,
            reason: reason,
            employee_name: employeeName
        };
        
        const response = await fetch(`${API_URL}/api/returns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(returnData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('✅ ' + data.message);
            await logAction('return', `مرتجع: ${quantity}x ${productName} - ${total.toFixed(3)} د.ك ${reason ? '(' + reason + ')' : ''}`, data.id);
            closeReturnModal();
            loadReturns();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ حدث خطأ في حفظ المرتجع');
    }
}

// عرض تفاصيل مرتجع
// عرض تفاصيل المرتجع
async function viewReturnDetails(id) {
    try {
        const response = await fetch(`${API_URL}/api/returns/${id}`);
        const data = await response.json();
        
        if (data.success) {
            const r = data.return;
            const date = new Date(r.created_at).toLocaleString('ar-EG');
            
            const details = `
━━━━━━━━━━━━━━━━━━━━━━━
🔄 تفاصيل المرتجع #${r.id}
━━━━━━━━━━━━━━━━━━━━━━━

📋 رقم الفاتورة: ${r.invoice_number || '-'}
📦 المنتج: ${r.product_name}
🔢 الكمية: ${r.quantity}
💰 السعر: ${(r.price || 0).toFixed(3)} د.ك
💵 الإجمالي: ${(r.total || 0).toFixed(3)} د.ك

📝 السبب: ${r.reason || '-'}
👤 الموظف: ${r.employee_name || '-'}
📅 التاريخ: ${date}

━━━━━━━━━━━━━━━━━━━━━━━
            `.trim();
            
            alert(details);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل جلب التفاصيل');
    }
}

// طباعة المرتجع
async function printReturn(id) {
    try {
        const response = await fetch(`${API_URL}/api/returns/${id}`);
        const data = await response.json();
        
        if (data.success) {
            const r = data.return;
            const date = new Date(r.created_at).toLocaleString('ar-EG');
            
            const printContent = `
                <html dir="rtl">
                <head>
                    <title>مرتجع #${r.id}</title>
                    <style>
                        body { font-family: Arial; padding: 20px; }
                        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #000; padding-bottom: 20px; }
                        .header h1 { margin: 0; color: #dc3545; }
                        .info { margin: 20px 0; }
                        .info-row { display: flex; justify-content: space-between; margin: 10px 0; padding: 8px; background: #f5f5f5; }
                        .label { font-weight: bold; }
                        .product-box { border: 2px solid #000; padding: 15px; margin: 20px 0; }
                        .total { font-size: 24px; font-weight: bold; text-align: center; margin: 20px 0; color: #dc3545; }
                        .footer { margin-top: 40px; border-top: 2px solid #000; padding-top: 20px; text-align: center; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <h1>🔄 إيصال مرتجع</h1>
                        <p>رقم المرتجع: <strong>#${r.id}</strong></p>
                        <p>${date}</p>
                    </div>
                    
                    <div class="info">
                        <div class="info-row">
                            <span class="label">رقم الفاتورة:</span>
                            <span>${r.invoice_number || '-'}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">الموظف:</span>
                            <span>${r.employee_name || '-'}</span>
                        </div>
                    </div>
                    
                    <div class="product-box">
                        <h3>تفاصيل المرتجع:</h3>
                        <div class="info-row">
                            <span class="label">المنتج:</span>
                            <span>${escHTML(r.product_name)}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">الكمية:</span>
                            <span>${r.quantity}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">السعر:</span>
                            <span>${(r.price || 0).toFixed(3)} د.ك</span>
                        </div>
                        ${r.reason ? `
                        <div class="info-row">
                            <span class="label">سبب الإرجاع:</span>
                            <span>${escHTML(r.reason)}</span>
                        </div>
                        ` : ''}
                    </div>
                    
                    <div class="total">
                        المبلغ المسترجع: ${(r.total || 0).toFixed(3)} د.ك
                    </div>
                    
                    <div class="footer">
                        <p>تم إعادة المنتج للمخزون</p>
                        <p>شكراً لتعاملكم معنا</p>
                    </div>
                </body>
                </html>
            `;
            
            const printWindow = window.open('', '_blank');
            printWindow.document.write(printContent);
            printWindow.document.close();
            printWindow.print();
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الطباعة');
    }
}

// طباعة مرتجع حراري 57×40 ملم
async function printThermalReturn(id) {
    try {
        const response = await fetch(`${API_URL}/api/returns/${id}`);
        const data = await response.json();
        if (data.success) {
            const r = data.return;
            const date = new Date(r.created_at).toLocaleString('ar-EG');
            const storeName = document.getElementById('storeName')?.value || 'متجر';
            const printContent = `<!DOCTYPE html>
<html dir="rtl">
<head>
<meta charset="UTF-8">
<title>مرتجع #${r.id}</title>
<style>
@page { size: 57mm 40mm; margin: 1mm; }
@media print {
    .toolbar { display: none !important; }
    .preview-wrapper { box-shadow: none !important; border: none !important; margin: 0 !important; }
    body { background: white !important; padding: 0 !important; }
    .receipt { width: 55mm; font-size: 7px; padding: 1mm; }
    .receipt .r-header { font-size: 9px; }
    .receipt .r-sub { font-size: 7px; }
    .receipt .r-total { font-size: 9px; }
    .receipt .r-small { font-size: 6px; }
    .receipt .r-mid { font-size: 7px; }
}
@media screen {
    body { background: #f0f0f0; font-family: Arial, sans-serif; direction: rtl; margin: 0; padding: 20px; }
    .toolbar { background: #333; color: white; padding: 15px 25px; display: flex; justify-content: space-between; align-items: center; position: fixed; top: 0; left: 0; right: 0; z-index: 100; }
    .toolbar h3 { margin: 0; font-size: 16px; }
    .toolbar-btns { display: flex; gap: 10px; }
    .toolbar button { padding: 10px 25px; border: none; border-radius: 8px; font-size: 15px; cursor: pointer; font-weight: bold; }
    .btn-print { background: #28a745; color: white; }
    .btn-print:hover { background: #218838; }
    .btn-close { background: #dc3545; color: white; }
    .btn-close:hover { background: #c82333; }
    .preview-wrapper { max-width: 280px; margin: 80px auto 20px; background: white; border: 2px solid #ccc; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); padding: 15px; }
    .receipt { width: 100%; font-size: 14px; line-height: 1.5; }
    .receipt .r-header { font-size: 18px; font-weight: bold; }
    .receipt .r-sub { font-size: 14px; }
    .receipt .r-total { font-size: 17px; font-weight: bold; }
    .receipt .r-small { font-size: 12px; }
    .receipt .r-mid { font-size: 13px; }
}
.receipt .center { text-align: center; }
.receipt .bold { font-weight: bold; }
.receipt .sep { border-top: 1px dashed #000; margin: 6px 0; }
.receipt .row { display: flex; justify-content: space-between; }
</style>
</head>
<body>
<div class="toolbar">
    <h3>معاينة إيصال المرتجع (57×40 ملم)</h3>
    <div class="toolbar-btns">
        <button class="btn-print" onclick="window.print()">🖨️ طباعة</button>
        <button class="btn-close" onclick="window.close()">✖ إغلاق</button>
    </div>
</div>
<div class="preview-wrapper">
<div class="receipt">
<div class="center r-header">${escHTML(storeName)}</div>
<div class="center r-sub" style="color:#dc3545;">إيصال مرتجع</div>
<div class="sep"></div>
<div class="row r-mid"><span>رقم: #${r.id}</span><span>${date}</span></div>
${r.invoice_number ? `<div class="r-small">الفاتورة: ${escHTML(r.invoice_number)}</div>` : ''}
${r.employee_name ? `<div class="r-small">الموظف: ${escHTML(r.employee_name)}</div>` : ''}
<div class="sep"></div>
<div class="bold">${escHTML(r.product_name)}</div>
<div class="row r-mid"><span>الكمية: ${r.quantity}</span><span>السعر: ${(r.price || 0).toFixed(3)}</span></div>
${r.reason ? `<div class="r-small">السبب: ${escHTML(r.reason)}</div>` : ''}
<div class="sep"></div>
<div class="row r-total"><span>المسترجع:</span><span>${(r.total || 0).toFixed(3)} د.ك</span></div>
<div class="sep"></div>
<div class="center r-small">شكراً لتعاملكم معنا</div>
</div>
</div>
</body>
</html>`;
            const printWindow = window.open('', '_blank', 'width=820,height=600');
            printWindow.document.write(printContent);
            printWindow.document.close();
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الطباعة');
    }
}

// حذف المرتجع مع تأكيد
async function deleteReturnConfirm(id) {
    if (!confirm('⚠️ هل أنت متأكد من حذف هذا المرتجع؟\n\n⚠️ تحذير: سيتم خصم الكمية من المخزون!')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/returns/${id}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('✅ تم حذف المرتجع');
            loadReturns();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الحذف');
    }
}

console.log('[Returns System] Loaded ✅');


// ===============================================
// 📦 حالات الطلب (Order Status)
// ===============================================

async function updateOrderStatus(invoiceId, newStatus) {
    try {
        const response = await fetch(`${API_URL}/api/invoices/${invoiceId}/status`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ order_status: newStatus })
        });

        const data = await response.json();
        if (data.success) {
            // تحديث لون القائمة المنسدلة بدون إعادة تحميل
            if (event && event.target) {
                event.target.className = 'order-status-select ' +
                    (newStatus === 'قيد التنفيذ' ? 'status-processing' :
                     newStatus === 'قيد التوصيل' ? 'status-delivering' : 'status-completed');
            }
            logAction('status_change', `تغيير حالة فاتورة #${invoiceId} إلى: ${newStatus}`, invoiceId);
        } else {
            alert('❌ خطأ: ' + data.error);
            loadInvoicesTable();
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل التحديث');
        loadInvoicesTable();
    }
}

function filterInvoicesByStatus() {
    const status = document.getElementById('orderStatusFilter').value;
    if (!allInvoices) return;

    if (!status) {
        loadInvoicesTable();
        return;
    }

    const filtered = status === 'ملغية'
        ? allInvoices.filter(inv => inv.cancelled)
        : allInvoices.filter(inv => !inv.cancelled && (inv.order_status || 'قيد التنفيذ') === status);
    const container = document.getElementById('invoicesListContainer');

    if (filtered.length === 0) {
        container.innerHTML = '<p style="text-align:center; padding:40px;">لا توجد فواتير بهذه الحالة</p>';
        return;
    }

    container.innerHTML = `
        <table class="data-table">
            <thead><tr><th>رقم الفاتورة</th><th>العميل</th><th>الموظف</th><th>الإجمالي</th><th>حالة الطلب</th><th>التاريخ</th><th>عرض</th></tr></thead>
            <tbody>
                ${filtered.map(inv => {
                    const isOffline = inv.id && inv.id.toString().startsWith('offline_');
                    const isCancelled = inv.cancelled;
                    const st = inv.order_status || 'قيد التنفيذ';
                    return `
                    <tr style="${isCancelled ? 'opacity:0.5; background:#fff5f5;' : ''}">
                        <td>
                            <strong${isCancelled ? ' style="text-decoration:line-through;"' : ''}>${escHTML(inv.invoice_number)}</strong>
                            ${isCancelled ? ' <span style="background:#dc3545; color:white; padding:2px 6px; border-radius:4px; font-size:10px;">🚫 ملغية</span>' : ''}
                            ${isOffline ? ' <span style="background:#dc3545; color:white; padding:2px 6px; border-radius:4px; font-size:10px;">📴 معلقة</span>' : ''}
                        </td>
                        <td>${escHTML(inv.customer_name) || 'عميل'}</td>
                        <td>${escHTML(inv.employee_name)}</td>
                        <td style="color:${isCancelled ? '#dc3545' : '#28a745'}; font-weight:bold;${isCancelled ? ' text-decoration:line-through;' : ''}">${inv.total.toFixed(3)} د.ك</td>
                        <td>
                            ${isCancelled ? '<span style="color:#dc3545; font-weight:bold; font-size:12px;">🚫 ملغية</span>' : `
                            <select class="order-status-select status-${st === 'قيد التنفيذ' ? 'processing' : st === 'قيد التوصيل' ? 'delivering' : 'completed'}"
                                    onchange="updateOrderStatus(${inv.id}, this.value)" ${isOffline ? 'disabled' : ''}>
                                <option value="قيد التنفيذ" ${st === 'قيد التنفيذ' ? 'selected' : ''}>⏳ قيد التنفيذ</option>
                                <option value="قيد التوصيل" ${st === 'قيد التوصيل' ? 'selected' : ''}>🚚 قيد التوصيل</option>
                                <option value="منجز" ${st === 'منجز' ? 'selected' : ''}>✅ منجز</option>
                            </select>`}
                        </td>
                        <td>${formatKuwaitTime(inv.created_at)}</td>
                        <td><button onclick="viewLocalInvoice('${inv.id}')" class="btn-sm">👁️</button></td>
                    </tr>
                `;
                }).join('')}
            </tbody>
        </table>
    `;
}

console.log('[Order Status] Loaded ✅');

// ===============================================
// 🏭 نظام الموردين (Suppliers)
// ===============================================

let allSuppliers = [];
let currentSupplierId = null;

async function loadSuppliers() {
    if (!_realOnlineStatus) {
        const container = document.getElementById('suppliersContainer');
        if (container) container.innerHTML = '<div style="text-align:center; padding:40px; color:#92400e;"><div style="font-size:48px; margin-bottom:10px;">📴</div><p>غير متصل - لا يمكن تحميل الموردين</p></div>';
        return;
    }
    try {
        const response = await fetch(`${API_URL}/api/suppliers`);
        const data = await response.json();
        if (data.success) {
            allSuppliers = data.suppliers;
            displaySuppliersTable(allSuppliers);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

function displaySuppliersTable(suppliers) {
    const container = document.getElementById('suppliersContainer');
    if (!container) return;

    if (!suppliers || suppliers.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">لا يوجد موردين</div>';
        return;
    }

    const totalSuppliers = suppliers.length;
    const totalAmount = suppliers.reduce((sum, s) => sum + (s.total_amount || 0), 0);
    const totalInvoices = suppliers.reduce((sum, s) => sum + (s.invoice_count || 0), 0);

    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin-bottom: 25px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px;">
                <div style="opacity: 0.9; font-size: 13px;">إجمالي الموردين</div>
                <div style="font-size: 28px; font-weight: bold;">${totalSuppliers}</div>
            </div>
            <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 20px; border-radius: 12px;">
                <div style="opacity: 0.9; font-size: 13px;">إجمالي الفواتير</div>
                <div style="font-size: 28px; font-weight: bold;">${totalInvoices}</div>
            </div>
            <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 20px; border-radius: 12px;">
                <div style="opacity: 0.9; font-size: 13px;">إجمالي المبالغ</div>
                <div style="font-size: 28px; font-weight: bold;">${totalAmount.toFixed(3)} د.ك</div>
            </div>
        </div>
        <table class="data-table">
            <thead>
                <tr>
                    <th>المورد</th>
                    <th>الشركة</th>
                    <th>الهاتف</th>
                    <th>عدد الفواتير</th>
                    <th>إجمالي المبالغ</th>
                    <th>إجراءات</th>
                </tr>
            </thead>
            <tbody>
                ${suppliers.map(s => `
                    <tr>
                        <td><strong>${escHTML(s.name)}</strong></td>
                        <td>${escHTML(s.company) || '-'}</td>
                        <td>${escHTML(s.phone) || '-'}</td>
                        <td><span style="background: #667eea; color: white; padding: 3px 10px; border-radius: 12px; font-weight: bold;">${s.invoice_count || 0}</span></td>
                        <td style="color: #e53e3e; font-weight: bold;">${(s.total_amount || 0).toFixed(3)} د.ك</td>
                        <td>
                            <button onclick="viewSupplierInvoices(${s.id}, '${escHTML((s.name || '').replace(/'/g, "\\'"))}')" class="btn-sm" style="background: #667eea;">📄</button>
                            <button onclick="editSupplier(${s.id})" class="btn-sm">✏️</button>
                            <button onclick="deleteSupplier(${s.id})" class="btn-sm btn-danger">🗑️</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function showAddSupplier() {
    document.getElementById('supplierModalTitle').textContent = '➕ إضافة مورد';
    document.getElementById('supplierForm').reset();
    document.getElementById('supplierId').value = '';
    document.getElementById('addSupplierModal').classList.add('active');
}

function closeAddSupplier() {
    document.getElementById('addSupplierModal').classList.remove('active');
}

async function editSupplier(id) {
    const s = allSuppliers.find(s => s.id === id);
    if (!s) return;
    document.getElementById('supplierModalTitle').textContent = '✏️ تعديل مورد';
    document.getElementById('supplierId').value = s.id;
    document.getElementById('supplierName').value = s.name || '';
    document.getElementById('supplierCompany').value = s.company || '';
    document.getElementById('supplierPhone').value = s.phone || '';
    document.getElementById('supplierEmail').value = s.email || '';
    document.getElementById('supplierAddress').value = s.address || '';
    document.getElementById('supplierNotes').value = s.notes || '';
    document.getElementById('addSupplierModal').classList.add('active');
}

document.getElementById('supplierForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const supplierId = document.getElementById('supplierId').value;
    const supplierData = {
        name: document.getElementById('supplierName').value,
        company: document.getElementById('supplierCompany').value,
        phone: document.getElementById('supplierPhone').value,
        email: document.getElementById('supplierEmail').value,
        address: document.getElementById('supplierAddress').value,
        notes: document.getElementById('supplierNotes').value
    };
    try {
        const url = supplierId ? `${API_URL}/api/suppliers/${supplierId}` : `${API_URL}/api/suppliers`;
        const method = supplierId ? 'PUT' : 'POST';
        const response = await fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(supplierData) });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحفظ');
            closeAddSupplier();
            loadSuppliers();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الحفظ');
    }
});

async function deleteSupplier(id) {
    if (!confirm('هل أنت متأكد من حذف هذا المورد وجميع فواتيره؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/suppliers/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            loadSuppliers();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

// ===== فواتير الموردين =====

async function viewSupplierInvoices(supplierId, supplierName) {
    currentSupplierId = supplierId;
    document.getElementById('supplierInvoicesTitle').textContent = `📄 فواتير: ${supplierName}`;
    document.getElementById('supplierInvoiceSupplierId').value = supplierId;

    try {
        const response = await fetch(`${API_URL}/api/suppliers/${supplierId}/invoices`);
        const data = await response.json();
        const container = document.getElementById('supplierInvoicesList');

        if (data.success && data.invoices.length > 0) {
            container.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>رقم الفاتورة</th>
                            <th>المبلغ</th>
                            <th>التاريخ</th>
                            <th>الملف</th>
                            <th>ملاحظات</th>
                            <th>إجراءات</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.invoices.map(inv => `
                            <tr>
                                <td><strong>${inv.invoice_number || '-'}</strong></td>
                                <td style="color: #e53e3e; font-weight: bold;">${(inv.amount || 0).toFixed(3)} د.ك</td>
                                <td>${inv.invoice_date || new Date(inv.created_at).toLocaleDateString('ar')}</td>
                                <td>
                                    ${inv.file_name ? `<button onclick="viewSupplierFile(${inv.id})" class="btn-sm" style="background: #0ea5e9;">👁️ ${inv.file_type === 'application/pdf' ? 'PDF' : 'صورة'}</button>` : '<span style="color:#999;">لا يوجد</span>'}
                                </td>
                                <td>${inv.notes || '-'}</td>
                                <td><button onclick="deleteSupplierInvoice(${inv.id})" class="btn-sm btn-danger">🗑️</button></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        } else {
            container.innerHTML = '<div style="text-align: center; padding: 30px; color: #666;">لا توجد فواتير لهذا المورد</div>';
        }
    } catch (error) {
        console.error('Error:', error);
    }

    document.getElementById('supplierInvoicesModal').classList.add('active');
}

function closeSupplierInvoices() {
    document.getElementById('supplierInvoicesModal').classList.remove('active');
}

function showAddSupplierInvoice() {
    document.getElementById('supplierInvoiceForm').reset();
    document.getElementById('supplierInvoiceSupplierId').value = currentSupplierId;
    document.getElementById('supplierFileInfo').textContent = '';
    document.getElementById('addSupplierInvoiceModal').classList.add('active');
}

function closeAddSupplierInvoice() {
    document.getElementById('addSupplierInvoiceModal').classList.remove('active');
}

function validateSupplierFile(input) {
    const file = input.files[0];
    const info = document.getElementById('supplierFileInfo');
    if (!file) { info.textContent = ''; return; }

    const maxSize = 1 * 1024 * 1024; // 1 MB
    if (file.size > maxSize) {
        info.innerHTML = '<span style="color: #dc3545;">❌ حجم الملف يتجاوز 1 MB! الحد الأقصى 1 ميجابايت</span>';
        input.value = '';
        return;
    }

    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    info.innerHTML = `<span style="color: #28a745;">✅ ${escHTML(file.name)} (${sizeMB} MB)</span>`;
}

document.getElementById('supplierInvoiceForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const fileInput = document.getElementById('supplierInvoiceFile');
    const file = fileInput.files[0];

    // التحقق من الحجم
    if (file && file.size > 1 * 1024 * 1024) {
        alert('❌ حجم الملف يتجاوز 1 ميجابايت');
        return;
    }

    let fileData = '';
    let fileName = '';
    let fileType = '';

    if (file) {
        fileData = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
        });
        fileName = file.name;
        fileType = file.type;
    }

    const invoiceData = {
        supplier_id: document.getElementById('supplierInvoiceSupplierId').value,
        invoice_number: document.getElementById('supplierInvoiceNumber').value,
        amount: parseFloat(document.getElementById('supplierInvoiceAmount').value) || 0,
        invoice_date: document.getElementById('supplierInvoiceDate').value,
        notes: document.getElementById('supplierInvoiceNotes').value,
        file_data: fileData,
        file_name: fileName,
        file_type: fileType
    };

    try {
        const response = await fetch(`${API_URL}/api/suppliers/invoices`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(invoiceData)
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم حفظ الفاتورة');
            closeAddSupplierInvoice();
            viewSupplierInvoices(currentSupplierId, document.getElementById('supplierInvoicesTitle').textContent.replace('📄 فواتير: ', ''));
            loadSuppliers();
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الحفظ');
    }
});

async function viewSupplierFile(invoiceId) {
    try {
        const response = await fetch(`${API_URL}/api/suppliers/invoices/${invoiceId}/file`);
        const data = await response.json();
        if (data.success && data.file_data) {
            const viewer = document.getElementById('supplierFileViewer');
            if (data.file_type === 'application/pdf') {
                viewer.innerHTML = `<iframe src="${data.file_data}" style="width:100%; height:600px; border:none; border-radius:8px;"></iframe>`;
            } else {
                viewer.innerHTML = `<img src="${data.file_data}" style="max-width:100%; max-height:600px; border-radius:8px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">`;
            }
            document.getElementById('viewSupplierFileModal').classList.add('active');
        } else {
            alert('❌ الملف غير موجود');
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

async function deleteSupplierInvoice(invoiceId) {
    if (!confirm('هل أنت متأكد من حذف هذه الفاتورة؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/suppliers/invoices/${invoiceId}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            viewSupplierInvoices(currentSupplierId, document.getElementById('supplierInvoicesTitle').textContent.replace('📄 فواتير: ', ''));
            loadSuppliers();
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

console.log('[Suppliers System] Loaded ✅');

// ===============================================
// 🎟️ نظام الكوبونات (Coupons)
// ===============================================

let allCoupons = [];
let appliedCouponDiscount = 0;
let appliedCouponId = null;

async function loadCoupons() {
    if (!_realOnlineStatus) {
        const container = document.getElementById('couponsContainer');
        if (container) container.innerHTML = '<div style="text-align:center; padding:40px; color:#92400e;"><div style="font-size:48px; margin-bottom:10px;">📴</div><p>غير متصل - لا يمكن تحميل الكوبونات</p></div>';
        return;
    }
    try {
        const response = await fetch(`${API_URL}/api/coupons`);
        const data = await response.json();

        if (data.success) {
            allCoupons = data.coupons;
            displayCouponsStats(allCoupons);
            displayCouponsTable(allCoupons);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

function displayCouponsStats(coupons) {
    const container = document.getElementById('couponsStatsContainer');
    if (!container) return;
    const active = coupons.filter(c => c.is_active);
    const expired = coupons.filter(c => c.expiry_date && new Date(c.expiry_date) < new Date());
    const totalUsed = coupons.reduce((s, c) => s + (c.used_count || 0), 0);
    container.innerHTML = `
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${coupons.length}</div>
            <div style="font-size: 13px; opacity: 0.9;">إجمالي الكوبونات</div>
        </div>
        <div style="background: linear-gradient(135deg, #38a169 0%, #2f855a 100%); color: white; padding: 20px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${active.length}</div>
            <div style="font-size: 13px; opacity: 0.9;">كوبونات فعالة</div>
        </div>
        <div style="background: linear-gradient(135deg, #eab308 0%, #ca8a04 100%); color: white; padding: 20px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${totalUsed}</div>
            <div style="font-size: 13px; opacity: 0.9;">مرات الاستخدام</div>
        </div>
        <div style="background: linear-gradient(135deg, #e53e3e 0%, #c53030 100%); color: white; padding: 20px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${expired.length}</div>
            <div style="font-size: 13px; opacity: 0.9;">منتهية الصلاحية</div>
        </div>
    `;
}

function displayCouponsTable(coupons) {
    const container = document.getElementById('couponsContainer');
    if (!container) return;

    if (coupons.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:40px; color:#6c757d;"><div style="font-size:48px; margin-bottom:10px;">🎟️</div><p>لا توجد كوبونات بعد</p></div>';
        return;
    }

    let html = '<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; background:white; border-radius:12px; overflow:hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">';
    html += `<thead><tr style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
        <th style="padding:12px; text-align:right;">الكود</th>
        <th style="padding:12px; text-align:center;">نوع الخصم</th>
        <th style="padding:12px; text-align:center;">القيمة</th>
        <th style="padding:12px; text-align:center;">الحد الأدنى</th>
        <th style="padding:12px; text-align:center;">الاستخدام</th>
        <th style="padding:12px; text-align:center;">الانتهاء</th>
        <th style="padding:12px; text-align:center;">الحالة</th>
        <th style="padding:12px; text-align:center;">إجراءات</th>
    </tr></thead><tbody>`;

    coupons.forEach(c => {
        const isExpired = c.expiry_date && new Date(c.expiry_date) < new Date();
        const isMaxed = c.max_uses > 0 && c.used_count >= c.max_uses;
        let statusBadge = '';
        if (!c.is_active) {
            statusBadge = '<span style="background:#dc3545; color:white; padding:4px 10px; border-radius:20px; font-size:12px;">معطل</span>';
        } else if (isExpired) {
            statusBadge = '<span style="background:#6c757d; color:white; padding:4px 10px; border-radius:20px; font-size:12px;">منتهي</span>';
        } else if (isMaxed) {
            statusBadge = '<span style="background:#fd7e14; color:white; padding:4px 10px; border-radius:20px; font-size:12px;">مستنفد</span>';
        } else {
            statusBadge = '<span style="background:#38a169; color:white; padding:4px 10px; border-radius:20px; font-size:12px;">فعال</span>';
        }

        html += `<tr style="border-bottom:1px solid #e2e8f0;">
            <td style="padding:12px; font-weight:bold; color:#667eea; font-family:monospace; font-size:16px;">${escHTML(c.code)}</td>
            <td style="padding:12px; text-align:center;">${c.discount_type === 'percent' ? '📊 نسبة' : '💵 مبلغ'}</td>
            <td style="padding:12px; text-align:center; font-weight:bold;">${c.discount_type === 'percent' ? c.discount_value + '%' : c.discount_value.toFixed(3) + ' د.ك'}</td>
            <td style="padding:12px; text-align:center;">${c.min_amount > 0 ? c.min_amount.toFixed(3) + ' د.ك' : '-'}</td>
            <td style="padding:12px; text-align:center;">${c.used_count}${c.max_uses > 0 ? ' / ' + c.max_uses : ' / ∞'}</td>
            <td style="padding:12px; text-align:center;">${c.expiry_date || 'بدون حد'}</td>
            <td style="padding:12px; text-align:center;">${statusBadge}</td>
            <td style="padding:12px; text-align:center;">
                <button onclick="editCoupon(${c.id})" class="btn-sm" style="margin:2px;">✏️</button>
                <button onclick="toggleCoupon(${c.id}, ${c.is_active ? 0 : 1})" class="btn-sm" style="margin:2px; background:${c.is_active ? '#dc3545' : '#38a169'}; color:white;">${c.is_active ? '⏸️' : '▶️'}</button>
                <button onclick="deleteCoupon(${c.id})" class="btn-sm btn-danger" style="margin:2px;">🗑️</button>
            </td>
        </tr>`;
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;
}

function showAddCoupon() {
    document.getElementById('couponModalTitle').textContent = '➕ إضافة كوبون';
    document.getElementById('couponId').value = '';
    document.getElementById('couponCode').value = '';
    document.getElementById('couponDiscountType').value = 'percent';
    document.getElementById('couponDiscountValue').value = '';
    document.getElementById('couponMinAmount').value = '0';
    document.getElementById('couponMaxUses').value = '0';
    document.getElementById('couponExpiryDate').value = '';
    document.getElementById('addCouponModal').classList.add('active');
}

function closeAddCoupon() {
    document.getElementById('addCouponModal').classList.remove('active');
}

async function editCoupon(id) {
    const coupon = allCoupons.find(c => c.id === id);
    if (!coupon) return;
    document.getElementById('couponModalTitle').textContent = '✏️ تعديل كوبون';
    document.getElementById('couponId').value = coupon.id;
    document.getElementById('couponCode').value = coupon.code;
    document.getElementById('couponDiscountType').value = coupon.discount_type;
    document.getElementById('couponDiscountValue').value = coupon.discount_value;
    document.getElementById('couponMinAmount').value = coupon.min_amount || 0;
    document.getElementById('couponMaxUses').value = coupon.max_uses || 0;
    document.getElementById('couponExpiryDate').value = coupon.expiry_date || '';
    document.getElementById('addCouponModal').classList.add('active');
}

document.getElementById('couponForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    const id = document.getElementById('couponId').value;
    const couponData = {
        code: document.getElementById('couponCode').value.toUpperCase(),
        discount_type: document.getElementById('couponDiscountType').value,
        discount_value: parseFloat(document.getElementById('couponDiscountValue').value) || 0,
        min_amount: parseFloat(document.getElementById('couponMinAmount').value) || 0,
        max_uses: parseInt(document.getElementById('couponMaxUses').value) || 0,
        expiry_date: document.getElementById('couponExpiryDate').value || null
    };

    try {
        const url = id ? `${API_URL}/api/coupons/${id}` : `${API_URL}/api/coupons`;
        const method = id ? 'PUT' : 'POST';
        const response = await fetch(url, {
            method: method,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(couponData)
        });
        const data = await response.json();
        if (data.success) {
            alert(id ? '✅ تم تعديل الكوبون' : '✅ تم إنشاء الكوبون');
            closeAddCoupon();
            loadCoupons();
        } else {
            alert('❌ ' + data.error);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('❌ فشل الحفظ');
    }
});

async function toggleCoupon(id, newState) {
    try {
        const response = await fetch(`${API_URL}/api/coupons/${id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ is_active: newState })
        });
        const data = await response.json();
        if (data.success) {
            loadCoupons();
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

async function deleteCoupon(id) {
    if (!confirm('هل أنت متأكد من حذف هذا الكوبون؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/coupons/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم الحذف');
            loadCoupons();
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

// تطبيق الكوبون في نقطة البيع
async function applyCouponCode() {
    const codeInput = document.getElementById('couponCodeInput');
    const resultDiv = document.getElementById('couponResult');
    const code = codeInput?.value?.trim().toUpperCase();

    if (!code) {
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#fee2e2';
        resultDiv.style.color = '#991b1b';
        resultDiv.innerHTML = '⚠️ الرجاء إدخال كود الكوبون';
        return;
    }

    if (!_realOnlineStatus) {
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#fef3c7';
        resultDiv.style.color = '#92400e';
        resultDiv.innerHTML = '📴 لا يمكن التحقق من الكوبون بدون إنترنت';
        return;
    }

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    try {
        const response = await fetch(`${API_URL}/api/coupons/validate`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ code: code, subtotal: subtotal })
        });
        const data = await response.json();

        if (data.success) {
            appliedCouponDiscount = data.discount;
            appliedCouponId = data.coupon.id;

            resultDiv.style.display = 'block';
            resultDiv.style.background = '#dcfce7';
            resultDiv.style.color = '#166534';
            resultDiv.innerHTML = `✅ تم تطبيق الكوبون! الخصم: ${data.discount.toFixed(3)} د.ك`;

            document.getElementById('couponDiscountDisplay').textContent = data.discount.toFixed(3) + ' د.ك';
            document.getElementById('couponDiscountRow').style.display = 'flex';
            updateTotals();
        } else {
            appliedCouponDiscount = 0;
            appliedCouponId = null;
            document.getElementById('couponDiscountRow').style.display = 'none';

            resultDiv.style.display = 'block';
            resultDiv.style.background = '#fee2e2';
            resultDiv.style.color = '#991b1b';
            resultDiv.innerHTML = '❌ ' + data.error;
            updateTotals();
        }
    } catch (error) {
        console.error('Error:', error);
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#fee2e2';
        resultDiv.style.color = '#991b1b';
        resultDiv.innerHTML = '❌ فشل التحقق من الكوبون';
    }
}

console.log('[Coupons System] Loaded ✅');

// ===============================================
// ➕ العمليات الإضافية (Additional Operations)
// ===============================================

let operationTemplates = [];
let additionalOperations = [];

async function loadOperationTemplates() {
    try {
        const response = await fetch(`${API_URL}/api/operation-templates`);
        const data = await response.json();
        
        if (data.success) {
            operationTemplates = data.templates;
            displayOperationTemplates();
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

function displayOperationTemplates() {
    // TODO: عرض قوالب العمليات
    console.log('Templates:', operationTemplates);
}

function addAdditionalOperation(name, amount, taxable = false) {
    additionalOperations.push({
        id: Date.now(),
        name: name,
        amount: amount,
        taxable: taxable
    });
    
    displayAdditionalOperations();
    updateTotals();
}

function removeAdditionalOperation(id) {
    additionalOperations = additionalOperations.filter(op => op.id !== id);
    displayAdditionalOperations();
    updateTotals();
}

function displayAdditionalOperations() {
    const container = document.getElementById('additionalOperationsContainer');
    if (!container) return;
    
    if (additionalOperations.length === 0) {
        container.innerHTML = '<div style="color: #999; font-size: 12px;">لا توجد عمليات إضافية</div>';
        return;
    }
    
    let html = '';
    additionalOperations.forEach(op => {
        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px; background: #f8f9fa; border-radius: 4px; margin-bottom: 5px;">
                <span style="font-size: 12px;">${escHTML(op.name)}</span>
                <div>
                    <span style="font-weight: bold; margin-right: 10px;">${op.amount.toFixed(3)} د.ك</span>
                    <button onclick="removeAdditionalOperation(${op.id})" style="background: #ef4444; color: white; border: none; padding: 2px 6px; border-radius: 3px; cursor: pointer;">✖</button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function calculateAdditionalOperationsTotal() {
    return additionalOperations.reduce((sum, op) => sum + op.amount, 0);
}

console.log('[Additional Operations] Loaded ✅');

// مزامنة العملاء المحفوظين محلياً عند العودة أونلاين
async function syncOfflineCustomers() {
    try {
        const pending = await localDB.getAll('pending_customers');
        if (!pending || pending.length === 0) return;
        console.log(`[Sync] Uploading ${pending.length} offline customers...`);
        for (const customer of pending) {
            try {
                const { id, _offline, ...data } = customer;
                const response = await fetch(`${API_URL}/api/customers`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                if (result.success) {
                    await localDB.delete('pending_customers', customer.id);
                    console.log(`[Sync] Customer synced: ${data.name}`);
                }
            } catch (e) {
                console.error('[Sync] Failed to sync customer:', e);
            }
        }
        // إعادة تحميل قائمة العملاء بعد المزامنة
        await loadCustomersDropdown();
        if (typeof loadCustomers === 'function') loadCustomers();
    } catch (e) {
        console.error('[Sync] Customer sync error:', e);
    }
}

// تحميل العملاء في dropdown عند بدء التشغيل
setTimeout(() => {
    if (document.getElementById('customerSearchInput')) {
        loadCustomersDropdown();
        // مزامنة العملاء المعلقين إذا أونلاين
        if (_realOnlineStatus) setTimeout(syncOfflineCustomers, 2000);
        console.log('[Customers Search] Loaded ✅');
    }
}, 1000);

// ===== نظام طاولات المطعم =====

let allTables = [];
let editingTableId = null;
let dragState = null;

// تحميل الطاولات في dropdown نقطة البيع
async function loadTablesDropdown() {
    const select = document.getElementById('selectedTableId');
    const section = document.getElementById('tableSelectionSection');
    if (!select || !section) return;

    try {
        if (!_realOnlineStatus) {
            // في وضع أوفلاين: إخفاء اختيار الطاولة
            section.style.display = 'none';
            return;
        }
        const response = await fetch(`${API_URL}/api/tables`);
        const data = await response.json();
        if (data.success && data.tables && data.tables.length > 0) {
            allTables = data.tables;
            select.innerHTML = '<option value="">-- بدون طاولة --</option>';
            data.tables.forEach(t => {
                const statusText = t.status === 'occupied' ? ' (مشغولة)' : t.status === 'reserved' ? ' (محجوزة)' : '';
                const isDisabled = t.status === 'occupied' || t.status === 'reserved';
                select.innerHTML += `<option value="${t.id}" ${isDisabled ? 'disabled' : ''}>${escHTML(t.name)}${statusText}</option>`;
            });
            section.style.display = 'block';
        } else {
            section.style.display = 'none';
        }
    } catch (e) {
        console.log('[Tables] Could not load tables dropdown:', e);
        section.style.display = 'none';
    }
}

// تحميل الطاولات لتبويب الطاولات
async function loadTables() {
    if (!_realOnlineStatus) {
        alert('لا يوجد اتصال بالإنترنت', 'warning');
        return;
    }
    try {
        const response = await fetch(`${API_URL}/api/tables`);
        const data = await response.json();
        if (data.success) {
            allTables = data.tables || [];
            displayTablesStats();
            displayTablesFloorPlan();
        }
    } catch (e) {
        console.error('[Tables] Failed to load:', e);
        alert('فشل تحميل الطاولات', 'error');
    }
}

// عرض إحصائيات الطاولات
function displayTablesStats() {
    const container = document.getElementById('tablesStatsContainer');
    if (!container) return;

    const total = allTables.length;
    const available = allTables.filter(t => t.status === 'available').length;
    const occupied = allTables.filter(t => t.status === 'occupied').length;
    const reserved = allTables.filter(t => t.status === 'reserved').length;
    const totalSeats = allTables.reduce((sum, t) => sum + (t.seats || 0), 0);

    container.innerHTML = `
        <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${total}</div>
            <div style="font-size: 13px; opacity: 0.9;">إجمالي الطاولات</div>
        </div>
        <div style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${available}</div>
            <div style="font-size: 13px; opacity: 0.9;">متاحة</div>
        </div>
        <div style="background: linear-gradient(135deg, #ef4444, #dc2626); color: white; padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${occupied}</div>
            <div style="font-size: 13px; opacity: 0.9;">مشغولة</div>
        </div>
        <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${reserved}</div>
            <div style="font-size: 13px; opacity: 0.9;">محجوزة</div>
        </div>
        <div style="background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold;">${totalSeats}</div>
            <div style="font-size: 13px; opacity: 0.9;">إجمالي المقاعد</div>
        </div>
    `;
}

// عرض مخطط الطاولات مع السحب والإفلات
function displayTablesFloorPlan() {
    const container = document.getElementById('tablesFloorPlan');
    if (!container) return;

    if (allTables.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 300px; color: #94a3b8; font-size: 18px;">لا توجد طاولات - اضغط ➕ إضافة طاولة للبدء</div>';
        return;
    }

    container.innerHTML = '';

    allTables.forEach(table => {
        const isOccupied = table.status === 'occupied';
        const isReserved = table.status === 'reserved';
        const tableEl = document.createElement('div');
        tableEl.className = 'table-card';
        tableEl.dataset.id = table.id;

        let bgColor, borderColor;
        if (isOccupied) { bgColor = 'linear-gradient(135deg, #fecaca, #fca5a5)'; borderColor = '#ef4444'; }
        else if (isReserved) { bgColor = 'linear-gradient(135deg, #fef3c7, #fde68a)'; borderColor = '#f59e0b'; }
        else { bgColor = 'linear-gradient(135deg, #d1fae5, #a7f3d0)'; borderColor = '#10b981'; }

        tableEl.style.cssText = `
            position: absolute;
            left: ${table.pos_x || 50}px;
            top: ${table.pos_y || 50}px;
            width: 130px;
            min-height: 120px;
            background: ${bgColor};
            border: 3px solid ${borderColor};
            border-radius: 16px;
            padding: 12px;
            cursor: grab;
            user-select: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            z-index: 10;
            transition: box-shadow 0.2s;
        `;

        let statusIcon, statusText, statusColor;
        if (isOccupied) { statusIcon = '🔴'; statusText = '🍽️ مشغولة'; statusColor = '#dc2626'; }
        else if (isReserved) { statusIcon = '🟡'; statusText = '🔒 محجوزة'; statusColor = '#d97706'; }
        else { statusIcon = '🟢'; statusText = '✅ متاحة'; statusColor = '#059669'; }

        let actionButtons = '';
        if (isOccupied) {
            actionButtons = `
                <button onclick="event.stopPropagation(); viewTableInvoice(${table.id})" style="background: #3b82f6; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;">📄 الفاتورة</button>
                <button onclick="event.stopPropagation(); releaseTableAction(${table.id})" style="background: #10b981; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;">🔓 تحرير</button>`;
        } else if (isReserved) {
            actionButtons = `
                <button onclick="event.stopPropagation(); unreserveTableAction(${table.id})" style="background: #10b981; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;">🔓 إلغاء الحجز</button>`;
        } else {
            actionButtons = `
                <button onclick="event.stopPropagation(); showAssignInvoice(${table.id})" style="background: #8b5cf6; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;">📎 ربط</button>
                <button onclick="event.stopPropagation(); reserveTableAction(${table.id})" style="background: #f59e0b; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;">🔒 حجز</button>`;
        }

        tableEl.innerHTML = `
            <div style="font-size: 24px; margin-bottom: 6px;">${statusIcon}</div>
            <div style="font-weight: bold; font-size: 14px; color: #1e293b;">${escHTML(table.name)}</div>
            <div style="font-size: 11px; color: #64748b; margin-top: 2px;">🪑 ${table.seats} مقاعد</div>
            <div style="font-size: 11px; color: ${statusColor}; margin-top: 4px; font-weight: bold;">
                ${statusText}
            </div>
            ${isOccupied && table.invoice_number ? `
                <div style="background: rgba(255,255,255,0.8); border: 1px solid #e5e7eb; border-radius: 8px; padding: 5px 8px; margin-top: 6px; font-size: 10px; width: 100%;">
                    <div style="color: #3b82f6; font-weight: bold;">📄 ${escHTML(table.invoice_number)}</div>
                    ${table.invoice_customer ? `<div style="color: #64748b;">👤 ${escHTML(table.invoice_customer)}</div>` : ''}
                    ${table.invoice_total ? `<div style="color: #059669; font-weight: bold;">${parseFloat(table.invoice_total).toFixed(3)} د.ك</div>` : ''}
                </div>
            ` : ''}
            <div style="display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; justify-content: center;">
                ${actionButtons}
                <button onclick="event.stopPropagation(); editTable(${table.id})" style="background: #f59e0b; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;">✏️</button>
                <button onclick="event.stopPropagation(); deleteTable(${table.id})" style="background: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;">🗑️</button>
            </div>
        `;

        // سحب وإفلات - Mouse Events
        tableEl.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            dragState = {
                tableId: table.id,
                el: tableEl,
                offsetX: e.clientX - tableEl.offsetLeft,
                offsetY: e.clientY - tableEl.offsetTop,
                containerRect: rect
            };
            tableEl.style.cursor = 'grabbing';
            tableEl.style.zIndex = '100';
            tableEl.style.boxShadow = '0 8px 24px rgba(0,0,0,0.2)';
        });

        // سحب وإفلات - Touch Events
        tableEl.addEventListener('touchstart', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            const touch = e.touches[0];
            const rect = container.getBoundingClientRect();
            dragState = {
                tableId: table.id,
                el: tableEl,
                offsetX: touch.clientX - tableEl.offsetLeft,
                offsetY: touch.clientY - tableEl.offsetTop,
                containerRect: rect
            };
            tableEl.style.cursor = 'grabbing';
            tableEl.style.zIndex = '100';
            tableEl.style.boxShadow = '0 8px 24px rgba(0,0,0,0.2)';
        }, { passive: true });

        container.appendChild(tableEl);
    });
}

// أحداث السحب على مستوى المستند
document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    e.preventDefault();
    const newX = e.clientX - dragState.offsetX;
    const newY = e.clientY - dragState.offsetY;
    // ضمان البقاء داخل الحاوية
    const maxX = dragState.containerRect.width - 140;
    const maxY = dragState.containerRect.height - 130;
    dragState.el.style.left = Math.max(0, Math.min(newX, maxX)) + 'px';
    dragState.el.style.top = Math.max(0, Math.min(newY, maxY)) + 'px';
});

document.addEventListener('mouseup', async () => {
    if (!dragState) return;
    const tableId = dragState.tableId;
    const newX = parseInt(dragState.el.style.left);
    const newY = parseInt(dragState.el.style.top);
    dragState.el.style.cursor = 'grab';
    dragState.el.style.zIndex = '10';
    dragState.el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
    dragState = null;

    // حفظ الموضع الجديد
    try {
        await fetch(`${API_URL}/api/tables/${tableId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ pos_x: newX, pos_y: newY })
        });
        // تحديث البيانات المحلية
        const t = allTables.find(tb => tb.id === tableId);
        if (t) { t.pos_x = newX; t.pos_y = newY; }
    } catch (e) {
        console.log('[Tables] Failed to save position:', e);
    }
});

document.addEventListener('touchmove', (e) => {
    if (!dragState) return;
    const touch = e.touches[0];
    const newX = touch.clientX - dragState.offsetX;
    const newY = touch.clientY - dragState.offsetY;
    const maxX = dragState.containerRect.width - 140;
    const maxY = dragState.containerRect.height - 130;
    dragState.el.style.left = Math.max(0, Math.min(newX, maxX)) + 'px';
    dragState.el.style.top = Math.max(0, Math.min(newY, maxY)) + 'px';
}, { passive: true });

document.addEventListener('touchend', async () => {
    if (!dragState) return;
    const tableId = dragState.tableId;
    const newX = parseInt(dragState.el.style.left);
    const newY = parseInt(dragState.el.style.top);
    dragState.el.style.cursor = 'grab';
    dragState.el.style.zIndex = '10';
    dragState.el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
    dragState = null;

    try {
        await fetch(`${API_URL}/api/tables/${tableId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ pos_x: newX, pos_y: newY })
        });
        const t = allTables.find(tb => tb.id === tableId);
        if (t) { t.pos_x = newX; t.pos_y = newY; }
    } catch (e) {
        console.log('[Tables] Failed to save position:', e);
    }
});

// إضافة طاولة
function showAddTable() {
    editingTableId = null;
    document.getElementById('tableId').value = '';
    document.getElementById('tableName').value = '';
    document.getElementById('tableSeats').value = '4';
    document.getElementById('tableModalTitle').textContent = '➕ إضافة طاولة';
    document.getElementById('addTableModal').classList.add('active');
}

function closeAddTable() {
    document.getElementById('addTableModal').classList.remove('active');
}

// تعديل طاولة
function editTable(id) {
    const table = allTables.find(t => t.id === id);
    if (!table) return;
    editingTableId = id;
    document.getElementById('tableId').value = id;
    document.getElementById('tableName').value = table.name;
    document.getElementById('tableSeats').value = table.seats || 4;
    document.getElementById('tableModalTitle').textContent = '✏️ تعديل طاولة';
    document.getElementById('addTableModal').classList.add('active');
}

// معالج نموذج الطاولة
document.getElementById('tableForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();

    const name = document.getElementById('tableName').value.trim();
    const seats = parseInt(document.getElementById('tableSeats').value) || 4;

    if (!name) {
        alert('يرجى إدخال اسم الطاولة', 'error');
        return;
    }

    try {
        if (editingTableId) {
            // تحديث طاولة
            const response = await fetch(`${API_URL}/api/tables/${editingTableId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name, seats })
            });
            const data = await response.json();
            if (data.success) {
                alert('تم تحديث الطاولة بنجاح', 'success');
            } else {
                alert('فشل تحديث الطاولة', 'error');
                return;
            }
        } else {
            // إضافة طاولة جديدة
            const response = await fetch(`${API_URL}/api/tables`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name, seats })
            });
            const data = await response.json();
            if (data.success) {
                alert('تمت إضافة الطاولة بنجاح', 'success');
            } else {
                alert('فشل إضافة الطاولة', 'error');
                return;
            }
        }

        closeAddTable();
        loadTables();
        loadTablesDropdown();
    } catch (e) {
        console.error('[Tables] Save error:', e);
        alert('خطأ في حفظ الطاولة', 'error');
    }
});

// حذف طاولة
async function deleteTable(id) {
    if (!confirm('هل أنت متأكد من حذف هذه الطاولة؟')) return;

    try {
        const response = await fetch(`${API_URL}/api/tables/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            alert('تم حذف الطاولة', 'success');
            loadTables();
            loadTablesDropdown();
        } else {
            alert('فشل حذف الطاولة', 'error');
        }
    } catch (e) {
        console.error('[Tables] Delete error:', e);
        alert('خطأ في حذف الطاولة', 'error');
    }
}

// عرض فاتورة الطاولة
async function viewTableInvoice(tableId) {
    const table = allTables.find(t => t.id === tableId);
    if (!table || !table.current_invoice_id) {
        alert('لا توجد فاتورة مرتبطة بهذه الطاولة', 'warning');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/invoices/${table.current_invoice_id}`);
        const data = await response.json();
        if (data.success && data.invoice) {
            const inv = data.invoice;
            const content = document.getElementById('tableInvoiceContent');
            const paymentMethods = {'cash':'💵 نقداً','knet':'💳 كي نت','visa':'💳 فيزا','other':'💰 أخرى'};

            // تحليل عمليات الدفع المتعددة
            if (!inv.payments && inv.transaction_number) {
                try {
                    const parsed = JSON.parse(inv.transaction_number);
                    if (Array.isArray(parsed)) inv.payments = parsed;
                } catch(e) {}
            }

            content.innerHTML = `
                <div style="padding: 15px;">
                    <div style="background: #f0fdf4; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #86efac;">
                        <strong>🍽️ ${escHTML(table.name)}</strong> | <strong>📄 فاتورة: ${escHTML(inv.invoice_number)}</strong>
                    </div>
                    <div style="font-size: 13px; margin-bottom: 10px;">
                        <div><strong>العميل:</strong> ${escHTML(inv.customer_name) || '-'}</div>
                        <div><strong>التاريخ:</strong> ${new Date(inv.created_at).toLocaleDateString('ar')}</div>
                        <div><strong>الدفع:</strong> ${inv.payments && inv.payments.length > 0 ? inv.payments.map(p => `${paymentMethods[p.method] || p.method} (${parseFloat(p.amount).toFixed(3)})`).join(' + ') : paymentMethods[inv.payment_method]}</div>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead><tr style="background: #667eea; color: white;">
                            <th style="padding: 6px; text-align: right;">المنتج</th>
                            <th style="padding: 6px; text-align: center;">الكمية</th>
                            <th style="padding: 6px; text-align: right;">السعر</th>
                            <th style="padding: 6px; text-align: right;">الإجمالي</th>
                        </tr></thead>
                        <tbody>
                            ${(inv.items || []).map(item => `
                                <tr style="border-bottom: 1px solid #e5e7eb;">
                                    <td style="padding: 5px;">${escHTML(item.product_name)}</td>
                                    <td style="padding: 5px; text-align: center;">${item.quantity}</td>
                                    <td style="padding: 5px;">${parseFloat(item.price).toFixed(3)}</td>
                                    <td style="padding: 5px;">${parseFloat(item.total).toFixed(3)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    <div style="margin-top: 12px; padding-top: 10px; border-top: 2px solid #667eea; font-size: 16px; font-weight: bold; color: #667eea; display: flex; justify-content: space-between;">
                        <span>الإجمالي:</span>
                        <span>${parseFloat(inv.total).toFixed(3)} د.ك</span>
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 15px;">
                        <button onclick="releaseTableAction(${tableId}); document.getElementById('tableInvoiceModal').classList.remove('active');" style="flex: 1; background: #10b981; color: white; border: none; padding: 10px; border-radius: 8px; cursor: pointer; font-size: 14px;">🔓 تحرير الطاولة</button>
                    </div>
                </div>
            `;

            document.getElementById('tableInvoiceTitle').textContent = `🍽️ فاتورة ${table.name}`;
            document.getElementById('tableInvoiceModal').classList.add('active');
        } else {
            alert('فشل تحميل الفاتورة', 'error');
        }
    } catch (e) {
        console.error('[Tables] View invoice error:', e);
        alert('خطأ في تحميل فاتورة الطاولة', 'error');
    }
}

// تحرير طاولة (إزالة الفاتورة)
async function releaseTableAction(tableId) {
    if (!confirm('هل تريد تحرير هذه الطاولة؟')) return;

    try {
        const response = await fetch(`${API_URL}/api/tables/${tableId}/release`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('تم تحرير الطاولة', 'success');
            loadTables();
            loadTablesDropdown();
        } else {
            alert('فشل تحرير الطاولة', 'error');
        }
    } catch (e) {
        console.error('[Tables] Release error:', e);
        alert('خطأ في تحرير الطاولة', 'error');
    }
}

// حجز طاولة
async function reserveTableAction(tableId) {
    if (!confirm('هل تريد حجز هذه الطاولة؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/tables/${tableId}/reserve`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('تم حجز الطاولة', 'success');
            loadTables();
            loadTablesDropdown();
        } else {
            alert(data.error || 'فشل حجز الطاولة', 'error');
        }
    } catch (e) {
        console.error('[Tables] Reserve error:', e);
        alert('خطأ في حجز الطاولة', 'error');
    }
}

// إلغاء حجز طاولة
async function unreserveTableAction(tableId) {
    if (!confirm('هل تريد إلغاء حجز هذه الطاولة؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/tables/${tableId}/release`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            alert('تم إلغاء حجز الطاولة', 'success');
            loadTables();
            loadTablesDropdown();
        } else {
            alert('فشل إلغاء حجز الطاولة', 'error');
        }
    } catch (e) {
        console.error('[Tables] Unreserve error:', e);
        alert('خطأ في إلغاء حجز الطاولة', 'error');
    }
}

// ربط فاتورة بطاولة من تبويب الطاولات
async function showAssignInvoice(tableId) {
    const table = allTables.find(t => t.id === tableId);
    if (!table) return;

    // عرض نافذة لإدخال رقم الفاتورة
    const invoiceNum = prompt('أدخل رقم الفاتورة لربطها بـ ' + table.name + ':');
    if (!invoiceNum || !invoiceNum.trim()) return;

    try {
        // البحث عن الفاتورة بالرقم
        const response = await fetch(`${API_URL}/api/invoices`);
        const data = await response.json();
        if (data.success && data.invoices) {
            const invoice = data.invoices.find(inv => inv.invoice_number === invoiceNum.trim());
            if (invoice) {
                const assignResponse = await fetch(`${API_URL}/api/tables/${tableId}/assign`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ invoice_id: invoice.id })
                });
                const assignData = await assignResponse.json();
                if (assignData.success) {
                    alert(`تم ربط الفاتورة ${invoiceNum} بـ ${table.name}`, 'success');
                    loadTables();
                    loadTablesDropdown();
                } else {
                    alert('فشل ربط الفاتورة', 'error');
                }
            } else {
                alert('لم يتم العثور على الفاتورة', 'error');
            }
        }
    } catch (e) {
        console.error('[Tables] Assign error:', e);
        alert('خطأ في ربط الفاتورة', 'error');
    }
}

console.log('[Tables] Restaurant Tables System Loaded ✅');

// ===== نظام المدير الأعلى (Super Admin) =====


function logoutSuperAdmin() {
    currentSuperAdmin = null;
    localStorage.removeItem('pos_super_admin');
    localStorage.removeItem('pos_auth_token');
    document.getElementById('superAdminDashboard').style.display = 'none';
    document.getElementById('loginOverlay').classList.remove('hidden');
}

function showSuperAdminSettings() {
    if (!currentSuperAdmin) return;
    document.getElementById('saSettingsFullName').value = currentSuperAdmin.full_name || '';
    document.getElementById('saSettingsUsername').value = currentSuperAdmin.username || '';
    document.getElementById('saSettingsOldPassword').value = '';
    document.getElementById('saSettingsNewPassword').value = '';
    document.getElementById('saSettingsConfirmPassword').value = '';
    document.getElementById('superAdminSettingsModal').classList.add('active');
}

document.getElementById('superAdminSettingsForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = document.getElementById('saSettingsFullName').value.trim();
    const newUsername = document.getElementById('saSettingsUsername').value.trim();
    const oldPassword = document.getElementById('saSettingsOldPassword').value;
    const newPassword = document.getElementById('saSettingsNewPassword').value;
    const confirmPassword = document.getElementById('saSettingsConfirmPassword').value;

    if (!oldPassword) {
        alert('يرجى إدخال كلمة المرور الحالية للتأكيد');
        return;
    }
    if (!newUsername) {
        alert('يرجى إدخال اسم المستخدم');
        return;
    }
    if (newPassword && newPassword !== confirmPassword) {
        alert('كلمة المرور الجديدة وتأكيدها غير متطابقتين');
        return;
    }

    try {
        const response = await authFetch(`${API_URL}/api/super-admin/change-password`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                admin_id: currentSuperAdmin.id,
                old_password: oldPassword,
                new_password: newPassword || '',
                new_username: newUsername,
                new_full_name: fullName
            })
        });
        const data = await response.json();
        if (data.success) {
            currentSuperAdmin = data.admin;
            localStorage.setItem('pos_super_admin', JSON.stringify(data.admin));
            document.getElementById('saUserInfo').textContent = data.admin.full_name;
            document.getElementById('superAdminSettingsModal').classList.remove('active');
            alert('تم حفظ التغييرات بنجاح');
        } else {
            alert(data.error || 'فشل حفظ التغييرات');
        }
    } catch (e) {
        console.error('[SuperAdmin] Settings error:', e);
        alert('خطأ في حفظ الإعدادات');
    }
});

async function loadSuperAdminDashboard() {
    try {
        const response = await authFetch(`${API_URL}/api/super-admin/tenants`);
        const data = await response.json();
        if (!data.success) return;

        const tenants = data.tenants || [];

        // إحصائيات عامة
        const totalTenants = tenants.length;
        const activeTenants = tenants.filter(t => t.is_active).length;
        const totalUsers = tenants.reduce((sum, t) => sum + (t.users_count || 0), 0);
        const totalInvoices = tenants.reduce((sum, t) => sum + (t.invoices_count || 0), 0);

        document.getElementById('saStatsContainer').innerHTML = `
            <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 20px; border-radius: 12px; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${totalTenants}</div>
                <div style="font-size: 13px; opacity: 0.9;">إجمالي المتاجر</div>
            </div>
            <div style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 20px; border-radius: 12px; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${activeTenants}</div>
                <div style="font-size: 13px; opacity: 0.9;">متاجر نشطة</div>
            </div>
            <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 20px; border-radius: 12px; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${totalUsers}</div>
                <div style="font-size: 13px; opacity: 0.9;">إجمالي المستخدمين</div>
            </div>
            <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 20px; border-radius: 12px; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${totalInvoices}</div>
                <div style="font-size: 13px; opacity: 0.9;">إجمالي الفواتير</div>
            </div>
        `;

        // جدول المستأجرين
        const thStyle = 'padding: 12px; text-align: right; border-bottom: 2px solid #e2e8f0; white-space: nowrap;';
        let tableHTML = `
            <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="background: #f1f5f9;">
                        <th style="${thStyle}">#</th>
                        <th style="${thStyle}">المتجر</th>
                        <th style="${thStyle}">المعرف</th>
                        <th style="${thStyle}">المالك</th>
                        <th style="${thStyle}">الخطة</th>
                        <th style="${thStyle} text-align: center;">الحالة</th>
                        <th style="${thStyle} text-align: center;">الوضع</th>
                        <th style="${thStyle} text-align: center;">الاشتراك</th>
                        <th style="${thStyle} text-align: center;">المستخدمين</th>
                        <th style="${thStyle} text-align: center;">الإجراءات</th>
                    </tr>
                </thead>
                <tbody>
        `;

        if (tenants.length === 0) {
            tableHTML += '<tr><td colspan="10" style="padding: 30px; text-align: center; color: #94a3b8;">لا توجد متاجر - اضغط "إضافة متجر جديد" للبدء</td></tr>';
        } else {
            tenants.forEach((t, i) => {
                const planNames = {'basic': 'أساسية', 'premium': 'متقدمة', 'enterprise': 'مؤسسات'};
                // Source badge (local / remote / both)
                let sourceBadge = '';
                if (t.source === 'remote') {
                    sourceBadge = '<span style="background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-right: 5px;" title="سيرفر فقط - البيانات غير متوفرة محلياً">☁️ سيرفر</span>';
                } else if (t.source === 'local') {
                    sourceBadge = '<span style="background: #dbeafe; color: #1e40af; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-right: 5px;" title="محلي فقط - غير موجود بالسيرفر">💻 محلي</span>';
                } else if (t.source === 'both') {
                    sourceBadge = '<span style="background: #d1fae5; color: #065f46; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-right: 5px;" title="متزامن - موجود محلياً وبالسيرفر">🔗 متزامن</span>';
                }
                // حالة الاشتراك
                let subStatus = '';
                if (t.expires_at) {
                    const expiry = new Date(t.expires_at);
                    const today = new Date();
                    today.setHours(0,0,0,0);
                    const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
                    if (daysLeft < 0) {
                        subStatus = `<span style="color: #ef4444; font-weight: bold;">⛔ منتهي</span><br><span style="font-size: 10px; color: #94a3b8;">${t.expires_at.substring(0,10)}</span>`;
                    } else if (daysLeft <= 7) {
                        subStatus = `<span style="color: #f59e0b; font-weight: bold;">⚠️ ${daysLeft} يوم</span><br><span style="font-size: 10px; color: #94a3b8;">${t.expires_at.substring(0,10)}</span>`;
                    } else {
                        subStatus = `<span style="color: #10b981; font-weight: bold;">✅ ${daysLeft} يوم</span><br><span style="font-size: 10px; color: #94a3b8;">${t.expires_at.substring(0,10)}</span>`;
                    }
                } else {
                    subStatus = '<span style="color: #94a3b8;">غير محدد</span>';
                }

                tableHTML += `
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px;">${i + 1}</td>
                        <td style="padding: 10px; font-weight: bold;">${escHTML(t.name)} ${sourceBadge}</td>
                        <td style="padding: 10px; direction: ltr; color: #64748b;">${escHTML(t.slug)}</td>
                        <td style="padding: 10px;">${escHTML(t.owner_name)}</td>
                        <td style="padding: 10px;"><span style="background: ${t.plan === 'enterprise' ? '#fef3c7' : t.plan === 'premium' ? '#dbeafe' : '#f1f5f9'}; padding: 3px 8px; border-radius: 6px; font-size: 11px;">${planNames[t.plan] || t.plan}</span></td>
                        <td style="padding: 10px; text-align: center;">${t.is_active ? '<span style="color: #10b981; font-weight: bold;">✅ نشط</span>' : '<span style="color: #ef4444;">❌ معطل</span>'}</td>
                        <td style="padding: 10px; text-align: center;">${t.mode === 'offline' ? '<span style="background: #fef3c7; color: #92400e; padding: 3px 8px; border-radius: 6px; font-size: 11px;">📴 أوفلاين</span>' : '<span style="background: #d1fae5; color: #065f46; padding: 3px 8px; border-radius: 6px; font-size: 11px;">🌐 أونلاين</span>'}</td>
                        <td style="padding: 10px; text-align: center; font-size: 12px;">${subStatus}</td>
                        <td style="padding: 10px; text-align: center;">${t.users_count || 0}</td>
                        <td style="padding: 10px; text-align: center;">
                            <div style="display: flex; gap: 4px; justify-content: center; flex-wrap: wrap;">
                                <button onclick="openSubscriptionModal(${t.id})" style="background: #8b5cf6; color: white; border: none; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;" title="الاشتراك">💳</button>
                                <button onclick="viewTenantStats(${t.id})" style="background: #3b82f6; color: white; border: none; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;" title="إحصائيات">📊</button>
                                <button onclick="superAdminBackupTenant(${t.id}, '${escHTML(t.name)}')" style="background: #10b981; color: white; border: none; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;" title="نسخ احتياطي">💾</button>
                                <button onclick="editTenant(${t.id})" style="background: #f59e0b; color: white; border: none; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;" title="تعديل">✏️</button>
                                <button onclick="toggleTenant(${t.id}, ${t.is_active ? 0 : 1})" style="background: ${t.is_active ? '#ef4444' : '#10b981'}; color: white; border: none; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;" title="${t.is_active ? 'تعطيل' : 'تفعيل'}">${t.is_active ? '🚫' : '✅'}</button>
                                <button onclick="deleteTenantAction(${t.id}, '${escHTML(t.name)}')" style="background: #dc2626; color: white; border: none; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 11px;" title="حذف">🗑️</button>
                            </div>
                        </td>
                    </tr>
                `;
            });
        }

        tableHTML += '</tbody></table></div>';
        document.getElementById('tenantsTableContainer').innerHTML = tableHTML;

    } catch (e) {
        console.error('[SuperAdmin] Load dashboard error:', e);
    }
}

let editingTenantId = null;

function showAddTenant() {
    editingTenantId = null;
    document.getElementById('tenantEditId').value = '';
    document.getElementById('tenantName').value = '';
    document.getElementById('tenantSlug').value = '';
    document.getElementById('tenantOwnerName').value = '';
    document.getElementById('tenantOwnerEmail').value = '';
    document.getElementById('tenantOwnerPhone').value = '';
    document.getElementById('tenantAdminUsername').value = 'admin';
    document.getElementById('tenantAdminPassword').value = 'admin123';
    document.getElementById('tenantPlan').value = 'basic';
    document.getElementById('tenantMaxUsers').value = '5';
    document.getElementById('tenantMaxBranches').value = '3';
    document.getElementById('tenantSubAmount').value = '0';
    document.getElementById('tenantSubPeriod').value = '30';
    document.getElementById('tenantMode').value = 'online';
    document.getElementById('tenantSlugGroup').style.display = 'block';
    document.getElementById('tenantAdminFields').style.display = 'grid';
    document.getElementById('tenantModalTitle').textContent = '➕ إضافة متجر جديد';
    document.getElementById('addTenantModal').classList.add('active');
}

async function editTenant(tenantId) {
    try {
        const response = await authFetch(`${API_URL}/api/super-admin/tenants/${tenantId}/stats`);
        const data = await response.json();
        if (!data.success) return;
        const t = data.tenant;
        editingTenantId = tenantId;
        document.getElementById('tenantEditId').value = tenantId;
        document.getElementById('tenantName').value = t.name;
        document.getElementById('tenantSlug').value = t.slug;
        document.getElementById('tenantOwnerName').value = t.owner_name;
        document.getElementById('tenantOwnerEmail').value = t.owner_email || '';
        document.getElementById('tenantOwnerPhone').value = t.owner_phone || '';
        document.getElementById('tenantPlan').value = t.plan || 'basic';
        document.getElementById('tenantMaxUsers').value = t.max_users || 5;
        document.getElementById('tenantMaxBranches').value = t.max_branches || 3;
        document.getElementById('tenantSubAmount').value = t.subscription_amount || 0;
        document.getElementById('tenantSubPeriod').value = t.subscription_period || 30;
        document.getElementById('tenantMode').value = t.mode || 'online';
        document.getElementById('tenantSlugGroup').style.display = 'none'; // لا يمكن تغيير slug
        document.getElementById('tenantAdminFields').style.display = 'none'; // لا يمكن تغيير أدمن من هنا
        document.getElementById('tenantModalTitle').textContent = '✏️ تعديل متجر';
        document.getElementById('addTenantModal').classList.add('active');
    } catch (e) {
        console.error('[SuperAdmin] Edit tenant error:', e);
    }
}

document.getElementById('tenantForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        if (editingTenantId) {
            // تحديث
            const response = await authFetch(`${API_URL}/api/super-admin/tenants/${editingTenantId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    name: document.getElementById('tenantName').value,
                    owner_name: document.getElementById('tenantOwnerName').value,
                    owner_email: document.getElementById('tenantOwnerEmail').value,
                    owner_phone: document.getElementById('tenantOwnerPhone').value,
                    plan: document.getElementById('tenantPlan').value,
                    max_users: parseInt(document.getElementById('tenantMaxUsers').value),
                    max_branches: parseInt(document.getElementById('tenantMaxBranches').value),
                    subscription_amount: parseFloat(document.getElementById('tenantSubAmount').value) || 0,
                    subscription_period: parseInt(document.getElementById('tenantSubPeriod').value) || 30,
                    mode: document.getElementById('tenantMode').value
                })
            });
            const data = await response.json();
            if (data.success) {
                alert('تم تحديث المتجر بنجاح');
            } else {
                alert(data.error || 'فشل التحديث');
                return;
            }
        } else {
            // إنشاء جديد
            const response = await authFetch(`${API_URL}/api/super-admin/tenants`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    name: document.getElementById('tenantName').value,
                    slug: document.getElementById('tenantSlug').value,
                    owner_name: document.getElementById('tenantOwnerName').value,
                    owner_email: document.getElementById('tenantOwnerEmail').value,
                    owner_phone: document.getElementById('tenantOwnerPhone').value,
                    admin_username: document.getElementById('tenantAdminUsername').value,
                    admin_password: document.getElementById('tenantAdminPassword').value,
                    plan: document.getElementById('tenantPlan').value,
                    max_users: parseInt(document.getElementById('tenantMaxUsers').value),
                    max_branches: parseInt(document.getElementById('tenantMaxBranches').value),
                    subscription_amount: parseFloat(document.getElementById('tenantSubAmount').value) || 0,
                    subscription_period: parseInt(document.getElementById('tenantSubPeriod').value) || 30,
                    mode: document.getElementById('tenantMode').value
                })
            });
            const data = await response.json();
            if (data.success) {
                alert('تم إنشاء المتجر بنجاح');
            } else {
                alert(data.error || 'فشل الإنشاء');
                return;
            }
        }
        document.getElementById('addTenantModal').classList.remove('active');
        loadSuperAdminDashboard();
    } catch (e) {
        console.error('[SuperAdmin] Save tenant error:', e);
        alert('خطأ في حفظ المتجر');
    }
});

async function toggleTenant(tenantId, newState) {
    try {
        const response = await authFetch(`${API_URL}/api/super-admin/tenants/${tenantId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ is_active: newState })
        });
        const data = await response.json();
        if (data.success) {
            loadSuperAdminDashboard();
        }
    } catch (e) {
        console.error('[SuperAdmin] Toggle error:', e);
    }
}

// نسخ احتياطي لمتجر معين
async function superAdminBackupTenant(tenantId, tenantName) {
    if (!confirm(`هل تريد إنشاء نسخة احتياطية لمتجر "${tenantName}"؟`)) return;
    try {
        const response = await authFetch(`${API_URL}/api/super-admin/backup/tenant/${tenantId}`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            const size = (data.backup.size / 1024).toFixed(1);
            alert(`تم إنشاء النسخة الاحتياطية بنجاح\n${data.backup.tenant_name}: ${data.backup.filename} (${size} KB)`);
        } else {
            alert(data.error || 'فشل إنشاء النسخة الاحتياطية');
        }
    } catch (e) {
        console.error('[SuperAdmin] Backup tenant error:', e);
        alert('خطأ في إنشاء النسخة الاحتياطية');
    }
}

// نسخ احتياطي لجميع المتاجر
async function superAdminBackupAll() {
    if (!confirm('هل تريد إنشاء نسخ احتياطية لجميع المتاجر؟\nقد تستغرق هذه العملية بعض الوقت.')) return;

    // إظهار مؤشر التحميل
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = '⏳ جاري النسخ...';
    btn.disabled = true;

    try {
        const response = await authFetch(`${API_URL}/api/super-admin/backup/all`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            let msg = `تم إنشاء ${data.total} نسخة احتياطية بنجاح`;
            if (data.failed > 0) {
                msg += `\n⚠️ فشل ${data.failed} نسخة:`;
                data.errors.forEach(e => { msg += `\n- ${e.tenant}: ${e.error}`; });
            }
            msg += '\n\nالتفاصيل:';
            data.backups.forEach(b => {
                msg += `\n- ${b.tenant_name}: ${(b.size / 1024).toFixed(1)} KB`;
            });
            alert(msg);
        } else {
            alert(data.error || 'فشل إنشاء النسخ الاحتياطية');
        }
    } catch (e) {
        console.error('[SuperAdmin] Backup all error:', e);
        alert('خطأ في إنشاء النسخ الاحتياطية');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function deleteTenantAction(tenantId, tenantName) {
    if (!confirm(`⚠️ هل أنت متأكد من حذف المتجر "${tenantName}"؟\n\nسيتم حذف جميع البيانات نهائياً!`)) return;
    if (!confirm('تأكيد نهائي: هذا الإجراء لا يمكن التراجع عنه!')) return;

    try {
        const response = await authFetch(`${API_URL}/api/super-admin/tenants/${tenantId}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            alert('تم حذف المتجر');
            loadSuperAdminDashboard();
        } else {
            alert(data.error || 'فشل الحذف');
        }
    } catch (e) {
        console.error('[SuperAdmin] Delete error:', e);
    }
}

async function viewTenantStats(tenantId) {
    try {
        const response = await authFetch(`${API_URL}/api/super-admin/tenants/${tenantId}/stats`);
        const data = await response.json();
        if (!data.success) return;

        const t = data.tenant;
        const s = data.stats;
        const planNames = {'basic': 'أساسية', 'premium': 'متقدمة', 'enterprise': 'مؤسسات'};

        document.getElementById('tenantStatsTitle').textContent = `📊 إحصائيات: ${t.name}`;
        document.getElementById('tenantStatsContent').innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px;">
                <div style="background: #f8fafc; padding: 12px; border-radius: 8px;">
                    <div style="color: #64748b; font-size: 12px;">المعرف</div>
                    <div style="font-weight: bold; direction: ltr;">${t.slug}</div>
                </div>
                <div style="background: #f8fafc; padding: 12px; border-radius: 8px;">
                    <div style="color: #64748b; font-size: 12px;">الخطة</div>
                    <div style="font-weight: bold;">${planNames[t.plan] || t.plan}</div>
                </div>
                <div style="background: #f8fafc; padding: 12px; border-radius: 8px;">
                    <div style="color: #64748b; font-size: 12px;">المالك</div>
                    <div style="font-weight: bold;">${t.owner_name}</div>
                </div>
                <div style="background: #f8fafc; padding: 12px; border-radius: 8px;">
                    <div style="color: #64748b; font-size: 12px;">تاريخ الإنشاء</div>
                    <div style="font-weight: bold;">${new Date(t.created_at).toLocaleDateString('ar')}</div>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
                <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold;">${s.users_count}</div>
                    <div style="font-size: 11px; opacity: 0.9;">مستخدمين (حد: ${t.max_users})</div>
                </div>
                <div style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold;">${s.branches_count}</div>
                    <div style="font-size: 11px; opacity: 0.9;">فروع (حد: ${t.max_branches})</div>
                </div>
                <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold;">${s.products_count}</div>
                    <div style="font-size: 11px; opacity: 0.9;">منتجات</div>
                </div>
                <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold;">${s.invoices_count}</div>
                    <div style="font-size: 11px; opacity: 0.9;">فواتير</div>
                </div>
                <div style="background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold;">${s.customers_count}</div>
                    <div style="font-size: 11px; opacity: 0.9;">عملاء</div>
                </div>
                <div style="background: linear-gradient(135deg, #ec4899, #db2777); color: white; padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold;">${parseFloat(s.total_sales || 0).toFixed(3)}</div>
                    <div style="font-size: 11px; opacity: 0.9;">إجمالي المبيعات (د.ك)</div>
                </div>
            </div>
        `;
        document.getElementById('tenantStatsModal').classList.add('active');
    } catch (e) {
        console.error('[SuperAdmin] Stats error:', e);
    }
}

// ===== إدارة الاشتراكات =====

async function openSubscriptionModal(tenantId) {
    document.getElementById('subTenantId').value = tenantId;

    try {
        // جلب بيانات المستأجر
        const statsRes = await authFetch(`${API_URL}/api/super-admin/tenants/${tenantId}/stats`);
        const statsData = await statsRes.json();

        if (!statsData.success) return;
        const t = statsData.tenant;

        // معلومات الاشتراك الحالي
        let infoHTML = '';
        const subAmount = t.subscription_amount || 0;
        const subPeriod = t.subscription_period || 30;

        if (t.expires_at) {
            const expiry = new Date(t.expires_at);
            const today = new Date();
            today.setHours(0,0,0,0);
            const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
            const isExpired = daysLeft < 0;
            infoHTML = `
                <div style="background: ${isExpired ? '#fef2f2' : daysLeft <= 7 ? '#fffbeb' : '#f0fdf4'}; padding: 15px; border-radius: 10px; border: 2px solid ${isExpired ? '#fca5a5' : daysLeft <= 7 ? '#fcd34d' : '#86efac'};">
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; text-align: center;">
                        <div>
                            <div style="font-size: 12px; color: #64748b;">المتجر</div>
                            <div style="font-weight: bold;">${escHTML(t.name)}</div>
                        </div>
                        <div>
                            <div style="font-size: 12px; color: #64748b;">ينتهي في</div>
                            <div style="font-weight: bold; color: ${isExpired ? '#ef4444' : '#059669'};">${t.expires_at.substring(0,10)}</div>
                        </div>
                        <div>
                            <div style="font-size: 12px; color: #64748b;">الأيام المتبقية</div>
                            <div style="font-weight: bold; font-size: 20px; color: ${isExpired ? '#ef4444' : daysLeft <= 7 ? '#f59e0b' : '#059669'};">${isExpired ? 'منتهي ⛔' : daysLeft + ' يوم'}</div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            infoHTML = `
                <div style="background: #f1f5f9; padding: 15px; border-radius: 10px; text-align: center; color: #64748b;">
                    <strong>${t.name}</strong> - لم يتم تحديد فترة اشتراك بعد
                </div>
            `;
        }
        document.getElementById('subscriptionInfo').innerHTML = infoHTML;

        // تعبئة القيم الافتراضية
        document.getElementById('subAmount').value = subAmount > 0 ? subAmount : '';
        document.getElementById('subPeriodDays').value = subPeriod;
        document.getElementById('subNotes').value = '';

        document.getElementById('subscriptionModalTitle').textContent = `💳 اشتراك: ${t.name}`;

        // جلب فواتير الاشتراك
        const invRes = await authFetch(`${API_URL}/api/super-admin/subscriptions/${tenantId}`);
        const invData = await invRes.json();

        let invHTML = '';
        if (invData.success && invData.invoices && invData.invoices.length > 0) {
            const payNames = {'cash': '💵 نقداً', 'knet': '💳 كي نت', 'bank': '🏦 تحويل بنكي'};
            invHTML = `<table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                <thead><tr style="background: #f1f5f9;">
                    <th style="padding: 8px; text-align: right;">#</th>
                    <th style="padding: 8px; text-align: right;">المبلغ</th>
                    <th style="padding: 8px; text-align: right;">المدة</th>
                    <th style="padding: 8px; text-align: right;">من</th>
                    <th style="padding: 8px; text-align: right;">إلى</th>
                    <th style="padding: 8px; text-align: right;">الدفع</th>
                    <th style="padding: 8px; text-align: center;">حذف</th>
                </tr></thead><tbody>`;
            invData.invoices.forEach((inv, i) => {
                invHTML += `<tr style="border-bottom: 1px solid #f1f5f9;">
                    <td style="padding: 6px;">${i+1}</td>
                    <td style="padding: 6px; font-weight: bold;">${parseFloat(inv.amount).toFixed(3)} د.ك</td>
                    <td style="padding: 6px;">${inv.period_days} يوم</td>
                    <td style="padding: 6px;">${inv.start_date}</td>
                    <td style="padding: 6px;">${inv.end_date}</td>
                    <td style="padding: 6px;">${payNames[inv.payment_method] || inv.payment_method}</td>
                    <td style="padding: 6px; text-align: center;">
                        <button onclick="deleteSubInvoice(${inv.id}, ${tenantId})" style="background: #ef4444; color: white; border: none; padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 10px;">🗑️</button>
                    </td>
                </tr>`;
            });
            invHTML += '</tbody></table>';
        } else {
            invHTML = '<div style="text-align: center; color: #94a3b8; padding: 20px;">لا توجد فواتير اشتراك</div>';
        }
        document.getElementById('subscriptionInvoicesList').innerHTML = invHTML;

        document.getElementById('subscriptionModal').classList.add('active');
    } catch (e) {
        console.error('[SuperAdmin] Open subscription error:', e);
    }
}

document.getElementById('subscriptionForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tenantId = document.getElementById('subTenantId').value;
    const amount = parseFloat(document.getElementById('subAmount').value);
    const periodDays = parseInt(document.getElementById('subPeriodDays').value);
    const paymentMethod = document.getElementById('subPaymentMethod').value;
    const notes = document.getElementById('subNotes').value;

    if (!amount || amount <= 0) {
        alert('يرجى إدخال مبلغ صحيح');
        return;
    }

    try {
        const response = await authFetch(`${API_URL}/api/super-admin/subscriptions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ tenant_id: tenantId, amount, period_days: periodDays, payment_method: paymentMethod, notes })
        });
        const data = await response.json();
        if (data.success) {
            alert(`تم تجديد الاشتراك بنجاح!\nمن: ${data.start_date}\nإلى: ${data.end_date}`);
            openSubscriptionModal(tenantId); // إعادة تحميل
            loadSuperAdminDashboard(); // تحديث الجدول
        } else {
            alert(data.error || 'فشل إنشاء الفاتورة');
        }
    } catch (e) {
        console.error('[SuperAdmin] Create subscription error:', e);
        alert('خطأ في إنشاء فاتورة الاشتراك');
    }
});

async function deleteSubInvoice(invoiceId, tenantId) {
    if (!confirm('هل تريد حذف هذه الفاتورة؟')) return;
    try {
        const response = await authFetch(`${API_URL}/api/super-admin/subscriptions/${invoiceId}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            openSubscriptionModal(tenantId);
        }
    } catch (e) {
        console.error('[SuperAdmin] Delete sub invoice error:', e);
    }
}

// استعادة جلسة Super Admin
(function restoreSuperAdmin() {
    const savedSA = localStorage.getItem('pos_super_admin');
    if (savedSA) {
        try {
            currentSuperAdmin = JSON.parse(savedSA);
            document.getElementById('loginOverlay').classList.add('hidden');
            document.getElementById('mainContainer').style.display = 'none';
            document.getElementById('superAdminDashboard').style.display = 'block';
            document.getElementById('saUserInfo').textContent = currentSuperAdmin.full_name;
            loadSuperAdminDashboard();
        } catch (e) {
            localStorage.removeItem('pos_super_admin');
        }
    }
})();

console.log('[Multi-Tenancy] System Loaded ✅');

// ===== نظام النسخ الاحتياطي =====

async function loadBackupTab() {
    await loadBackupsList();
    await loadGDriveStatus();
    await loadBackupSchedule();
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function loadBackupsList() {
    try {
        const response = await fetch(`${API_URL}/api/backup/list`, {
            headers: {}
        });
        const data = await response.json();
        if (!data.success) return;

        const container = document.getElementById('backupsList');
        if (!data.backups || data.backups.length === 0) {
            container.innerHTML = '<div style="padding: 30px; text-align: center; color: #a0aec0;">لا توجد نسخ احتياطية بعد</div>';
            return;
        }

        let html = '';
        data.backups.forEach(b => {
            const date = new Date(b.created_at);
            const dateStr = date.toLocaleDateString('ar', {year: 'numeric', month: 'long', day: 'numeric'});
            const timeStr = date.toLocaleTimeString('ar', {hour: '2-digit', minute: '2-digit'});
            html += `
                <div style="padding: 15px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: bold; color: #2d3748;">${b.filename}</div>
                        <div style="font-size: 13px; color: #718096;">${dateStr} - ${timeStr} | ${formatFileSize(b.size)}</div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button onclick="downloadBackup('${b.filename}')" class="btn" style="background: #38a169; padding: 6px 12px; font-size: 13px;" title="تحميل">📥</button>
                        <button onclick="uploadBackupToGDrive('${b.filename}')" class="btn gdrive-upload-btn" style="background: #4285f4; padding: 6px 12px; font-size: 13px; display: none;" title="رفع إلى Google Drive">☁️</button>
                        <button onclick="restoreFromLocal('${b.filename}')" class="btn" style="background: #e67e00; padding: 6px 12px; font-size: 13px;" title="استعادة">🔄</button>
                        <button onclick="deleteBackup('${b.filename}')" class="btn" style="background: #e53e3e; padding: 6px 12px; font-size: 13px;" title="حذف">🗑️</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;

        // إظهار أزرار Google Drive إذا كان متصلاً
        if (window._gdriveConnected) {
            document.querySelectorAll('.gdrive-upload-btn').forEach(btn => btn.style.display = 'inline-block');
        }

        // تحديث إعدادات الجدولة من البيانات
        if (data.schedule) {
            document.getElementById('backupScheduleEnabled').value = data.schedule.enabled ? 'true' : 'false';
            document.getElementById('backupScheduleTime').value = data.schedule.time || '03:00';
            document.getElementById('backupKeepDays').value = data.schedule.keep_days || 30;
            document.getElementById('backupGDriveAuto').value = data.schedule.gdrive_auto ? 'true' : 'false';
        }

    } catch (error) {
        console.error('[Backup] Error loading backups:', error);
    }
}

async function createBackup() {
    const progress = document.getElementById('backupProgress');
    const progressText = document.getElementById('backupProgressText');
    progress.style.display = 'block';
    progressText.textContent = 'جاري إنشاء النسخة الاحتياطية...';

    try {
        const response = await fetch(`${API_URL}/api/backup/create`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'}
        });
        const data = await response.json();
        if (data.success) {
            progressText.textContent = `تم إنشاء النسخة بنجاح: ${data.backup.filename} (${formatFileSize(data.backup.size)})`;
            setTimeout(() => { progress.style.display = 'none'; }, 3000);
            await loadBackupsList();
        } else {
            progressText.textContent = `خطأ: ${data.error}`;
            setTimeout(() => { progress.style.display = 'none'; }, 5000);
        }
    } catch (error) {
        progressText.textContent = 'فشل إنشاء النسخة الاحتياطية';
        setTimeout(() => { progress.style.display = 'none'; }, 5000);
    }
}

async function downloadBackup(filename) {
    try {
        const response = await fetch(`${API_URL}/api/backup/download/${filename}`, {
            headers: {}
        });
        if (!response.ok) {
            alert('خطأ في تحميل الملف');
            return;
        }
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    } catch (error) {
        alert('فشل تحميل النسخة الاحتياطية');
    }
}

async function deleteBackup(filename) {
    if (!confirm(`هل تريد حذف النسخة الاحتياطية ${filename}؟`)) return;

    try {
        const response = await fetch(`${API_URL}/api/backup/delete/${filename}`, {
            method: 'DELETE',
            headers: {}
        });
        const data = await response.json();
        if (data.success) {
            await loadBackupsList();
        } else {
            alert(data.error || 'فشل الحذف');
        }
    } catch (error) {
        alert('فشل حذف النسخة');
    }
}

async function restoreBackup() {
    const fileInput = document.getElementById('restoreFileInput');
    if (!fileInput.files || !fileInput.files[0]) {
        alert('يرجى اختيار ملف النسخة الاحتياطية');
        return;
    }

    if (!confirm('⚠️ هل أنت متأكد من استعادة هذه النسخة؟\nسيتم استبدال جميع البيانات الحالية.\nسيتم إنشاء نسخة احتياطية تلقائية قبل الاستعادة.')) return;

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
        const response = await fetch(`${API_URL}/api/backup/restore`, {
            method: 'POST',
            headers: {},
            body: formData
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تمت الاستعادة بنجاح!\nسيتم إعادة تحميل الصفحة.');
            location.reload();
        } else {
            alert(data.error || 'فشل الاستعادة');
        }
    } catch (error) {
        alert('فشل استعادة النسخة الاحتياطية');
    }
}

async function restoreFromLocal(filename) {
    if (!confirm(`⚠️ هل أنت متأكد من استعادة النسخة ${filename}؟\nسيتم استبدال جميع البيانات الحالية.\nسيتم إنشاء نسخة احتياطية تلقائية قبل الاستعادة.`)) return;

    try {
        const response = await fetch(`${API_URL}/api/backup/restore`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({filename: filename})
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تمت الاستعادة بنجاح!\nسيتم إعادة تحميل الصفحة.');
            location.reload();
        } else {
            alert(data.error || 'فشل الاستعادة');
        }
    } catch (error) {
        alert('فشل استعادة النسخة الاحتياطية');
    }
}

async function saveBackupSchedule() {
    try {
        const response = await fetch(`${API_URL}/api/backup/schedule`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                enabled: document.getElementById('backupScheduleEnabled').value === 'true',
                time: document.getElementById('backupScheduleTime').value,
                keep_days: parseInt(document.getElementById('backupKeepDays').value) || 30,
                gdrive_auto: document.getElementById('backupGDriveAuto').value === 'true'
            })
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم حفظ إعدادات الجدولة');
        } else {
            alert(data.error || 'فشل الحفظ');
        }
    } catch (error) {
        alert('فشل حفظ الإعدادات');
    }
}

async function loadBackupSchedule() {
    // يتم تحميلها مع قائمة النسخ
}

// ===== Google Drive Integration =====

window._gdriveConnected = false;

async function loadGDriveStatus() {
    try {
        const response = await fetch(`${API_URL}/api/backup/gdrive/status`, {
            headers: {}
        });
        const data = await response.json();
        if (!data.success) return;

        window._gdriveConnected = data.connected;
        const badge = document.getElementById('gdriveStatusBadge');
        const setupSection = document.getElementById('gdriveSetupSection');
        const connectedSection = document.getElementById('gdriveConnectedSection');
        const gdriveBtn = document.getElementById('backupToGDriveBtn');

        if (data.connected) {
            badge.textContent = 'متصل';
            badge.style.background = '#dcfce7';
            badge.style.color = '#16a34a';
            setupSection.style.display = 'none';
            connectedSection.style.display = 'block';
            if (gdriveBtn) gdriveBtn.style.display = 'inline-block';
            document.querySelectorAll('.gdrive-upload-btn').forEach(btn => btn.style.display = 'inline-block');
            await loadGDriveFiles();
        } else {
            badge.textContent = 'غير متصل';
            badge.style.background = '#fee2e2';
            badge.style.color = '#ef4444';
            setupSection.style.display = 'block';
            connectedSection.style.display = 'none';
            if (gdriveBtn) gdriveBtn.style.display = 'none';
            document.querySelectorAll('.gdrive-upload-btn').forEach(btn => btn.style.display = 'none');
        }
    } catch (error) {
        console.error('[GDrive] Status check error:', error);
    }
}

// استقبال رسالة نجاح الربط من نافذة callback
window.addEventListener('message', function(event) {
    if (event.data === 'gdrive_connected') {
        loadGDriveStatus();
    }
});

async function gdriveStartAuth() {
    const clientId = document.getElementById('gdriveClientId').value.trim();
    const clientSecret = document.getElementById('gdriveClientSecret').value.trim();

    if (!clientId || !clientSecret) {
        alert('يرجى إدخال Client ID و Client Secret');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/backup/gdrive/save-credentials`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                base_url: window.location.origin
            })
        });
        const data = await response.json();
        if (data.success && data.auth_url) {
            // عرض redirect_uri للمستخدم لإضافته في Google Cloud Console
            if (data.redirect_uri) {
                document.getElementById('gdriveRedirectUriDisplay').textContent = data.redirect_uri;
                document.getElementById('gdriveRedirectUriSection').style.display = 'block';
            }
            window.open(data.auth_url, '_blank');
            document.getElementById('gdriveAuthCodeSection').style.display = 'block';
        } else {
            alert(data.error || 'فشل حفظ البيانات');
        }
    } catch (error) {
        alert('فشل الاتصال بالخادم');
    }
}

async function gdriveConnect() {
    const code = document.getElementById('gdriveAuthCode').value.trim();
    if (!code) {
        alert('يرجى إدخال كود التفويض');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/backup/gdrive/connect`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: code})
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم ربط Google Drive بنجاح!');
            await loadGDriveStatus();
        } else {
            alert(data.error || 'فشل الربط');
        }
    } catch (error) {
        alert('فشل ربط Google Drive');
    }
}

async function gdriveDisconnect() {
    if (!confirm('هل تريد قطع اتصال Google Drive؟')) return;

    try {
        const response = await fetch(`${API_URL}/api/backup/gdrive/disconnect`, {
            method: 'POST',
            headers: {}
        });
        const data = await response.json();
        if (data.success) {
            await loadGDriveStatus();
        }
    } catch (error) {
        alert('فشل قطع الاتصال');
    }
}

async function createAndUploadGDrive() {
    const progress = document.getElementById('backupProgress');
    const progressText = document.getElementById('backupProgressText');
    progress.style.display = 'block';
    progressText.textContent = 'جاري إنشاء النسخة ورفعها إلى Google Drive...';

    try {
        const response = await fetch(`${API_URL}/api/backup/gdrive/upload`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({})
        });
        const data = await response.json();
        if (data.success) {
            progressText.textContent = `✅ ${data.message}`;
            setTimeout(() => { progress.style.display = 'none'; }, 3000);
            await loadBackupsList();
            await loadGDriveFiles();
        } else {
            progressText.textContent = `خطأ: ${data.error}`;
            setTimeout(() => { progress.style.display = 'none'; }, 5000);
        }
    } catch (error) {
        progressText.textContent = 'فشل الرفع إلى Google Drive';
        setTimeout(() => { progress.style.display = 'none'; }, 5000);
    }
}

async function uploadBackupToGDrive(filename) {
    const progress = document.getElementById('backupProgress');
    const progressText = document.getElementById('backupProgressText');
    progress.style.display = 'block';
    progressText.textContent = `جاري رفع ${filename} إلى Google Drive...`;

    try {
        const response = await fetch(`${API_URL}/api/backup/gdrive/upload`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({filename: filename})
        });
        const data = await response.json();
        if (data.success) {
            progressText.textContent = `✅ ${data.message}`;
            setTimeout(() => { progress.style.display = 'none'; }, 3000);
            await loadGDriveFiles();
        } else {
            progressText.textContent = `خطأ: ${data.error}`;
            setTimeout(() => { progress.style.display = 'none'; }, 5000);
        }
    } catch (error) {
        progressText.textContent = 'فشل الرفع إلى Google Drive';
        setTimeout(() => { progress.style.display = 'none'; }, 5000);
    }
}

async function loadGDriveFiles() {
    try {
        const response = await fetch(`${API_URL}/api/backup/gdrive/files`, {
            headers: {}
        });
        const data = await response.json();
        const container = document.getElementById('gdriveFilesList');

        if (!data.success || !data.files || data.files.length === 0) {
            container.innerHTML = '<div style="padding: 30px; text-align: center; color: #a0aec0;">لا توجد نسخ في Google Drive</div>';
            return;
        }

        let html = '';
        data.files.forEach(f => {
            const date = new Date(f.created_at);
            const dateStr = date.toLocaleDateString('ar', {year: 'numeric', month: 'long', day: 'numeric'});
            const timeStr = date.toLocaleTimeString('ar', {hour: '2-digit', minute: '2-digit'});
            html += `
                <div style="padding: 15px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: bold; color: #2d3748; font-size: 13px;">${escHTML(f.name)}</div>
                        <div style="font-size: 12px; color: #718096;">${dateStr} - ${timeStr} | ${formatFileSize(f.size)}</div>
                    </div>
                    <div style="display: flex; gap: 5px;">
                        <span style="color: #4285f4; font-size: 20px;">☁️</span>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error('[GDrive] Load files error:', error);
    }
}

console.log('[Backup System] Loaded ✅');

// ===== شاشة الأدمن - لوحة مراقبة الشركة =====

let _adminDashStockData = null; // لحفظ بيانات المخزون للبحث

async function loadAdminDashboard() {
    // هذه الصفحة أونلاين فقط
    if (!_realOnlineStatus) {
        document.getElementById('adminDashOverallStats').innerHTML = `
            <div style="grid-column: 1 / -1; background: #fff3cd; padding: 20px; border-radius: 12px; text-align: center; color: #856404; font-size: 16px;">
                ⚠️ هذه الصفحة تعمل أونلاين فقط. يرجى الاتصال بالإنترنت.
            </div>`;
        document.getElementById('adminDashInvoicesTable').innerHTML = '';
        document.getElementById('adminDashStockTable').innerHTML = '';
        return;
    }

    // تحميل البيانات بالتوازي
    await Promise.all([
        loadAdminDashInvoices(),
        loadAdminDashStock(),
        loadAdminDashShiftPerformance()
    ]);
}

async function loadAdminDashInvoices() {
    try {
        const response = await fetch(`${API_URL}/api/admin-dashboard/invoices-summary`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error);

        const overall = data.overall;
        const branches = data.branches;

        // بطاقات الإحصائيات العامة
        document.getElementById('adminDashOverallStats').innerHTML = `
            <div style="background: linear-gradient(135deg, #667eea, #764ba2); padding: 20px; border-radius: 14px; color: white; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${overall.total_invoices}</div>
                <div style="opacity: 0.9; font-size: 14px; margin-top: 5px;">إجمالي الفواتير</div>
            </div>
            <div style="background: linear-gradient(135deg, #11998e, #38ef7d); padding: 20px; border-radius: 14px; color: white; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${Number(overall.total_sales).toFixed(2)}</div>
                <div style="opacity: 0.9; font-size: 14px; margin-top: 5px;">إجمالي المبيعات</div>
            </div>
            <div style="background: linear-gradient(135deg, #f093fb, #f5576c); padding: 20px; border-radius: 14px; color: white; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${overall.today_invoices}</div>
                <div style="opacity: 0.9; font-size: 14px; margin-top: 5px;">فواتير اليوم</div>
            </div>
            <div style="background: linear-gradient(135deg, #4facfe, #00f2fe); padding: 20px; border-radius: 14px; color: white; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${Number(overall.today_sales).toFixed(2)}</div>
                <div style="opacity: 0.9; font-size: 14px; margin-top: 5px;">مبيعات اليوم</div>
            </div>
            <div style="background: linear-gradient(135deg, #fa709a, #fee140); padding: 20px; border-radius: 14px; color: white; text-align: center;">
                <div style="font-size: 32px; font-weight: bold;">${overall.cancelled_invoices}</div>
                <div style="opacity: 0.9; font-size: 14px; margin-top: 5px;">الفواتير الملغية</div>
            </div>
        `;

        // جدول الفواتير حسب الفروع
        if (branches.length === 0) {
            document.getElementById('adminDashInvoicesTable').innerHTML = '<div style="padding: 20px; text-align: center; color: #a0aec0;">لا توجد فروع</div>';
            return;
        }

        let tableHtml = `
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <thead>
                    <tr style="background: #f7fafc;">
                        <th style="padding: 12px 15px; text-align: right; border-bottom: 2px solid #e2e8f0; color: #4a5568;">الفرع</th>
                        <th style="padding: 12px 15px; text-align: center; border-bottom: 2px solid #e2e8f0; color: #4a5568;">إجمالي الفواتير</th>
                        <th style="padding: 12px 15px; text-align: center; border-bottom: 2px solid #e2e8f0; color: #4a5568;">إجمالي المبيعات</th>
                        <th style="padding: 12px 15px; text-align: center; border-bottom: 2px solid #e2e8f0; color: #4a5568;">فواتير اليوم</th>
                        <th style="padding: 12px 15px; text-align: center; border-bottom: 2px solid #e2e8f0; color: #4a5568;">مبيعات اليوم</th>
                        <th style="padding: 12px 15px; text-align: center; border-bottom: 2px solid #e2e8f0; color: #4a5568;">الملغية</th>
                    </tr>
                </thead>
                <tbody>`;

        branches.forEach((b, idx) => {
            const bgColor = idx % 2 === 0 ? '#ffffff' : '#f7fafc';
            tableHtml += `
                <tr style="background: ${bgColor};">
                    <td style="padding: 12px 15px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">🏢 ${escHTML(b.branch_name)}</td>
                    <td style="padding: 12px 15px; text-align: center; border-bottom: 1px solid #e2e8f0; color: #4a5568;">${b.total_invoices}</td>
                    <td style="padding: 12px 15px; text-align: center; border-bottom: 1px solid #e2e8f0; color: #38a169; font-weight: bold;">${Number(b.total_sales).toFixed(2)}</td>
                    <td style="padding: 12px 15px; text-align: center; border-bottom: 1px solid #e2e8f0; color: #667eea; font-weight: bold;">${b.today_invoices}</td>
                    <td style="padding: 12px 15px; text-align: center; border-bottom: 1px solid #e2e8f0; color: #38a169;">${Number(b.today_sales).toFixed(2)}</td>
                    <td style="padding: 12px 15px; text-align: center; border-bottom: 1px solid #e2e8f0; color: ${b.cancelled_invoices > 0 ? '#e53e3e' : '#a0aec0'};">${b.cancelled_invoices}</td>
                </tr>`;
        });

        tableHtml += '</tbody></table>';
        document.getElementById('adminDashInvoicesTable').innerHTML = tableHtml;

    } catch (error) {
        console.error('[AdminDash] Invoices error:', error);
        document.getElementById('adminDashInvoicesTable').innerHTML = `<div style="padding: 20px; text-align: center; color: #e53e3e;">خطأ في تحميل بيانات الفواتير: ${error.message}</div>`;
    }
}

async function loadAdminDashStock() {
    try {
        const response = await fetch(`${API_URL}/api/admin-dashboard/stock-summary`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error);

        _adminDashStockData = data;
        renderAdminDashStockTable(data.branches, data.products);

    } catch (error) {
        console.error('[AdminDash] Stock error:', error);
        document.getElementById('adminDashStockTable').innerHTML = `<div style="padding: 20px; text-align: center; color: #e53e3e;">خطأ في تحميل بيانات المخزون: ${error.message}</div>`;
    }
}

function renderAdminDashStockTable(branches, products) {
    if (!branches || branches.length === 0) {
        document.getElementById('adminDashStockTable').innerHTML = '<div style="padding: 20px; text-align: center; color: #a0aec0;">لا توجد فروع</div>';
        return;
    }
    if (!products || products.length === 0) {
        document.getElementById('adminDashStockTable').innerHTML = '<div style="padding: 20px; text-align: center; color: #a0aec0;">لا توجد منتجات</div>';
        return;
    }

    let html = `
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead>
                <tr style="background: #f7fafc;">
                    <th style="padding: 12px 15px; text-align: right; border-bottom: 2px solid #e2e8f0; color: #4a5568; position: sticky; right: 0; background: #f7fafc; min-width: 180px;">المنتج</th>
                    <th style="padding: 12px 15px; text-align: right; border-bottom: 2px solid #e2e8f0; color: #4a5568; min-width: 100px;">التصنيف</th>`;

    branches.forEach(b => {
        html += `<th style="padding: 12px 15px; text-align: center; border-bottom: 2px solid #e2e8f0; color: #4a5568; min-width: 120px;">🏢 ${escHTML(b.name)}</th>`;
    });

    html += `<th style="padding: 12px 15px; text-align: center; border-bottom: 2px solid #e2e8f0; color: #4a5568; min-width: 100px; background: #edf2f7;">الإجمالي</th>
            </tr>
            </thead>
            <tbody>`;

    products.forEach((p, idx) => {
        const bgColor = idx % 2 === 0 ? '#ffffff' : '#f7fafc';
        let totalStock = 0;

        html += `<tr style="background: ${bgColor};">
            <td style="padding: 10px 15px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748; position: sticky; right: 0; background: ${bgColor};">${escHTML(p.name)}</td>
            <td style="padding: 10px 15px; border-bottom: 1px solid #e2e8f0; color: #718096;">${escHTML(p.category) || '-'}</td>`;

        branches.forEach(b => {
            const branchData = p.branches[b.id];
            const stock = branchData ? branchData.stock : 0;
            totalStock += stock;

            let stockColor = '#2d3748';
            let stockBg = '';
            if (stock === 0) {
                stockColor = '#e53e3e';
                stockBg = 'background: #fff5f5;';
            } else if (stock <= 5) {
                stockColor = '#dd6b20';
                stockBg = 'background: #fffaf0;';
            }

            html += `<td style="padding: 10px 15px; text-align: center; border-bottom: 1px solid #e2e8f0; color: ${stockColor}; font-weight: bold; ${stockBg}">${stock}</td>`;
        });

        html += `<td style="padding: 10px 15px; text-align: center; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #667eea; background: #edf2f7;">${totalStock}</td>`;
        html += '</tr>';
    });

    html += '</tbody></table>';
    document.getElementById('adminDashStockTable').innerHTML = html;
}

function filterAdminDashStock() {
    if (!_adminDashStockData) return;
    const searchTerm = document.getElementById('adminDashStockSearch').value.trim().toLowerCase();

    if (!searchTerm) {
        renderAdminDashStockTable(_adminDashStockData.branches, _adminDashStockData.products);
        return;
    }

    const filtered = _adminDashStockData.products.filter(p =>
        p.name.toLowerCase().includes(searchTerm) ||
        (p.category && p.category.toLowerCase().includes(searchTerm))
    );
    renderAdminDashStockTable(_adminDashStockData.branches, filtered);
}

console.log('[Admin Dashboard] Loaded ✅');

// ===== XBRL / IFRS =====

let _xbrlFinancialData = null;
let _xbrlLastXML = null;

async function loadXBRLTab() {
    // تعيين التواريخ الافتراضية (بداية ونهاية السنة الحالية)
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    document.getElementById('xbrl_period_start').valueAsDate = startOfYear;
    document.getElementById('xbrl_period_end').valueAsDate = now;

    // جلب بيانات الشركة المحفوظة
    try {
        const res = await fetch('/api/xbrl/company-info');
        const data = await res.json();
        if (data.success && data.data) {
            const c = data.data;
            document.getElementById('xbrl_company_name_ar').value = c.company_name_ar || '';
            document.getElementById('xbrl_company_name_en').value = c.company_name_en || '';
            document.getElementById('xbrl_cr_number').value = c.commercial_registration || '';
            document.getElementById('xbrl_tax_number').value = c.tax_number || '';
            document.getElementById('xbrl_currency').value = c.reporting_currency || 'SAR';
            document.getElementById('xbrl_sector').value = c.industry_sector || 'تجارة تجزئة';
            document.getElementById('xbrl_country').value = c.country || 'SA';
            document.getElementById('xbrl_legal_form').value = c.legal_form || 'مؤسسة فردية';
            document.getElementById('xbrl_fiscal_year_end').value = c.fiscal_year_end || '12-31';
            document.getElementById('xbrl_email').value = c.contact_email || '';
            document.getElementById('xbrl_phone').value = c.contact_phone || '';
            document.getElementById('xbrl_address').value = c.address || '';
        }
    } catch (e) {
        console.log('[XBRL] Could not load company info:', e);
    }

    // جلب التقارير المحفوظة
    loadXBRLSavedReports();
}

async function saveXBRLCompanyInfo() {
    try {
        const body = {
            company_name_ar: document.getElementById('xbrl_company_name_ar').value,
            company_name_en: document.getElementById('xbrl_company_name_en').value,
            commercial_registration: document.getElementById('xbrl_cr_number').value,
            tax_number: document.getElementById('xbrl_tax_number').value,
            reporting_currency: document.getElementById('xbrl_currency').value,
            industry_sector: document.getElementById('xbrl_sector').value,
            country: document.getElementById('xbrl_country').value,
            fiscal_year_end: document.getElementById('xbrl_fiscal_year_end').value,
            legal_form: document.getElementById('xbrl_legal_form').value,
            contact_email: document.getElementById('xbrl_email').value,
            contact_phone: document.getElementById('xbrl_phone').value,
            address: document.getElementById('xbrl_address').value
        };
        const res = await fetch('/api/xbrl/company-info', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ تم حفظ بيانات الشركة بنجاح');
        } else {
            alert('❌ خطأ: ' + data.error);
        }
    } catch (e) {
        alert('❌ خطأ في الاتصال: ' + e.message);
    }
}

async function loadXBRLFinancialData() {
    const startDate = document.getElementById('xbrl_period_start').value;
    const endDate = document.getElementById('xbrl_period_end').value;
    if (!startDate || !endDate) {
        alert('⚠️ يرجى تحديد فترة التقرير');
        return;
    }

    try {
        const res = await fetch(`/api/xbrl/financial-data?start_date=${startDate}&end_date=${endDate}`);
        const data = await res.json();
        if (!data.success) {
            alert('❌ خطأ: ' + data.error);
            return;
        }

        _xbrlFinancialData = data.data;
        document.getElementById('xbrl_income_section').style.display = 'block';

        // تعبئة المخزون
        document.getElementById('xbrl_inventory_val').value = (_xbrlFinancialData.inventory.value || 0).toFixed(2);

        // تعبئة التدفقات النقدية التلقائية من بيانات النظام
        const d = _xbrlFinancialData;
        document.getElementById('xbrl_cf_customers').value = (d.revenue.total_revenue || 0).toFixed(2);
        document.getElementById('xbrl_cf_suppliers').value = (d.cost_of_sales || 0).toFixed(2);
        document.getElementById('xbrl_cf_employees').value = (d.operating_expenses.salaries || 0).toFixed(2);

        // بناء جدول قائمة الدخل
        renderXBRLIncomeTable();
        recalcXBRLBalanceSheet();
        recalcXBRLCashFlow();
        recalcXBRLEquityChanges();
    } catch (e) {
        alert('❌ خطأ في جلب البيانات: ' + e.message);
    }
}

function renderXBRLIncomeTable() {
    if (!_xbrlFinancialData) return;
    const d = _xbrlFinancialData;
    const currency = document.getElementById('xbrl_currency').value || 'SAR';

    const otherIncome = parseFloat(document.getElementById('xbrl_other_income').value) || 0;
    const additionalExp = parseFloat(document.getElementById('xbrl_additional_expenses').value) || 0;
    const depreciation = parseFloat(document.getElementById('xbrl_depreciation').value) || 0;
    const financeCosts = parseFloat(document.getElementById('xbrl_finance_costs').value) || 0;
    const zakat = parseFloat(document.getElementById('xbrl_zakat').value) || 0;

    const totalRevenue = (d.revenue.total_revenue || 0) + otherIncome;
    const cogs = d.cost_of_sales || 0;
    const grossProfit = totalRevenue - cogs;
    const totalOpex = (d.operating_expenses.total || 0) + additionalExp + depreciation;
    const operatingProfit = grossProfit - totalOpex;
    const profitBeforeTax = operatingProfit - financeCosts;
    const netProfit = profitBeforeTax - zakat;

    const fmt = (n) => n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    const rows = [
        {label: 'الإيرادات (Revenue)', ifrs: 'ifrs-full:Revenue', system: d.revenue.total_revenue, manual: otherIncome, total: totalRevenue, bold: true, color: '#2b6cb0'},
        {label: '  منها: إيرادات المبيعات', ifrs: 'IFRS 15', system: d.revenue.gross_revenue, manual: 0, total: d.revenue.gross_revenue, indent: true, color: '#718096'},
        {label: '  منها: خصومات', ifrs: '', system: -(d.revenue.total_discounts || 0), manual: 0, total: -(d.revenue.total_discounts || 0), indent: true, color: '#e53e3e'},
        {label: '  منها: رسوم التوصيل', ifrs: '', system: d.revenue.delivery_revenue, manual: 0, total: d.revenue.delivery_revenue, indent: true, color: '#718096'},
        {sep: true},
        {label: 'تكلفة المبيعات (Cost of Sales)', ifrs: 'ifrs-full:CostOfSales', system: -cogs, manual: 0, total: -cogs, bold: true, color: '#c53030'},
        {sep: true},
        {label: 'مجمل الربح (Gross Profit)', ifrs: 'ifrs-full:GrossProfit', system: null, manual: null, total: grossProfit, bold: true, color: grossProfit >= 0 ? '#38a169' : '#c53030', highlight: true},
        {sep: true},
        {label: 'المصاريف التشغيلية', ifrs: '', system: -(d.operating_expenses.total || 0), manual: -additionalExp, total: -(d.operating_expenses.total + additionalExp), bold: false, color: '#c53030'},
        {label: 'الاستهلاك والإطفاء', ifrs: 'IAS 16/38', system: 0, manual: -depreciation, total: -depreciation, color: '#c53030'},
        {sep: true},
        {label: 'ربح العمليات (Operating Profit)', ifrs: 'ifrs-full:ProfitLossFromOperatingActivities', system: null, manual: null, total: operatingProfit, bold: true, color: operatingProfit >= 0 ? '#38a169' : '#c53030', highlight: true},
        {sep: true},
        {label: 'تكاليف التمويل (Finance Costs)', ifrs: 'IFRS 9', system: 0, manual: -financeCosts, total: -financeCosts, color: '#c53030'},
        {label: 'الربح قبل الزكاة/الضريبة', ifrs: 'ifrs-full:ProfitLossBeforeTax', system: null, manual: null, total: profitBeforeTax, bold: true, color: profitBeforeTax >= 0 ? '#38a169' : '#c53030'},
        {label: 'الزكاة / ضريبة الدخل (IAS 12)', ifrs: 'ifrs-full:IncomeTaxExpense', system: 0, manual: -zakat, total: -zakat, color: '#c53030'},
        {sep: true},
        {label: 'صافي الربح (Net Profit)', ifrs: 'ifrs-full:ProfitLoss', system: null, manual: null, total: netProfit, bold: true, color: netProfit >= 0 ? '#38a169' : '#c53030', highlight: true, big: true},
    ];

    let html = '';
    rows.forEach(r => {
        if (r.sep) {
            html += '<tr><td colspan="5" style="border-bottom: 2px solid #e2e8f0; padding: 2px;"></td></tr>';
            return;
        }
        const bg = r.highlight ? 'background: #f7fafc;' : '';
        const fw = r.bold ? 'font-weight: bold;' : '';
        const fs = r.big ? 'font-size: 16px;' : '';
        const indent = r.indent ? 'padding-right: 30px;' : '';
        html += `<tr style="${bg}">
            <td style="padding: 10px 15px; ${fw} ${fs} ${indent} color: ${r.color};">${r.label}</td>
            <td style="padding: 10px 15px; font-size: 11px; color: #a0aec0; direction: ltr;">${r.ifrs}</td>
            <td style="padding: 10px 15px; text-align: center; color: #4a5568;">${r.system !== null ? fmt(r.system) : '-'}</td>
            <td style="padding: 10px 15px; text-align: center; color: #805ad5;">${r.manual !== null ? fmt(r.manual) : '-'}</td>
            <td style="padding: 10px 15px; text-align: center; ${fw} ${fs} color: ${r.color};">${fmt(r.total)} ${currency}</td>
        </tr>`;
    });

    document.getElementById('xbrl_income_tbody').innerHTML = html;

    // تحديث صافي الربح في قائمة التغيرات في حقوق الملكية
    document.getElementById('xbrl_eq_net_profit').value = netProfit.toFixed(2);
    recalcXBRLEquityChanges();
}

function recalcXBRLIncome() {
    renderXBRLIncomeTable();
}

function recalcXBRLBalanceSheet() {
    const val = (id) => parseFloat(document.getElementById(id).value) || 0;

    const cash = val('xbrl_cash');
    const receivables = val('xbrl_receivables');
    const inventoryVal = val('xbrl_inventory_val');
    const otherCA = val('xbrl_other_current_assets');
    const totalCA = cash + receivables + inventoryVal + otherCA;

    const ppe = val('xbrl_ppe');
    const intangibles = val('xbrl_intangibles');
    const otherNCA = val('xbrl_other_non_current_assets');
    const totalNCA = ppe + intangibles + otherNCA;

    const totalAssets = totalCA + totalNCA;

    const payables = val('xbrl_payables');
    const shortLoans = val('xbrl_short_loans');
    const otherCL = val('xbrl_other_current_liabilities');
    const totalCL = payables + shortLoans + otherCL;

    const longLoans = val('xbrl_long_loans');
    const otherNCL = val('xbrl_other_non_current_liabilities');
    const totalNCL = longLoans + otherNCL;

    const totalLiabilities = totalCL + totalNCL;

    const shareCapital = val('xbrl_share_capital');
    const retained = val('xbrl_retained_earnings');
    const otherEq = val('xbrl_other_equity');
    const totalEquity = shareCapital + retained + otherEq;

    const fmt = (n) => n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    document.getElementById('xbrl_total_current_assets').textContent = fmt(totalCA);
    document.getElementById('xbrl_total_non_current_assets').textContent = fmt(totalNCA);
    document.getElementById('xbrl_total_assets').textContent = fmt(totalAssets);
    document.getElementById('xbrl_total_current_liabilities').textContent = fmt(totalCL);
    document.getElementById('xbrl_total_non_current_liabilities').textContent = fmt(totalNCL);
    document.getElementById('xbrl_total_liabilities').textContent = fmt(totalLiabilities);
    document.getElementById('xbrl_total_equity').textContent = fmt(totalEquity);
    document.getElementById('xbrl_liabilities_equity').textContent = fmt(totalLiabilities + totalEquity);
}

function recalcXBRLCashFlow() {
    const val = (id) => parseFloat(document.getElementById(id).value) || 0;
    const fmt = (n) => n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    // تشغيلية
    const customers = val('xbrl_cf_customers');
    const suppliers = val('xbrl_cf_suppliers');
    const employees = val('xbrl_cf_employees');
    const otherOp = val('xbrl_cf_other_operating');
    const interest = val('xbrl_cf_interest_paid');
    const taxes = val('xbrl_cf_taxes_paid');
    const netOperating = customers - suppliers - employees + otherOp - interest - taxes;

    // استثمارية
    const ppePurchased = val('xbrl_cf_ppe_purchased');
    const ppeSold = val('xbrl_cf_ppe_sold');
    const invPurchased = val('xbrl_cf_inv_purchased');
    const invSold = val('xbrl_cf_inv_sold');
    const otherInv = val('xbrl_cf_other_investing');
    const netInvesting = ppeSold - ppePurchased + invSold - invPurchased + otherInv;

    // تمويلية
    const loansReceived = val('xbrl_cf_loans_received');
    const loansRepaid = val('xbrl_cf_loans_repaid');
    const capital = val('xbrl_cf_capital');
    const dividends = val('xbrl_cf_dividends');
    const otherFin = val('xbrl_cf_other_financing');
    const netFinancing = loansReceived - loansRepaid + capital - dividends + otherFin;

    const netChange = netOperating + netInvesting + netFinancing;
    const cashBeginning = val('xbrl_cash_beginning');
    const cashEnding = cashBeginning + netChange;

    document.getElementById('xbrl_net_cash_operating').textContent = fmt(netOperating);
    document.getElementById('xbrl_net_cash_operating').style.color = netOperating >= 0 ? '#38a169' : '#c53030';
    document.getElementById('xbrl_net_cash_investing').textContent = fmt(netInvesting);
    document.getElementById('xbrl_net_cash_investing').style.color = netInvesting >= 0 ? '#805ad5' : '#c53030';
    document.getElementById('xbrl_net_cash_financing').textContent = fmt(netFinancing);
    document.getElementById('xbrl_net_cash_financing').style.color = netFinancing >= 0 ? '#dd6b20' : '#c53030';
    document.getElementById('xbrl_net_change_cash').textContent = fmt(netChange);
    document.getElementById('xbrl_cash_ending').textContent = fmt(cashEnding);
}

// ===== بيانات الشركاء - XBRL =====
let _xbrlPartnerCount = 0;

function addXBRLPartner(data) {
    _xbrlPartnerCount++;
    const idx = _xbrlPartnerCount;
    const container = document.getElementById('xbrl_partners_container');
    const div = document.createElement('div');
    div.id = `xbrl_partner_${idx}`;
    div.style.cssText = 'background: #fef9ee; border: 2px solid #e67e2244; border-radius: 10px; padding: 15px; margin-bottom: 12px; position: relative;';
    div.innerHTML = `
        <button type="button" onclick="removeXBRLPartner(${idx})" style="position: absolute; top: 8px; left: 8px; background: #dc3545; color: white; border: none; border-radius: 50%; width: 26px; height: 26px; cursor: pointer; font-size: 14px;">✕</button>
        <div style="font-weight: bold; color: #e67e22; margin-bottom: 10px;">👤 شريك ${idx}</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
            <div class="form-group">
                <label style="font-size: 12px;">اسم الشريك:</label>
                <input type="text" class="xbrl-partner-name" value="${escHTML((data && data.name) || '')}" style="padding: 8px; border: 1px solid #cbd5e0; border-radius: 6px; width: 100%;">
            </div>
            <div class="form-group">
                <label style="font-size: 12px;">نسبة الملكية %:</label>
                <input type="number" class="xbrl-partner-share" step="0.01" value="${(data && data.share_percent) || 0}" onchange="recalcXBRLPartners()" style="padding: 8px; border: 1px solid #cbd5e0; border-radius: 6px; width: 100%;">
            </div>
            <div class="form-group">
                <label style="font-size: 12px;">رأس المال الافتتاحي:</label>
                <input type="number" class="xbrl-partner-capital-opening" step="0.01" value="${(data && data.capital_opening) || 0}" onchange="recalcXBRLPartners()" style="padding: 8px; border: 1px solid #cbd5e0; border-radius: 6px; width: 100%;">
            </div>
            <div class="form-group">
                <label style="font-size: 12px;">التوزيعات (مسحوبات):</label>
                <input type="number" class="xbrl-partner-distributions" step="0.01" value="${(data && data.distributions) || 0}" onchange="recalcXBRLPartners()" style="padding: 8px; border: 1px solid #cbd5e0; border-radius: 6px; width: 100%;">
            </div>
            <div class="form-group">
                <label style="font-size: 12px;">تغير رأس المال:</label>
                <input type="number" class="xbrl-partner-capital-change" step="0.01" value="${(data && data.capital_change) || 0}" onchange="recalcXBRLPartners()" style="padding: 8px; border: 1px solid #cbd5e0; border-radius: 6px; width: 100%;">
            </div>
            <div class="form-group">
                <label style="font-size: 12px;">نصيب الربح <span style="color: #48bb78;">✓ تلقائي</span>:</label>
                <input type="number" class="xbrl-partner-profit" step="0.01" value="0" readonly style="padding: 8px; border: 1px solid #48bb78; border-radius: 6px; width: 100%; background: #f0fff4;">
            </div>
        </div>
        <div style="text-align: left; margin-top: 8px; font-weight: bold; color: #2b6cb0;">
            الرصيد الختامي: <span class="xbrl-partner-closing" style="font-size: 16px;">0.00</span>
        </div>
    `;
    container.appendChild(div);
    recalcXBRLPartners();
}

function removeXBRLPartner(idx) {
    const div = document.getElementById(`xbrl_partner_${idx}`);
    if (div) div.remove();
    recalcXBRLPartners();
}

function recalcXBRLPartners() {
    const netProfit = parseFloat(document.getElementById('xbrl_eq_net_profit')?.value) || 0;
    const partnerDivs = document.querySelectorAll('#xbrl_partners_container > div');
    let totalDistributions = 0;

    partnerDivs.forEach(div => {
        const sharePct = parseFloat(div.querySelector('.xbrl-partner-share')?.value) || 0;
        const capitalOpening = parseFloat(div.querySelector('.xbrl-partner-capital-opening')?.value) || 0;
        const distributions = parseFloat(div.querySelector('.xbrl-partner-distributions')?.value) || 0;
        const capitalChange = parseFloat(div.querySelector('.xbrl-partner-capital-change')?.value) || 0;
        const profitShare = netProfit * (sharePct / 100);
        const closing = capitalOpening + profitShare - distributions + capitalChange;

        const profitInput = div.querySelector('.xbrl-partner-profit');
        if (profitInput) profitInput.value = profitShare.toFixed(2);
        const closingSpan = div.querySelector('.xbrl-partner-closing');
        if (closingSpan) closingSpan.textContent = closing.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

        totalDistributions += distributions;
    });

    // تحديث إجمالي التوزيعات في حقل الأرباح الموزعة
    const divField = document.getElementById('xbrl_eq_dividends');
    if (divField && totalDistributions > 0) {
        divField.value = totalDistributions.toFixed(2);
    }
    recalcXBRLEquityChanges();
}

function getXBRLPartnersData() {
    const partners = [];
    const partnerDivs = document.querySelectorAll('#xbrl_partners_container > div');
    partnerDivs.forEach(div => {
        partners.push({
            name: div.querySelector('.xbrl-partner-name')?.value || '',
            share_percent: parseFloat(div.querySelector('.xbrl-partner-share')?.value) || 0,
            capital_opening: parseFloat(div.querySelector('.xbrl-partner-capital-opening')?.value) || 0,
            distributions: parseFloat(div.querySelector('.xbrl-partner-distributions')?.value) || 0,
            capital_change: parseFloat(div.querySelector('.xbrl-partner-capital-change')?.value) || 0
        });
    });
    return partners;
}

function recalcXBRLEquityChanges() {
    const val = (id) => parseFloat(document.getElementById(id).value) || 0;
    const fmt = (n) => n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    const openingCapital = val('xbrl_eq_opening_capital');
    const openingRetained = val('xbrl_eq_opening_retained');
    const openingOther = val('xbrl_eq_opening_other');
    const openingTotal = openingCapital + openingRetained + openingOther;

    const netProfit = val('xbrl_eq_net_profit');
    const oci = val('xbrl_eq_oci');
    const newCapital = val('xbrl_eq_new_capital');
    const dividends = val('xbrl_eq_dividends');

    const closingCapital = openingCapital + newCapital;
    const closingRetained = openingRetained + netProfit - dividends;
    const closingOther = openingOther + oci;
    const closingTotal = closingCapital + closingRetained + closingOther;

    document.getElementById('xbrl_eq_opening_total').textContent = fmt(openingTotal);
    document.getElementById('xbrl_eq_closing_capital').textContent = fmt(closingCapital);
    document.getElementById('xbrl_eq_closing_retained').textContent = fmt(closingRetained);
    document.getElementById('xbrl_eq_closing_other').textContent = fmt(closingOther);
    document.getElementById('xbrl_eq_closing_total').textContent = fmt(closingTotal);
}

// ربط حقول المركز المالي بإعادة الحساب
document.addEventListener('DOMContentLoaded', () => {
    const bsFields = ['xbrl_cash', 'xbrl_receivables', 'xbrl_other_current_assets',
        'xbrl_ppe', 'xbrl_intangibles', 'xbrl_other_non_current_assets',
        'xbrl_payables', 'xbrl_short_loans', 'xbrl_other_current_liabilities',
        'xbrl_long_loans', 'xbrl_other_non_current_liabilities',
        'xbrl_share_capital', 'xbrl_retained_earnings', 'xbrl_other_equity'];
    bsFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', recalcXBRLBalanceSheet);
    });
});

async function generateXBRLReport() {
    if (!_xbrlFinancialData) {
        alert('⚠️ يرجى جلب البيانات المالية أولاً');
        return;
    }

    const periodStart = document.getElementById('xbrl_period_start').value;
    const periodEnd = document.getElementById('xbrl_period_end').value;
    if (!periodStart || !periodEnd) {
        alert('⚠️ يرجى تحديد فترة التقرير');
        return;
    }

    const val = (id) => parseFloat(document.getElementById(id).value) || 0;

    const companyInfo = {
        company_name_ar: document.getElementById('xbrl_company_name_ar').value,
        company_name_en: document.getElementById('xbrl_company_name_en').value,
        commercial_registration: document.getElementById('xbrl_cr_number').value,
        tax_number: document.getElementById('xbrl_tax_number').value,
        reporting_currency: document.getElementById('xbrl_currency').value,
        industry_sector: document.getElementById('xbrl_sector').value,
        country: document.getElementById('xbrl_country').value,
        legal_form: document.getElementById('xbrl_legal_form').value
    };

    const manualAdjustments = {
        other_income: val('xbrl_other_income'),
        additional_expenses: val('xbrl_additional_expenses'),
        depreciation: val('xbrl_depreciation'),
        finance_costs: val('xbrl_finance_costs'),
        zakat_tax: val('xbrl_zakat'),
        cash_equivalents: val('xbrl_cash'),
        trade_receivables: val('xbrl_receivables'),
        other_current_assets: val('xbrl_other_current_assets'),
        property_plant_equipment: val('xbrl_ppe'),
        intangible_assets: val('xbrl_intangibles'),
        other_non_current_assets: val('xbrl_other_non_current_assets'),
        trade_payables: val('xbrl_payables'),
        short_term_loans: val('xbrl_short_loans'),
        other_current_liabilities: val('xbrl_other_current_liabilities'),
        long_term_loans: val('xbrl_long_loans'),
        other_non_current_liabilities: val('xbrl_other_non_current_liabilities'),
        share_capital: val('xbrl_share_capital'),
        retained_earnings: val('xbrl_retained_earnings'),
        other_equity: val('xbrl_other_equity'),
        // تدفقات نقدية
        cf_customers_received: val('xbrl_cf_customers'),
        cf_suppliers_paid: val('xbrl_cf_suppliers'),
        cf_employees_paid: val('xbrl_cf_employees'),
        cf_other_operating: val('xbrl_cf_other_operating'),
        cf_interest_paid: val('xbrl_cf_interest_paid'),
        cf_taxes_paid: val('xbrl_cf_taxes_paid'),
        cf_ppe_purchased: val('xbrl_cf_ppe_purchased'),
        cf_ppe_sold: val('xbrl_cf_ppe_sold'),
        cf_investments_purchased: val('xbrl_cf_inv_purchased'),
        cf_investments_sold: val('xbrl_cf_inv_sold'),
        cf_other_investing: val('xbrl_cf_other_investing'),
        cf_loans_received: val('xbrl_cf_loans_received'),
        cf_loans_repaid: val('xbrl_cf_loans_repaid'),
        cf_capital_contributed: val('xbrl_cf_capital'),
        cf_dividends_paid: val('xbrl_cf_dividends'),
        cf_other_financing: val('xbrl_cf_other_financing'),
        cash_beginning: val('xbrl_cash_beginning'),
        // تغيرات حقوق الملكية
        equity_opening_capital: val('xbrl_eq_opening_capital'),
        equity_opening_other: val('xbrl_eq_opening_other'),
        equity_new_capital: val('xbrl_eq_new_capital'),
        dividends_declared: val('xbrl_eq_dividends'),
        other_comprehensive_income: val('xbrl_eq_oci'),
        // بيانات الشركاء
        partners: getXBRLPartnersData()
    };

    try {
        const res = await fetch('/api/xbrl/generate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                period_start: periodStart,
                period_end: periodEnd,
                financial_data: _xbrlFinancialData,
                company_info: companyInfo,
                manual_adjustments: manualAdjustments
            })
        });
        const data = await res.json();
        if (!data.success) {
            alert('❌ خطأ: ' + data.error);
            return;
        }

        _xbrlLastXML = data.xbrl_xml;
        const s = data.summary;
        const currency = companyInfo.reporting_currency;
        const fmt = (n) => (n || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

        // عرض النتائج
        document.getElementById('xbrl_results').style.display = 'block';
        document.getElementById('xbrl_download_btn').style.display = 'inline-block';
        document.getElementById('xbrl_report_period').textContent = `الفترة: ${periodStart} إلى ${periodEnd}`;

        // ملخص قائمة الدخل
        document.getElementById('xbrl_income_summary').innerHTML = `
            <table style="width: 100%; border-collapse: collapse;">
                <tr style="background: #f7fafc;"><td style="padding: 10px 15px; font-weight: bold;">الإيرادات</td><td style="padding: 10px 15px; text-align: left; color: #2b6cb0; font-weight: bold;">${fmt(s.total_revenue)} ${currency}</td></tr>
                <tr><td style="padding: 10px 15px;">تكلفة المبيعات</td><td style="padding: 10px 15px; text-align: left; color: #c53030;">(${fmt(s.cost_of_sales)}) ${currency}</td></tr>
                <tr style="background: #f7fafc;"><td style="padding: 10px 15px; font-weight: bold;">مجمل الربح</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: ${s.gross_profit >= 0 ? '#38a169' : '#c53030'};">${fmt(s.gross_profit)} ${currency}</td></tr>
                <tr><td style="padding: 10px 15px;">المصاريف التشغيلية</td><td style="padding: 10px 15px; text-align: left; color: #c53030;">(${fmt(s.operating_expenses)}) ${currency}</td></tr>
                <tr style="background: #f7fafc;"><td style="padding: 10px 15px; font-weight: bold;">ربح العمليات</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: ${s.operating_profit >= 0 ? '#38a169' : '#c53030'};">${fmt(s.operating_profit)} ${currency}</td></tr>
                <tr><td style="padding: 10px 15px;">تكاليف التمويل</td><td style="padding: 10px 15px; text-align: left; color: #c53030;">(${fmt(s.finance_costs)}) ${currency}</td></tr>
                <tr><td style="padding: 10px 15px;">الزكاة / الضريبة</td><td style="padding: 10px 15px; text-align: left; color: #c53030;">(${fmt(s.zakat_tax)}) ${currency}</td></tr>
                <tr style="background: #1a365d; color: white;"><td style="padding: 12px 15px; font-weight: bold; font-size: 16px;">صافي الربح</td><td style="padding: 12px 15px; text-align: left; font-weight: bold; font-size: 18px;">${fmt(s.net_profit)} ${currency}</td></tr>
            </table>`;

        // ملخص المركز المالي
        document.getElementById('xbrl_balance_summary').innerHTML = `
            <table style="width: 100%; border-collapse: collapse;">
                <tr style="background: #ebf8ff;"><td style="padding: 10px 15px; font-weight: bold; color: #2b6cb0;">إجمالي الأصول</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: #2b6cb0;">${fmt(s.total_assets)} ${currency}</td></tr>
                <tr style="background: #fff5f5;"><td style="padding: 10px 15px; font-weight: bold; color: #c53030;">إجمالي الخصوم</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: #c53030;">${fmt(s.total_liabilities)} ${currency}</td></tr>
                <tr style="background: #f0fff4;"><td style="padding: 10px 15px; font-weight: bold; color: #38a169;">حقوق الملكية</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: #38a169;">${fmt(s.total_equity)} ${currency}</td></tr>
            </table>`;

        // ملخص التدفقات النقدية
        document.getElementById('xbrl_cashflow_summary').innerHTML = `
            <table style="width: 100%; border-collapse: collapse;">
                <tr style="background: #f0fff4;"><td style="padding: 10px 15px; font-weight: bold; color: #38a169;">صافي النقد من الأنشطة التشغيلية</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: #38a169;">${fmt(s.net_cash_operating)} ${currency}</td></tr>
                <tr style="background: #faf5ff;"><td style="padding: 10px 15px; font-weight: bold; color: #805ad5;">صافي النقد من الأنشطة الاستثمارية</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: #805ad5;">${fmt(s.net_cash_investing)} ${currency}</td></tr>
                <tr style="background: #fffaf0;"><td style="padding: 10px 15px; font-weight: bold; color: #dd6b20;">صافي النقد من الأنشطة التمويلية</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: #dd6b20;">${fmt(s.net_cash_financing)} ${currency}</td></tr>
                <tr style="background: #1a365d; color: white;"><td style="padding: 12px 15px; font-weight: bold; font-size: 15px;">صافي التغير في النقد</td><td style="padding: 12px 15px; text-align: left; font-weight: bold; font-size: 16px;">${fmt(s.net_change_cash)} ${currency}</td></tr>
                <tr><td style="padding: 10px 15px; color: #718096;">رصيد النقد - بداية الفترة</td><td style="padding: 10px 15px; text-align: left; color: #718096;">${fmt(s.cash_beginning)} ${currency}</td></tr>
                <tr style="background: #2b6cb0; color: white;"><td style="padding: 12px 15px; font-weight: bold; font-size: 16px;">رصيد النقد - نهاية الفترة</td><td style="padding: 12px 15px; text-align: left; font-weight: bold; font-size: 18px;">${fmt(s.cash_ending)} ${currency}</td></tr>
            </table>`;

        // ملخص التغيرات في حقوق الملكية
        let equityHtml = `
            <table style="width: 100%; border-collapse: collapse;">
                <tr style="background: #ebf8ff;"><td style="padding: 10px 15px; font-weight: bold; color: #2b6cb0;">حقوق الملكية - بداية الفترة</td><td style="padding: 10px 15px; text-align: left; font-weight: bold; color: #2b6cb0;">${fmt(s.equity_opening_total)} ${currency}</td></tr>
                <tr><td style="padding: 10px 15px; color: #38a169;">+ صافي ربح الفترة</td><td style="padding: 10px 15px; text-align: left; color: #38a169;">${fmt(s.net_profit)} ${currency}</td></tr>
                <tr><td style="padding: 10px 15px; color: #805ad5;">+ الدخل الشامل الآخر</td><td style="padding: 10px 15px; text-align: left; color: #805ad5;">${fmt(s.other_comprehensive_income)} ${currency}</td></tr>
                <tr><td style="padding: 10px 15px; color: #c53030;">- أرباح موزعة (توزيعات على الشركاء)</td><td style="padding: 10px 15px; text-align: left; color: #c53030;">(${fmt(s.dividends_declared)}) ${currency}</td></tr>
                <tr style="background: #38a169; color: white;"><td style="padding: 12px 15px; font-weight: bold; font-size: 16px;">حقوق الملكية - نهاية الفترة</td><td style="padding: 12px 15px; text-align: left; font-weight: bold; font-size: 18px;">${fmt(s.equity_closing_total)} ${currency}</td></tr>
            </table>`;

        // تفصيل الشركاء
        if (s.partners && s.partners.length > 0) {
            equityHtml += `
            <h4 style="color: #e67e22; margin: 15px 0 8px;">👥 تفصيل حقوق الشركاء</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <tr style="background: #fef3c7;">
                    <th style="padding: 8px 10px; text-align: right; color: #92400e;">الشريك</th>
                    <th style="padding: 8px 10px; text-align: center; color: #92400e;">النسبة</th>
                    <th style="padding: 8px 10px; text-align: center; color: #92400e;">رأس المال</th>
                    <th style="padding: 8px 10px; text-align: center; color: #92400e;">نصيب الربح</th>
                    <th style="padding: 8px 10px; text-align: center; color: #92400e;">التوزيعات</th>
                    <th style="padding: 8px 10px; text-align: center; color: #92400e;">الرصيد الختامي</th>
                </tr>
                ${s.partners.map(p => `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 8px 10px; font-weight: bold;">${escHTML(p.name)}</td>
                    <td style="padding: 8px 10px; text-align: center;">${p.share_percent.toFixed(1)}%</td>
                    <td style="padding: 8px 10px; text-align: center;">${fmt(p.capital_opening)} ${currency}</td>
                    <td style="padding: 8px 10px; text-align: center; color: #38a169;">${fmt(p.profit_share)} ${currency}</td>
                    <td style="padding: 8px 10px; text-align: center; color: #c53030;">(${fmt(p.distributions)}) ${currency}</td>
                    <td style="padding: 8px 10px; text-align: center; font-weight: bold; color: #2b6cb0;">${fmt(p.capital_closing)} ${currency}</td>
                </tr>`).join('')}
            </table>`;
        }
        document.getElementById('xbrl_equity_summary').innerHTML = equityHtml;

        // عرض XML
        document.getElementById('xbrl_xml_preview').textContent = data.xbrl_xml;

        // تحديث التقارير المحفوظة
        loadXBRLSavedReports();

        // تمرير للنتائج
        document.getElementById('xbrl_results').scrollIntoView({behavior: 'smooth'});
    } catch (e) {
        alert('❌ خطأ: ' + e.message);
    }
}

function downloadXBRLXML() {
    if (!_xbrlLastXML) {
        alert('⚠️ لا يوجد تقرير لتحميله');
        return;
    }
    const blob = new Blob([_xbrlLastXML], {type: 'text/html'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const companyEn = document.getElementById('xbrl_company_name_en').value || 'company';
    const periodEnd = document.getElementById('xbrl_period_end').value || 'report';
    a.href = url;
    a.download = `iXBRL_${companyEn.replace(/\s+/g, '_')}_${periodEnd}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function loadXBRLSavedReports() {
    try {
        const res = await fetch('/api/xbrl/reports');
        const data = await res.json();
        if (!data.success) return;

        const container = document.getElementById('xbrl_saved_reports');
        if (!data.reports || data.reports.length === 0) {
            container.innerHTML = '<p style="color: #a0aec0; text-align: center; padding: 20px;">لا توجد تقارير محفوظة بعد</p>';
            return;
        }

        let html = '<table style="width: 100%; border-collapse: collapse;">';
        html += '<thead><tr style="background: #f7fafc;">';
        html += '<th style="padding: 10px 15px; text-align: right; color: #4a5568;">رقم</th>';
        html += '<th style="padding: 10px 15px; text-align: right; color: #4a5568;">النوع</th>';
        html += '<th style="padding: 10px 15px; text-align: right; color: #4a5568;">الفترة</th>';
        html += '<th style="padding: 10px 15px; text-align: right; color: #4a5568;">تاريخ الإنشاء</th>';
        html += '<th style="padding: 10px 15px; text-align: center; color: #4a5568;">تحميل</th>';
        html += '</tr></thead><tbody>';

        data.reports.forEach(r => {
            html += `<tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 15px;">#${r.id}</td>
                <td style="padding: 10px 15px;">${r.report_type}</td>
                <td style="padding: 10px 15px;">${r.period_start} → ${r.period_end}</td>
                <td style="padding: 10px 15px;">${r.created_at || ''}</td>
                <td style="padding: 10px 15px; text-align: center;">
                    <button onclick="downloadSavedXBRL(${r.id})" style="background: #2b6cb0; color: white; border: none; padding: 6px 15px; border-radius: 6px; cursor: pointer;">⬇️ تحميل</button>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (e) {
        console.log('[XBRL] Error loading saved reports:', e);
    }
}

async function downloadSavedXBRL(reportId) {
    try {
        const res = await fetch(`/api/xbrl/reports/${reportId}`);
        const data = await res.json();
        if (!data.success || !data.report.xbrl_xml) {
            alert('❌ لا يمكن تحميل التقرير');
            return;
        }
        const blob = new Blob([data.report.xbrl_xml], {type: 'text/html'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `iXBRL_Report_${reportId}_${data.report.period_end}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('❌ خطأ: ' + e.message);
    }
}

console.log('[XBRL/IFRS] Loaded ✅');

// ===== نظام الشفتات =====

async function loadShiftsForUserForm() {
    try {
        const response = await fetch(`${API_URL}/api/shifts`);
        const data = await response.json();
        if (data.success) {
            const select = document.getElementById('userShift');
            if (select) {
                select.innerHTML = '<option value="">-- بدون شفت --</option>' +
                    data.shifts.filter(s => s.is_active).map(s =>
                        `<option value="${s.id}">${escHTML(s.name)}${s.start_time ? ` (${escHTML(s.start_time)} - ${escHTML(s.end_time)})` : ''}</option>`
                    ).join('');
            }
        }
    } catch (error) {
        console.error('[Shifts] loadShiftsForUserForm error:', error);
    }
}

function openShiftsManagement() {
    document.getElementById('shiftsManagementModal').classList.add('active');
    loadShiftsList();
}

function closeShiftsManagement() {
    document.getElementById('shiftsManagementModal').classList.remove('active');
}

async function loadShiftsList() {
    try {
        const response = await fetch(`${API_URL}/api/shifts`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error);

        const container = document.getElementById('shiftsListContainer');
        if (data.shifts.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #a0aec0; padding: 30px;">لا توجد شفتات. أضف شفت جديد.</div>';
            return;
        }

        container.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <thead>
                    <tr style="background: #f7fafc;">
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">الاسم</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">من</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">إلى</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">الحالة</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">قفل تلقائي</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">إجراءات</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.shifts.map(s => `
                        <tr style="border-bottom: 1px solid #e2e8f0;">
                            <td style="padding: 10px; font-weight: bold;">🕐 ${escHTML(s.name)}</td>
                            <td style="padding: 10px; text-align: center;">${escHTML(s.start_time) || '-'}</td>
                            <td style="padding: 10px; text-align: center;">${escHTML(s.end_time) || '-'}</td>
                            <td style="padding: 10px; text-align: center;">
                                <span style="padding: 3px 10px; border-radius: 12px; font-size: 12px; background: ${s.is_active ? '#c6f6d5' : '#fed7d7'}; color: ${s.is_active ? '#22543d' : '#9b2c2c'};">
                                    ${s.is_active ? 'نشط' : 'معطل'}
                                </span>
                            </td>
                            <td style="padding: 10px; text-align: center;">
                                <button onclick="toggleShiftAutoLock(${s.id}, ${s.auto_lock ? 0 : 1})" class="btn" style="font-size: 11px; padding: 4px 10px; background: ${s.auto_lock ? '#9b59b6' : '#95a5a6'};">${s.auto_lock ? '🔒 مفعل' : '🔓 معطل'}</button>
                            </td>
                            <td style="padding: 10px; text-align: center;">
                                <button onclick="toggleShiftActive(${s.id}, '${escHTML(s.name)}', '${escHTML(s.start_time)}', '${escHTML(s.end_time)}', ${s.is_active ? 0 : 1}, ${s.auto_lock || 0})" class="btn" style="font-size: 11px; padding: 4px 10px; background: ${s.is_active ? '#e67e22' : '#38a169'};">${s.is_active ? 'تعطيل' : 'تفعيل'}</button>
                                <button onclick="deleteShift(${s.id})" class="btn" style="font-size: 11px; padding: 4px 10px; background: #dc3545;">حذف</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    } catch (error) {
        document.getElementById('shiftsListContainer').innerHTML = `<div style="color: #dc3545; text-align: center; padding: 20px;">خطأ: ${escHTML(error.message)}</div>`;
    }
}

async function addNewShift() {
    const name = document.getElementById('newShiftName').value.trim();
    if (!name) { alert('أدخل اسم الشفت'); return; }
    const startTime = document.getElementById('newShiftStart').value;
    const endTime = document.getElementById('newShiftEnd').value;
    const autoLock = document.getElementById('newShiftAutoLock')?.checked ? 1 : 0;

    try {
        const response = await fetch(`${API_URL}/api/shifts`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, start_time: startTime, end_time: endTime, auto_lock: autoLock })
        });
        const data = await response.json();
        if (data.success) {
            document.getElementById('newShiftName').value = '';
            document.getElementById('newShiftStart').value = '';
            document.getElementById('newShiftEnd').value = '';
            if (document.getElementById('newShiftAutoLock')) document.getElementById('newShiftAutoLock').checked = false;
            loadShiftsList();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ في الاتصال');
    }
}

async function toggleShiftActive(id, name, startTime, endTime, newActive, autoLock) {
    try {
        const response = await fetch(`${API_URL}/api/shifts/${id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, start_time: startTime, end_time: endTime, is_active: newActive, auto_lock: autoLock || 0 })
        });
        const data = await response.json();
        if (data.success) loadShiftsList();
    } catch (error) {
        alert('خطأ في الاتصال');
    }
}

async function toggleShiftAutoLock(id, newAutoLock) {
    try {
        // جلب بيانات الشفت أولاً
        const res = await fetch(`${API_URL}/api/shifts`);
        const sData = await res.json();
        const shift = sData.shifts?.find(s => s.id === id);
        if (!shift) return;

        const response = await fetch(`${API_URL}/api/shifts/${id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name: shift.name,
                start_time: shift.start_time,
                end_time: shift.end_time,
                is_active: shift.is_active,
                auto_lock: newAutoLock
            })
        });
        const data = await response.json();
        if (data.success) loadShiftsList();
    } catch (error) {
        alert('خطأ في الاتصال');
    }
}

async function deleteShift(id) {
    if (!confirm('هل أنت متأكد من حذف هذا الشفت؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/shifts/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) loadShiftsList();
        else alert('خطأ: ' + data.error);
    } catch (error) {
        alert('خطأ في الاتصال');
    }
}

console.log('[Shifts] Loaded ✅');

// ===== قفل الشفت التلقائي =====

let _shiftLockInterval = null;

function startShiftLockChecker() {
    // إيقاف أي مؤقت سابق
    if (_shiftLockInterval) clearInterval(_shiftLockInterval);

    // لا تفعل شيئاً إذا لم يكن المستخدم مسجل دخول أو ليس له شفت
    if (!currentUser || !currentUser.shift_id) return;

    // المدير معفى من القفل
    if (currentUser.role === 'admin') return;

    // فحص كل 30 ثانية
    _shiftLockInterval = setInterval(checkShiftLock, 30000);
    // فحص فوري أيضاً
    setTimeout(checkShiftLock, 3000);
}

function stopShiftLockChecker() {
    if (_shiftLockInterval) {
        clearInterval(_shiftLockInterval);
        _shiftLockInterval = null;
    }
}

async function checkShiftLock() {
    if (!currentUser || !currentUser.shift_id) return;
    if (currentUser.role === 'admin') return;

    try {
        const response = await fetch(`${API_URL}/api/shifts/check-lock`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ shift_id: currentUser.shift_id })
        });
        const data = await response.json();

        if (data.success && data.locked) {
            // قفل النظام
            const overlay = document.getElementById('shiftLockOverlay');
            if (overlay) {
                overlay.style.display = 'flex';
                const msg = document.getElementById('shiftLockMessage');
                if (msg) {
                    msg.textContent = `الشفت "${data.shift_name}" انتهى في الساعة ${data.end_time} - الوقت الحالي: ${data.current_time}`;
                }
            }
            logAction('shift_lock', `تم قفل النظام - انتهاء شفت "${data.shift_name}" (${data.end_time})`);
            stopShiftLockChecker();
        }
    } catch (error) {
        // تجاهل أخطاء الاتصال - سنحاول مرة أخرى في الدورة التالية
        console.log('[ShiftLock] Check failed:', error.message);
    }
}

function logoutFromShiftLock() {
    // إخفاء overlay القفل
    const overlay = document.getElementById('shiftLockOverlay');
    if (overlay) overlay.style.display = 'none';

    // استدعاء دالة تسجيل الخروج الأصلية
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.click();
}

console.log('[ShiftLock] Loaded ✅');

// ===== تعديل الفواتير =====

// بيانات العناصر المعدلة
window._editInvoiceItems = [];

function closeEditInvoiceModal() {
    document.getElementById('editInvoiceModal').classList.remove('active');
}

function renderEditInvoiceItems(items) {
    const container = document.getElementById('editInvoiceItemsContainer');
    container.innerHTML = `
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead>
                <tr style="background: #667eea; color: white;">
                    <th style="padding: 8px; text-align: right;">المنتج</th>
                    <th style="padding: 8px; text-align: center; width: 80px;">الكمية</th>
                    <th style="padding: 8px; text-align: center; width: 100px;">السعر</th>
                    <th style="padding: 8px; text-align: center; width: 100px;">الإجمالي</th>
                    <th style="padding: 8px; text-align: center; width: 50px;">حذف</th>
                </tr>
            </thead>
            <tbody>
                ${items.map((item, i) => `
                    <tr style="border-bottom: 1px solid #e2e8f0;" data-index="${i}">
                        <td style="padding: 8px;">${escHTML(item.product_name)}${item.variant_name ? ` (${escHTML(item.variant_name)})` : ''}</td>
                        <td style="padding: 8px; text-align: center;">
                            <input type="number" value="${item.quantity}" min="1" style="width: 60px; text-align: center; border: 1px solid #e2e8f0; border-radius: 4px; padding: 4px;"
                                onchange="updateEditItemQty(${i}, this.value)">
                        </td>
                        <td style="padding: 8px; text-align: center;">
                            <input type="number" value="${item.price}" step="0.001" min="0" style="width: 80px; text-align: center; border: 1px solid #e2e8f0; border-radius: 4px; padding: 4px;"
                                onchange="updateEditItemPrice(${i}, this.value)">
                        </td>
                        <td style="padding: 8px; text-align: center; font-weight: bold;" id="editItemTotal_${i}">${(item.quantity * item.price).toFixed(3)}</td>
                        <td style="padding: 8px; text-align: center;">
                            <button onclick="removeEditItem(${i})" style="background: #dc3545; color: white; border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer;">✕</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

function openEditInvoiceModal() {
    if (!currentInvoice) return;
    const inv = currentInvoice;

    if (inv.order_status === 'منجز' && !window.userPermissions.canEditCompletedInvoices) {
        alert('لا تملك صلاحية تعديل فاتورة منجزة');
        return;
    }
    if (inv.cancelled) {
        alert('لا يمكن تعديل فاتورة ملغية');
        return;
    }

    document.getElementById('editInvoiceId').value = inv.id;
    document.getElementById('editInvCustomerName').value = inv.customer_name || '';
    document.getElementById('editInvCustomerPhone').value = inv.customer_phone || '';
    document.getElementById('editInvCustomerAddress').value = inv.customer_address || '';
    document.getElementById('editInvPaymentMethod').value = inv.payment_method || 'cash';
    document.getElementById('editInvDeliveryFee').value = inv.delivery_fee || 0;
    document.getElementById('editInvDiscount').value = inv.discount || 0;
    document.getElementById('editInvNotes').value = inv.notes || '';

    // نسخة عميقة من العناصر
    window._editInvoiceItems = (inv.items || []).map(item => ({...item}));
    renderEditInvoiceItems(window._editInvoiceItems);
    recalcEditInvoiceTotal();

    document.getElementById('invoiceViewModal').classList.remove('active');
    document.getElementById('editInvoiceModal').classList.add('active');
}

function updateEditItemQty(index, value) {
    const qty = parseInt(value) || 1;
    window._editInvoiceItems[index].quantity = qty;
    window._editInvoiceItems[index].total = qty * window._editInvoiceItems[index].price;
    const totalEl = document.getElementById(`editItemTotal_${index}`);
    if (totalEl) totalEl.textContent = window._editInvoiceItems[index].total.toFixed(3);
    recalcEditInvoiceTotal();
}

function updateEditItemPrice(index, value) {
    const price = parseFloat(value) || 0;
    window._editInvoiceItems[index].price = price;
    window._editInvoiceItems[index].total = window._editInvoiceItems[index].quantity * price;
    const totalEl = document.getElementById(`editItemTotal_${index}`);
    if (totalEl) totalEl.textContent = window._editInvoiceItems[index].total.toFixed(3);
    recalcEditInvoiceTotal();
}

function removeEditItem(index) {
    window._editInvoiceItems.splice(index, 1);
    renderEditInvoiceItems(window._editInvoiceItems);
    recalcEditInvoiceTotal();
}

function recalcEditInvoiceTotal() {
    const subtotal = window._editInvoiceItems.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const discount = parseFloat(document.getElementById('editInvDiscount').value) || 0;
    const deliveryFee = parseFloat(document.getElementById('editInvDeliveryFee').value) || 0;
    const total = subtotal - discount + deliveryFee;
    document.getElementById('editInvTotal').textContent = total.toFixed(3);
}

// ربط حقول الخصم والتوصيل بإعادة الحساب
document.getElementById('editInvDiscount')?.addEventListener('input', recalcEditInvoiceTotal);
document.getElementById('editInvDeliveryFee')?.addEventListener('input', recalcEditInvoiceTotal);

async function saveEditedInvoice() {
    const invoiceId = document.getElementById('editInvoiceId').value;
    if (!invoiceId) return;

    const items = window._editInvoiceItems;
    if (items.length === 0) {
        alert('لا يمكن حفظ فاتورة بدون عناصر');
        return;
    }

    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const discount = parseFloat(document.getElementById('editInvDiscount').value) || 0;
    const deliveryFee = parseFloat(document.getElementById('editInvDeliveryFee').value) || 0;
    const total = subtotal - discount + deliveryFee;

    const editData = {
        customer_name: document.getElementById('editInvCustomerName').value,
        customer_phone: document.getElementById('editInvCustomerPhone').value,
        customer_address: document.getElementById('editInvCustomerAddress').value,
        payment_method: document.getElementById('editInvPaymentMethod').value,
        delivery_fee: deliveryFee,
        discount: discount,
        subtotal: subtotal,
        total: total,
        notes: document.getElementById('editInvNotes').value,
        edited_by: currentUser.full_name,
        edited_by_id: currentUser.id,
        can_edit_completed: window.userPermissions.canEditCompletedInvoices,
        items: items.map(item => ({
            product_id: item.product_id,
            product_name: item.product_name,
            quantity: item.quantity,
            price: item.price,
            total: item.quantity * item.price,
            branch_stock_id: item.branch_stock_id,
            variant_id: item.variant_id || null,
            variant_name: item.variant_name || null
        }))
    };

    try {
        const response = await fetch(`${API_URL}/api/invoices/${invoiceId}/edit`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(editData)
        });
        const data = await response.json();
        if (data.success) {
            logAction('edit_invoice', `تعديل فاتورة رقم ${invoiceId}`, parseInt(invoiceId));
            alert('تم حفظ التعديلات بنجاح');
            closeEditInvoiceModal();
            // إعادة تحميل الفاتورة المعدلة
            await viewInvoiceDetails(parseInt(invoiceId));
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ في الاتصال: ' + error.message);
    }
}

console.log('[Invoice Edit] Loaded ✅');

// ===== أداء الشفتات - شاشة الأدمن =====

async function loadAdminDashShiftPerformance() {
    const container = document.getElementById('adminDashShiftPerformance');
    if (!container) return;

    try {
        const response = await fetch(`${API_URL}/api/admin-dashboard/shift-performance`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error);

        const { shift_stats, unassigned_employees } = data;

        if (shift_stats.length === 0 && unassigned_employees.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #a0aec0; padding: 20px;">لا توجد شفتات. أضف شفتات من إدارة المستخدمين.</div>';
            return;
        }

        let html = '';

        // بطاقات الشفتات
        html += '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 25px;">';
        shift_stats.forEach(ss => {
            const s = ss.shift;
            const st = ss.stats;
            html += `
                <div style="background: linear-gradient(135deg, #667eea22, #764ba222); border: 2px solid #667eea44; border-radius: 14px; padding: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                        <h4 style="margin: 0; color: #667eea; font-size: 16px;">🕐 ${escHTML(s.name)}</h4>
                        <span style="font-size: 12px; color: #718096;">${escHTML(s.start_time || '')} - ${escHTML(s.end_time || '')}</span>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                        <div style="background: white; padding: 10px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 22px; font-weight: bold; color: #667eea;">${st.total_invoices}</div>
                            <div style="font-size: 11px; color: #718096;">إجمالي الفواتير</div>
                        </div>
                        <div style="background: white; padding: 10px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 22px; font-weight: bold; color: #38a169;">${Number(st.total_sales).toFixed(2)}</div>
                            <div style="font-size: 11px; color: #718096;">إجمالي المبيعات</div>
                        </div>
                        <div style="background: white; padding: 10px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 22px; font-weight: bold; color: #e67e22;">${st.today_invoices}</div>
                            <div style="font-size: 11px; color: #718096;">فواتير اليوم</div>
                        </div>
                        <div style="background: white; padding: 10px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 22px; font-weight: bold; color: #4facfe;">${Number(st.today_sales).toFixed(2)}</div>
                            <div style="font-size: 11px; color: #718096;">مبيعات اليوم</div>
                        </div>
                    </div>
                    ${ss.employees.length > 0 ? `
                    <div style="font-size: 13px; font-weight: bold; color: #4a5568; margin-bottom: 8px;">موظفي الشفت:</div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead>
                            <tr style="background: #f7fafc;">
                                <th style="padding: 6px 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">الموظف</th>
                                <th style="padding: 6px 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">الفواتير</th>
                                <th style="padding: 6px 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">المبيعات</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${ss.employees.map(emp => `
                                <tr>
                                    <td style="padding: 5px 8px; border-bottom: 1px solid #f0f0f0;">${escHTML(emp.full_name)}</td>
                                    <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0;">${emp.invoice_count}</td>
                                    <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #38a169; font-weight: bold;">${Number(emp.total_sales).toFixed(2)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>` : '<div style="font-size: 12px; color: #a0aec0; text-align: center;">لا يوجد موظفين في هذا الشفت</div>'}
                </div>`;
        });
        html += '</div>';

        // موظفين بدون شفت
        if (unassigned_employees.length > 0) {
            html += `
                <div style="background: #fff3cd22; border: 2px solid #ffc10744; border-radius: 14px; padding: 20px;">
                    <h4 style="margin: 0 0 15px; color: #856404; font-size: 15px;">⚠️ موظفين بدون شفت</h4>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        <thead>
                            <tr style="background: #f7fafc;">
                                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">الموظف</th>
                                <th style="padding: 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">الفواتير</th>
                                <th style="padding: 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">المبيعات</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${unassigned_employees.map(emp => `
                                <tr>
                                    <td style="padding: 6px 8px; border-bottom: 1px solid #f0f0f0;">${escHTML(emp.full_name)}</td>
                                    <td style="padding: 6px 8px; text-align: center; border-bottom: 1px solid #f0f0f0;">${emp.invoice_count}</td>
                                    <td style="padding: 6px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #38a169; font-weight: bold;">${Number(emp.total_sales).toFixed(2)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>`;
        }

        container.innerHTML = html;
    } catch (error) {
        container.innerHTML = `<div style="color: #dc3545; text-align: center; padding: 20px;">خطأ في تحميل أداء الشفتات: ${escHTML(error.message)}</div>`;
    }
}

console.log('[Shift Performance] Loaded ✅');

// ===== نظام طلبات النقل المخزني (Stock Transfer Requests) =====

let _transferItems = []; // عناصر الطلب الحالي
let _transferBranches = []; // قائمة الفروع المحملة

const _transferStatusLabels = {
    'pending': '⏳ قيد الانتظار',
    'approved': '✅ تم التجهيز',
    'in_transit': '🚚 جاري التوصيل',
    'completed': '📦 مكتمل',
    'rejected': '❌ مرفوض'
};
const _transferStatusColors = {
    'pending': '#f39c12',
    'approved': '#27ae60',
    'in_transit': '#3498db',
    'completed': '#2ecc71',
    'rejected': '#e74c3c'
};

async function loadStockTransfers() {
    if (!_realOnlineStatus) {
        const c = document.getElementById('transfersTableContainer');
        if (c) c.innerHTML = '<div style="text-align:center; padding:40px; color:#92400e;"><div style="font-size:48px; margin-bottom:10px;">📴</div><p>غير متصل - لا يمكن تحميل طلبات النقل</p></div>';
        return;
    }
    try {
        const statusFilter = document.getElementById('transferStatusFilter')?.value || '';
        const branchFilter = document.getElementById('transferBranchFilter')?.value || '';

        const params = new URLSearchParams();
        if (statusFilter) params.set('status', statusFilter);
        if (branchFilter) params.set('branch_id', branchFilter);

        const response = await fetch(`${API_URL}/api/stock-transfers?${params.toString()}`);
        const data = await response.json();

        // تحميل قائمة الفروع للفلتر
        await _loadTransferBranchesFilter();

        // إخفاء/إظهار زر إنشاء الطلب حسب الصلاحية
        const createBtn = document.getElementById('createTransferBtn');
        if (createBtn) createBtn.style.display = window.userPermissions?.canCreateTransfer ? 'inline-block' : 'none';

        const container = document.getElementById('transfersTableContainer');
        const statsEl = document.getElementById('transfersStats');

        if (!data.success || !data.transfers || data.transfers.length === 0) {
            if (statsEl) statsEl.textContent = '';
            container.innerHTML = '<p style="text-align:center; padding:40px; color:#999;">لا توجد طلبات نقل</p>';
            return;
        }

        const transfers = data.transfers;
        if (statsEl) {
            const pending = transfers.filter(t => t.status === 'pending').length;
            const inTransit = transfers.filter(t => t.status === 'in_transit').length;
            statsEl.textContent = `الإجمالي: ${transfers.length} | قيد الانتظار: ${pending} | جاري التوصيل: ${inTransit}`;
        }

        let html = `<table class="data-table" style="font-size:13px;">
            <thead><tr>
                <th>رقم الطلب</th>
                <th>من (المصدر)</th>
                <th>إلى (الطالب)</th>
                <th>الحالة</th>
                <th>عدد الأصناف</th>
                <th>الطالب</th>
                <th>التاريخ</th>
                <th>إجراءات</th>
            </tr></thead><tbody>`;

        transfers.forEach(t => {
            const statusLabel = _transferStatusLabels[t.status] || t.status;
            const statusColor = _transferStatusColors[t.status] || '#666';
            const date = new Date(t.requested_at).toLocaleString('ar-EG');
            const itemCount = t.items ? t.items.length : 0;

            html += `<tr>
                <td style="font-weight:bold; color:#667eea;">${escHTML(t.transfer_number)}</td>
                <td>${escHTML(t.from_branch_name || '-')}</td>
                <td>${escHTML(t.to_branch_name || '-')}</td>
                <td><span style="padding:3px 10px; border-radius:12px; font-size:12px; background:${statusColor}22; color:${statusColor}; font-weight:bold;">${statusLabel}</span></td>
                <td style="text-align:center;">${itemCount}</td>
                <td>${escHTML(t.requested_by_name || '-')}</td>
                <td style="font-size:11px;">${date}</td>
                <td>
                    <button onclick="viewTransferDetails(${t.id})" class="btn" style="font-size:11px; padding:4px 10px; background:#667eea;">تفاصيل</button>
                    ${t.status === 'pending' && window.userPermissions?.canApproveTransfer && (currentUser.branch_id == t.from_branch_id) ?
                        `<button onclick="approveTransferPrompt(${t.id})" class="btn" style="font-size:11px; padding:4px 10px; background:#27ae60;">موافقة</button>
                         <button onclick="rejectTransferPrompt(${t.id})" class="btn" style="font-size:11px; padding:4px 10px; background:#e74c3c;">رفض</button>` : ''}
                    ${t.status === 'approved' && window.userPermissions?.canDeliverTransfer && (currentUser.branch_id == t.from_branch_id) ?
                        `<button onclick="pickupTransferPrompt(${t.id})" class="btn" style="font-size:11px; padding:4px 10px; background:#f39c12;">استلام سائق</button>` : ''}
                    ${t.status === 'in_transit' && window.userPermissions?.canCreateTransfer && (currentUser.branch_id == t.to_branch_id) ?
                        `<button onclick="receiveTransferPrompt(${t.id})" class="btn" style="font-size:11px; padding:4px 10px; background:#2ecc71;">تأكيد استلام</button>` : ''}
                    ${(t.status === 'pending' || t.status === 'rejected') && window.userPermissions?.canCreateTransfer && (currentUser.branch_id == t.to_branch_id) ?
                        `<button onclick="deleteTransferPrompt(${t.id})" class="btn" style="font-size:11px; padding:4px 10px; background:#dc3545;">حذف</button>` : ''}
                </td>
            </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (error) {
        console.error('[Transfers] Error:', error);
        document.getElementById('transfersTableContainer').innerHTML = `<p style="color:#dc3545; text-align:center;">خطأ: ${escHTML(error.message)}</p>`;
    }
}

async function _loadTransferBranchesFilter() {
    try {
        const res = await fetch(`${API_URL}/api/branches`);
        const data = await res.json();
        if (data.success) {
            _transferBranches = data.branches || [];
            const select = document.getElementById('transferBranchFilter');
            if (select && select.options.length <= 1) {
                _transferBranches.forEach(b => {
                    const opt = document.createElement('option');
                    opt.value = b.id;
                    opt.textContent = b.name;
                    select.appendChild(opt);
                });
            }
        }
    } catch (e) {}
}

// === إنشاء طلب نقل ===

async function showCreateTransfer() {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    _transferItems = [];
    document.getElementById('transferNotes').value = '';
    document.getElementById('transferItemsBody').innerHTML = '';
    document.getElementById('transferProductQty').value = '1';

    // تحميل الفروع + المنتجات بالتوازي
    try {
        const [branchRes, invRes] = await Promise.all([
            fetch(`${API_URL}/api/branches`),
            fetch(`${API_URL}/api/inventory`)
        ]);
        const branchData = await branchRes.json();
        const invData = await invRes.json();

        if (branchData.success) {
            _transferBranches = branchData.branches || [];
            const fromSelect = document.getElementById('transferFromBranch');
            const toSelect = document.getElementById('transferToBranch');
            const options = '<option value="">اختر الفرع</option>' +
                _transferBranches.map(b => `<option value="${b.id}">${escHTML(b.name)}</option>`).join('');
            fromSelect.innerHTML = options;
            toSelect.innerHTML = options;

            if (currentUser?.branch_id) {
                toSelect.value = currentUser.branch_id;
            }
        }

        // تحميل المنتجات في القائمة المنسدلة
        const productSelect = document.getElementById('transferProductSelect');
        let pOptions = '<option value="">-- اختر الصنف --</option>';
        if (invData.success && invData.inventory) {
            invData.inventory.forEach(p => {
                if (p.variants && p.variants.length > 0) {
                    p.variants.forEach(v => {
                        pOptions += `<option value="${p.id}|${v.id}|${escHTML(p.name)} - ${escHTML(v.name)}">${escHTML(p.name)} - ${escHTML(v.name)}</option>`;
                    });
                } else {
                    pOptions += `<option value="${p.id}|0|${escHTML(p.name)}">${escHTML(p.name)}</option>`;
                }
            });
        }
        productSelect.innerHTML = pOptions;
    } catch (e) {
        console.error('[Transfer] Load error:', e);
    }

    document.getElementById('createTransferModal').classList.add('active');
    renderTransferItems();
}

function closeCreateTransfer() {
    document.getElementById('createTransferModal').classList.remove('active');
}

function addTransferItemFromSelect() {
    const select = document.getElementById('transferProductSelect');
    const val = select.value;
    if (!val) { alert('اختر صنف من القائمة'); return; }

    const parts = val.split('|');
    const inventoryId = parseInt(parts[0]);
    const variantId = parseInt(parts[1]) || null;
    const productName = parts.slice(2).join('|');
    const qty = parseInt(document.getElementById('transferProductQty').value) || 1;

    // تحقق من التكرار
    const exists = _transferItems.find(i => i.inventory_id === inventoryId && i.variant_id === variantId);
    if (exists) {
        exists.quantity += qty;
        renderTransferItems();
        select.value = '';
        document.getElementById('transferProductQty').value = '1';
        return;
    }

    _transferItems.push({
        inventory_id: inventoryId,
        product_name: productName,
        variant_id: variantId,
        variant_name: variantId ? productName.split(' - ').slice(1).join(' - ') : '',
        quantity: qty
    });

    select.value = '';
    document.getElementById('transferProductQty').value = '1';
    renderTransferItems();
}

function renderTransferItems() {
    const tbody = document.getElementById('transferItemsBody');
    if (_transferItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#999;">لم تتم إضافة أصناف بعد</td></tr>';
        return;
    }

    tbody.innerHTML = _transferItems.map((item, idx) => `
        <tr style="border-bottom:1px solid #eee;">
            <td style="padding:8px;">${escHTML(item.product_name)}</td>
            <td style="padding:8px; text-align:center;">
                <input type="number" min="1" value="${item.quantity}" onchange="updateTransferItemQty(${idx}, this.value)" style="width:80px; padding:6px; text-align:center; border:1px solid #ddd; border-radius:6px;">
            </td>
            <td style="padding:8px; text-align:center;">
                <button onclick="removeTransferItem(${idx})" style="background:#e74c3c; color:#fff; border:none; padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px;">حذف</button>
            </td>
        </tr>
    `).join('');
}

function updateTransferItemQty(idx, val) {
    const qty = parseInt(val);
    if (qty > 0) _transferItems[idx].quantity = qty;
}

function removeTransferItem(idx) {
    _transferItems.splice(idx, 1);
    renderTransferItems();
}

async function submitTransferRequest() {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    const fromBranch = document.getElementById('transferFromBranch').value;
    const toBranch = document.getElementById('transferToBranch').value;
    const notes = document.getElementById('transferNotes').value.trim();

    if (!fromBranch) { alert('اختر الفرع المصدر'); return; }
    if (!toBranch) { alert('اختر الفرع الطالب'); return; }
    if (fromBranch === toBranch) { alert('لا يمكن النقل من وإلى نفس الفرع'); return; }
    if (_transferItems.length === 0) { alert('أضف صنف واحد على الأقل'); return; }

    try {
        const response = await fetch(`${API_URL}/api/stock-transfers`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                from_branch_id: parseInt(fromBranch),
                to_branch_id: parseInt(toBranch),
                requested_by: currentUser.id,
                requested_by_name: currentUser.full_name,
                notes: notes,
                items: _transferItems.map(i => ({
                    inventory_id: i.inventory_id,
                    product_name: i.product_name,
                    variant_id: i.variant_id,
                    variant_name: i.variant_name,
                    quantity: i.quantity
                }))
            })
        });
        const data = await response.json();
        if (data.success) {
            logAction('create_transfer', `إنشاء طلب نقل ${data.transfer_number} - ${_transferItems.length} أصناف`, data.id);
            alert(`تم إنشاء طلب النقل بنجاح\nرقم الطلب: ${data.transfer_number}`);
            closeCreateTransfer();
            loadStockTransfers();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ في الاتصال: ' + error.message);
    }
}

// === تفاصيل طلب النقل ===

async function viewTransferDetails(transferId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    try {
        const response = await fetch(`${API_URL}/api/stock-transfers/${transferId}`);
        const data = await response.json();
        if (!data.success) { alert('خطأ: ' + data.error); return; }

        const t = data.transfer;
        const statusLabel = _transferStatusLabels[t.status] || t.status;
        const statusColor = _transferStatusColors[t.status] || '#666';

        let html = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
                <div style="background:#f7fafc; padding:12px; border-radius:8px;">
                    <strong>رقم الطلب:</strong> <span style="color:#667eea; font-weight:bold;">${escHTML(t.transfer_number)}</span>
                </div>
                <div style="background:#f7fafc; padding:12px; border-radius:8px;">
                    <strong>الحالة:</strong> <span style="padding:3px 10px; border-radius:12px; font-size:12px; background:${statusColor}22; color:${statusColor}; font-weight:bold;">${statusLabel}</span>
                </div>
                <div style="background:#f7fafc; padding:12px; border-radius:8px;">
                    <strong>من:</strong> ${escHTML(t.from_branch_name || '-')}
                </div>
                <div style="background:#f7fafc; padding:12px; border-radius:8px;">
                    <strong>إلى:</strong> ${escHTML(t.to_branch_name || '-')}
                </div>
                <div style="background:#f7fafc; padding:12px; border-radius:8px;">
                    <strong>طلب بواسطة:</strong> ${escHTML(t.requested_by_name || '-')}
                </div>
                <div style="background:#f7fafc; padding:12px; border-radius:8px;">
                    <strong>تاريخ الطلب:</strong> ${new Date(t.requested_at).toLocaleString('ar-EG')}
                </div>`;

        if (t.approved_by_name) {
            html += `<div style="background:#e8f5e9; padding:12px; border-radius:8px;">
                <strong>${t.status === 'rejected' ? 'رفض بواسطة' : 'موافقة بواسطة'}:</strong> ${escHTML(t.approved_by_name)}
                ${t.approved_at ? ' - ' + new Date(t.approved_at).toLocaleString('ar-EG') : ''}
            </div>`;
        }
        if (t.driver_name) {
            html += `<div style="background:#e3f2fd; padding:12px; border-radius:8px;">
                <strong>السائق:</strong> ${escHTML(t.driver_name)}
                ${t.picked_up_at ? ' - استلم: ' + new Date(t.picked_up_at).toLocaleString('ar-EG') : ''}
            </div>`;
        }
        if (t.received_by_name) {
            html += `<div style="background:#e8f5e9; padding:12px; border-radius:8px;">
                <strong>استلم بواسطة:</strong> ${escHTML(t.received_by_name)}
                ${t.completed_at ? ' - ' + new Date(t.completed_at).toLocaleString('ar-EG') : ''}
            </div>`;
        }
        if (t.reject_reason) {
            html += `<div style="background:#ffebee; padding:12px; border-radius:8px; grid-column:1/3;">
                <strong>سبب الرفض:</strong> ${escHTML(t.reject_reason)}
            </div>`;
        }
        if (t.notes) {
            html += `<div style="background:#fff8e1; padding:12px; border-radius:8px; grid-column:1/3;">
                <strong>ملاحظات:</strong> ${escHTML(t.notes)}
            </div>`;
        }

        html += `</div>`;

        // جدول العناصر
        html += `<h3 style="margin-bottom:10px;">📦 الأصناف</h3>
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
                <thead><tr style="background:#f7fafc;">
                    <th style="padding:8px; text-align:right; border-bottom:2px solid #e2e8f0;">الصنف</th>
                    <th style="padding:8px; text-align:center; border-bottom:2px solid #e2e8f0;">الكمية المطلوبة</th>
                    <th style="padding:8px; text-align:center; border-bottom:2px solid #e2e8f0;">الكمية المعتمدة</th>
                    <th style="padding:8px; text-align:center; border-bottom:2px solid #e2e8f0;">الكمية المستلمة</th>
                </tr></thead><tbody>`;

        (t.items || []).forEach(item => {
            html += `<tr style="border-bottom:1px solid #eee;">
                <td style="padding:8px;">${escHTML(item.product_name)}${item.variant_name ? ' - <span style="color:#667eea;">' + escHTML(item.variant_name) + '</span>' : ''}</td>
                <td style="padding:8px; text-align:center;">${item.quantity_requested}</td>
                <td style="padding:8px; text-align:center;">${item.quantity_approved || '-'}</td>
                <td style="padding:8px; text-align:center;">${item.quantity_received || '-'}</td>
            </tr>`;
        });

        html += '</tbody></table>';

        // أزرار الإجراءات
        html += '<div style="margin-top:20px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">';
        // الفرع المرسل: موافقة + تسليم سائق | الفرع الطالب: تأكيد استلام
        const isFromBranch = currentUser.branch_id == t.from_branch_id;
        const isToBranch = currentUser.branch_id == t.to_branch_id;
        if (t.status === 'pending' && window.userPermissions?.canApproveTransfer && isFromBranch) {
            html += `<button onclick="approveTransferPrompt(${t.id})" class="btn" style="padding:10px 25px; background:#27ae60; font-size:14px;">✅ موافقة وتجهيز</button>`;
            html += `<button onclick="rejectTransferPrompt(${t.id})" class="btn" style="padding:10px 25px; background:#e74c3c; font-size:14px;">❌ رفض</button>`;
        }
        if (t.status === 'approved' && window.userPermissions?.canDeliverTransfer && isFromBranch) {
            html += `<button onclick="pickupTransferPrompt(${t.id})" class="btn" style="padding:10px 25px; background:#f39c12; font-size:14px;">🚗 استلام السائق</button>`;
        }
        if (t.status === 'in_transit' && window.userPermissions?.canCreateTransfer && isToBranch) {
            html += `<button onclick="receiveTransferPrompt(${t.id})" class="btn" style="padding:10px 25px; background:#2ecc71; font-size:14px;">📦 تأكيد الاستلام</button>`;
        }
        html += '</div>';

        document.getElementById('transferDetailsContent').innerHTML = html;
        document.getElementById('transferDetailsModal').classList.add('active');
    } catch (error) {
        alert('خطأ: ' + error.message);
    }
}

function closeTransferDetails() {
    document.getElementById('transferDetailsModal').classList.remove('active');
}

// === إجراءات Workflow ===

async function approveTransferPrompt(transferId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    if (!confirm('هل أنت متأكد من الموافقة على هذا الطلب؟\n\nسيتم خصم الكميات من مخزون الفرع المصدر.')) return;

    try {
        // جلب العناصر لتعيين الكميات المعتمدة
        const res = await fetch(`${API_URL}/api/stock-transfers/${transferId}`);
        const tData = await res.json();
        if (!tData.success) { alert('خطأ: ' + tData.error); return; }

        const approvedItems = tData.transfer.items.map(item => ({
            item_id: item.id,
            quantity_approved: item.quantity_requested
        }));

        const response = await fetch(`${API_URL}/api/stock-transfers/${transferId}/approve`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                approved_by: currentUser.id,
                approved_by_name: currentUser.full_name,
                user_branch_id: currentUser.branch_id,
                items: approvedItems
            })
        });
        const data = await response.json();
        if (data.success) {
            logAction('approve_transfer', `موافقة على طلب نقل #${transferId}`, transferId);
            alert('تمت الموافقة وتجهيز البضاعة');
            closeTransferDetails();
            loadStockTransfers();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ: ' + error.message);
    }
}

async function rejectTransferPrompt(transferId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    const reason = prompt('أدخل سبب الرفض:');
    if (reason === null) return;

    try {
        const response = await fetch(`${API_URL}/api/stock-transfers/${transferId}/reject`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                approved_by: currentUser.id,
                approved_by_name: currentUser.full_name,
                user_branch_id: currentUser.branch_id,
                reject_reason: reason
            })
        });
        const data = await response.json();
        if (data.success) {
            logAction('reject_transfer', `رفض طلب نقل #${transferId} - السبب: ${reason}`, transferId);
            alert('تم رفض الطلب');
            closeTransferDetails();
            loadStockTransfers();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ: ' + error.message);
    }
}

async function pickupTransferPrompt(transferId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    const driverName = prompt('أدخل اسم السائق:', '');
    if (driverName === null) return;
    if (!driverName.trim()) { alert('يجب إدخال اسم السائق'); return; }

    try {
        const response = await fetch(`${API_URL}/api/stock-transfers/${transferId}/pickup`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                driver_id: currentUser.id,
                driver_name: driverName.trim(),
                user_branch_id: currentUser.branch_id
            })
        });
        const data = await response.json();
        if (data.success) {
            logAction('pickup_transfer', `استلام سائق "${driverName.trim()}" لطلب نقل #${transferId}`, transferId);
            alert(`✅ تم تسجيل الاستلام - السائق: ${driverName.trim()}\nجاري التوصيل`);
            closeTransferDetails();
            loadStockTransfers();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ: ' + error.message);
    }
}

async function receiveTransferPrompt(transferId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    if (!confirm('هل تم استلام البضاعة بالكامل؟\n\nسيتم إضافة الكميات لمخزون فرعك وإكمال الطلب.')) return;

    try {
        // جلب العناصر لتعيين الكميات المستلمة
        const res = await fetch(`${API_URL}/api/stock-transfers/${transferId}`);
        const tData = await res.json();
        if (!tData.success) { alert('خطأ: ' + tData.error); return; }

        const receivedItems = tData.transfer.items.map(item => ({
            item_id: item.id,
            quantity_received: item.quantity_approved || item.quantity_requested
        }));

        const response = await fetch(`${API_URL}/api/stock-transfers/${transferId}/receive`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                received_by: currentUser.id,
                received_by_name: currentUser.full_name,
                user_branch_id: currentUser.branch_id,
                items: receivedItems
            })
        });
        const data = await response.json();
        if (data.success) {
            logAction('receive_transfer', `تأكيد استلام طلب نقل #${transferId}`, transferId);
            alert('تم تأكيد الاستلام - اكتمل الطلب بنجاح');
            closeTransferDetails();
            loadStockTransfers();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ: ' + error.message);
    }
}

async function deleteTransferPrompt(transferId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    if (!confirm('هل أنت متأكد من حذف هذا الطلب؟')) return;

    try {
        const response = await fetch(`${API_URL}/api/stock-transfers/${transferId}?user_branch_id=${currentUser.branch_id}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            logAction('delete_transfer', `حذف طلب نقل #${transferId}`, transferId);
            alert('تم حذف الطلب');
            closeTransferDetails();
            loadStockTransfers();
        } else {
            alert('خطأ: ' + data.error);
        }
    } catch (error) {
        alert('خطأ: ' + error.message);
    }
}

console.log('[Stock Transfers] Loaded ✅');

// ===== نظام الاشتراكات (مربوط بالمنتجات) =====

let _allSubscriptions = [];
let _allPlans = [];
let _planItems = []; // منتجات الفئة الحالية المؤقتة

const _subStatusLabels = { 'active': '✅ فعّال', 'expired': '⏳ منتهي', 'cancelled': '🚫 ملغي' };
const _subStatusColors = { 'active': '#28a745', 'expired': '#ffc107', 'cancelled': '#dc3545' };

async function loadSubscriptions() {
    if (!_realOnlineStatus) {
        const c = document.getElementById('subscriptionsTableContainer');
        if (c) c.innerHTML = '<div style="text-align:center; padding:40px; color:#92400e;"><div style="font-size:48px; margin-bottom:10px;">📴</div><p>غير متصل - لا يمكن تحميل الاشتراكات</p></div>';
        return;
    }
    try {
        const statusFilter = document.getElementById('subStatusFilter')?.value || '';
        const response = await fetch(`${API_URL}/api/customer-subscriptions?status=${statusFilter}`);
        const data = await response.json();
        if (data.success) {
            _allSubscriptions = data.subscriptions;
            renderSubscriptions(_allSubscriptions);
            // تحديث الداشبورد
            if (_allPlans.length > 0) renderCategoryDashboard();
            else {
                try {
                    const pRes = await fetch(`${API_URL}/api/subscription-plans`);
                    const pData = await pRes.json();
                    if (pData.success) { _allPlans = pData.plans; renderCategoryDashboard(); }
                } catch(e) {}
            }
        }
    } catch (error) {
        console.error('[Subscriptions] Error:', error);
        document.getElementById('subscriptionsTableContainer').innerHTML = '<p style="text-align:center; padding:40px; color:#dc3545;">خطأ في تحميل الاشتراكات</p>';
    }
}

function filterSubscriptions() {
    const search = (document.getElementById('subSearchInput')?.value || '').toLowerCase();
    if (!search) { renderSubscriptions(_allSubscriptions); return; }
    const filtered = _allSubscriptions.filter(s =>
        (s.customer_name || '').toLowerCase().includes(search) ||
        (s.customer_phone || '').includes(search) ||
        (s.subscription_code || '').toLowerCase().includes(search)
    );
    renderSubscriptions(filtered);
}

function renderSubscriptions(subs) {
    const container = document.getElementById('subscriptionsTableContainer');
    if (subs.length === 0) {
        container.innerHTML = '<p style="text-align:center; padding:40px; color:#6c757d;">لا توجد اشتراكات</p>';
        return;
    }
    const today = new Date().toISOString().split('T')[0];
    container.innerHTML = `
        <table class="data-table">
            <thead><tr>
                <th>الكود</th><th>العميل</th><th>الهاتف</th><th>الفئة</th>
                <th>المنتجات</th><th>من</th><th>إلى</th><th>الحالة</th><th>إجراءات</th>
            </tr></thead>
            <tbody>
                ${subs.map(s => {
                    const isExpired = s.status === 'active' && s.end_date < today;
                    const displayStatus = isExpired ? 'expired' : s.status;
                    const planItems = s.plan_items || [];
                    const redeemedMap = s.redeemed_map || {};
                    const totalItems = planItems.reduce((sum, it) => sum + it.quantity, 0);
                    const totalRedeemed = planItems.reduce((sum, it) => {
                        const key = `${it.product_id}_${it.variant_id || 0}`;
                        return sum + (redeemedMap[key] || 0);
                    }, 0);
                    return `<tr style="${displayStatus !== 'active' ? 'opacity:0.7;' : ''}">
                        <td><strong style="color:#667eea; font-family:monospace; font-size:14px;">${escHTML(s.subscription_code)}</strong></td>
                        <td>${escHTML(s.customer_name)}</td>
                        <td dir="ltr">${escHTML(s.customer_phone || '-')}</td>
                        <td>${escHTML(s.plan_name)}</td>
                        <td>
                            <span style="font-weight:bold; color:${totalRedeemed >= totalItems ? '#dc3545' : '#28a745'};">
                                ${totalRedeemed}/${totalItems}
                            </span>
                            <button onclick="showSubscriptionDetail(${s.id})" class="btn-sm" title="تفاصيل" style="margin-right:5px;">📋</button>
                        </td>
                        <td>${s.start_date}</td>
                        <td>${s.end_date}</td>
                        <td><span style="background:${_subStatusColors[displayStatus] || '#6c757d'}; color:white; padding:3px 10px; border-radius:12px; font-size:12px;">${_subStatusLabels[displayStatus] || displayStatus}</span></td>
                        <td>
                            ${displayStatus === 'active' ? `<button onclick="showRedeemForSub(${s.id})" class="btn-sm" title="استلام" style="background:#764ba2; color:white;">📦</button>` : ''}
                            ${displayStatus === 'active' ? `<button onclick="cancelSubscription(${s.id})" class="btn-sm btn-danger" title="إلغاء">🚫</button>` : ''}
                            ${window.userPermissions.canManageSubscriptions ? `<button onclick="deleteSubscription(${s.id})" class="btn-sm btn-danger" title="حذف">🗑️</button>` : ''}
                            <button onclick="renewSubscription(${s.id}, ${s.customer_id}, ${s.plan_id})" class="btn-sm" title="تجديد">🔄</button>
                        </td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
    `;
}

// --- عرض تفاصيل اشتراك ---

function showSubscriptionDetail(subId) {
    const sub = _allSubscriptions.find(s => s.id === subId);
    if (!sub) return;
    const planItems = sub.plan_items || [];
    const redeemedMap = sub.redeemed_map || {};
    const body = document.getElementById('subscriptionDetailBody');
    body.innerHTML = `
        <div style="background: linear-gradient(135deg, #667eea15, #764ba215); padding: 15px; border-radius: 10px; border: 2px solid #764ba2; margin-bottom: 15px;">
            <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                <div>
                    <div style="font-weight:bold; font-size:18px; color:#764ba2;">${escHTML(sub.plan_name)}</div>
                    <div>العميل: <strong>${escHTML(sub.customer_name)}</strong> | الهاتف: <strong dir="ltr">${escHTML(sub.customer_phone || '-')}</strong></div>
                    <div>الكود: <strong style="font-family:monospace; color:#667eea;">${escHTML(sub.subscription_code)}</strong></div>
                </div>
                <div style="text-align: left;">
                    <div>من: <strong>${sub.start_date}</strong></div>
                    <div>إلى: <strong>${sub.end_date}</strong></div>
                    <div>المدفوع: <strong style="color:#28a745;">${(sub.price_paid || 0).toFixed(3)} د.ك</strong></div>
                </div>
            </div>
        </div>
        <h3 style="margin-bottom: 10px;">📦 منتجات الاشتراك</h3>
        ${planItems.length === 0 ? '<p style="color:#6c757d;">لا توجد منتجات في هذه الفئة</p>' : `
        <table class="data-table">
            <thead><tr><th>المنتج</th><th>المتغير</th><th>المسموح</th><th>المستلم</th><th>المتبقي</th></tr></thead>
            <tbody>
                ${planItems.map(it => {
                    const key = `${it.product_id}_${it.variant_id || 0}`;
                    const redeemed = redeemedMap[key] || 0;
                    const remaining = it.quantity - redeemed;
                    return `<tr>
                        <td>${escHTML(it.product_name)}</td>
                        <td>${it.variant_name ? escHTML(it.variant_name) : '-'}</td>
                        <td style="font-weight:bold;">${it.quantity}</td>
                        <td style="color:#667eea; font-weight:bold;">${redeemed}</td>
                        <td style="font-weight:bold; color:${remaining > 0 ? '#28a745' : '#dc3545'};">${remaining}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>`}
        <div style="margin-top: 15px;">
            <button onclick="loadRedemptionHistory(${sub.id})" class="add-btn">📜 سجل الاستلامات</button>
        </div>
        <div id="redemptionHistoryContainer" style="margin-top: 10px;"></div>
    `;
    document.getElementById('subscriptionDetailModal').classList.add('active');
}

async function loadRedemptionHistory(subId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    try {
        const response = await fetch(`${API_URL}/api/subscription-redemptions/${subId}`);
        const data = await response.json();
        const container = document.getElementById('redemptionHistoryContainer');
        if (!data.success || !data.redemptions || data.redemptions.length === 0) {
            container.innerHTML = '<p style="color:#6c757d; text-align:center;">لا توجد استلامات بعد</p>';
            return;
        }
        container.innerHTML = `
            <table class="data-table">
                <thead><tr><th>المنتج</th><th>المتغير</th><th>الكمية</th><th>التاريخ</th><th>بواسطة</th></tr></thead>
                <tbody>
                    ${data.redemptions.map(r => `<tr>
                        <td>${escHTML(r.product_name)}</td>
                        <td>${r.variant_name ? escHTML(r.variant_name) : '-'}</td>
                        <td style="font-weight:bold;">${r.quantity}</td>
                        <td>${r.redeemed_at ? r.redeemed_at.replace('T', ' ').substring(0, 16) : '-'}</td>
                        <td>${escHTML(r.redeemed_by_name || '-')}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        `;
    } catch (error) { console.error('[Redemptions] Error:', error); }
}

// --- فئات الاشتراك ---

async function showManagePlans() {
    if (!window.userPermissions?.canManageSubscriptions) { alert('ليس لديك صلاحية'); return; }
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    document.getElementById('managePlansModal').classList.add('active');
    _planItems = [];
    renderPlanItems();
    await loadProductsForPlanPicker();
    await loadPlansList();
}

function closePlansModal() {
    document.getElementById('managePlansModal').classList.remove('active');
}

async function loadProductsForPlanPicker() {
    try {
        const branchId = (currentUser && currentUser.branch_id) ? currentUser.branch_id : 1;
        const response = await fetch(`${API_URL}/api/products?branch_id=${branchId}`);
        const data = await response.json();
        if (data.success && data.products) {
            const select = document.getElementById('planProductSelect');
            let options = '<option value="">-- اختر منتج --</option>';
            data.products.forEach(p => {
                if (p.variants && p.variants.length > 0) {
                    p.variants.forEach(v => {
                        options += `<option value="${p.id}|${v.id}|${escHTML(p.name + ' - ' + v.name)}">${escHTML(p.name)} - ${escHTML(v.name)} (مخزون: ${v.stock || 0})</option>`;
                    });
                } else {
                    options += `<option value="${p.id}|0|${escHTML(p.name)}">${escHTML(p.name)} (مخزون: ${p.stock || 0})</option>`;
                }
            });
            select.innerHTML = options;
        }
    } catch (error) { console.error('[Plans] Products load error:', error); }
}

function addProductToPlan() {
    const select = document.getElementById('planProductSelect');
    const val = select.value;
    if (!val) { alert('اختر منتج'); return; }
    const qty = parseInt(document.getElementById('planProductQty').value) || 1;
    const [productId, variantId, productName] = val.split('|');

    // التحقق من عدم التكرار
    const exists = _planItems.find(it => it.product_id == productId && (it.variant_id || 0) == (variantId || 0));
    if (exists) {
        exists.quantity += qty;
    } else {
        _planItems.push({
            product_id: parseInt(productId),
            variant_id: parseInt(variantId) || null,
            product_name: productName.split(' - ')[0],
            variant_name: parseInt(variantId) ? productName.split(' - ').slice(1).join(' - ') : null,
            quantity: qty
        });
    }
    renderPlanItems();
    select.value = '';
    document.getElementById('planProductQty').value = '1';
}

function removePlanItem(index) {
    _planItems.splice(index, 1);
    renderPlanItems();
}

function renderPlanItems() {
    const container = document.getElementById('planItemsList');
    if (!container) return;
    if (_planItems.length === 0) {
        container.innerHTML = '<p style="color:#6c757d; font-size:13px; margin:5px 0;">لم يتم إضافة منتجات بعد</p>';
        return;
    }
    container.innerHTML = _planItems.map((it, i) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; margin:3px 0; background:#f8f9fa; border-radius:6px; border:1px solid #e0e0e0;">
            <span>📦 ${escHTML(it.product_name)}${it.variant_name ? ' - ' + escHTML(it.variant_name) : ''} <strong style="color:#667eea;">x${it.quantity}</strong></span>
            <button onclick="removePlanItem(${i})" style="background:none; border:none; color:#dc3545; cursor:pointer; font-size:16px;">✖</button>
        </div>
    `).join('');
}

async function loadPlansList() {
    try {
        const response = await fetch(`${API_URL}/api/subscription-plans`);
        const data = await response.json();
        if (data.success) {
            _allPlans = data.plans;
            const container = document.getElementById('plansListContainer');
            if (_allPlans.length === 0) {
                container.innerHTML = '<p style="text-align:center; color:#6c757d;">لا توجد فئات</p>';
                return;
            }
            container.innerHTML = _allPlans.map(p => {
                const items = p.items || [];
                const cardImage = p.image ? `<img src="${p.image}" style="width:100%; height:100%; object-fit:cover;">` : _getDefaultCardBg(p.name);
                return `
                <div style="display:flex; gap:15px; align-items:start; background:#fff; border:2px solid #e0e0e0; border-radius:12px; padding:15px; margin-bottom:12px; flex-wrap:wrap;">
                    <div style="width:160px; height:100px; border-radius:10px; overflow:hidden; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,0.15);">
                        ${cardImage}
                    </div>
                    <div style="flex:1; min-width:200px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                            <div>
                                <strong style="font-size:16px; color:#1e40af;">${escHTML(p.name)}</strong>
                                ${p.description ? `<span style="color:#6c757d; margin-right:8px;">(${escHTML(p.description)})</span>` : ''}
                            </div>
                            <div style="display:flex; gap:5px; align-items:center;">
                                <span style="background:#28a745; color:white; padding:3px 10px; border-radius:12px; font-size:13px; font-weight:bold;">${p.price.toFixed(3)} د.ك</span>
                                <span style="background:#667eea; color:white; padding:3px 10px; border-radius:12px; font-size:13px;">${p.duration_days} يوم</span>
                                ${p.is_active ? '<span style="color:#28a745;">فعّال</span>' : '<span style="color:#dc3545;">معطّل</span>'}
                                <button onclick="togglePlan(${p.id}, ${p.is_active})" class="btn-sm">${p.is_active ? '⏸️' : '▶️'}</button>
                                <button onclick="deletePlan(${p.id})" class="btn-sm btn-danger">🗑️</button>
                            </div>
                        </div>
                        ${items.length > 0 ? `
                        <div style="margin-top:8px; padding-top:8px; border-top:1px solid #e0e0e0;">
                            <strong style="font-size:13px;">📦 المنتجات (${items.length}):</strong>
                            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
                                ${items.map(it => `
                                    <span style="background:#f0f9ff; border:1px solid #bae6fd; padding:4px 10px; border-radius:6px; font-size:12px;">
                                        ${escHTML(it.product_name)}${it.variant_name ? ' - ' + escHTML(it.variant_name) : ''} <strong style="color:#667eea;">x${it.quantity}</strong>
                                    </span>
                                `).join('')}
                            </div>
                        </div>` : '<div style="margin-top:8px; color:#ffc107; font-size:13px;">⚠️ لا توجد منتجات في هذه الفئة</div>'}
                    </div>
                </div>`;
            }).join('');
            // تحديث الداشبورد
            renderCategoryDashboard();
        }
    } catch (error) {
        console.error('[Plans] Error:', error);
    }
}

// === صورة الفئة ===

function _getDefaultCardBg(name) {
    const gradients = [
        'linear-gradient(135deg, #667eea, #764ba2)',
        'linear-gradient(135deg, #f093fb, #f5576c)',
        'linear-gradient(135deg, #4facfe, #00f2fe)',
        'linear-gradient(135deg, #43e97b, #38f9d7)',
        'linear-gradient(135deg, #fa709a, #fee140)',
        'linear-gradient(135deg, #a18cd1, #fbc2eb)',
        'linear-gradient(135deg, #fccb90, #d57eeb)',
        'linear-gradient(135deg, #e0c3fc, #8ec5fc)',
    ];
    const idx = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % gradients.length;
    return `<div style="width:100%; height:100%; background:${gradients[idx]}; display:flex; align-items:center; justify-content:center;">
        <span style="font-size:32px; text-shadow:0 2px 8px rgba(0,0,0,0.2);">💳</span>
    </div>`;
}

function handlePlanImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 500 * 1024) { alert('الحد الأقصى لحجم الصورة 500 كيلوبايت'); return; }
    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        document.getElementById('planImageData').value = dataUrl;
        document.getElementById('planImagePreview').innerHTML = `<img src="${dataUrl}" style="width:100%; height:100%; object-fit:cover;">`;
    };
    reader.readAsDataURL(file);
}

const _cardTemplates = [
    { name: 'بنفسجي', gradient: 'linear-gradient(135deg, #667eea, #764ba2)', icon: '💳' },
    { name: 'وردي', gradient: 'linear-gradient(135deg, #f093fb, #f5576c)', icon: '🌸' },
    { name: 'أزرق', gradient: 'linear-gradient(135deg, #4facfe, #00f2fe)', icon: '💎' },
    { name: 'أخضر', gradient: 'linear-gradient(135deg, #43e97b, #38f9d7)', icon: '🍀' },
    { name: 'ذهبي', gradient: 'linear-gradient(135deg, #f7971e, #ffd200)', icon: '⭐' },
    { name: 'فضي', gradient: 'linear-gradient(135deg, #bdc3c7, #2c3e50)', icon: '🔷' },
    { name: 'كلاسيكي', gradient: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)', icon: '👑' },
    { name: 'برونزي', gradient: 'linear-gradient(135deg, #c9920e, #8B6914)', icon: '🏆' },
];

function showPlanTemplates() {
    const grid = document.getElementById('planTemplatesGrid');
    if (grid.style.display !== 'none') { grid.style.display = 'none'; return; }
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
    grid.style.gap = '8px';
    grid.innerHTML = _cardTemplates.map((t, i) => `
        <div onclick="selectPlanTemplate(${i})" style="cursor:pointer; border-radius:10px; overflow:hidden; height:75px; box-shadow:0 2px 6px rgba(0,0,0,0.15); transition:transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
            <div style="width:100%; height:100%; background:${t.gradient}; display:flex; align-items:center; justify-content:center; flex-direction:column;">
                <span style="font-size:24px;">${t.icon}</span>
                <span style="color:white; font-size:11px; margin-top:4px; text-shadow:0 1px 3px rgba(0,0,0,0.3);">${t.name}</span>
            </div>
        </div>
    `).join('');
}

function selectPlanTemplate(index) {
    const t = _cardTemplates[index];
    // إنشاء صورة من التصميم باستخدام Canvas
    const canvas = document.createElement('canvas');
    canvas.width = 340;
    canvas.height = 214;
    const ctx = canvas.getContext('2d');

    // رسم الخلفية المتدرجة
    const colors = t.gradient.match(/#[a-fA-F0-9]{6}/g) || ['#667eea', '#764ba2'];
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 16);
    ctx.fill();

    // نمط زخرفي
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(280, 40, 80, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(60, 180, 60, 0, Math.PI * 2);
    ctx.fill();

    // خطوط بطاقة
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(30, 70, 50, 35);

    const dataUrl = canvas.toDataURL('image/png');
    document.getElementById('planImageData').value = dataUrl;
    document.getElementById('planImagePreview').innerHTML = `<img src="${dataUrl}" style="width:100%; height:100%; object-fit:cover;">`;
    document.getElementById('planTemplatesGrid').style.display = 'none';
}

// === داشبورد الفئات ===

function renderCategoryDashboard() {
    const container = document.getElementById('subCategoryDashboard');
    if (!container) return;
    const activePlans = _allPlans.filter(p => p.is_active);
    if (activePlans.length === 0) {
        container.innerHTML = '';
        return;
    }

    // إحصائيات لكل فئة
    const planStats = {};
    _allSubscriptions.forEach(s => {
        if (!planStats[s.plan_id]) planStats[s.plan_id] = { active: 0, total: 0 };
        planStats[s.plan_id].total++;
        if (s.status === 'active') planStats[s.plan_id].active++;
    });

    container.innerHTML = `
        <div style="display:flex; gap:15px; overflow-x:auto; padding:10px 0;">
            ${activePlans.map(p => {
                const stats = planStats[p.id] || { active: 0, total: 0 };
                const items = p.items || [];
                const totalProducts = items.reduce((s, it) => s + it.quantity, 0);
                const hasImage = p.image;
                return `
                <div onclick="filterByCategory(${p.id})" style="flex-shrink:0; width:270px; height:170px; border-radius:14px; overflow:hidden; cursor:pointer; position:relative; box-shadow:0 4px 15px rgba(0,0,0,0.2); transition:transform 0.2s, box-shadow 0.2s;" onmouseover="this.style.transform='translateY(-4px)'; this.style.boxShadow='0 8px 25px rgba(0,0,0,0.3)'" onmouseout="this.style.transform=''; this.style.boxShadow='0 4px 15px rgba(0,0,0,0.2)'">
                    ${hasImage ? `<img src="${p.image}" style="width:100%; height:100%; object-fit:cover; position:absolute; top:0; left:0;">` : _getDefaultCardBg(p.name).replace('width:100%', 'width:100%; position:absolute; top:0; left:0')}
                    <div style="position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.35); display:flex; flex-direction:column; justify-content:space-between; padding:18px;">
                        <div>
                            <div style="color:white; font-size:18px; font-weight:bold; text-shadow:0 2px 4px rgba(0,0,0,0.3);">${escHTML(p.name)}</div>
                            <div style="color:rgba(255,255,255,0.85); font-size:12px; margin-top:4px;">${p.description ? escHTML(p.description) : `${totalProducts} منتج | ${p.duration_days} يوم`}</div>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:end;">
                            <div>
                                <div style="color:rgba(255,255,255,0.7); font-size:11px;">المشتركين</div>
                                <div style="color:white; font-size:20px; font-weight:bold;">${stats.active}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.2); backdrop-filter:blur(4px); padding:6px 14px; border-radius:20px;">
                                <span style="color:white; font-size:16px; font-weight:bold;">${p.price.toFixed(3)}</span>
                                <span style="color:rgba(255,255,255,0.8); font-size:11px;"> د.ك</span>
                            </div>
                        </div>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;
}

function filterByCategory(planId) {
    const filtered = _allSubscriptions.filter(s => s.plan_id === planId);
    renderSubscriptions(filtered);
    // تمييز البطاقة المحددة
    const search = document.getElementById('subSearchInput');
    if (search) {
        const plan = _allPlans.find(p => p.id === planId);
        search.value = plan ? plan.name : '';
    }
}

async function savePlan() {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    const name = document.getElementById('planName').value.trim();
    const price = parseFloat(document.getElementById('planPrice').value);
    if (!name || isNaN(price)) { alert('يجب إدخال اسم الفئة والسعر'); return; }
    if (_planItems.length === 0) { alert('يجب إضافة منتج واحد على الأقل للفئة'); return; }

    try {
        const response = await fetch(`${API_URL}/api/subscription-plans`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name,
                duration_days: parseInt(document.getElementById('planDuration').value) || 30,
                price,
                discount_percent: 0,
                loyalty_multiplier: 1,
                description: document.getElementById('planDesc').value.trim(),
                image: document.getElementById('planImageData').value || '',
                items: _planItems
            })
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم حفظ الفئة');
            document.getElementById('planName').value = '';
            document.getElementById('planPrice').value = '';
            document.getElementById('planDesc').value = '';
            document.getElementById('planDuration').value = '30';
            document.getElementById('planImageData').value = '';
            document.getElementById('planImagePreview').innerHTML = '<span style="color:#aaa; font-size:12px;">معاينة الصورة</span>';
            document.getElementById('planTemplatesGrid').style.display = 'none';
            _planItems = [];
            renderPlanItems();
            await loadPlansList();
        } else { alert('خطأ: ' + data.error); }
    } catch (error) { alert('خطأ: ' + error.message); }
}

async function togglePlan(planId, currentActive) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    try {
        const plan = _allPlans.find(p => p.id === planId);
        if (!plan) return;
        const response = await fetch(`${API_URL}/api/subscription-plans/${planId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({...plan, is_active: currentActive ? 0 : 1})
        });
        const data = await response.json();
        if (data.success) await loadPlansList();
    } catch (error) { alert('خطأ: ' + error.message); }
}

async function deletePlan(planId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    if (!confirm('حذف هذه الفئة ومنتجاتها؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/subscription-plans/${planId}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) await loadPlansList();
        else alert('خطأ: ' + data.error);
    } catch (error) { alert('خطأ: ' + error.message); }
}

// --- إضافة اشتراك ---

async function showAddSubscription() {
    if (!window.userPermissions?.canManageSubscriptions) { alert('ليس لديك صلاحية'); return; }
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    try {
        const [custRes, planRes] = await Promise.all([
            fetch(`${API_URL}/api/customers`),
            fetch(`${API_URL}/api/subscription-plans`)
        ]);
        const custData = await custRes.json();
        const planData = await planRes.json();

        const custSelect = document.getElementById('subCustomerId');
        custSelect.innerHTML = '<option value="">-- اختر العميل --</option>' +
            (custData.success ? custData.customers.map(c => `<option value="${c.id}">${escHTML(c.name)} - ${escHTML(c.phone || '')}</option>`).join('') : '');

        const planSelect = document.getElementById('subPlanId');
        _allPlans = planData.success ? planData.plans.filter(p => p.is_active) : [];
        planSelect.innerHTML = '<option value="">-- اختر الفئة --</option>' +
            _allPlans.map(p => {
                const itemCount = (p.items || []).reduce((s, it) => s + it.quantity, 0);
                return `<option value="${p.id}">${escHTML(p.name)} (${p.price.toFixed(3)} د.ك / ${p.duration_days} يوم / ${itemCount} منتج)</option>`;
            }).join('');

        document.getElementById('subStartDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('subCode').value = '';
        document.getElementById('subPricePaid').value = '';
        document.getElementById('subNotes').value = '';
        document.getElementById('subPlanInfo').style.display = 'none';
        document.getElementById('addSubscriptionModal').classList.add('active');
    } catch (error) { alert('خطأ في تحميل البيانات: ' + error.message); }
}

function closeAddSubscription() {
    document.getElementById('addSubscriptionModal').classList.remove('active');
}

function onPlanSelect() {
    const planId = parseInt(document.getElementById('subPlanId').value);
    const plan = _allPlans.find(p => p.id === planId);
    const infoDiv = document.getElementById('subPlanInfo');
    if (plan) {
        infoDiv.style.display = 'block';
        const items = plan.items || [];
        document.getElementById('subPlanDetails').innerHTML = `
            <div style="font-weight:bold; margin-bottom:5px; color:#0369a1;">${escHTML(plan.name)}</div>
            <div>المدة: <strong>${plan.duration_days} يوم</strong> | السعر: <strong>${plan.price.toFixed(3)} د.ك</strong></div>
            ${plan.description ? `<div style="color:#6c757d;">${escHTML(plan.description)}</div>` : ''}
            ${items.length > 0 ? `
            <div style="margin-top:8px; border-top:1px solid #bae6fd; padding-top:8px;">
                <strong>📦 المنتجات المشمولة:</strong>
                <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:5px;">
                    ${items.map(it => `<span style="background:#e0f2fe; padding:3px 8px; border-radius:4px; font-size:12px;">${escHTML(it.product_name)}${it.variant_name ? ' - ' + escHTML(it.variant_name) : ''} <strong>x${it.quantity}</strong></span>`).join('')}
                </div>
            </div>` : ''}
        `;
        document.getElementById('subPricePaid').value = plan.price.toFixed(3);
    } else {
        infoDiv.style.display = 'none';
    }
}

function generateSubCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'SUB-';
    for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById('subCode').value = code;
}

async function submitSubscription() {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    const customerId = document.getElementById('subCustomerId').value;
    const planId = document.getElementById('subPlanId').value;
    const code = document.getElementById('subCode').value.trim();
    if (!customerId || !planId || !code) { alert('يجب تعبئة العميل والفئة والكود'); return; }

    try {
        const response = await fetch(`${API_URL}/api/customer-subscriptions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                customer_id: parseInt(customerId),
                plan_id: parseInt(planId),
                subscription_code: code.toUpperCase(),
                start_date: document.getElementById('subStartDate').value,
                price_paid: parseFloat(document.getElementById('subPricePaid').value) || 0,
                notes: document.getElementById('subNotes').value.trim(),
                created_by: currentUser.id,
                created_by_name: currentUser.full_name
            })
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم تسجيل الاشتراك بنجاح');
            closeAddSubscription();
            loadSubscriptions();
            logAction('add_subscription', `اشتراك جديد: ${code}`, data.id);
        } else { alert('خطأ: ' + data.error); }
    } catch (error) { alert('خطأ: ' + error.message); }
}

async function cancelSubscription(subId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    if (!confirm('إلغاء هذا الاشتراك؟')) return;
    try {
        const sub = _allSubscriptions.find(s => s.id === subId);
        const response = await fetch(`${API_URL}/api/customer-subscriptions/${subId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ status: 'cancelled', notes: sub?.notes || '', end_date: sub?.end_date })
        });
        const data = await response.json();
        if (data.success) { loadSubscriptions(); logAction('cancel_subscription', `إلغاء اشتراك #${subId}`, subId); }
    } catch (error) { alert('خطأ: ' + error.message); }
}

async function deleteSubscription(subId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    if (!confirm('حذف هذا الاشتراك نهائياً؟')) return;
    try {
        const response = await fetch(`${API_URL}/api/customer-subscriptions/${subId}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) { loadSubscriptions(); logAction('delete_subscription', `حذف اشتراك #${subId}`, subId); }
    } catch (error) { alert('خطأ: ' + error.message); }
}

async function renewSubscription(subId, customerId, planId) {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    if (!confirm('تجديد هذا الاشتراك؟')) return;
    try {
        const sub = _allSubscriptions.find(s => s.id === subId);
        let plan = _allPlans.find(p => p.id === planId);
        if (!plan) {
            const planRes = await fetch(`${API_URL}/api/subscription-plans`);
            const planData = await planRes.json();
            if (planData.success) { _allPlans = planData.plans; }
            plan = _allPlans.find(p => p.id === planId);
            if (!plan) { alert('الفئة غير موجودة'); return; }
        }
        const startDate = new Date().toISOString().split('T')[0];
        const response = await fetch(`${API_URL}/api/customer-subscriptions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                customer_id: customerId,
                plan_id: planId,
                subscription_code: sub.subscription_code + '-R' + Date.now().toString(36).slice(-4).toUpperCase(),
                start_date: startDate,
                price_paid: plan.price || 0,
                notes: 'تجديد اشتراك',
                created_by: currentUser.id,
                created_by_name: currentUser.full_name
            })
        });
        const data = await response.json();
        if (data.success) {
            await fetch(`${API_URL}/api/customer-subscriptions/${subId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ status: 'expired', notes: sub?.notes || '', end_date: sub?.end_date })
            });
            alert('✅ تم التجديد بنجاح');
            loadSubscriptions();
            logAction('renew_subscription', `تجديد اشتراك #${subId}`, data.id);
        } else { alert('خطأ: ' + data.error); }
    } catch (error) { alert('خطأ: ' + error.message); }
}

// --- استلام منتجات الاشتراك (POS + من صفحة الاشتراكات) ---

function showRedeemForSub(subId) {
    const sub = _allSubscriptions.find(s => s.id === subId);
    if (!sub) return;
    window._redeemSubscription = sub;
    _openRedeemModal(sub);
}

function showRedeemSubscription() {
    const sub = window._activeSubscription;
    if (!sub) { alert('لا يوجد اشتراك فعّال'); return; }
    window._redeemSubscription = sub;
    _openRedeemModal(sub);
}

function _openRedeemModal(sub) {
    const planItems = sub.plan_items || [];
    const redeemedMap = sub.redeemed_map || {};

    document.getElementById('redeemSubInfo').innerHTML = `
        <div style="font-weight:bold; font-size:16px; color:#764ba2; margin-bottom:5px;">💳 ${escHTML(sub.plan_name)} - ${escHTML(sub.customer_name)}</div>
        <div>الكود: <strong style="font-family:monospace;">${escHTML(sub.subscription_code)}</strong> | ينتهي: ${sub.end_date}</div>
    `;

    if (planItems.length === 0) {
        document.getElementById('redeemItemsList').innerHTML = '<p style="text-align:center; color:#dc3545;">لا توجد منتجات في هذه الفئة</p>';
    } else {
        document.getElementById('redeemItemsList').innerHTML = `
            <table class="data-table">
                <thead><tr><th>المنتج</th><th>المتغير</th><th>المسموح</th><th>المستلم</th><th>المتبقي</th><th>الكمية للاستلام</th></tr></thead>
                <tbody>
                    ${planItems.map((it, i) => {
                        const key = `${it.product_id}_${it.variant_id || 0}`;
                        const redeemed = redeemedMap[key] || 0;
                        const remaining = it.quantity - redeemed;
                        return `<tr>
                            <td>${escHTML(it.product_name)}</td>
                            <td>${it.variant_name ? escHTML(it.variant_name) : '-'}</td>
                            <td style="font-weight:bold;">${it.quantity}</td>
                            <td style="color:#667eea;">${redeemed}</td>
                            <td style="font-weight:bold; color:${remaining > 0 ? '#28a745' : '#dc3545'};">${remaining}</td>
                            <td>
                                ${remaining > 0 ? `<input type="number" id="redeemQty_${i}" min="0" max="${remaining}" value="0" style="width:70px; padding:5px; border:2px solid #e0e0e0; border-radius:6px; text-align:center;"
                                    data-product-id="${it.product_id}" data-variant-id="${it.variant_id || ''}" data-product-name="${escHTML(it.product_name)}" data-variant-name="${it.variant_name ? escHTML(it.variant_name) : ''}" data-max="${remaining}">` :
                                    '<span style="color:#dc3545;">اكتمل</span>'}
                            </td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    document.getElementById('redeemSubscriptionModal').classList.add('active');
}

function closeRedeemModal() {
    document.getElementById('redeemSubscriptionModal').classList.remove('active');
    window._redeemSubscription = null;
}

async function submitRedemption() {
    if (!_realOnlineStatus) { alert('غير متصل بالإنترنت'); return; }
    const sub = window._redeemSubscription;
    if (!sub) return;

    const items = [];
    const inputs = document.querySelectorAll('[id^="redeemQty_"]');
    inputs.forEach(input => {
        const qty = parseInt(input.value) || 0;
        if (qty > 0) {
            const max = parseInt(input.dataset.max) || 0;
            if (qty > max) {
                alert(`الكمية لـ ${input.dataset.productName} تتجاوز المتبقي (${max})`);
                return;
            }
            items.push({
                product_id: parseInt(input.dataset.productId),
                variant_id: input.dataset.variantId ? parseInt(input.dataset.variantId) : null,
                product_name: input.dataset.productName,
                variant_name: input.dataset.variantName || null,
                quantity: qty
            });
        }
    });

    if (items.length === 0) { alert('اختر كمية واحدة على الأقل للاستلام'); return; }
    if (!confirm(`تأكيد استلام ${items.length} منتج؟`)) return;

    try {
        const response = await fetch(`${API_URL}/api/subscription-redemptions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                subscription_id: sub.id,
                branch_id: currentUser.branch_id || 1,
                items: items,
                redeemed_by: currentUser.id,
                redeemed_by_name: currentUser.full_name
            })
        });
        const data = await response.json();
        if (data.success) {
            alert('✅ تم استلام المنتجات بنجاح');
            closeRedeemModal();
            logAction('subscription_redeem', `استلام منتجات اشتراك ${sub.subscription_code}`, sub.id);
            // تحديث البيانات
            if (typeof loadSubscriptions === 'function' && document.getElementById('subscriptionsTab')?.style.display !== 'none') {
                loadSubscriptions();
            }
            // تحديث الاشتراك في POS
            if (window._activeSubscription && window._activeSubscription.id === sub.id) {
                checkCustomerSubscription(sub.customer_id);
            }
        } else { alert('خطأ: ' + data.error); }
    } catch (error) { alert('خطأ: ' + error.message); }
}

// --- دمج الاشتراك بنقطة البيع ---

async function checkCustomerSubscription(customerId) {
    try {
        const response = await fetch(`${API_URL}/api/customer-subscriptions/check?customer_id=${customerId}`);
        const data = await response.json();
        if (data.success && data.active && data.subscription) {
            window._activeSubscription = data.subscription;
            showSubscriptionBadge(data.subscription);
            return data.subscription;
        } else {
            window._activeSubscription = null;
            hideSubscriptionBadge();
            return null;
        }
    } catch (error) {
        console.log('[Subscription] Check failed:', error);
        window._activeSubscription = null;
        hideSubscriptionBadge();
        return null;
    }
}

function showSubscriptionBadge(sub) {
    let badge = document.getElementById('subscriptionBadge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'subscriptionBadge';
        const customerDetails = document.getElementById('customerDetails');
        if (customerDetails) customerDetails.parentNode.insertBefore(badge, customerDetails.nextSibling);
    }

    const planItems = sub.plan_items || [];
    const redeemedMap = sub.redeemed_map || {};
    const totalItems = planItems.reduce((s, it) => s + it.quantity, 0);
    const totalRedeemed = planItems.reduce((s, it) => {
        const key = `${it.product_id}_${it.variant_id || 0}`;
        return s + (redeemedMap[key] || 0);
    }, 0);
    const remaining = totalItems - totalRedeemed;

    badge.style.cssText = 'background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 10px 15px; border-radius: 8px; margin-top: 8px; font-size: 13px;';
    badge.innerHTML = `
        <div style="font-weight:bold; margin-bottom:4px;">💳 مشترك - ${escHTML(sub.plan_name)}</div>
        <div>الكود: <strong style="font-family:monospace;">${escHTML(sub.subscription_code)}</strong></div>
        <div>المنتجات: <strong>${totalRedeemed}/${totalItems}</strong> مستلم | المتبقي: <strong style="color:${remaining > 0 ? '#90EE90' : '#ffcccb'};">${remaining}</strong></div>
        <div>ينتهي: ${sub.end_date}</div>
        ${remaining > 0 ? `<button onclick="showRedeemSubscription()" style="margin-top:6px; padding:5px 15px; background:rgba(255,255,255,0.2); color:white; border:1px solid rgba(255,255,255,0.4); border-radius:6px; cursor:pointer; font-weight:bold;">📦 استلام منتجات</button>` : ''}
    `;
    badge.style.display = 'block';

    // عرض زر الاستلام في ملخص الفاتورة
    const subRedeemRow = document.getElementById('subscriptionRedeemRow');
    if (subRedeemRow) subRedeemRow.style.display = 'flex';
}

function hideSubscriptionBadge() {
    const badge = document.getElementById('subscriptionBadge');
    if (badge) badge.style.display = 'none';
    window._activeSubscription = null;
    const subRedeemRow = document.getElementById('subscriptionRedeemRow');
    if (subRedeemRow) subRedeemRow.style.display = 'none';
}

console.log('[Subscriptions] Loaded ✅');

// ========================================
// Sync & Admin Dashboard - المزامنة ولوحة الأدمن
// ========================================

// مزامنة يدوية (زر المزامنة)
async function manualSync() {
    if (!window.userPermissions?.isAdmin) {
        alert('المزامنة متاحة فقط للأدمن');
        return;
    }
    const result = await syncManager.sync();
    await updateSyncStatsUI();

    if (result.success) {
        let msg = 'تمت المزامنة بنجاح!';
        if (result.invoices_uploaded > 0) msg += `\nتم رفع ${result.invoices_uploaded} فاتورة`;
        if (result.customers_uploaded > 0) msg += `\nتم رفع ${result.customers_uploaded} عميل`;
        if (result.products_downloaded > 0) msg += `\nتم تحديث ${result.products_downloaded} منتج`;
        alert(msg);
    }
}

// مزامنة كاملة (إعادة تحميل كل البيانات)
async function fullSync() {
    if (!window.userPermissions?.isAdmin) {
        alert('المزامنة الكاملة متاحة فقط للأدمن');
        return;
    }
    if (!confirm('سيتم تحميل جميع البيانات من السيرفر. هذا قد يستغرق وقتاً. متابعة؟')) return;

    const result = await syncManager.fullSync();
    await updateSyncStatsUI();

    if (result.success) {
        alert(`تمت المزامنة الكاملة!\nالمنتجات: ${result.data_counts?.products || 0}\nالعملاء: ${result.data_counts?.customers || 0}`);
    } else {
        alert('فشلت المزامنة: ' + (result.error || 'خطأ غير معروف'));
    }
}

// تحديث إحصائيات المزامنة في واجهة الأدمن
async function updateSyncStatsUI() {
    try {
        const stats = await syncManager.getSyncStats();

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        setVal('syncStatPendingInv', stats.pendingInvoices);
        setVal('syncStatPendingCust', stats.pendingCustomers);
        setVal('syncStatProducts', stats.localProducts);
        setVal('syncStatCustomers', stats.localCustomers);
        setVal('syncStatLocalInv', stats.localInvoices);

        // تحديث نص آخر مزامنة
        const syncStatusEl = document.getElementById('syncStatusText');
        if (syncStatusEl && stats.lastSync) {
            const d = new Date(stats.lastSync);
            syncStatusEl.textContent = `اخر مزامنة: ${d.toLocaleDateString('ar-SA')} ${d.toLocaleTimeString('ar-SA')}`;
        }

        // تحميل سجل المزامنة
        await loadSyncLog();

        // استعادة رابط السيرفر المحفوظ
        const serverUrlInput = document.getElementById('serverUrlInput');
        if (serverUrlInput) {
            const savedUrl = localStorage.getItem('pos_server_url') || API_URL;
            serverUrlInput.value = savedUrl;
        }

        // عرض وضع التزامن الحالي في لوحة الأدمن
        const adminSyncInfo = document.getElementById('adminSyncModeInfo');
        if (adminSyncInfo) {
            const mode = getSyncMode();
            const serverUrl = getSyncServerUrl();
            if (mode === 'server' && serverUrl) {
                adminSyncInfo.innerHTML = `<span style="color: #63b3ed;">تزامن مع سيرفر:</span> <span style="direction: ltr; unicode-bidi: embed;">${escHTML(serverUrl)}</span>`;
            } else {
                adminSyncInfo.innerHTML = '<span style="color: #81e6d9;">محلي بالكامل</span> - لا يوجد تزامن مع سيرفر خارجي';
            }
        }
    } catch (e) {
        console.error('[SyncUI] Error:', e);
    }
}

// تحميل سجل المزامنة
async function loadSyncLog() {
    try {
        if (!localDB.isReady) return;
        const logs = await localDB.getRecentSyncLogs(10);
        const container = document.getElementById('syncLogList');
        if (!container) return;

        if (logs.length === 0) {
            container.innerHTML = '<div style="opacity: 0.5;">لا يوجد سجلات</div>';
            return;
        }

        container.innerHTML = logs.map(log => {
            const d = new Date(log.timestamp);
            const timeStr = `${d.toLocaleDateString('ar-SA')} ${d.toLocaleTimeString('ar-SA')}`;
            let detail = '';
            if (log.type === 'sync_complete') {
                detail = `رفع: ${log.invoices_uploaded || 0} فاتورة, ${log.customers_uploaded || 0} عميل | تحميل: ${log.products_downloaded || 0} منتج`;
            } else if (log.type === 'full_sync_complete') {
                detail = `مزامنة كاملة: ${log.products || 0} منتج, ${log.customers || 0} عميل`;
            } else if (log.type === 'sync_error') {
                detail = `خطأ: ${log.error || 'غير معروف'}`;
            }
            const color = log.type === 'sync_error' ? '#ff6b6b' : '#90EE90';
            return `<div style="padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <span style="color: ${color}; font-weight: bold;">${log.type === 'sync_error' ? 'X' : '+'}</span>
                <span style="margin: 0 5px;">${timeStr}</span>
                <span style="opacity: 0.7;">${detail}</span>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('[SyncLog] Error:', e);
    }
}

// عرض/إخفاء سجل المزامنة
function toggleSyncLog() {
    const container = document.getElementById('syncLogContainer');
    const toggle = document.getElementById('syncLogToggle');
    if (container && toggle) {
        const isHidden = container.style.display === 'none';
        container.style.display = isHidden ? 'block' : 'none';
        toggle.textContent = isHidden ? 'إخفاء' : 'عرض';
    }
}

// حفظ رابط السيرفر
function saveServerUrl() {
    const input = document.getElementById('serverUrlInput');
    if (input && input.value.trim()) {
        let url = input.value.trim();
        // إزالة / من الآخر
        if (url.endsWith('/')) url = url.slice(0, -1);
        localStorage.setItem('pos_server_url', url);
        alert('تم حفظ رابط السيرفر');
    }
}

// اختبار الاتصال بالسيرفر
async function testServerConnection() {
    const resultEl = document.getElementById('serverTestResult');
    const input = document.getElementById('serverUrlInput');
    if (!resultEl || !input) return;

    const url = input.value.trim() || API_URL;
    resultEl.textContent = 'جاري الاختبار...';
    resultEl.style.color = '#fbbf24';

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${url}/api/sync/status`, {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-store'
        });
        clearTimeout(timeout);

        const statusCode = response.status;
        let responseText = '';
        let data = null;

        try {
            responseText = await response.text();
            data = JSON.parse(responseText);
        } catch (parseErr) {
            // الرد مو JSON
        }

        if (response.ok && data && data.success) {
            resultEl.innerHTML = `<span style="color: #10b981;">متصل! السيرفر يعمل</span><br>
                <span style="opacity:0.7;">المنتجات: ${data.stats?.products || 0} | العملاء: ${data.stats?.customers || 0} | الفواتير: ${data.stats?.invoices || 0}</span>`;
            return;
        }

        // تفاصيل الخطأ
        let errInfo = `HTTP ${statusCode}`;
        if (data && data.error) {
            errInfo += ` | ${data.error}`;
        } else if (!data && responseText) {
            errInfo += ` | رد غير JSON: ${responseText.substring(0, 100)}`;
        }
        resultEl.innerHTML = `<span style="color: #f59e0b;">السيرفر يستجيب لكن حدث خطأ</span><br><span style="font-size: 11px; opacity: 0.8;">${escHTML(errInfo)}</span>`;
        resultEl.style.color = '#f59e0b';
    } catch (e) {
        let errMsg = 'فشل الاتصال';
        if (e.name === 'AbortError') {
            errMsg += ' - انتهت المهلة (5 ثواني)';
        } else if (e.message.includes('Failed to fetch')) {
            errMsg += ' - تأكد من الرابط والشبكة (CORS أو سيرفر مغلق)';
        } else {
            errMsg += ` - ${e.message}`;
        }
        resultEl.textContent = errMsg;
        resultEl.style.color = '#ef4444';
    }
}

// ========================================
// إعدادات وضع التزامن (محلي / سيرفر)
// ========================================

// جلب وضع التزامن الحالي
function getSyncMode() {
    return localStorage.getItem('pos_sync_mode') || 'local';
}

// جلب عنوان السيرفر البعيد
function getSyncServerUrl() {
    return localStorage.getItem('pos_sync_server_url') || '';
}

// جلب عنوان API حسب وضع التزامن
function getEffectiveSyncUrl() {
    if (getSyncMode() === 'server') {
        const serverUrl = getSyncServerUrl();
        if (serverUrl) return serverUrl;
    }
    return API_URL;
}

// تحميل إعدادات التزامن عند فتح الإعدادات
function loadSyncModeSettings() {
    const mode = getSyncMode();
    const serverUrl = getSyncServerUrl();

    const modeSelect = document.getElementById('syncModeSelect');
    if (modeSelect) modeSelect.value = mode;

    // إظهار/إخفاء إعدادات السيرفر
    const serverSettings = document.getElementById('serverSyncSettings');
    if (serverSettings) serverSettings.style.display = mode === 'server' ? 'block' : 'none';

    // تعبئة عنوان السيرفر
    const presetSelect = document.getElementById('syncServerPreset');
    const customInput = document.getElementById('syncCustomServerUrl');
    const customGroup = document.getElementById('customServerUrlGroup');

    if (presetSelect && serverUrl) {
        // تحقق هل العنوان من القائمة الجاهزة
        const options = Array.from(presetSelect.options).map(o => o.value);
        if (options.includes(serverUrl)) {
            presetSelect.value = serverUrl;
            if (customGroup) customGroup.style.display = 'none';
        } else if (serverUrl) {
            presetSelect.value = 'custom';
            if (customGroup) customGroup.style.display = 'block';
            if (customInput) customInput.value = serverUrl;
        }
    }

    // تحديث حالة الوضع
    updateSyncModeStatus();
}

// عند تغيير وضع التزامن
function onSyncModeChange() {
    const mode = document.getElementById('syncModeSelect')?.value || 'local';
    const serverSettings = document.getElementById('serverSyncSettings');
    if (serverSettings) serverSettings.style.display = mode === 'server' ? 'block' : 'none';

    if (mode === 'local') {
        // حفظ فوري للوضع المحلي
        localStorage.setItem('pos_sync_mode', 'local');
        updateSyncModeStatus();
        // إيقاف المزامنة التلقائية مع السيرفر
        if (typeof syncManager !== 'undefined') {
            syncManager.serverUrl = null;
        }
    }
}

// عند تغيير السيرفر من القائمة
function onSyncServerPresetChange() {
    const preset = document.getElementById('syncServerPreset')?.value;
    const customGroup = document.getElementById('customServerUrlGroup');
    if (customGroup) {
        customGroup.style.display = preset === 'custom' ? 'block' : 'none';
    }
}

// حفظ إعدادات التزامن
function saveSyncModeSettings() {
    const mode = document.getElementById('syncModeSelect')?.value || 'local';
    localStorage.setItem('pos_sync_mode', mode);

    if (mode === 'server') {
        const preset = document.getElementById('syncServerPreset')?.value;
        let serverUrl = '';

        if (preset === 'custom') {
            serverUrl = document.getElementById('syncCustomServerUrl')?.value?.trim() || '';
        } else {
            serverUrl = preset || '';
        }

        // تنظيف العنوان
        if (serverUrl.endsWith('/')) serverUrl = serverUrl.slice(0, -1);

        if (!serverUrl) {
            alert('الرجاء إدخال عنوان السيرفر');
            return;
        }

        localStorage.setItem('pos_sync_server_url', serverUrl);
        // تحديث عنوان السيرفر القديم أيضاً للتوافق
        localStorage.setItem('pos_server_url', serverUrl);

        // حفظ عنوان الخادم في قاعدة البيانات المحلية لاستخدامه من Electron
        fetch(`${API_URL}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flask_server_url: serverUrl })
        }).catch(function() { /* ignore - offline */ });

        // تحديث SyncManager
        if (typeof syncManager !== 'undefined') {
            syncManager.serverUrl = serverUrl;
        }
    }

    updateSyncModeStatus();
    alert('تم حفظ إعدادات التزامن');
}

// اختبار الاتصال بسيرفر التزامن
async function testSyncServer() {
    const resultEl = document.getElementById('syncServerTestResult');
    if (!resultEl) return;

    const preset = document.getElementById('syncServerPreset')?.value;
    let serverUrl = '';

    if (preset === 'custom') {
        serverUrl = document.getElementById('syncCustomServerUrl')?.value?.trim() || '';
    } else {
        serverUrl = preset || '';
    }

    if (!serverUrl) {
        resultEl.style.display = 'block';
        resultEl.style.background = '#fff5f5';
        resultEl.style.color = '#e53e3e';
        resultEl.textContent = 'الرجاء اختيار أو إدخال عنوان السيرفر أولاً';
        return;
    }

    if (serverUrl.endsWith('/')) serverUrl = serverUrl.slice(0, -1);

    resultEl.style.display = 'block';
    resultEl.style.background = '#fffff0';
    resultEl.style.color = '#d69e2e';
    resultEl.innerHTML = 'جاري فحص السيرفر... <span class="sync-spinner"></span>';

    // فحص عدة endpoints لمعرفة وش شغال على السيرفر
    // نختبر endpoints العادية (لأن السيرفر البعيد قد لا يدعم /api/sync/*)
    const endpoints = [
        { path: '/api/settings', name: 'الإعدادات', primary: true },
        { path: '/api/products', name: 'المنتجات' },
        { path: '/api/customers', name: 'العملاء' },
    ];

    const results = [];

    for (const ep of endpoints) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const resp = await fetch(`${serverUrl}${ep.path}`, {
                method: 'GET', signal: ctrl.signal, cache: 'no-store'
            });
            clearTimeout(t);

            let data = null;
            try {
                const text = await resp.text();
                data = JSON.parse(text);
            } catch (e) { /* not JSON */ }

            results.push({
                ...ep,
                status: resp.status,
                ok: resp.ok,
                isJson: !!data,
                success: data?.success,
                data: data
            });
        } catch (e) {
            results.push({
                ...ep,
                status: 0,
                ok: false,
                error: e.name === 'AbortError' ? 'timeout' : e.message
            });
        }
    }

    // تحليل النتائج
    const working = results.filter(r => r.ok && r.isJson && r.success);
    const responding = results.filter(r => r.status > 0);

    if (working.length > 0) {
        // نجاح - في endpoint شغال
        resultEl.style.background = '#f0fff4';
        resultEl.style.color = '#22543d';
        let html = `<strong>متصل بنجاح!</strong> السيرفر يعمل (${working.length}/${endpoints.length} endpoints)<br>`;
        // عرض عدد المنتجات والعملاء إذا متاح
        const productsEp = results.find(r => r.path === '/api/products' && r.success);
        const customersEp = results.find(r => r.path === '/api/customers' && r.success);
        if (productsEp?.data || customersEp?.data) {
            const pCount = productsEp?.data?.products?.length || productsEp?.data?.total || '?';
            const cCount = customersEp?.data?.customers?.length || customersEp?.data?.total || '?';
            html += `<span style="font-size: 12px; opacity: 0.8;">المنتجات: ${pCount} | العملاء: ${cCount}</span><br>`;
        }
        html += `<div style="font-size: 11px; margin-top: 6px; opacity: 0.7;">`;
        for (const r of results) {
            const icon = r.success ? '&#10004;' : (r.ok ? '&#9888;' : '&#10008;');
            const color = r.success ? '#22543d' : (r.ok ? '#92400e' : '#e53e3e');
            html += `<span style="color:${color};">${icon}</span> ${r.name} (${r.path}) → ${r.status || r.error}<br>`;
        }
        html += `</div>`;
        resultEl.innerHTML = html;
    } else if (responding.length > 0) {
        // السيرفر يستجيب لكن الـ endpoints ما تشتغل
        resultEl.style.background = '#fffff0';
        resultEl.style.color = '#92400e';
        let html = `<strong>السيرفر يستجيب لكن الـ API غير متاح</strong><br>`;
        html += `<div style="font-size: 12px; margin-top: 8px; background: rgba(0,0,0,0.03); padding: 10px; border-radius: 6px; direction: ltr; text-align: left; font-family: monospace;">`;
        for (const r of results) {
            const icon = r.ok ? '&#9888;' : '&#10008;';
            const color = r.ok ? '#d69e2e' : '#e53e3e';
            let detail = `HTTP ${r.status}`;
            if (r.error) detail = r.error;
            else if (r.data?.error) detail += ` - ${r.data.error}`;
            else if (!r.isJson) detail += ' (not JSON)';
            html += `<span style="color:${color};">${icon}</span> ${r.path} → ${escHTML(detail)}<br>`;
        }
        html += `</div>`;
        html += `<div style="font-size: 12px; margin-top: 8px; padding: 8px; background: #f7f7f7; border-radius: 6px;">`;
        html += `<strong>أسباب محتملة:</strong><br>`;
        html += `• السيرفر يشغل كود مختلف (مو نفس server.py)<br>`;
        html += `• الـ API على مسار فرعي (مثلاً <span style="direction:ltr;unicode-bidi:embed;">${escHTML(serverUrl)}/pos/api/...</span>)<br>`;
        html += `• السيرفر يحتاج إعداد قاعدة بيانات أو تهيئة أولية<br>`;
        html += `</div>`;
        resultEl.innerHTML = html;
    } else {
        // ما في أي استجابة
        resultEl.style.background = '#fff5f5';
        resultEl.style.color = '#e53e3e';
        const firstErr = results[0]?.error || 'غير معروف';
        let errMsg = `<strong>فشل الاتصال بالسيرفر</strong><br>`;
        if (firstErr === 'timeout') {
            errMsg += `<span style="font-size: 12px;">انتهت المهلة (5 ثواني) - السيرفر بطيء أو مغلق</span>`;
        } else if (firstErr.includes('Failed to fetch') || firstErr.includes('NetworkError')) {
            errMsg += `<span style="font-size: 12px;">خطأ شبكة - تأكد من:<br>• العنوان صحيح<br>• السيرفر شغال<br>• CORS مفعل على السيرفر<br>• الشبكة متصلة</span>`;
        } else {
            errMsg += `<span style="font-size: 12px;">${escHTML(firstErr)}</span>`;
        }
        resultEl.innerHTML = errMsg;
    }
}

// تحديث عرض حالة وضع التزامن
function updateSyncModeStatus() {
    const statusEl = document.getElementById('syncModeStatusText');
    const statusContainer = document.getElementById('syncModeStatus');
    if (!statusEl || !statusContainer) return;

    const mode = getSyncMode();
    const serverUrl = getSyncServerUrl();

    if (mode === 'server' && serverUrl) {
        statusContainer.style.background = '#ebf8ff';
        statusContainer.style.borderColor = '#63b3ed';
        statusEl.innerHTML = `<strong>الوضع الحالي:</strong> تزامن مع سيرفر<br><span style="font-size: 12px; direction: ltr; unicode-bidi: embed;">${escHTML(serverUrl)}</span>`;
    } else if (mode === 'server') {
        statusContainer.style.background = '#fffff0';
        statusContainer.style.borderColor = '#ecc94b';
        statusEl.innerHTML = '<strong>الوضع الحالي:</strong> سيرفر (لم يتم تحديد العنوان بعد)';
    } else {
        statusContainer.style.background = '#e6fffa';
        statusContainer.style.borderColor = '#81e6d9';
        statusEl.innerHTML = '<strong>الوضع الحالي:</strong> محلي بالكامل';
    }
}

// مزامنة الآن من صفحة الإعدادات
async function syncNowFromSettings() {
    const resultEl = document.getElementById('syncNowResult');
    const btn = document.getElementById('syncNowSettingsBtn');
    if (!resultEl) return;

    const mode = getSyncMode();
    const serverUrl = getSyncServerUrl();
    if (mode !== 'server' || !serverUrl) {
        resultEl.style.display = 'block';
        resultEl.style.background = '#fffff0';
        resultEl.style.border = '1px solid #ecc94b';
        resultEl.innerHTML = '⚠️ يرجى حفظ إعدادات السيرفر أولاً';
        return;
    }

    if (btn) btn.disabled = true;
    resultEl.style.display = 'block';
    resultEl.style.background = '#ebf8ff';
    resultEl.style.border = '1px solid #63b3ed';
    resultEl.innerHTML = '⏳ جاري المزامنة الشاملة مع السيرفر...';

    try {
        if (typeof syncManager !== 'undefined') {
            syncManager.serverUrl = serverUrl;
        }

        const r = await syncManager.sync();

        if (r.success) {
            resultEl.style.background = '#f0fff4';
            resultEl.style.border = '1px solid #68d391';
            let details = '<span style="font-size: 12px;">';
            if (r.invoices_uploaded || r.customers_uploaded)
                details += `📤 رفع: ${r.invoices_uploaded || 0} فاتورة، ${r.customers_uploaded || 0} عميل<br>`;
            details += `📥 تحميل: ${r.branches || 0} فرع، ${r.products || 0} منتج، ${r.customers || 0} عميل، ${r.invoices || 0} فاتورة<br>`;
            details += `📋 ${r.categories || 0} فئة، ${r.settings || 0} إعداد، ${r.returns || 0} مرتجع، ${r.expenses || 0} مصروف`;
            details += '</span>';
            resultEl.innerHTML = `✅ <strong>تمت المزامنة بنجاح!</strong><br>${details}`;
        } else {
            resultEl.style.background = '#fff5f5';
            resultEl.style.border = '1px solid #fc8181';
            const errMsg = r.error || r.reason || r.errors?.join(', ') || 'خطأ غير معروف';
            resultEl.innerHTML = `❌ <strong>فشلت المزامنة</strong><br><span style="font-size: 12px;">${escHTML(errMsg)}</span>`;
        }
    } catch (e) {
        resultEl.style.background = '#fff5f5';
        resultEl.style.border = '1px solid #fc8181';
        resultEl.innerHTML = `❌ <strong>خطأ في المزامنة</strong><br><span style="font-size: 12px;">${escHTML(e.message)}</span>`;
    } finally {
        if (btn) btn.disabled = false;
    }
}

// حفظ فترة المزامنة التلقائية
function saveAutoSyncInterval() {
    const select = document.getElementById('autoSyncIntervalSelect');
    if (!select) return;
    const minutes = parseInt(select.value, 10) || 5;
    localStorage.setItem('pos_auto_sync_minutes', String(minutes));
    if (typeof syncManager !== 'undefined') {
        syncManager.restart();
    }
}

// تحميل فترة المزامنة التلقائية
function loadAutoSyncInterval() {
    const select = document.getElementById('autoSyncIntervalSelect');
    if (!select) return;
    const saved = localStorage.getItem('pos_auto_sync_minutes') || '5';
    select.value = saved;
}

// تحميل إعدادات التزامن عند فتح صفحة الإعدادات
const _originalLoadSettings = typeof loadSettings === 'function' ? loadSettings : null;
if (_originalLoadSettings) {
    const _origLoadSettings = loadSettings;
    loadSettings = async function() {
        await _origLoadSettings.apply(this, arguments);
        loadSyncModeSettings();
        loadAutoSyncInterval();
    };
}

// تحميل لوحة الأدمن مع إحصائيات المزامنة
const _originalLoadAdminDashboard = typeof loadAdminDashboard === 'function' ? loadAdminDashboard : null;
if (_originalLoadAdminDashboard) {
    const _origFn = loadAdminDashboard;
    loadAdminDashboard = async function() {
        await _origFn.apply(this, arguments);
        await updateSyncStatsUI();
    };
} else {
    // في حال لم تكن الدالة موجودة بعد
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof loadAdminDashboard === 'function') {
            const _origFn2 = loadAdminDashboard;
            loadAdminDashboard = async function() {
                await _origFn2.apply(this, arguments);
                await updateSyncStatsUI();
            };
        }
    });
}

console.log('[Sync UI] Loaded');
console.log('All Systems Loaded!');

