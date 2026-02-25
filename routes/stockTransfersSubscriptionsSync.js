const path = require('path');
const fs = require('fs');

/**
 * Stock Transfers, Subscriptions, Sync, and Version routes.
 * Converted from Python Flask (server.py lines 6616-7794).
 *
 * Dependencies available via closure:
 *   - app: Express application
 *   - getDb(req): returns a better-sqlite3 Database instance for the tenant
 *   - logAction(db, actionType, description, userId, userName, branchId, targetId, details)
 */
module.exports = function (app, helpers) {
  const { getDb, logAction } = helpers;

  // ===== Stock Transfers =====

  // GET /api/stock-transfers
  app.get('/api/stock-transfers', (req, res) => {
    try {
      const db = getDb(req);
      const status = req.query.status;
      const branch_id = req.query.branch_id;

      let query = 'SELECT * FROM stock_transfers WHERE 1=1';
      const params = [];

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }

      if (branch_id) {
        query += ' AND (from_branch_id = ? OR to_branch_id = ?)';
        params.push(branch_id, branch_id);
      }

      query += ' ORDER BY requested_at DESC LIMIT 200';
      const transfers = db.prepare(query).all(...params);

      // Fetch items for each transfer
      for (const t of transfers) {
        t.items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ?').all(t.id);
      }

      return res.json({ success: true, transfers });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/stock-transfers/:transfer_id
  app.get('/api/stock-transfers/:transfer_id', (req, res) => {
    try {
      const db = getDb(req);
      const transfer_id = parseInt(req.params.transfer_id);

      const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transfer_id);
      if (!transfer) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0637\u0644\u0628 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f' });
      }

      transfer.items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ?').all(transfer_id);

      return res.json({ success: true, transfer });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/stock-transfers
  app.post('/api/stock-transfers', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);

      // Generate transfer number
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM stock_transfers').get();
      const count = countRow.cnt;
      const transfer_number = 'TR-' + String(count + 1).padStart(5, '0');

      // Fetch branch names
      let from_branch_name = '';
      let to_branch_name = '';
      if (data.from_branch_id) {
        const row = db.prepare('SELECT name FROM branches WHERE id = ?').get(data.from_branch_id);
        if (row) from_branch_name = row.name;
      }
      if (data.to_branch_id) {
        const row = db.prepare('SELECT name FROM branches WHERE id = ?').get(data.to_branch_id);
        if (row) to_branch_name = row.name;
      }

      const insertResult = db.prepare(`
        INSERT INTO stock_transfers
        (transfer_number, from_branch_id, from_branch_name, to_branch_id, to_branch_name,
         status, requested_by, requested_by_name, notes)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        transfer_number,
        data.from_branch_id || null,
        from_branch_name,
        data.to_branch_id || null,
        to_branch_name,
        data.requested_by || null,
        data.requested_by_name || null,
        data.notes || ''
      );
      const transfer_id = insertResult.lastInsertRowid;

      // Add items
      const items = data.items || [];
      const insertItem = db.prepare(`
        INSERT INTO stock_transfer_items
        (transfer_id, inventory_id, product_name, variant_id, variant_name, quantity_requested)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(
          transfer_id,
          item.inventory_id || null,
          item.product_name || '',
          item.variant_id || null,
          item.variant_name || '',
          item.quantity || 0
        );
      }

      return res.json({ success: true, id: transfer_id, transfer_number });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/stock-transfers/:transfer_id/approve
  app.put('/api/stock-transfers/:transfer_id/approve', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const transfer_id = parseInt(req.params.transfer_id);

      const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transfer_id);
      if (!transfer) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0637\u0644\u0628 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f' });
      }
      if (transfer.status !== 'pending') {
        return res.status(400).json({ success: false, error: '\u0644\u0627 \u064a\u0645\u0643\u0646 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 - \u0627\u0644\u062d\u0627\u0644\u0629 \u0627\u0644\u062d\u0627\u0644\u064a\u0629: ' + transfer.status });
      }

      // Verify user is from source branch
      const user_branch = data.user_branch_id;
      if (user_branch && parseInt(user_branch) !== transfer.from_branch_id) {
        return res.status(403).json({ success: false, error: '\u0641\u0642\u0637 \u0627\u0644\u0641\u0631\u0639 \u0627\u0644\u0645\u0631\u0633\u0644 \u064a\u0645\u0643\u0646\u0647 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649 \u0627\u0644\u0637\u0644\u0628' });
      }

      // Update approved quantities
      const approved_items = data.items || [];
      const updateApproved = db.prepare(`
        UPDATE stock_transfer_items SET quantity_approved = ?
        WHERE id = ? AND transfer_id = ?
      `);
      for (const ai of approved_items) {
        updateApproved.run(ai.quantity_approved || 0, ai.item_id, transfer_id);
      }

      // Deduct stock from source branch (goods in transit)
      const items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ?').all(transfer_id);

      const updateBranchStock = db.prepare(`
        UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
        WHERE inventory_id = ? AND branch_id = ?
        AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL))
      `);
      for (const item of items) {
        const qty = item.quantity_approved || item.quantity_requested || 0;
        if (qty > 0 && item.inventory_id) {
          updateBranchStock.run(qty, item.inventory_id, transfer.from_branch_id,
            item.variant_id || null, item.variant_id || null);
        }
      }

      db.prepare(`
        UPDATE stock_transfers
        SET status = 'approved', approved_by = ?, approved_by_name = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.approved_by || null, data.approved_by_name || null, transfer_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/stock-transfers/:transfer_id/reject
  app.put('/api/stock-transfers/:transfer_id/reject', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const transfer_id = parseInt(req.params.transfer_id);

      const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transfer_id);
      if (!transfer) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0637\u0644\u0628 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f' });
      }
      if (transfer.status !== 'pending') {
        return res.status(400).json({ success: false, error: '\u0644\u0627 \u064a\u0645\u0643\u0646 \u0627\u0644\u0631\u0641\u0636 - \u0627\u0644\u062d\u0627\u0644\u0629: ' + transfer.status });
      }

      // Verify user is from source branch
      const user_branch = data.user_branch_id;
      if (user_branch && parseInt(user_branch) !== transfer.from_branch_id) {
        return res.status(403).json({ success: false, error: '\u0641\u0642\u0637 \u0627\u0644\u0641\u0631\u0639 \u0627\u0644\u0645\u0631\u0633\u0644 \u064a\u0645\u0643\u0646\u0647 \u0631\u0641\u0636 \u0627\u0644\u0637\u0644\u0628' });
      }

      db.prepare(`
        UPDATE stock_transfers
        SET status = 'rejected', reject_reason = ?, approved_by = ?, approved_by_name = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.reject_reason || '', data.approved_by || null, data.approved_by_name || null, transfer_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/stock-transfers/:transfer_id/pickup
  app.put('/api/stock-transfers/:transfer_id/pickup', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const transfer_id = parseInt(req.params.transfer_id);

      const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transfer_id);
      if (!transfer) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0637\u0644\u0628 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f' });
      }
      if (transfer.status !== 'approved') {
        return res.status(400).json({ success: false, error: '\u0644\u0627 \u064a\u0645\u0643\u0646 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645 - \u0627\u0644\u062d\u0627\u0644\u0629: ' + transfer.status });
      }

      // Verify user is from source branch
      const user_branch = data.user_branch_id;
      if (user_branch && parseInt(user_branch) !== transfer.from_branch_id) {
        return res.status(403).json({ success: false, error: '\u0641\u0642\u0637 \u0627\u0644\u0641\u0631\u0639 \u0627\u0644\u0645\u0631\u0633\u0644 \u064a\u0645\u0643\u0646\u0647 \u062a\u0633\u0644\u064a\u0645 \u0627\u0644\u0628\u0636\u0627\u0639\u0629 \u0644\u0644\u0633\u0627\u0626\u0642' });
      }

      db.prepare(`
        UPDATE stock_transfers
        SET status = 'in_transit', driver_id = ?, driver_name = ?, picked_up_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.driver_id || null, data.driver_name || null, transfer_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/stock-transfers/:transfer_id/receive
  app.put('/api/stock-transfers/:transfer_id/receive', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const transfer_id = parseInt(req.params.transfer_id);

      let transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transfer_id);
      if (!transfer) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0637\u0644\u0628 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f' });
      }
      if (transfer.status !== 'in_transit') {
        return res.status(400).json({ success: false, error: '\u0644\u0627 \u064a\u0645\u0643\u0646 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645 - \u0627\u0644\u062d\u0627\u0644\u0629: ' + transfer.status });
      }

      // Verify user is from destination branch
      const user_branch = data.user_branch_id;
      if (user_branch && parseInt(user_branch) !== transfer.to_branch_id) {
        return res.status(403).json({ success: false, error: '\u0641\u0642\u0637 \u0627\u0644\u0641\u0631\u0639 \u0627\u0644\u0637\u0627\u0644\u0628 \u064a\u0645\u0643\u0646\u0647 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645 \u0648\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u0639\u0645\u0644\u064a\u0629' });
      }

      // Update received quantities
      const received_items = data.items || [];
      const updateReceived = db.prepare(`
        UPDATE stock_transfer_items SET quantity_received = ?
        WHERE id = ? AND transfer_id = ?
      `);
      for (const ri of received_items) {
        if (ri.item_id && ri.quantity_received !== undefined && ri.quantity_received !== null) {
          updateReceived.run(ri.quantity_received, ri.item_id, transfer_id);
        }
      }

      // Fetch items after update
      const items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ?').all(transfer_id);

      // Add stock to destination branch
      const to_branch_id = transfer.to_branch_id;

      const selectBranchStock = db.prepare(`
        SELECT id, stock FROM branch_stock
        WHERE inventory_id = ? AND branch_id = ?
        AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL))
      `);
      const updateBranchStock = db.prepare(`
        UPDATE branch_stock SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const insertBranchStock = db.prepare(`
        INSERT INTO branch_stock (inventory_id, branch_id, variant_id, stock)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        const qty = item.quantity_received || item.quantity_approved || item.quantity_requested || 0;
        if (qty > 0 && item.inventory_id) {
          const existing = selectBranchStock.get(
            item.inventory_id, to_branch_id,
            item.variant_id || null, item.variant_id || null
          );

          if (existing) {
            updateBranchStock.run(qty, existing.id);
          } else {
            insertBranchStock.run(item.inventory_id, to_branch_id, item.variant_id || null, qty);
          }
        }
      }

      db.prepare(`
        UPDATE stock_transfers
        SET status = 'completed', received_by = ?, received_by_name = ?,
            delivered_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.received_by || null, data.received_by_name || null, transfer_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/stock-transfers/:transfer_id
  app.delete('/api/stock-transfers/:transfer_id', (req, res) => {
    try {
      const db = getDb(req);
      const transfer_id = parseInt(req.params.transfer_id);

      const transfer = db.prepare('SELECT status, from_branch_id, to_branch_id FROM stock_transfers WHERE id = ?').get(transfer_id);
      if (!transfer) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0637\u0644\u0628 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f' });
      }
      if (transfer.status !== 'pending' && transfer.status !== 'rejected') {
        return res.status(400).json({ success: false, error: '\u0644\u0627 \u064a\u0645\u0643\u0646 \u062d\u0630\u0641 \u0637\u0644\u0628 \u0641\u064a \u062d\u0627\u0644\u0629: ' + transfer.status });
      }

      // Verify user is from destination branch
      const user_branch = req.query.user_branch_id;
      if (user_branch && parseInt(user_branch) !== transfer.to_branch_id) {
        return res.status(403).json({ success: false, error: '\u0641\u0642\u0637 \u0627\u0644\u0641\u0631\u0639 \u0627\u0644\u0637\u0627\u0644\u0628 \u064a\u0645\u0643\u0646\u0647 \u062d\u0630\u0641 \u0627\u0644\u0637\u0644\u0628' });
      }

      db.prepare('DELETE FROM stock_transfer_items WHERE transfer_id = ?').run(transfer_id);
      db.prepare('DELETE FROM stock_transfers WHERE id = ?').run(transfer_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Subscription Plans =====

  // GET /api/subscription-plans
  app.get('/api/subscription-plans', (req, res) => {
    try {
      const db = getDb(req);
      const plans = db.prepare('SELECT * FROM subscription_plans ORDER BY price ASC').all();

      // Fetch items for each plan
      const getItems = db.prepare('SELECT * FROM subscription_plan_items WHERE plan_id = ?');
      for (const plan of plans) {
        plan.items = getItems.all(plan.id);
      }

      return res.json({ success: true, plans });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/subscription-plans
  app.post('/api/subscription-plans', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);

      const result = db.prepare(`
        INSERT INTO subscription_plans (name, duration_days, price, discount_percent, loyalty_multiplier, description, image)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.name || null,
        data.duration_days || 30,
        data.price || 0,
        data.discount_percent || 0,
        data.loyalty_multiplier || 1,
        data.description || '',
        data.image || ''
      );
      const plan_id = result.lastInsertRowid;

      // Add plan items
      const items = data.items || [];
      const insertItem = db.prepare(`
        INSERT INTO subscription_plan_items (plan_id, product_id, product_name, variant_id, variant_name, quantity)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(
          plan_id,
          item.product_id || null,
          item.product_name || null,
          item.variant_id || null,
          item.variant_name || null,
          item.quantity || 1
        );
      }

      return res.json({ success: true, id: plan_id });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/subscription-plans/:plan_id
  app.put('/api/subscription-plans/:plan_id', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const plan_id = parseInt(req.params.plan_id);

      db.prepare(`
        UPDATE subscription_plans SET name=?, duration_days=?, price=?, discount_percent=?,
        loyalty_multiplier=?, description=?, image=?, is_active=? WHERE id=?
      `).run(
        data.name || null,
        data.duration_days || null,
        data.price || null,
        data.discount_percent || null,
        data.loyalty_multiplier || null,
        data.description || '',
        data.image || '',
        data.is_active !== undefined ? data.is_active : 1,
        plan_id
      );

      // Update items if provided
      if (data.items !== undefined) {
        db.prepare('DELETE FROM subscription_plan_items WHERE plan_id = ?').run(plan_id);
        const insertItem = db.prepare(`
          INSERT INTO subscription_plan_items (plan_id, product_id, product_name, variant_id, variant_name, quantity)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const item of data.items) {
          insertItem.run(
            plan_id,
            item.product_id || null,
            item.product_name || null,
            item.variant_id || null,
            item.variant_name || null,
            item.quantity || 1
          );
        }
      }

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/subscription-plans/:plan_id
  app.delete('/api/subscription-plans/:plan_id', (req, res) => {
    try {
      const db = getDb(req);
      const plan_id = parseInt(req.params.plan_id);

      db.prepare('DELETE FROM subscription_plan_items WHERE plan_id = ?').run(plan_id);
      db.prepare('DELETE FROM subscription_plans WHERE id = ?').run(plan_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/subscription-plans/:plan_id/items
  app.get('/api/subscription-plans/:plan_id/items', (req, res) => {
    try {
      const db = getDb(req);
      const plan_id = parseInt(req.params.plan_id);

      const items = db.prepare('SELECT * FROM subscription_plan_items WHERE plan_id = ?').all(plan_id);

      return res.json({ success: true, items });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/subscription-plans/:plan_id/items
  app.post('/api/subscription-plans/:plan_id/items', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const plan_id = parseInt(req.params.plan_id);

      const result = db.prepare(`
        INSERT INTO subscription_plan_items (plan_id, product_id, product_name, variant_id, variant_name, quantity)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        plan_id,
        data.product_id || null,
        data.product_name || null,
        data.variant_id || null,
        data.variant_name || null,
        data.quantity || 1
      );
      const item_id = result.lastInsertRowid;

      return res.json({ success: true, id: item_id });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/subscription-plan-items/:item_id
  app.delete('/api/subscription-plan-items/:item_id', (req, res) => {
    try {
      const db = getDb(req);
      const item_id = parseInt(req.params.item_id);

      db.prepare('DELETE FROM subscription_plan_items WHERE id = ?').run(item_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Customer Subscriptions =====

  // GET /api/customer-subscriptions
  app.get('/api/customer-subscriptions', (req, res) => {
    try {
      const db = getDb(req);
      const status_filter = req.query.status || '';

      let query = 'SELECT * FROM customer_subscriptions WHERE 1=1';
      const params = [];
      if (status_filter) {
        query += ' AND status = ?';
        params.push(status_filter);
      }
      query += ' ORDER BY created_at DESC';

      const subs = db.prepare(query).all(...params);

      // Fetch plan items and redemptions for each subscription
      const getPlanItems = db.prepare('SELECT * FROM subscription_plan_items WHERE plan_id = ?');
      const getRedemptions = db.prepare(`
        SELECT product_id, variant_id, SUM(quantity) as total_redeemed
        FROM subscription_redemptions WHERE subscription_id = ?
        GROUP BY product_id, variant_id
      `);

      for (const sub of subs) {
        if (sub.plan_id) {
          sub.plan_items = getPlanItems.all(sub.plan_id);
        } else {
          sub.plan_items = [];
        }

        // Redemption totals per product
        const redemptionRows = getRedemptions.all(sub.id);
        const redeemed_map = {};
        for (const rd of redemptionRows) {
          const key = `${rd.product_id}_${rd.variant_id || 0}`;
          redeemed_map[key] = rd.total_redeemed;
        }
        sub.redeemed_map = redeemed_map;
      }

      return res.json({ success: true, subscriptions: subs });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/customer-subscriptions
  app.post('/api/customer-subscriptions', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);

      const customer_id = data.customer_id;
      const plan_id = data.plan_id;
      const subscription_code = (data.subscription_code || '').trim();

      if (!customer_id || !plan_id) {
        return res.status(400).json({ success: false, error: '\u064a\u062c\u0628 \u062a\u062d\u062f\u064a\u062f \u0627\u0644\u0639\u0645\u064a\u0644 \u0648\u0627\u0644\u062e\u0637\u0629' });
      }

      if (!subscription_code) {
        return res.status(400).json({ success: false, error: '\u064a\u062c\u0628 \u0625\u062f\u062e\u0627\u0644 \u0643\u0648\u062f \u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643' });
      }

      // Check code uniqueness
      const existingCode = db.prepare('SELECT id FROM customer_subscriptions WHERE subscription_code = ?').get(subscription_code);
      if (existingCode) {
        return res.status(400).json({ success: false, error: '\u0643\u0648\u062f \u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643 \u0645\u0633\u062a\u062e\u062f\u0645 \u0645\u0633\u0628\u0642\u0627\u064b' });
      }

      // Fetch plan data
      const plan = db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(plan_id);
      if (!plan) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u062e\u0637\u0629 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f\u0629' });
      }

      // Fetch customer data
      const cust = db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(customer_id);
      if (!cust) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0639\u0645\u064a\u0644 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f' });
      }

      const now = new Date();
      const start_date = data.start_date || now.toISOString().slice(0, 10);
      const start_dt = new Date(start_date);
      const end_dt = new Date(start_dt.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);
      const end_date = end_dt.toISOString().slice(0, 10);

      const result = db.prepare(`
        INSERT INTO customer_subscriptions
        (customer_id, customer_name, customer_phone, plan_id, plan_name, subscription_code,
         start_date, end_date, price_paid, discount_percent, loyalty_multiplier, notes,
         created_by, created_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer_id,
        cust.name,
        cust.phone,
        plan_id,
        plan.name,
        subscription_code,
        start_date,
        end_date,
        data.price_paid !== undefined ? data.price_paid : plan.price,
        plan.discount_percent,
        plan.loyalty_multiplier,
        data.notes || '',
        data.created_by || null,
        data.created_by_name || null
      );
      const sub_id = result.lastInsertRowid;

      return res.json({ success: true, id: sub_id });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT /api/customer-subscriptions/:sub_id
  app.put('/api/customer-subscriptions/:sub_id', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const sub_id = parseInt(req.params.sub_id);

      db.prepare(`
        UPDATE customer_subscriptions SET status=?, notes=?, end_date=? WHERE id=?
      `).run(data.status || null, data.notes || '', data.end_date || null, sub_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/customer-subscriptions/:sub_id
  app.delete('/api/customer-subscriptions/:sub_id', (req, res) => {
    try {
      const db = getDb(req);
      const sub_id = parseInt(req.params.sub_id);

      db.prepare('DELETE FROM customer_subscriptions WHERE id = ?').run(sub_id);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/customer-subscriptions/check
  app.get('/api/customer-subscriptions/check', (req, res) => {
    try {
      const code = (req.query.code || '').trim();
      const phone = (req.query.phone || '').trim();
      const customer_id = req.query.customer_id || '';

      const db = getDb(req);

      let query = "SELECT * FROM customer_subscriptions WHERE status = 'active'";
      const params = [];

      if (code) {
        query += ' AND subscription_code = ?';
        params.push(code);
      } else if (customer_id) {
        query += ' AND customer_id = ?';
        params.push(parseInt(customer_id));
      } else if (phone) {
        query += ' AND customer_phone = ?';
        params.push(phone);
      } else {
        return res.json({ success: true, subscription: null });
      }

      query += ' ORDER BY end_date DESC LIMIT 1';
      const row = db.prepare(query).get(...params);

      if (!row) {
        return res.json({ success: true, subscription: null, active: false });
      }

      const sub = row;
      const today = new Date().toISOString().slice(0, 10);
      if (sub.end_date < today) {
        db.prepare("UPDATE customer_subscriptions SET status = 'expired' WHERE id = ?").run(sub.id);
        sub.status = 'expired';
        return res.json({ success: true, subscription: sub, active: false });
      }

      // Fetch plan items
      if (sub.plan_id) {
        sub.plan_items = db.prepare('SELECT * FROM subscription_plan_items WHERE plan_id = ?').all(sub.plan_id);
      } else {
        sub.plan_items = [];
      }

      // Fetch redemption totals
      const redemptionRows = db.prepare(`
        SELECT product_id, variant_id, SUM(quantity) as total_redeemed
        FROM subscription_redemptions WHERE subscription_id = ?
        GROUP BY product_id, variant_id
      `).all(sub.id);
      const redeemed_map = {};
      for (const rd of redemptionRows) {
        const key = `${rd.product_id}_${rd.variant_id || 0}`;
        redeemed_map[key] = rd.total_redeemed;
      }
      sub.redeemed_map = redeemed_map;

      return res.json({ success: true, subscription: sub, active: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Subscription Redemptions =====

  // POST /api/subscription-redemptions
  app.post('/api/subscription-redemptions', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const subscription_id = data.subscription_id;
      const items = data.items || [];
      const branch_id = data.branch_id;

      if (!subscription_id || !items.length) {
        return res.status(400).json({ success: false, error: '\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645 \u063a\u064a\u0631 \u0645\u0643\u062a\u0645\u0644\u0629' });
      }

      if (!branch_id) {
        return res.status(400).json({ success: false, error: '\u064a\u062c\u0628 \u062a\u062d\u062f\u064a\u062f \u0627\u0644\u0641\u0631\u0639' });
      }

      // Verify subscription
      const sub = db.prepare('SELECT * FROM customer_subscriptions WHERE id = ? AND status = ?').get(subscription_id, 'active');
      if (!sub) {
        return res.status(404).json({ success: false, error: '\u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f \u0623\u0648 \u063a\u064a\u0631 \u0641\u0639\u0651\u0627\u0644' });
      }

      const today = new Date().toISOString().slice(0, 10);
      if (sub.end_date < today) {
        db.prepare('UPDATE customer_subscriptions SET status = ? WHERE id = ?').run('expired', subscription_id);
        return res.status(400).json({ success: false, error: '\u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643 \u0645\u0646\u062a\u0647\u064a \u0627\u0644\u0635\u0644\u0627\u062d\u064a\u0629' });
      }

      // Fetch plan items
      const planItemRows = db.prepare('SELECT * FROM subscription_plan_items WHERE plan_id = ?').all(sub.plan_id);
      const plan_items = {};
      for (const r of planItemRows) {
        const key = `${r.product_id}_${r.variant_id || 0}`;
        plan_items[key] = r;
      }

      // Fetch previous redemptions
      const redemptionRows = db.prepare(`
        SELECT product_id, variant_id, SUM(quantity) as total_redeemed
        FROM subscription_redemptions WHERE subscription_id = ?
        GROUP BY product_id, variant_id
      `).all(subscription_id);
      const redeemed = {};
      for (const rd of redemptionRows) {
        const key = `${rd.product_id}_${rd.variant_id || 0}`;
        redeemed[key] = rd.total_redeemed;
      }

      const redeemed_items = [];

      const insertRedemption = db.prepare(`
        INSERT INTO subscription_redemptions (subscription_id, customer_id, product_id, product_name, variant_id, variant_name, quantity, redeemed_by, redeemed_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateBranchStockDeduct = db.prepare(`
        UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      for (const item of items) {
        const product_id = item.product_id;
        const variant_id = item.variant_id;
        const qty = parseInt(item.quantity || 1);
        const key = `${product_id}_${variant_id || 0}`;

        // Verify product is in plan
        if (!plan_items[key]) {
          return res.status(400).json({ success: false, error: `\u0627\u0644\u0645\u0646\u062a\u062c ${item.product_name || ''} \u063a\u064a\u0631 \u0645\u0634\u0645\u0648\u0644 \u0641\u064a \u0627\u0644\u062e\u0637\u0629` });
        }

        // Check remaining quantity
        const allowed = plan_items[key].quantity;
        const already_redeemed = redeemed[key] || 0;
        const remaining = allowed - already_redeemed;
        if (qty > remaining) {
          return res.status(400).json({ success: false, error: `\u0627\u0644\u0643\u0645\u064a\u0629 \u0627\u0644\u0645\u062a\u0628\u0642\u064a\u0629 \u0644\u0640 ${item.product_name || ''} \u0647\u064a ${remaining} \u0641\u0642\u0637` });
        }

        // Check branch stock
        let bs;
        if (variant_id) {
          bs = db.prepare(`
            SELECT id, stock FROM branch_stock
            WHERE inventory_id = ? AND branch_id = ? AND variant_id = ?
          `).get(product_id, branch_id, variant_id);
        } else {
          bs = db.prepare(`
            SELECT id, stock FROM branch_stock
            WHERE inventory_id = ? AND branch_id = ? AND (variant_id IS NULL OR variant_id = 0)
          `).get(product_id, branch_id);
        }

        if (!bs) {
          return res.status(400).json({ success: false, error: `\u0627\u0644\u0645\u0646\u062a\u062c ${item.product_name || ''} \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f \u0641\u064a \u0645\u062e\u0632\u0648\u0646 \u0647\u0630\u0627 \u0627\u0644\u0641\u0631\u0639` });
        }

        if (bs.stock < qty) {
          return res.status(400).json({ success: false, error: `\u0645\u062e\u0632\u0648\u0646 \u0627\u0644\u0641\u0631\u0639 \u0644\u0627 \u064a\u0643\u0641\u064a \u0644\u0640 ${item.product_name || ''} (\u0627\u0644\u0645\u062a\u0648\u0641\u0631: ${bs.stock})` });
        }

        // Record redemption
        insertRedemption.run(
          subscription_id,
          sub.customer_id,
          product_id,
          item.product_name || null,
          variant_id || null,
          item.variant_name || null,
          qty,
          data.redeemed_by || null,
          data.redeemed_by_name || null
        );

        // Deduct from branch stock
        updateBranchStockDeduct.run(qty, bs.id);

        redeemed_items.push({ product_name: item.product_name, quantity: qty });
      }

      return res.json({ success: true, redeemed: redeemed_items });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/subscription-redemptions/:subscription_id
  app.get('/api/subscription-redemptions/:subscription_id', (req, res) => {
    try {
      const db = getDb(req);
      const subscription_id = parseInt(req.params.subscription_id);

      const redemptions = db.prepare('SELECT * FROM subscription_redemptions WHERE subscription_id = ? ORDER BY redeemed_at DESC').all(subscription_id);

      return res.json({ success: true, redemptions });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Sync API =====

  // POST /api/sync/upload
  app.post('/api/sync/upload', (req, res) => {
    try {
      const data = req.body;
      const db = getDb(req);
      const results = { invoices_synced: 0, customers_synced: 0, errors: [] };

      // 1. Sync new customers
      const customers = data.customers || [];
      for (const customer of customers) {
        try {
          if (customer.phone) {
            const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(customer.phone);
            if (existing) {
              results.customers_synced += 1;
              continue;
            }
          }
          db.prepare(`
            INSERT INTO customers (name, phone, email, address, notes)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            customer.name || '',
            customer.phone || '',
            customer.email || '',
            customer.address || '',
            customer.notes || ''
          );
          results.customers_synced += 1;
        } catch (e) {
          results.errors.push(`Customer ${customer.name || ''}: ${e.message}`);
        }
      }

      // 2. Sync invoices
      const invoices = data.invoices || [];
      for (const invoice of invoices) {
        try {
          const inv_num = invoice.invoice_number || '';
          if (inv_num) {
            const existingInv = db.prepare('SELECT id FROM invoices WHERE invoice_number = ?').get(inv_num);
            if (existingInv) {
              results.invoices_synced += 1;
              continue;
            }
          }

          const branch_id = invoice.branch_id || 1;
          const branchRow = db.prepare('SELECT name FROM branches WHERE id = ?').get(branch_id);
          const branch_name = branchRow ? branchRow.name : '';

          const shift_id = invoice.shift_id || null;
          let shift_name = '';
          if (shift_id) {
            const s = db.prepare('SELECT name FROM shifts WHERE id = ?').get(shift_id);
            shift_name = s ? s.name : '';
          }

          const now = new Date();
          const nowStr = now.toISOString().slice(0, 19).replace('T', ' ');

          const invResult = db.prepare(`
            INSERT INTO invoices
            (invoice_number, customer_id, customer_name, customer_phone, customer_address,
             subtotal, discount, total, payment_method, employee_name, notes,
             transaction_number, branch_id, branch_name, delivery_fee,
             coupon_discount, coupon_code, loyalty_discount,
             loyalty_points_earned, loyalty_points_redeemed,
             table_id, table_name, shift_id, shift_name, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            inv_num,
            invoice.customer_id || null,
            invoice.customer_name || '',
            invoice.customer_phone || '',
            invoice.customer_address || '',
            invoice.subtotal || 0,
            invoice.discount || 0,
            invoice.total || 0,
            invoice.payment_method || 'cash',
            invoice.employee_name || '',
            invoice.notes || '',
            invoice.transaction_number || '',
            branch_id,
            branch_name,
            invoice.delivery_fee || 0,
            invoice.coupon_discount || 0,
            invoice.coupon_code || '',
            invoice.loyalty_discount || 0,
            invoice.loyalty_points_earned || 0,
            invoice.loyalty_points_redeemed || 0,
            invoice.table_id || null,
            invoice.table_name || '',
            shift_id,
            shift_name,
            invoice.created_at || nowStr
          );
          const new_invoice_id = invResult.lastInsertRowid;

          // Insert invoice items
          const insertInvItem = db.prepare(`
            INSERT INTO invoice_items
            (invoice_id, product_id, product_name, quantity, price, total, branch_stock_id, variant_id, variant_name)
            VALUES (?,?,?,?,?,?,?,?,?)
          `);
          const updateStock = db.prepare(`
            UPDATE branch_stock SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `);

          const invItems = invoice.items || [];
          for (const item of invItems) {
            const branch_stock_id = item.branch_stock_id || item.product_id;
            insertInvItem.run(
              new_invoice_id,
              item.product_id || null,
              item.product_name || null,
              item.quantity || null,
              item.price || null,
              item.total || null,
              branch_stock_id || null,
              item.variant_id || null,
              item.variant_name || null
            );
            // Update stock
            if (branch_stock_id) {
              updateStock.run(item.quantity || 0, branch_stock_id);
            }
          }

          // Save payment details
          const payments = invoice.payments || [];
          if (payments.length > 0) {
            db.prepare(`
              UPDATE invoices SET payment_details = ? WHERE id = ?
            `).run(JSON.stringify(payments), new_invoice_id);
          }

          results.invoices_synced += 1;
        } catch (e) {
          results.errors.push(`Invoice ${invoice.invoice_number || ''}: ${e.message}`);
        }
      }

      const now = new Date();
      const synced_at = now.toISOString().slice(0, 19).replace('T', ' ');

      return res.json({
        success: true,
        results,
        synced_at
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/sync/download
  app.get('/api/sync/download', (req, res) => {
    try {
      const db = getDb(req);
      const branch_id = parseInt(req.query.branch_id) || 1;
      const since = req.query.since || '';

      const result = {};

      // 1. Products (from branch_stock)
      let products;
      if (since) {
        products = db.prepare(`
          SELECT bs.*, i.name as product_name, i.barcode, i.category, i.image,
                 i.description, i.unit
          FROM branch_stock bs
          JOIN inventory i ON bs.inventory_id = i.id
          WHERE bs.branch_id = ? AND (bs.updated_at > ? OR i.updated_at > ?)
        `).all(branch_id, since, since);
      } else {
        products = db.prepare(`
          SELECT bs.*, i.name as product_name, i.barcode, i.category, i.image,
                 i.description, i.unit
          FROM branch_stock bs
          JOIN inventory i ON bs.inventory_id = i.id
          WHERE bs.branch_id = ?
        `).all(branch_id);
      }

      // Fallback: if no branch_stock, use products table directly
      if (!products.length && !since) {
        products = db.prepare('SELECT * FROM products').all();
      }
      result.products = products;

      // 2. Customers
      if (since) {
        result.customers = db.prepare('SELECT * FROM customers WHERE updated_at > ?').all(since);
      } else {
        result.customers = db.prepare('SELECT * FROM customers').all();
      }

      // 3. Settings
      const settingsRows = db.prepare('SELECT * FROM settings').all();
      const settings = {};
      for (const row of settingsRows) {
        settings[row.key] = row.value;
      }
      result.settings = settings;

      // 4. Branches
      result.branches = db.prepare('SELECT * FROM branches').all();

      // 5. Categories (from products)
      const catRows = db.prepare('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""').all();
      result.categories = catRows.map(row => row.category);

      // 6. Active coupons
      result.coupons = db.prepare('SELECT * FROM coupons WHERE is_active = 1').all();

      const now = new Date();
      const synced_at = now.toISOString().slice(0, 19).replace('T', ' ');

      return res.json({
        success: true,
        data: result,
        synced_at
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/sync/status
  app.get('/api/sync/status', (req, res) => {
    try {
      const db = getDb(req);

      const products_count = db.prepare('SELECT COUNT(*) as cnt FROM products').get().cnt;
      const customers_count = db.prepare('SELECT COUNT(*) as cnt FROM customers').get().cnt;
      const invoices_count = db.prepare('SELECT COUNT(*) as cnt FROM invoices').get().cnt;

      // Last invoice
      const row = db.prepare('SELECT MAX(created_at) as last_invoice FROM invoices').get();
      const last_invoice = row ? row.last_invoice : null;

      const now = new Date();
      const server_time = now.toISOString().slice(0, 19).replace('T', ' ');

      return res.json({
        success: true,
        server_time,
        stats: {
          products: products_count,
          customers: customers_count,
          invoices: invoices_count,
          last_invoice
        }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/sync/full-download
  app.get('/api/sync/full-download', (req, res) => {
    try {
      const db = getDb(req);
      const branch_id = parseInt(req.query.branch_id) || 1;
      const result = {};

      // Products
      let products = db.prepare(`
        SELECT bs.id, bs.inventory_id, bs.stock, bs.price, bs.cost,
               i.name as product_name, i.barcode, i.category, i.image, i.unit
        FROM branch_stock bs
        JOIN inventory i ON bs.inventory_id = i.id
        WHERE bs.branch_id = ?
      `).all(branch_id);
      if (!products.length) {
        products = db.prepare('SELECT * FROM products').all();
      }
      result.products = products;

      // Customers
      result.customers = db.prepare('SELECT * FROM customers').all();

      // Settings
      const settingsRows = db.prepare('SELECT * FROM settings').all();
      const settings = {};
      for (const row of settingsRows) {
        settings[row.key] = row.value;
      }
      result.settings = settings;

      // Branches
      try {
        result.branches = db.prepare('SELECT * FROM branches').all();
      } catch (_e) {
        result.branches = [];
      }

      // Categories
      const catRows = db.prepare('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""').all();
      result.categories = catRows.map(row => row.category);

      // Coupons
      try {
        result.coupons = db.prepare('SELECT * FROM coupons WHERE is_active = 1').all();
      } catch (_e) {
        result.coupons = [];
      }

      // Variants
      try {
        result.variants = db.prepare('SELECT * FROM product_variants').all();
      } catch (_e) {
        result.variants = [];
      }

      const now = new Date();
      const synced_at = now.toISOString().slice(0, 19).replace('T', ' ');

      return res.json({
        success: true,
        data: result,
        synced_at,
        full_sync: true
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/version
  app.get('/api/version', (req, res) => {
    try {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return res.json({ success: true, version: pkg.version || '1.0.0' });
    } catch (_e) {
      return res.json({ success: true, version: '1.0.0' });
    }
  });

};

// NOTE: The original Python server runs on host 0.0.0.0 port 5000 (configurable via PORT env variable).
// In the Express entry point, use:
//   const port = parseInt(process.env.PORT) || 5000;
//   app.listen(port, '0.0.0.0', () => { ... });
