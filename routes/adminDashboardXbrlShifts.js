/**
 * Routes: Admin Dashboard (invoices/stock summary), XBRL/IFRS, Shifts, Invoice Editing
 * Converted from server.py lines 5217-6615
 */

module.exports = function (app, helpers) {
  const { getDb, getMasterDb } = helpers;

  // ===== Helper: ensure XBRL tables exist =====
  function ensureXbrlTables(db) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS xbrl_company_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name_ar TEXT, company_name_en TEXT, commercial_registration TEXT,
        tax_number TEXT, reporting_currency TEXT DEFAULT 'SAR', industry_sector TEXT,
        country TEXT DEFAULT 'SA', fiscal_year_end TEXT DEFAULT '12-31',
        legal_form TEXT, contact_email TEXT, contact_phone TEXT, address TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS xbrl_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL,
        period_start TEXT NOT NULL, period_end TEXT NOT NULL,
        report_data TEXT, xbrl_xml TEXT, created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT
      )`);
    } catch (e) {
      console.log(`[XBRL] ensureXbrlTables: ${e.message}`);
    }
  }

  // ===== GET /api/admin-dashboard/invoices-summary =====
  app.get('/api/admin-dashboard/invoices-summary', (req, res) => {
    try {
      const db = getDb(req);

      const branchesSummary = db.prepare(`
        SELECT
          b.id as branch_id, b.name as branch_name,
          COUNT(i.id) as total_invoices,
          COALESCE(SUM(i.total), 0) as total_sales,
          COUNT(CASE WHEN i.cancelled = 1 THEN 1 END) as cancelled_invoices,
          COUNT(CASE WHEN DATE(i.created_at) = DATE('now') THEN 1 END) as today_invoices,
          COALESCE(SUM(CASE WHEN DATE(i.created_at) = DATE('now') THEN i.total ELSE 0 END), 0) as today_sales
        FROM branches b
        LEFT JOIN invoices i ON i.branch_id = b.id
        WHERE b.is_active = 1
        GROUP BY b.id, b.name ORDER BY b.id
      `).all();

      const overall = db.prepare(`
        SELECT
          COUNT(id) as total_invoices,
          COALESCE(SUM(total), 0) as total_sales,
          COUNT(CASE WHEN cancelled = 1 THEN 1 END) as cancelled_invoices,
          COUNT(CASE WHEN DATE(created_at) = DATE('now') THEN 1 END) as today_invoices,
          COALESCE(SUM(CASE WHEN DATE(created_at) = DATE('now') THEN total ELSE 0 END), 0) as today_sales
        FROM invoices
      `).get();

      res.json({ success: true, branches: branchesSummary, overall });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/admin-dashboard/stock-summary =====
  app.get('/api/admin-dashboard/stock-summary', (req, res) => {
    try {
      const db = getDb(req);
      const branches = db.prepare('SELECT id, name FROM branches WHERE is_active = 1 ORDER BY id').all();

      const rawData = db.prepare(`
        SELECT inv.id as product_id, inv.name as product_name, inv.category,
          pv.id as variant_id, pv.variant_name,
          bs.branch_id, b.name as branch_name, bs.stock, bs.sales_count
        FROM inventory inv
        LEFT JOIN product_variants pv ON pv.inventory_id = inv.id
        LEFT JOIN branch_stock bs ON bs.inventory_id = inv.id
          AND (bs.variant_id = pv.id OR (bs.variant_id IS NULL AND pv.id IS NULL))
        LEFT JOIN branches b ON b.id = bs.branch_id AND b.is_active = 1
        ORDER BY inv.name, pv.variant_name, b.id
      `).all();

      const productsMap = {};
      for (const row of rawData) {
        const key = `${row.product_id}_${row.variant_id || 0}`;
        if (!productsMap[key]) {
          let displayName = row.product_name;
          if (row.variant_name) displayName += ` - ${row.variant_name}`;
          productsMap[key] = {
            product_id: row.product_id, variant_id: row.variant_id,
            name: displayName, category: row.category || '', branches: {}
          };
        }
        if (row.branch_id) {
          productsMap[key].branches[row.branch_id] = {
            stock: row.stock || 0, sales_count: row.sales_count || 0
          };
        }
      }

      res.json({ success: true, branches, products: Object.values(productsMap) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/xbrl/company-info =====
  app.get('/api/xbrl/company-info', (req, res) => {
    try {
      const db = getDb(req);
      ensureXbrlTables(db);
      const row = db.prepare('SELECT * FROM xbrl_company_info ORDER BY id DESC LIMIT 1').get();
      res.json({ success: true, data: row || null });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/xbrl/company-info =====
  app.post('/api/xbrl/company-info', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      ensureXbrlTables(db);
      const existing = db.prepare('SELECT id FROM xbrl_company_info ORDER BY id DESC LIMIT 1').get();
      if (existing) {
        db.prepare(`UPDATE xbrl_company_info SET
          company_name_ar=?, company_name_en=?, commercial_registration=?,
          tax_number=?, reporting_currency=?, industry_sector=?,
          country=?, fiscal_year_end=?, legal_form=?,
          contact_email=?, contact_phone=?, address=?,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
          data.company_name_ar || '', data.company_name_en || '',
          data.commercial_registration || '', data.tax_number || '',
          data.reporting_currency || 'SAR', data.industry_sector || '',
          data.country || 'SA', data.fiscal_year_end || '12-31',
          data.legal_form || '', data.contact_email || '',
          data.contact_phone || '', data.address || '', existing.id
        );
      } else {
        db.prepare(`INSERT INTO xbrl_company_info
          (company_name_ar, company_name_en, commercial_registration,
           tax_number, reporting_currency, industry_sector,
           country, fiscal_year_end, legal_form,
           contact_email, contact_phone, address)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          data.company_name_ar || '', data.company_name_en || '',
          data.commercial_registration || '', data.tax_number || '',
          data.reporting_currency || 'SAR', data.industry_sector || '',
          data.country || 'SA', data.fiscal_year_end || '12-31',
          data.legal_form || '', data.contact_email || '',
          data.contact_phone || '', data.address || ''
        );
      }
      res.json({ success: true, message: 'تم حفظ بيانات الشركة' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/xbrl/financial-data =====
  app.get('/api/xbrl/financial-data', (req, res) => {
    try {
      const startDate = req.query.start_date;
      const endDate = req.query.end_date;
      const branchId = req.query.branch_id;
      const db = getDb(req);

      let dateFilter = '';
      const dateParams = [];
      if (startDate) { dateFilter += ' AND date(created_at) >= ?'; dateParams.push(startDate); }
      if (endDate) { dateFilter += ' AND date(created_at) <= ?'; dateParams.push(endDate); }

      let branchFilter = '';
      const branchParams = [];
      if (branchId) {
        const br = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId);
        if (br) { branchFilter = ' AND branch_name = ?'; branchParams.push(br.name); }
      }

      // Revenue (IFRS 15)
      const revenue = db.prepare(`SELECT
        COUNT(*) as invoice_count, COALESCE(SUM(total), 0) as total_revenue,
        COALESCE(SUM(subtotal), 0) as gross_revenue, COALESCE(SUM(discount), 0) as total_discounts,
        COALESCE(SUM(delivery_fee), 0) as delivery_revenue,
        COALESCE(SUM(coupon_discount), 0) as coupon_discounts,
        COALESCE(SUM(loyalty_discount), 0) as loyalty_discounts
        FROM invoices WHERE cancelled = 0 ${dateFilter} ${branchFilter}`).get(
        ...dateParams, ...branchParams
      );

      // COGS
      const cogsDateFilter = dateFilter.replace(/created_at/g, 'i.created_at');
      const cogsBranchFilter = branchFilter.replace(/branch_name/g, 'i.branch_name');
      const cogsData = db.prepare(`SELECT
        COALESCE(SUM(ii.quantity * COALESCE(inv.cost, 0)), 0) as total_cogs
        FROM invoice_items ii
        LEFT JOIN inventory inv ON ii.product_name = inv.name
        JOIN invoices i ON ii.invoice_id = i.id
        WHERE i.cancelled = 0 ${cogsDateFilter} ${cogsBranchFilter}`).get(
        ...dateParams, ...branchParams
      );
      const totalCogs = cogsData.total_cogs || 0;

      // Operating Expenses
      let expDateFilter = '';
      const expParams = [];
      if (startDate) { expDateFilter += ' AND date(expense_date) >= ?'; expParams.push(startDate); }
      if (endDate) { expDateFilter += ' AND date(expense_date) <= ?'; expParams.push(endDate); }
      let expBranchFilter = '';
      if (branchId) { expBranchFilter = ' AND branch_id = ?'; expParams.push(branchId); }

      const expenseRows = db.prepare(`SELECT
        COALESCE(SUM(amount), 0) as total_expenses,
        expense_type, COALESCE(SUM(amount), 0) as type_total
        FROM expenses WHERE 1=1 ${expDateFilter} ${expBranchFilter}
        GROUP BY expense_type`).all(...expParams);
      const expensesByType = {};
      let totalExpenses = 0;
      for (const row of expenseRows) {
        expensesByType[row.expense_type || 'أخرى'] = row.type_total;
        totalExpenses += row.type_total;
      }

      // Salaries
      const salaryParams = [];
      let salaryDateFilter = '';
      if (startDate) { salaryDateFilter += ' AND date(e.expense_date) >= ?'; salaryParams.push(startDate); }
      if (endDate) { salaryDateFilter += ' AND date(e.expense_date) <= ?'; salaryParams.push(endDate); }
      const sal = db.prepare(`SELECT COALESCE(SUM(sd.monthly_salary), 0) as total_salaries
        FROM salary_details sd JOIN expenses e ON sd.expense_id = e.id
        WHERE 1=1 ${salaryDateFilter}`).get(...salaryParams);
      const totalSalaries = sal.total_salaries || 0;

      // Inventory (IAS 2)
      const invData = db.prepare(`SELECT
        COALESCE(SUM(bs.stock * COALESCE(inv.cost, 0)), 0) as inventory_value,
        COALESCE(SUM(bs.stock), 0) as total_units
        FROM branch_stock bs JOIN inventory inv ON bs.inventory_id = inv.id`).get();

      // Customers
      const cust = db.prepare('SELECT COUNT(*) as customer_count FROM customers').get();

      // Returns
      let returnsData;
      try {
        returnsData = db.prepare(`SELECT COUNT(*) as return_count,
          COALESCE(SUM(total), 0) as total_refunds FROM returns WHERE 1=1 ${dateFilter}`).get(...dateParams);
      } catch (_e) {
        returnsData = { return_count: 0, total_refunds: 0 };
      }

      // Derived calculations
      const totalRev = revenue.total_revenue || 0;
      const grossProfit = totalRev - totalCogs;
      const operatingProfit = grossProfit - totalExpenses;
      const netProfit = operatingProfit;
      const totalRefunds = returnsData.total_refunds || 0;

      // Sales by payment method
      const payments = db.prepare(`SELECT payment_method,
        COUNT(*) as count, COALESCE(SUM(total), 0) as total
        FROM invoices WHERE cancelled = 0 ${dateFilter} ${branchFilter}
        GROUP BY payment_method`).all(...dateParams, ...branchParams);

      // Sales by branch
      const branchesData = db.prepare(`SELECT branch_name,
        COUNT(*) as count, COALESCE(SUM(total), 0) as total
        FROM invoices WHERE cancelled = 0 ${dateFilter} ${branchFilter}
        GROUP BY branch_name`).all(...dateParams, ...branchParams);

      res.json({
        success: true,
        data: {
          revenue: {
            total_revenue: totalRev, gross_revenue: revenue.gross_revenue || 0,
            total_discounts: revenue.total_discounts || 0, delivery_revenue: revenue.delivery_revenue || 0,
            coupon_discounts: revenue.coupon_discounts || 0, loyalty_discounts: revenue.loyalty_discounts || 0,
            invoice_count: revenue.invoice_count || 0
          },
          cost_of_sales: totalCogs, gross_profit: grossProfit,
          operating_expenses: { total: totalExpenses, by_type: expensesByType, salaries: totalSalaries },
          operating_profit: operatingProfit, net_profit: netProfit,
          profit_margin: totalRev > 0 ? Math.round((netProfit / totalRev * 100) * 100) / 100 : 0,
          inventory: { value: invData.inventory_value || 0, units: invData.total_units || 0 },
          customers: { count: cust.customer_count || 0 },
          returns: { count: returnsData.return_count || 0, total_refunds: totalRefunds },
          payments, branches: branchesData
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/xbrl/generate =====
  app.post('/api/xbrl/generate', (req, res) => {
    try {
      const data = req.body;
      const periodStart = data.period_start;
      const periodEnd = data.period_end;
      const financial = data.financial_data || {};
      const company = data.company_info || {};
      const manualAdjustments = data.manual_adjustments || {};

      const currency = company.reporting_currency || 'SAR';
      const entityName = company.company_name_en || 'Entity';
      const entityNameAr = company.company_name_ar || '';
      const crNumber = company.commercial_registration || '';
      const taxNumber = company.tax_number || '';

      // Merge manual adjustments
      const rev = financial.revenue || {};
      const totalRevenue = (rev.total_revenue || 0) + (manualAdjustments.other_income || 0);
      const costOfSales = financial.cost_of_sales || 0;
      const grossProfit = totalRevenue - costOfSales;
      const opExp = financial.operating_expenses || {};
      let totalOpex = (opExp.total || 0) + (manualAdjustments.additional_expenses || 0);
      const depreciation = manualAdjustments.depreciation || 0;
      totalOpex += depreciation;
      const operatingProfit = grossProfit - totalOpex;
      const financeCosts = manualAdjustments.finance_costs || 0;
      const zakatTax = manualAdjustments.zakat_tax || 0;
      const profitBeforeTax = operatingProfit - financeCosts;
      const netProfit = profitBeforeTax - zakatTax;

      // Assets
      const cashEquivalents = manualAdjustments.cash_equivalents || 0;
      const receivables = manualAdjustments.trade_receivables || 0;
      const inventoryVal = (financial.inventory || {}).value || 0;
      const totalCurrentAssets = cashEquivalents + receivables + inventoryVal + (manualAdjustments.other_current_assets || 0);
      const ppe = manualAdjustments.property_plant_equipment || 0;
      const intangibleAssets = manualAdjustments.intangible_assets || 0;
      const totalNonCurrentAssets = ppe + intangibleAssets + (manualAdjustments.other_non_current_assets || 0);
      const totalAssets = totalCurrentAssets + totalNonCurrentAssets;

      // Liabilities
      const tradePayables = manualAdjustments.trade_payables || 0;
      const shortTermLoans = manualAdjustments.short_term_loans || 0;
      const totalCurrentLiabilities = tradePayables + shortTermLoans + (manualAdjustments.other_current_liabilities || 0);
      const longTermLoans = manualAdjustments.long_term_loans || 0;
      const totalNonCurrentLiabilities = longTermLoans + (manualAdjustments.other_non_current_liabilities || 0);
      const totalLiabilities = totalCurrentLiabilities + totalNonCurrentLiabilities;

      // Equity
      const shareCapital = manualAdjustments.share_capital || 0;
      const retainedEarningsOpening = manualAdjustments.retained_earnings || 0;
      const retainedEarnings = retainedEarningsOpening + netProfit;
      const otherEquity = manualAdjustments.other_equity || 0;
      const totalEquity = shareCapital + retainedEarnings + otherEquity;

      // Cash Flow Statement (IAS 7)
      let cfCustomersReceived = manualAdjustments.cf_customers_received || 0;
      let cfSuppliersPaid = manualAdjustments.cf_suppliers_paid || 0;
      let cfEmployeesPaid = manualAdjustments.cf_employees_paid || 0;
      const cfOtherOperating = manualAdjustments.cf_other_operating || 0;
      const cfInterestPaid = manualAdjustments.cf_interest_paid || 0;
      const cfTaxesPaid = manualAdjustments.cf_taxes_paid || 0;
      if (cfCustomersReceived === 0 && totalRevenue > 0) cfCustomersReceived = totalRevenue;
      if (cfSuppliersPaid === 0 && costOfSales > 0) cfSuppliersPaid = costOfSales;
      if (cfEmployeesPaid === 0) cfEmployeesPaid = opExp.salaries || 0;
      const netCashOperating = cfCustomersReceived - cfSuppliersPaid - cfEmployeesPaid + cfOtherOperating - cfInterestPaid - cfTaxesPaid;

      const cfPpePurchased = manualAdjustments.cf_ppe_purchased || 0;
      const cfPpeSold = manualAdjustments.cf_ppe_sold || 0;
      const cfInvestmentsPurchased = manualAdjustments.cf_investments_purchased || 0;
      const cfInvestmentsSold = manualAdjustments.cf_investments_sold || 0;
      const cfOtherInvesting = manualAdjustments.cf_other_investing || 0;
      const netCashInvesting = cfPpeSold - cfPpePurchased + cfInvestmentsSold - cfInvestmentsPurchased + cfOtherInvesting;

      const cfLoansReceived = manualAdjustments.cf_loans_received || 0;
      const cfLoansRepaid = manualAdjustments.cf_loans_repaid || 0;
      const cfCapitalContributed = manualAdjustments.cf_capital_contributed || 0;
      const cfDividendsPaid = manualAdjustments.cf_dividends_paid || 0;
      const cfOtherFinancing = manualAdjustments.cf_other_financing || 0;
      const netCashFinancing = cfLoansReceived - cfLoansRepaid + cfCapitalContributed - cfDividendsPaid + cfOtherFinancing;

      const netChangeCash = netCashOperating + netCashInvesting + netCashFinancing;
      const cashBeginning = manualAdjustments.cash_beginning || 0;
      const cashEnding = cashBeginning + netChangeCash;

      // Statement of Changes in Equity (IAS 1)
      const equityOpeningCapital = manualAdjustments.equity_opening_capital !== undefined ? manualAdjustments.equity_opening_capital : shareCapital;
      const equityOpeningRetained = retainedEarningsOpening;
      const equityOpeningOther = manualAdjustments.equity_opening_other || 0;
      const equityOpeningTotal = equityOpeningCapital + equityOpeningRetained + equityOpeningOther;
      const equityNewCapital = manualAdjustments.equity_new_capital || 0;
      const dividendsDeclared = manualAdjustments.dividends_declared || 0;
      const otherComprehensiveIncome = manualAdjustments.other_comprehensive_income || 0;
      const equityClosingCapital = equityOpeningCapital + equityNewCapital;
      const equityClosingRetained = equityOpeningRetained + netProfit - dividendsDeclared;
      const equityClosingOther = equityOpeningOther + otherComprehensiveIncome;
      const equityClosingTotal = equityClosingCapital + equityClosingRetained + equityClosingOther;

      // Partners data
      const partners = manualAdjustments.partners || [];
      const partnersData = [];
      for (const p of partners) {
        const pCapitalOpening = p.capital_opening || 0;
        const pSharePct = p.share_percent || 0;
        const pProfit = pSharePct > 0 ? netProfit * (pSharePct / 100) : 0;
        const pDistributions = p.distributions || 0;
        const pCapitalChange = p.capital_change || 0;
        partnersData.push({
          name: p.name || '', capital_opening: pCapitalOpening, share_percent: pSharePct,
          profit_share: Math.round(pProfit * 100) / 100, distributions: pDistributions,
          capital_change: pCapitalChange,
          capital_closing: Math.round((pCapitalOpening + pProfit - pDistributions + pCapitalChange) * 100) / 100
        });
      }

      // iXBRL HTML Generation helpers
      function fmt(v) {
        return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      let factIdCounter = 0;
      function fid() { return `fact_${++factIdCounter}`; }
      function nf(concept, ctx, val) {
        const absVal = val ? Math.abs(val) : 0;
        return `<ix:nonFraction id="${fid()}" name="ifrs-full:${concept}" contextRef="${ctx}" unitRef="${currency}" decimals="0" scale="0" format="ixt:num-dot-decimal">${fmt(absVal)}</ix:nonFraction>`;
      }
      function nt(concept, ctx, text) {
        const safeText = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<ix:nonNumeric id="${fid()}" name="ifrs-full:${concept}" contextRef="${ctx}" xml:lang="ar">${safeText}</ix:nonNumeric>`;
      }

      // Build partners section
      let partnersSection = '';
      if (partnersData.length > 0) {
        let partnersRows = '';
        for (const pd of partnersData) {
          partnersRows += `<tr>
        <td style="font-weight: bold;">${pd.name}</td>
        <td class="num">${pd.share_percent.toFixed(1)}%</td>
        <td class="num">${fmt(pd.capital_opening)}</td>
        <td class="num" style="color: #38a169;">${fmt(pd.profit_share)}</td>
        <td class="num" style="color: #c53030;">(${fmt(pd.distributions)})</td>
        <td class="num">${fmt(pd.capital_change)}</td>
        <td class="num" style="font-weight: bold;">${fmt(pd.capital_closing)}</td>
      </tr>`;
        }
        const totalSharePercent = partnersData.reduce((s, pd) => s + pd.share_percent, 0);
        const totalCapitalOpening = partnersData.reduce((s, pd) => s + pd.capital_opening, 0);
        const totalProfitShare = partnersData.reduce((s, pd) => s + pd.profit_share, 0);
        const totalDistributions = partnersData.reduce((s, pd) => s + pd.distributions, 0);
        const totalCapitalChange = partnersData.reduce((s, pd) => s + pd.capital_change, 0);
        const totalCapitalClosing = partnersData.reduce((s, pd) => s + pd.capital_closing, 0);

        partnersSection = `
    <h3 style="color: #2b6cb0; margin-top: 25px;">تفصيل حقوق الملكية حسب الشركاء</h3>
    <table><tr><th>الشريك</th><th style="width:100px">نسبة الملكية</th><th style="width:130px">رأس المال الافتتاحي</th><th style="width:130px">نصيب الربح</th><th style="width:130px">التوزيعات</th><th style="width:130px">تغير رأس المال</th><th style="width:130px">الرصيد الختامي</th></tr>
    ${partnersRows}
    <tr class="grand-total"><td>الإجمالي</td><td class="num">${totalSharePercent.toFixed(1)}%</td><td class="num">${fmt(totalCapitalOpening)}</td><td class="num">${fmt(totalProfitShare)}</td><td class="num">(${fmt(totalDistributions)})</td><td class="num">${fmt(totalCapitalChange)}</td><td class="num">${fmt(totalCapitalClosing)}</td></tr>
    </table>`;
      }

      // Generate iXBRL HTML (abbreviated for space - full version in production)
      const xbrlXml = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:ixt="http://www.xbrl.org/inlineXBRL/transformation/2020-02-12" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:ifrs-full="https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full" xml:lang="ar">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><title>التقرير المالي - ${entityNameAr || entityName} - ${periodEnd}</title>
<style type="text/css">body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;margin:40px;background:#f9f9f9;color:#333;line-height:1.6;}h1{text-align:center;color:#1a365d;border-bottom:3px solid #2b6cb0;padding-bottom:15px;}h2{color:#2b6cb0;border-bottom:2px solid #e2e8f0;padding-bottom:8px;margin-top:35px;}.company-info{background:#edf2f7;padding:20px;border-radius:8px;margin:20px 0;}table{width:100%;border-collapse:collapse;margin:15px 0;background:white;}th{background:#2b6cb0;color:white;padding:12px 15px;text-align:right;}td{padding:10px 15px;border-bottom:1px solid #e2e8f0;}.num{text-align:left;direction:ltr;}.total{font-weight:bold;background:#edf2f7;}.grand-total{font-weight:bold;background:#e2e8f0;border-top:2px solid #2b6cb0;}.section-head{background:#f7fafc;font-weight:bold;color:#2b6cb0;}.footer{text-align:center;margin-top:40px;color:#a0aec0;font-size:0.85em;border-top:1px solid #e2e8f0;padding-top:15px;}@media print{body{margin:20px;background:white;}}</style></head>
<body>
<ix:header><ix:hidden>
<ix:nonNumeric id="h_entity_name" name="ifrs-full:NameOfReportingEntityOrOtherMeansOfIdentification" contextRef="CurrentPeriod" xml:lang="ar">${entityNameAr || entityName}</ix:nonNumeric>
</ix:hidden>
<ix:references><link:schemaRef xlink:type="simple" xlink:href="https://xbrl.ifrs.org/taxonomy/2024-03-27/full_ifrs_entry_point_2024-03-27.xsd"/></ix:references>
<ix:resources>
<xbrli:context id="CurrentPeriod"><xbrli:entity><xbrli:identifier scheme="http://www.cr.gov.sa">${crNumber}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>${periodStart}</xbrli:startDate><xbrli:endDate>${periodEnd}</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="CurrentInstant"><xbrli:entity><xbrli:identifier scheme="http://www.cr.gov.sa">${crNumber}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>${periodEnd}</xbrli:instant></xbrli:period></xbrli:context>
<xbrli:context id="PriorInstant"><xbrli:entity><xbrli:identifier scheme="http://www.cr.gov.sa">${crNumber}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>${periodStart}</xbrli:instant></xbrli:period></xbrli:context>
<xbrli:unit id="${currency}"><xbrli:measure>iso4217:${currency}</xbrli:measure></xbrli:unit>
</ix:resources></ix:header>
<h1>التقرير المالي وفق معايير IFRS</h1>
<p style="text-align:center;color:#718096;">الفترة من ${periodStart} إلى ${periodEnd}</p>
<div class="company-info">
<p><strong>اسم الشركة:</strong> ${nt('NameOfReportingEntityOrOtherMeansOfIdentification', 'CurrentPeriod', entityNameAr || entityName)}</p>
<p><strong>السجل التجاري:</strong> ${crNumber}</p><p><strong>الرقم الضريبي:</strong> ${taxNumber}</p><p><strong>العملة:</strong> ${currency}</p>
</div>
<h2>قائمة الدخل الشامل</h2>
<table><tr><th>البند</th><th style="width:200px">المبلغ (${currency})</th></tr>
<tr><td>الإيرادات</td><td class="num">${nf('Revenue', 'CurrentPeriod', totalRevenue)}</td></tr>
<tr><td>تكلفة المبيعات</td><td class="num">(${nf('CostOfSales', 'CurrentPeriod', costOfSales)})</td></tr>
<tr class="total"><td>مجمل الربح</td><td class="num">${nf('GrossProfit', 'CurrentPeriod', grossProfit)}</td></tr>
<tr><td>مصاريف تشغيلية</td><td class="num">(${nf('OtherExpenseByNature', 'CurrentPeriod', totalOpex)})</td></tr>
<tr class="total"><td>ربح العمليات</td><td class="num">${nf('ProfitLossFromOperatingActivities', 'CurrentPeriod', operatingProfit)}</td></tr>
<tr><td>تكاليف التمويل</td><td class="num">(${nf('FinanceCosts', 'CurrentPeriod', financeCosts)})</td></tr>
<tr class="total"><td>الربح قبل الزكاة</td><td class="num">${nf('ProfitLossBeforeTax', 'CurrentPeriod', profitBeforeTax)}</td></tr>
<tr><td>الزكاة / ضريبة الدخل</td><td class="num">(${nf('IncomeTaxExpenseContinuingOperations', 'CurrentPeriod', zakatTax)})</td></tr>
<tr class="grand-total"><td>صافي الربح</td><td class="num">${nf('ProfitLoss', 'CurrentPeriod', netProfit)}</td></tr>
</table>
<h2>قائمة المركز المالي</h2>
<table><tr><th>البند</th><th style="width:200px">المبلغ (${currency})</th></tr>
<tr class="section-head"><td colspan="2">الأصول المتداولة</td></tr>
<tr><td>النقد وما يعادله</td><td class="num">${nf('CashAndCashEquivalents', 'CurrentInstant', cashEquivalents)}</td></tr>
<tr><td>الذمم المدينة</td><td class="num">${nf('TradeAndOtherCurrentReceivables', 'CurrentInstant', receivables)}</td></tr>
<tr><td>المخزون</td><td class="num">${nf('Inventories', 'CurrentInstant', inventoryVal)}</td></tr>
<tr class="total"><td>إجمالي الأصول المتداولة</td><td class="num">${nf('CurrentAssets', 'CurrentInstant', totalCurrentAssets)}</td></tr>
<tr class="section-head"><td colspan="2">الأصول غير المتداولة</td></tr>
<tr><td>الممتلكات والمعدات</td><td class="num">${nf('PropertyPlantAndEquipment', 'CurrentInstant', ppe)}</td></tr>
<tr class="total"><td>إجمالي الأصول غير المتداولة</td><td class="num">${nf('NoncurrentAssets', 'CurrentInstant', totalNonCurrentAssets)}</td></tr>
<tr class="grand-total"><td>إجمالي الأصول</td><td class="num">${nf('Assets', 'CurrentInstant', totalAssets)}</td></tr>
<tr class="section-head"><td colspan="2">الخصوم المتداولة</td></tr>
<tr><td>الذمم الدائنة</td><td class="num">${nf('TradeAndOtherCurrentPayables', 'CurrentInstant', tradePayables)}</td></tr>
<tr class="total"><td>إجمالي الخصوم المتداولة</td><td class="num">${nf('CurrentLiabilities', 'CurrentInstant', totalCurrentLiabilities)}</td></tr>
<tr class="grand-total"><td>إجمالي الخصوم</td><td class="num">${nf('Liabilities', 'CurrentInstant', totalLiabilities)}</td></tr>
<tr class="section-head"><td colspan="2">حقوق الملكية</td></tr>
<tr><td>رأس المال</td><td class="num">${nf('IssuedCapital', 'CurrentInstant', shareCapital)}</td></tr>
<tr><td>الأرباح المبقاة</td><td class="num">${nf('RetainedEarnings', 'CurrentInstant', retainedEarnings)}</td></tr>
<tr class="total"><td>إجمالي حقوق الملكية</td><td class="num">${nf('Equity', 'CurrentInstant', totalEquity)}</td></tr>
<tr class="grand-total"><td>إجمالي الخصوم وحقوق الملكية</td><td class="num">${nf('EquityAndLiabilities', 'CurrentInstant', totalLiabilities + totalEquity)}</td></tr>
</table>
<h2>قائمة التدفقات النقدية</h2>
<table><tr><th>البند</th><th style="width:200px">المبلغ (${currency})</th></tr>
<tr class="section-head"><td colspan="2">الأنشطة التشغيلية</td></tr>
<tr><td>المقبوضات من العملاء</td><td class="num">${nf('ReceiptsFromSalesOfGoodsAndRenderingOfServices', 'CurrentPeriod', cfCustomersReceived)}</td></tr>
<tr><td>المدفوعات للموردين</td><td class="num">(${nf('PaymentsToSuppliersForGoodsAndServices', 'CurrentPeriod', cfSuppliersPaid)})</td></tr>
<tr><td>المدفوعات للموظفين</td><td class="num">(${nf('PaymentsToAndOnBehalfOfEmployees', 'CurrentPeriod', cfEmployeesPaid)})</td></tr>
<tr class="total"><td>صافي النقد من الأنشطة التشغيلية</td><td class="num">${nf('CashFlowsFromUsedInOperatingActivities', 'CurrentPeriod', netCashOperating)}</td></tr>
<tr class="section-head"><td colspan="2">الأنشطة الاستثمارية</td></tr>
<tr class="total"><td>صافي النقد من الأنشطة الاستثمارية</td><td class="num">${nf('CashFlowsFromUsedInInvestingActivities', 'CurrentPeriod', netCashInvesting)}</td></tr>
<tr class="section-head"><td colspan="2">الأنشطة التمويلية</td></tr>
<tr class="total"><td>صافي النقد من الأنشطة التمويلية</td><td class="num">${nf('CashFlowsFromUsedInFinancingActivities', 'CurrentPeriod', netCashFinancing)}</td></tr>
<tr class="grand-total"><td>صافي التغير في النقد</td><td class="num">${nf('IncreaseDecreaseInCashAndCashEquivalents', 'CurrentPeriod', netChangeCash)}</td></tr>
<tr><td>رصيد النقد - بداية الفترة</td><td class="num">${nf('CashAndCashEquivalents', 'PriorInstant', cashBeginning)}</td></tr>
<tr class="grand-total"><td>رصيد النقد - نهاية الفترة</td><td class="num">${nf('CashAndCashEquivalents', 'CurrentInstant', cashEnding)}</td></tr>
</table>
<h2>قائمة التغيرات في حقوق الملكية</h2>
<table><tr><th>البند</th><th style="width:150px">رأس المال</th><th style="width:150px">أرباح مبقاة</th><th style="width:150px">الإجمالي</th></tr>
<tr><td>الرصيد الافتتاحي</td><td class="num">${nf('IssuedCapital', 'PriorInstant', equityOpeningCapital)}</td><td class="num">${nf('RetainedEarnings', 'PriorInstant', equityOpeningRetained)}</td><td class="num">${nf('Equity', 'PriorInstant', equityOpeningTotal)}</td></tr>
<tr><td>صافي الربح</td><td class="num">-</td><td class="num">${nf('ProfitLoss', 'CurrentPeriod', netProfit)}</td><td class="num">${fmt(netProfit)}</td></tr>
<tr><td>أرباح موزعة</td><td class="num">-</td><td class="num">(${nf('DividendsRecognisedAsDistributionsToOwnersOfParent', 'CurrentPeriod', dividendsDeclared)})</td><td class="num">(${fmt(dividendsDeclared)})</td></tr>
<tr class="grand-total"><td>الرصيد الختامي</td><td class="num">${nf('IssuedCapital', 'CurrentInstant', equityClosingCapital)}</td><td class="num">${nf('RetainedEarnings', 'CurrentInstant', equityClosingRetained)}</td><td class="num">${nf('Equity', 'CurrentInstant', equityClosingTotal)}</td></tr>
</table>
${partnersSection}
<div class="footer"><p>تقرير مالي مولّد آلياً وفق معايير IFRS - صيغة Inline XBRL (iXBRL)</p><p>تم التوليد بتاريخ: ${periodEnd}</p></div>
</body></html>`;

      // Save report
      const db = getDb(req);
      ensureXbrlTables(db);
      const reportDataJson = JSON.stringify({
        revenue: totalRevenue, cost_of_sales: costOfSales, gross_profit: grossProfit,
        operating_expenses: totalOpex, depreciation, operating_profit: operatingProfit,
        finance_costs: financeCosts, profit_before_tax: profitBeforeTax, zakat_tax: zakatTax,
        net_profit: netProfit, total_current_assets: totalCurrentAssets,
        total_non_current_assets: totalNonCurrentAssets, total_assets: totalAssets,
        total_current_liabilities: totalCurrentLiabilities, total_non_current_liabilities: totalNonCurrentLiabilities,
        total_liabilities: totalLiabilities, total_equity: totalEquity,
        cash_flow: { net_cash_operating: netCashOperating, net_cash_investing: netCashInvesting,
          net_cash_financing: netCashFinancing, net_change_cash: netChangeCash,
          cash_beginning: cashBeginning, cash_ending: cashEnding },
        equity_changes: { opening_total: equityOpeningTotal, closing_total: equityClosingTotal,
          net_profit: netProfit, dividends: dividendsDeclared, new_capital: equityNewCapital,
          other_comprehensive_income: otherComprehensiveIncome, partners: partnersData },
        company, manual_adjustments: manualAdjustments
      });

      const result = db.prepare(`INSERT INTO xbrl_reports
        (report_type, period_start, period_end, report_data, xbrl_xml, notes)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        'IFRS_FULL', periodStart, periodEnd, reportDataJson, xbrlXml, data.notes || ''
      );

      res.json({
        success: true,
        report_id: Number(result.lastInsertRowid),
        xbrl_xml: xbrlXml,
        summary: {
          total_revenue: totalRevenue, cost_of_sales: costOfSales, gross_profit: grossProfit,
          operating_expenses: totalOpex, operating_profit: operatingProfit,
          finance_costs: financeCosts, profit_before_tax: profitBeforeTax,
          zakat_tax: zakatTax, net_profit: netProfit,
          total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
          net_cash_operating: netCashOperating, net_cash_investing: netCashInvesting,
          net_cash_financing: netCashFinancing, net_change_cash: netChangeCash,
          cash_beginning: cashBeginning, cash_ending: cashEnding,
          equity_opening_total: equityOpeningTotal, equity_closing_total: equityClosingTotal,
          dividends_declared: dividendsDeclared, other_comprehensive_income: otherComprehensiveIncome,
          partners: partnersData
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/xbrl/reports =====
  app.get('/api/xbrl/reports', (req, res) => {
    try {
      const db = getDb(req);
      ensureXbrlTables(db);
      res.json({ success: true, reports: db.prepare('SELECT id, report_type, period_start, period_end, created_at, notes FROM xbrl_reports ORDER BY created_at DESC LIMIT 50').all() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/xbrl/reports/:report_id =====
  app.get('/api/xbrl/reports/:report_id', (req, res) => {
    try {
      const db = getDb(req);
      ensureXbrlTables(db);
      const row = db.prepare('SELECT * FROM xbrl_reports WHERE id = ?').get(req.params.report_id);
      if (!row) return res.status(404).json({ success: false, error: 'التقرير غير موجود' });
      res.json({ success: true, report: row });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Shifts System =====

  // ===== GET /api/shifts =====
  app.get('/api/shifts', (req, res) => {
    try {
      const db = getDb(req);
      res.json({ success: true, shifts: db.prepare('SELECT * FROM shifts ORDER BY created_at DESC').all() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/shifts =====
  app.post('/api/shifts', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const result = db.prepare('INSERT INTO shifts (name, start_time, end_time, is_active, auto_lock) VALUES (?, ?, ?, ?, ?)')
        .run(data.name, data.start_time || '', data.end_time || '',
          data.is_active !== undefined ? data.is_active : 1, data.auto_lock || 0);
      res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/shifts/:shift_id =====
  app.put('/api/shifts/:shift_id', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      db.prepare('UPDATE shifts SET name = ?, start_time = ?, end_time = ?, is_active = ?, auto_lock = ? WHERE id = ?')
        .run(data.name, data.start_time || '', data.end_time || '',
          data.is_active !== undefined ? data.is_active : 1, data.auto_lock || 0, req.params.shift_id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== DELETE /api/shifts/:shift_id =====
  app.delete('/api/shifts/:shift_id', (req, res) => {
    try {
      const shiftId = req.params.shift_id;
      const db = getDb(req);
      db.prepare('UPDATE users SET shift_id = NULL WHERE shift_id = ?').run(shiftId);
      db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== POST /api/shifts/check-lock =====
  app.post('/api/shifts/check-lock', (req, res) => {
    try {
      const shiftId = req.body.shift_id;
      if (!shiftId) return res.json({ success: true, locked: false });

      const db = getDb(req);
      const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
      if (!shift || !shift.auto_lock || !shift.end_time) {
        return res.json({ success: true, locked: false });
      }

      const currentTime = new Date().toTimeString().slice(0, 5);
      const endTime = shift.end_time;
      const startTime = shift.start_time || '00:00';

      let locked;
      if (startTime <= endTime) {
        locked = currentTime >= endTime || currentTime < startTime;
      } else {
        locked = currentTime >= endTime && currentTime < startTime;
      }

      res.json({ success: true, locked, shift_name: shift.name, end_time: endTime, current_time: currentTime });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== PUT /api/invoices/:invoice_id/edit =====
  app.put('/api/invoices/:invoice_id/edit', (req, res) => {
    try {
      const invoiceId = req.params.invoice_id;
      const data = req.body;
      const db = getDb(req);

      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      if (!invoice) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
      if (invoice.cancelled) return res.status(400).json({ success: false, error: 'لا يمكن تعديل فاتورة ملغية' });
      if (invoice.order_status === 'منجز' && !data.can_edit_completed) {
        return res.status(403).json({ success: false, error: 'لا تملك صلاحية تعديل فاتورة منجزة' });
      }

      // Restore old stock
      const oldItems = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
      for (const item of oldItems) {
        if (item.branch_stock_id) {
          db.prepare('UPDATE branch_stock SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(item.quantity || 0, item.branch_stock_id);
        }
      }

      // Delete old items and insert new
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
      const newItems = data.items || [];
      for (const item of newItems) {
        const branchStockId = item.branch_stock_id || item.product_id;
        db.prepare(`INSERT INTO invoice_items
          (invoice_id, product_id, product_name, quantity, price, total, branch_stock_id, variant_id, variant_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(invoiceId, item.product_id, item.product_name, item.quantity,
            item.price, item.total, branchStockId, item.variant_id, item.variant_name);
        if (branchStockId) {
          db.prepare('UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(item.quantity || 0, branchStockId);
        }
      }

      // Update invoice
      db.prepare(`UPDATE invoices SET
        customer_id = ?, customer_name = ?, customer_phone = ?, customer_address = ?,
        subtotal = ?, discount = ?, total = ?, payment_method = ?,
        notes = ?, delivery_fee = ?,
        edited_at = CURRENT_TIMESTAMP, edited_by = ?,
        edit_count = COALESCE(edit_count, 0) + 1
        WHERE id = ?`).run(
        data.customer_id !== undefined ? data.customer_id : (invoice.customer_id || null),
        data.customer_name !== undefined ? data.customer_name : (invoice.customer_name || ''),
        data.customer_phone !== undefined ? data.customer_phone : (invoice.customer_phone || ''),
        data.customer_address !== undefined ? data.customer_address : (invoice.customer_address || ''),
        data.subtotal !== undefined ? data.subtotal : (invoice.subtotal || 0),
        data.discount !== undefined ? data.discount : (invoice.discount || 0),
        data.total !== undefined ? data.total : (invoice.total || 0),
        data.payment_method !== undefined ? data.payment_method : (invoice.payment_method || ''),
        data.notes !== undefined ? data.notes : (invoice.notes || ''),
        data.delivery_fee !== undefined ? data.delivery_fee : (invoice.delivery_fee || 0),
        data.edited_by || '', invoiceId
      );

      // Save payments
      const payments = data.payments || [];
      if (payments.length > 0) {
        db.prepare('UPDATE invoices SET transaction_number = ? WHERE id = ?').run(JSON.stringify(payments), invoiceId);
      }

      // Save edit history
      db.prepare('INSERT INTO invoice_edit_history (invoice_id, edited_by, edited_by_name, changes) VALUES (?, ?, ?, ?)')
        .run(invoiceId, data.edited_by_id, data.edited_by || '',
          JSON.stringify({ old_total: invoice.total || 0, new_total: data.total || 0,
            old_items_count: oldItems.length, new_items_count: newItems.length }));

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/invoices/:invoice_id/edit-history =====
  app.get('/api/invoices/:invoice_id/edit-history', (req, res) => {
    try {
      const db = getDb(req);
      res.json({ success: true,
        history: db.prepare('SELECT * FROM invoice_edit_history WHERE invoice_id = ? ORDER BY edited_at DESC').all(req.params.invoice_id)
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== GET /api/admin-dashboard/shift-performance =====
  app.get('/api/admin-dashboard/shift-performance', (req, res) => {
    try {
      const db = getDb(req);
      const shifts = db.prepare('SELECT * FROM shifts WHERE is_active = 1 ORDER BY id').all();

      const shiftStats = [];
      for (const shift of shifts) {
        const stats = db.prepare(`SELECT
          COUNT(i.id) as total_invoices, COALESCE(SUM(i.total), 0) as total_sales,
          COUNT(CASE WHEN DATE(i.created_at) = DATE('now') THEN 1 END) as today_invoices,
          COALESCE(SUM(CASE WHEN DATE(i.created_at) = DATE('now') THEN i.total ELSE 0 END), 0) as today_sales
          FROM invoices i WHERE i.shift_id = ? AND i.cancelled = 0`).get(shift.id);

        const employees = db.prepare(`SELECT u.id, u.full_name, u.username,
          COUNT(i.id) as invoice_count, COALESCE(SUM(i.total), 0) as total_sales
          FROM users u LEFT JOIN invoices i ON i.employee_name = u.full_name AND i.shift_id = ? AND i.cancelled = 0
          WHERE u.shift_id = ? AND u.is_active = 1 GROUP BY u.id ORDER BY total_sales DESC`).all(shift.id, shift.id);

        shiftStats.push({ shift, stats, employees });
      }

      const unassigned = db.prepare(`SELECT u.id, u.full_name, u.username,
        COUNT(i.id) as invoice_count, COALESCE(SUM(i.total), 0) as total_sales
        FROM users u LEFT JOIN invoices i ON i.employee_name = u.full_name AND i.cancelled = 0
        WHERE (u.shift_id IS NULL OR u.shift_id = 0) AND u.is_active = 1
        GROUP BY u.id ORDER BY total_sales DESC`).all();

      res.json({ success: true, shift_stats: shiftStats, unassigned_employees: unassigned });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Tenant Mode (online/offline) =====

  // PUT /api/admin/tenants/:id/mode — update tenant mode in master.db
  app.put('/api/admin/tenants/:id/mode', (req, res) => {
    try {
      const tenantId = req.params.id;
      const { mode } = req.body;
      if (!mode || !['online', 'offline'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'الوضع يجب أن يكون online أو offline' });
      }
      const masterDb = getMasterDb();
      const tenant = masterDb.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
      if (!tenant) {
        masterDb.close();
        return res.status(404).json({ success: false, error: 'المتجر غير موجود' });
      }
      masterDb.prepare('UPDATE tenants SET mode = ? WHERE id = ?').run(mode, tenantId);
      masterDb.close();
      return res.json({ success: true, message: 'تم تحديث وضع المتجر' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

};
