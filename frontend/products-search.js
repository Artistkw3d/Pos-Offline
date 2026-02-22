// Advanced Product Search Functions

function displayProductsCards(products) {
    const byCategory = {};
    products.forEach(p => {
        const cat = p.category || 'بدون فئة';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(p);
    });
    
    const container = document.getElementById('productsTableContainer');
    let html = '';
    
    // التحقق من الصلاحيات
    const canEdit = window.userPermissions?.canEditProducts || false;
    const canDelete = window.userPermissions?.canDeleteProducts || false;
    
    Object.keys(byCategory).sort().forEach(category => {
        html += `
            <div style="margin-bottom: 30px;">
                <h3 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 20px; border-radius: 10px; margin-bottom: 20px; font-size: 18px;">
                    📁 ${category} (${byCategory[category].length})
                </h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px;">
                    ${byCategory[category].map(p => {
                        let imgDisplay = '🛍️';
                        if (p.image_data && p.image_data.startsWith('data:image')) {
                            imgDisplay = `<img src="${p.image_data}" style="width:60px; height:60px; object-fit:cover; border-radius:8px;">`;
                        }
                        
                        // أزرار الإجراءات حسب الصلاحيات
                        let actionButtons = '';
                        if (canEdit || canDelete) {
                            actionButtons = '<div style="display:flex; gap:5px; justify-content:center; margin-top:10px;">';
                            if (canEdit) {
                                actionButtons += `<button onclick="editProduct(${p.id})" class="btn-sm" style="flex:1;">✏️ تعديل</button>`;
                            }
                            if (canDelete) {
                                actionButtons += `<button onclick="deleteProduct(${p.id})" class="btn-sm btn-danger" style="flex:1;">🗑️</button>`;
                            }
                            actionButtons += '</div>';
                        }
                        
                        return `
                            <div style="border:2px solid #e2e8f0; padding:15px; border-radius:12px; background:white; text-align:center; transition:all 0.3s;" 
                                 onmouseover="this.style.boxShadow='0 4px 12px rgba(102,126,234,0.3)'; this.style.transform='translateY(-2px)';"
                                 onmouseout="this.style.boxShadow='none'; this.style.transform='translateY(0)';">
                                <div style="margin-bottom:10px;">${imgDisplay}</div>
                                <div style="font-weight:bold; margin-bottom:5px; color:#2d3748;">${p.name}</div>
                                <div style="color:#667eea; font-size:18px; font-weight:bold; margin:8px 0;">${p.price.toFixed(3)} د.ك</div>
                                <div style="color:#6c757d; font-size:13px; margin-bottom:10px;">المخزون: ${p.stock}</div>
                                ${p.barcode ? `<div style="color:#6c757d; font-size:11px; margin-bottom:10px;">📊 ${p.barcode}</div>` : ''}
                                ${actionButtons}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function advancedSearchProducts() {
    const name = document.getElementById('searchProductName').value.toLowerCase();
    const barcode = document.getElementById('searchProductBarcode').value.toLowerCase();
    const category = document.getElementById('searchProductCategory').value;
    const priceMin = parseFloat(document.getElementById('searchPriceMin').value) || 0;
    const priceMax = parseFloat(document.getElementById('searchPriceMax').value) || Infinity;
    
    const filtered = allProducts.filter(p => {
        const matchName = !name || p.name.toLowerCase().includes(name);
        const matchBarcode = !barcode || (p.barcode && p.barcode.toLowerCase().includes(barcode));
        const matchCategory = !category || p.category === category;
        const matchPrice = p.price >= priceMin && p.price <= priceMax;
        
        return matchName && matchBarcode && matchCategory && matchPrice;
    });
    
    displayProductsCards(filtered);
}

function clearAdvancedSearch() {
    document.getElementById('searchProductName').value = '';
    document.getElementById('searchProductBarcode').value = '';
    document.getElementById('searchProductCategory').value = '';
    document.getElementById('searchPriceMin').value = '';
    document.getElementById('searchPriceMax').value = '';
    displayProductsCards(allProducts);
}

// تحديث loadProductsTable لاستخدام الدوال الجديدة
const originalLoadProductsTable = window.loadProductsTable;
window.loadProductsTable = async function() {
    try {
        const response = await fetch(`${API_URL}/api/products`);
        const data = await response.json();
        if (data.success) {
            allProducts = data.products;
            
            // تحديث قائمة الفئات في البحث
            const categorySelect = document.getElementById('searchProductCategory');
            if (categorySelect) {
                const cats = new Set();
                data.products.forEach(p => {
                    if (p.category) cats.add(p.category);
                });
                categorySelect.innerHTML = '<option value="">كل الفئات</option>' + 
                    Array.from(cats).sort().map(c => `<option value="${c}">${c}</option>`).join('');
            }
            
            displayProductsCards(data.products);
        }
    } catch (error) {
        console.error('خطأ:', error);
    }
};
