// ===============================================
// 🔧 تصحيح نظام العملاء - CUSTOMERS FIX
// ===============================================
// أضف هذا الكود في نهاية app.js

console.log('[Customers Fix] Loading...');

// متغير عام للعملاء في dropdown
let allCustomersDropdown = [];

// ===== 1. تحميل العملاء في dropdown =====
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

// ===== 2. تحديث dropdown العملاء =====
function updateCustomerSelect() {
    const select = document.getElementById('customerSelect');
    if (!select) return;
    
    // مسح الخيارات القديمة (ماعدا الأولين)
    while (select.options.length > 2) {
        select.remove(2);
    }
    
    // إضافة العملاء
    allCustomersDropdown.forEach(customer => {
        const option = document.createElement('option');
        option.value = customer.id;
        option.textContent = `${customer.name}${customer.phone ? ' (' + customer.phone + ')' : ''}`;
        select.appendChild(option);
    });
    
    console.log(`[Customers] تم تحديث dropdown: ${allCustomersDropdown.length} عميل`);
}

// ===== 3. اختيار عميل من dropdown =====
function selectCustomer() {
    const selectValue = document.getElementById('customerSelect').value;
    
    if (selectValue === 'new') {
        // فتح modal إضافة عميل جديد
        showAddCustomer();
        document.getElementById('customerSelect').value = '';
        return;
    }
    
    if (!selectValue) {
        clearCustomerSelection();
        return;
    }
    
    // البحث عن العميل المختار
    const customer = allCustomersDropdown.find(c => c.id == selectValue);
    if (customer) {
        document.getElementById('selectedCustomerId').value = customer.id;
        document.getElementById('selectedCustomerName').value = customer.name;
        document.getElementById('selectedCustomerPhone').value = customer.phone || '';
        
        // عرض التفاصيل
        document.getElementById('displayCustomerName').textContent = customer.name;
        document.getElementById('displayCustomerPhone').textContent = customer.phone || '-';
        document.getElementById('displayCustomerAddress').textContent = customer.address || '-';
        document.getElementById('customerDetails').style.display = 'block';
        
        console.log('[Customers] تم اختيار عميل:', customer.name);
    }
}

// ===== 4. مسح اختيار العميل =====
function clearCustomerSelection() {
    document.getElementById('customerSelect').value = '';
    document.getElementById('selectedCustomerId').value = '';
    document.getElementById('selectedCustomerName').value = '';
    document.getElementById('selectedCustomerPhone').value = '';
    document.getElementById('customerDetails').style.display = 'none';
    console.log('[Customers] تم مسح الاختيار');
}

// ===== 5. إنشاء/تحديث dropdown في الصفحة =====
function createCustomerDropdown() {
    const customerSection = document.querySelector('.customer-section');
    if (!customerSection) {
        console.warn('[Customers] لم يتم العثور على .customer-section');
        return;
    }
    
    customerSection.innerHTML = `
        <h3>معلومات العميل</h3>
        
        <select id="customerSelect" onchange="selectCustomer()" 
                style="width: 100%; padding: 10px; border: 2px solid #e0e0e0; 
                       border-radius: 8px; font-size: 14px; margin-bottom: 10px;">
            <option value="">-- اختر عميل أو أضف جديد --</option>
            <option value="new" style="font-weight: bold; color: #667eea;">➕ عميل جديد</option>
        </select>
        
        <input type="hidden" id="selectedCustomerId">
        <input type="hidden" id="selectedCustomerName">
        <input type="hidden" id="selectedCustomerPhone">
        
        <div id="customerDetails" style="display: none; background: #f8f9fa; 
                                          padding: 15px; border-radius: 8px; margin-top: 10px;">
            <div style="margin-bottom: 8px;">
                <strong>📝 الاسم:</strong> <span id="displayCustomerName"></span>
            </div>
            <div style="margin-bottom: 8px;">
                <strong>📞 الهاتف:</strong> <span id="displayCustomerPhone"></span>
            </div>
            <div style="margin-bottom: 8px;">
                <strong>📍 العنوان:</strong> <span id="displayCustomerAddress"></span>
            </div>
            <button onclick="clearCustomerSelection()" 
                    style="margin-top: 10px; padding: 6px 12px; background: #dc3545; 
                           color: white; border: none; border-radius: 6px; cursor: pointer;">
                ✖️ مسح الاختيار
            </button>
        </div>
    `;
    
    console.log('[Customers] تم إنشاء dropdown');
}

// ===== 6. التشغيل عند تحميل الصفحة =====
(function initCustomersDropdown() {
    // انتظر قليلاً حتى يتم تحميل الصفحة
    setTimeout(() => {
        createCustomerDropdown();
        loadCustomersDropdown();
        console.log('[Customers Fix] ✅ تم التفعيل');
    }, 1000);
})();

// ===== 7. ربط مع نظام الفواتير =====
// تحديث completeSale تلقائياً
const originalCompleteSale = window.completeSale;
window.completeSale = async function() {
    // تحديث بيانات العميل قبل الحفظ
    const oldCustomerName = document.getElementById('customerName');
    const oldCustomerPhone = document.getElementById('customerPhone');
    
    if (oldCustomerName) {
        oldCustomerName.value = document.getElementById('selectedCustomerName')?.value || '';
    }
    if (oldCustomerPhone) {
        oldCustomerPhone.value = document.getElementById('selectedCustomerPhone')?.value || '';
    }
    
    // استدعاء الدالة الأصلية
    return originalCompleteSale.apply(this, arguments);
};

console.log('[Customers Fix] Loaded ✅');
