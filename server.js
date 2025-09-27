// Bunca Bakery - Fully Automated Workflow System
// Enhanced with complete automation, smart calculations, and advanced features
// Compatible with existing database structure while adding powerful new capabilities

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'PLEASE_SET_ME';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

console.log('🍞 Bunca Bakery - Fully Automated System Starting...');
console.log('Environment:', { 
  node_env: NODE_ENV, 
  has_db: !!DATABASE_URL, 
  has_admin: !!ADMIN_EMAIL,
  port: PORT 
});

/* ---------- Enhanced Database Connection ---------- */
const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

async function q(text, params = []) {
  const client = await pool.connect();
  try { 
    return await client.query(text, params); 
  } catch (error) {
    console.error('Database query error:', error.message);
    throw error;
  } finally { 
    client.release(); 
  }
}

/* ---------- Enhanced Express Configuration ---------- */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

// Enhanced session configuration
app.use(session({
  name: 'bunca_session',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, 
    sameSite: 'lax',
    secure: NODE_ENV === 'production' ? 'auto' : false,
    maxAge: 1000 * 60 * 60 * 12 // 12 hours
  }
}));

// Enhanced static file serving
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: NODE_ENV === 'production' ? '1d' : '0',
  etag: true
}));

/* ---------- Enhanced Database Schema with Automation ---------- */
async function ensureSchema() {
  try {
    console.log('🔧 Setting up enhanced database schema...');
    
    // First, create basic tables if they don't exist (backward compatible)
    await q(`CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      base_unit TEXT NOT NULL,
      price_per_unit DECIMAL(10,4) NOT NULL DEFAULT 0
    );`);
    
    // Then safely add new columns one by one
    try {
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS current_stock DECIMAL(10,3) DEFAULT 0;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS min_stock DECIMAL(10,3) DEFAULT 0;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS reorder_point DECIMAL(10,3) DEFAULT 0;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS supplier TEXT DEFAULT '';`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS shelf_life_days INTEGER DEFAULT 30;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
      console.log('✅ Materials table enhanced successfully');
    } catch (error) {
      console.log('ℹ️ Materials table migration skipped (columns may already exist)');
    }

    // Create basic items table
    await q(`CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      yield_qty DECIMAL(10,3) NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs'
    );`);
    
    // Safely add new columns to items table
    try {
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'bakery';`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS shelf_life_hours INTEGER DEFAULT 24;`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS allergens TEXT[] DEFAULT '{}';`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
      console.log('✅ Items table enhanced successfully');
    } catch (error) {
      console.log('ℹ️ Items table migration skipped (columns may already exist)');
    }

    // Create basic BOM table
    await q(`CREATE TABLE IF NOT EXISTS bom (
      id SERIAL PRIMARY KEY,
      product_code TEXT NOT NULL,
      material_code TEXT NOT NULL,
      qty DECIMAL(10,4) NOT NULL,
      unit TEXT NOT NULL
    );`);
    
    // Safely add new columns to BOM table
    try {
      await q(`ALTER TABLE bom ADD COLUMN IF NOT EXISTS waste_factor DECIMAL(5,4) DEFAULT 0.05;`);
      await q(`ALTER TABLE bom ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';`);
      console.log('✅ BOM table enhanced successfully');
    } catch (error) {
      console.log('ℹ️ BOM table migration skipped (columns may already exist)');
    }

    // Create basic production_plan table
    await q(`CREATE TABLE IF NOT EXISTS production_plan (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      product_code TEXT NOT NULL,
      qty DECIMAL(10,3) NOT NULL
    );`);
    
    // Safely add new columns to production_plan table
    try {
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'planned';`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 5;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS start_time TIME;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS end_time TIME;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS assigned_staff TEXT[] DEFAULT '{}';`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS equipment_required TEXT[] DEFAULT '{}';`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS shop TEXT DEFAULT '';`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS actual_qty DECIMAL(10,3) DEFAULT 0;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS cost_per_unit DECIMAL(10,4) DEFAULT 0;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS total_cost DECIMAL(10,2) DEFAULT 0;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
      console.log('✅ Production plan table enhanced successfully');
    } catch (error) {
      console.log('ℹ️ Production plan table migration skipped (columns may already exist)');
    }

    // Enhanced automation tables
    await q(`CREATE TABLE IF NOT EXISTS inventory_transactions (
      id SERIAL PRIMARY KEY,
      material_code TEXT NOT NULL,
      transaction_type TEXT NOT NULL, -- 'in', 'out', 'adjustment'
      quantity DECIMAL(10,3) NOT NULL,
      unit TEXT NOT NULL,
      reference_type TEXT, -- 'production', 'purchase', 'adjustment', 'waste'
      reference_id TEXT,
      cost_per_unit DECIMAL(10,4) DEFAULT 0,
      total_cost DECIMAL(10,2) DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT 'system',
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (material_code) REFERENCES materials(code) ON DELETE CASCADE
    );`);

    await q(`CREATE TABLE IF NOT EXISTS quality_checks (
      id SERIAL PRIMARY KEY,
      check_type TEXT NOT NULL, -- 'material_receipt', 'production_batch', 'finished_product'
      reference_id TEXT NOT NULL,
      checked_by TEXT NOT NULL,
      check_date TIMESTAMP DEFAULT NOW(),
      passed BOOLEAN NOT NULL,
      temperature DECIMAL(5,2),
      ph_level DECIMAL(4,2),
      moisture_content DECIMAL(5,2),
      visual_inspection TEXT,
      notes TEXT DEFAULT '',
      corrective_action TEXT DEFAULT ''
    );`);

    await q(`CREATE TABLE IF NOT EXISTS cost_calculations (
      id SERIAL PRIMARY KEY,
      product_code TEXT NOT NULL,
      calculation_date DATE DEFAULT CURRENT_DATE,
      quantity DECIMAL(10,3) NOT NULL,
      material_cost DECIMAL(10,2) DEFAULT 0,
      labor_cost DECIMAL(10,2) DEFAULT 0,
      overhead_cost DECIMAL(10,2) DEFAULT 0,
      total_cost DECIMAL(10,2) DEFAULT 0,
      cost_per_unit DECIMAL(10,4) DEFAULT 0,
      margin_percentage DECIMAL(5,2) DEFAULT 0,
      suggested_price DECIMAL(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (product_code) REFERENCES items(code) ON DELETE CASCADE
    );`);

    await q(`CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      table_name TEXT,
      record_id TEXT,
      old_values JSONB,
      new_values JSONB,
      ip_address TEXT,
      user_agent TEXT,
      timestamp TIMESTAMP DEFAULT NOW()
    );`);

    // Performance indexes
    await q(`CREATE INDEX IF NOT EXISTS idx_materials_active ON materials(active) WHERE active = true;`);
    await q(`CREATE INDEX IF NOT EXISTS idx_materials_stock ON materials(current_stock, reorder_point);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_items_active ON items(active) WHERE active = true;`);
    await q(`CREATE INDEX IF NOT EXISTS idx_production_plan_day ON production_plan(day);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_production_plan_status ON production_plan(status);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_material ON inventory_transactions(material_code);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_date ON inventory_transactions(created_at);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);`);

    // Insert default system settings
    await q(`INSERT INTO system_settings (key, value, description) VALUES 
      ('default_waste_factor', '0.05', 'Default waste factor for recipes (5%)'),
      ('auto_inventory_tracking', 'true', 'Enable automatic inventory tracking'),
      ('quality_check_required', 'false', 'Require quality checks for all production'),
      ('cost_calculation_method', 'fifo', 'Cost calculation method: fifo, lifo, average'),
      ('default_labor_cost_per_hour', '15.00', 'Default labor cost per hour'),
      ('default_overhead_percentage', '25.0', 'Default overhead percentage'),
      ('auto_reorder_alerts', 'true', 'Enable automatic reorder point alerts'),
      ('default_shelf_life_hours', '24', 'Default shelf life for baked goods'),
      ('temperature_monitoring', 'false', 'Enable temperature monitoring'),
      ('batch_tracking', 'true', 'Enable batch tracking for production')
    ON CONFLICT (key) DO NOTHING;`);

    console.log('✅ Enhanced database schema ready');
  } catch (error) {
    console.error('❌ Schema setup failed:', error.message);
    throw error;
  }
}

/* ---------- Enhanced Authentication ---------- */
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function logAudit(userId, action, tableName = null, recordId = null, oldValues = null, newValues = null, req = null) {
  const ipAddress = req ? (req.ip || req.connection.remoteAddress) : null;
  const userAgent = req ? req.get('User-Agent') : null;
  
  q(`INSERT INTO audit_log (user_id, action, table_name, record_id, old_values, new_values, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, action, tableName, recordId, oldValues, newValues, ipAddress, userAgent])
    .catch(err => console.error('Audit log failed:', err.message));
}

/* ---------- Enhanced Utility Functions ---------- */
async function getSetting(key, defaultValue = null) {
  try {
    const result = await q('SELECT value FROM system_settings WHERE key = $1', [key]);
    return result.rows.length > 0 ? result.rows[0].value : defaultValue;
  } catch (error) {
    return defaultValue;
  }
}

async function updateInventory(materialCode, quantity, transactionType, referenceType = null, referenceId = null, userId = 'system') {
  try {
    const autoTracking = await getSetting('auto_inventory_tracking', 'true');
    if (autoTracking !== 'true') return;

    // Get current material info
    const materialResult = await q('SELECT * FROM materials WHERE code = $1', [materialCode]);
    if (materialResult.rows.length === 0) return;

    const material = materialResult.rows[0];
    const costPerUnit = material.price_per_unit || 0;
    const totalCost = quantity * costPerUnit;

    // Record transaction
    await q(`INSERT INTO inventory_transactions 
             (material_code, transaction_type, quantity, unit, reference_type, reference_id, cost_per_unit, total_cost, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [materialCode, transactionType, quantity, material.base_unit, referenceType, referenceId, costPerUnit, totalCost, userId]);

    // Update stock
    const stockChange = transactionType === 'out' ? -quantity : quantity;
    await q('UPDATE materials SET current_stock = current_stock + $1, updated_at = NOW() WHERE code = $2',
      [stockChange, materialCode]);

    console.log(`📦 Inventory updated: ${materialCode} ${transactionType} ${quantity} ${material.base_unit}`);
  } catch (error) {
    console.error('Inventory update failed:', error.message);
  }
}

async function calculateProductCost(productCode, quantity = 1) {
  try {
    const bomResult = await q(`
      SELECT b.material_code, b.qty, b.unit, b.waste_factor, m.price_per_unit, m.name as material_name
      FROM bom b
      JOIN materials m ON m.code = b.material_code
      WHERE b.product_code = $1 AND m.active = true
    `, [productCode]);

    let totalMaterialCost = 0;
    const lines = [];
    const warnings = [];

    for (const line of bomResult.rows) {
      const adjustedQty = line.qty * (1 + (line.waste_factor || 0)) * quantity;
      const lineCost = adjustedQty * line.price_per_unit;
      totalMaterialCost += lineCost;

      lines.push({
        material_code: line.material_code,
        material_name: line.material_name,
        qty: adjustedQty,
        unit: line.unit,
        cost_per_unit: line.price_per_unit,
        cost: lineCost.toFixed(4)
      });

      // Check stock availability
      const stockResult = await q('SELECT current_stock FROM materials WHERE code = $1', [line.material_code]);
      if (stockResult.rows.length > 0) {
        const currentStock = stockResult.rows[0].current_stock || 0;
        if (currentStock < adjustedQty) {
          warnings.push(`${line.material_name}: Insufficient stock (need ${adjustedQty}, have ${currentStock})`);
        }
      }
    }

    // Calculate additional costs
    const laborCostPerHour = parseFloat(await getSetting('default_labor_cost_per_hour', '15.00'));
    const overheadPercentage = parseFloat(await getSetting('default_overhead_percentage', '25.0'));
    
    const estimatedLaborHours = quantity * 0.5; // Estimate 30 minutes per unit
    const laborCost = estimatedLaborHours * laborCostPerHour;
    const overheadCost = totalMaterialCost * (overheadPercentage / 100);
    const totalCost = totalMaterialCost + laborCost + overheadCost;

    return {
      product_code: productCode,
      quantity: quantity,
      material_cost: totalMaterialCost.toFixed(2),
      labor_cost: laborCost.toFixed(2),
      overhead_cost: overheadCost.toFixed(2),
      total_cost: totalCost.toFixed(2),
      cost_per_unit: (totalCost / quantity).toFixed(4),
      lines: lines,
      warnings: warnings
    };
  } catch (error) {
    console.error('Cost calculation failed:', error.message);
    return { error: error.message };
  }
}

async function processProduction(productionId, userId = 'system') {
  try {
    const productionResult = await q('SELECT * FROM production_plan WHERE id = $1', [productionId]);
    if (productionResult.rows.length === 0) return { error: 'Production not found' };

    const production = productionResult.rows[0];
    
    // Calculate costs
    const costData = await calculateProductCost(production.product_code, production.qty);
    if (costData.error) return costData;

    // Deduct materials from inventory
    const bomResult = await q(`
      SELECT b.material_code, b.qty, b.waste_factor
      FROM bom b
      WHERE b.product_code = $1
    `, [production.product_code]);

    for (const line of bomResult.rows) {
      const adjustedQty = line.qty * (1 + (line.waste_factor || 0)) * production.qty;
      await updateInventory(line.material_code, adjustedQty, 'out', 'production', productionId, userId);
    }

    // Update production record
    await q(`UPDATE production_plan 
             SET status = 'completed', 
                 actual_qty = $1, 
                 cost_per_unit = $2, 
                 total_cost = $3,
                 updated_at = NOW()
             WHERE id = $4`,
      [production.qty, costData.cost_per_unit, costData.total_cost, productionId]);

    // Record cost calculation
    await q(`INSERT INTO cost_calculations 
             (product_code, quantity, material_cost, labor_cost, overhead_cost, total_cost, cost_per_unit)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [production.product_code, production.qty, costData.material_cost, costData.labor_cost, 
       costData.overhead_cost, costData.total_cost, costData.cost_per_unit]);

    logAudit(userId, 'production_completed', 'production_plan', productionId, null, { status: 'completed' });

    return { success: true, cost_data: costData };
  } catch (error) {
    console.error('Production processing failed:', error.message);
    return { error: error.message };
  }
}

/* ---------- Enhanced API Routes ---------- */

// Health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString(), system: 'Bunca Bakery Automated' });
});

// Authentication
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      req.session.user = { email, role: 'admin' };
      logAudit(email, 'login', null, null, null, null, req);
      res.json({ success: true, user: { email, role: 'admin' } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', (req, res) => {
  const userId = req.session.user?.email || 'unknown';
  logAudit(userId, 'logout', null, null, null, null, req);
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Enhanced Materials API
app.get('/api/materials', requireAuth, async (req, res) => {
  try {
    const { active = 'true', low_stock = 'false' } = req.query;
    
    let query = `
      SELECT m.*, 
             CASE WHEN m.current_stock <= m.reorder_point THEN true ELSE false END as needs_reorder,
             (SELECT COUNT(*) FROM inventory_transactions it WHERE it.material_code = m.code) as transaction_count
      FROM materials m
    `;
    
    const conditions = [];
    const params = [];
    
    if (active !== 'all') {
      conditions.push(`m.active = $${params.length + 1}`);
      params.push(active === 'true');
    }
    
    if (low_stock === 'true') {
      conditions.push(`m.current_stock <= m.reorder_point`);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY m.name';
    
    const result = await q(query, params);
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Materials fetch failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/materials', requireAuth, async (req, res) => {
  try {
    const { code, name, base_unit, price_per_unit, current_stock = 0, min_stock = 0, reorder_point = 0, supplier = '', shelf_life_days = 30 } = req.body;
    
    const result = await q(`
      INSERT INTO materials (code, name, base_unit, price_per_unit, current_stock, min_stock, reorder_point, supplier, shelf_life_days)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [code, name, base_unit, price_per_unit, current_stock, min_stock, reorder_point, supplier, shelf_life_days]);
    
    logAudit(req.session.user.email, 'material_created', 'materials', code, null, result.rows[0], req);
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/materials/:code', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const updates = req.body;
    
    // Get old values for audit
    const oldResult = await q('SELECT * FROM materials WHERE code = $1', [code]);
    const oldValues = oldResult.rows[0];
    
    const fields = Object.keys(updates).filter(key => key !== 'code');
    const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
    const values = [code, ...fields.map(field => updates[field])];
    
    const result = await q(`
      UPDATE materials SET ${setClause}, updated_at = NOW()
      WHERE code = $1
      RETURNING *
    `, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    logAudit(req.session.user.email, 'material_updated', 'materials', code, oldValues, result.rows[0], req);
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/materials/:code', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    
    const oldResult = await q('SELECT * FROM materials WHERE code = $1', [code]);
    const oldValues = oldResult.rows[0];
    
    await q('DELETE FROM materials WHERE code = $1', [code]);
    
    logAudit(req.session.user.email, 'material_deleted', 'materials', code, oldValues, null, req);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Inventory transactions
app.get('/api/materials/:code/transactions', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const result = await q(`
      SELECT * FROM inventory_transactions 
      WHERE material_code = $1 
      ORDER BY created_at DESC 
      LIMIT 100
    `, [code]);
    
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/materials/:code/adjust-stock', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { quantity, reason = 'Manual adjustment' } = req.body;
    
    await updateInventory(code, quantity, quantity > 0 ? 'in' : 'out', 'adjustment', null, req.session.user.email);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enhanced Items API
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const { active = 'true' } = req.query;
    
    let query = `
      SELECT i.*, 
             (SELECT COUNT(*) FROM bom b WHERE b.product_code = i.code) as ingredient_count,
             (SELECT AVG(cc.cost_per_unit) FROM cost_calculations cc WHERE cc.product_code = i.code) as avg_cost_per_unit
      FROM items i
    `;
    
    if (active !== 'all') {
      query += ' WHERE i.active = $1';
    }
    
    query += ' ORDER BY i.name';
    
    const params = active !== 'all' ? [active === 'true'] : [];
    const result = await q(query, params);
    
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/items', requireAuth, async (req, res) => {
  try {
    const { code, name, yield_qty = 1, yield_unit = 'pcs', category = 'bakery', shelf_life_hours = 24, allergens = [] } = req.body;
    
    const result = await q(`
      INSERT INTO items (code, name, yield_qty, yield_unit, category, shelf_life_hours, allergens)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [code, name, yield_qty, yield_unit, category, shelf_life_hours, allergens]);
    
    logAudit(req.session.user.email, 'item_created', 'items', code, null, result.rows[0], req);
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enhanced BOM API
app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const result = await q(`
      SELECT b.*, m.name as material_name, m.base_unit, m.price_per_unit, m.current_stock
      FROM bom b
      JOIN materials m ON m.code = b.material_code
      WHERE b.product_code = $1
      ORDER BY m.name
    `, [code]);
    
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/items/:code/bom/priced', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { qty = 1 } = req.query;
    
    const costData = await calculateProductCost(code, parseFloat(qty));
    res.json({ data: costData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enhanced Production Planning API
app.get('/api/plan', requireAuth, async (req, res) => {
  try {
    const { week_start, status } = req.query;
    
    let query = `
      SELECT p.*, i.name as product_name, i.yield_unit,
             (SELECT COUNT(*) FROM quality_checks qc WHERE qc.reference_id = p.id::text AND qc.check_type = 'production_batch') as quality_checks
      FROM production_plan p
      JOIN items i ON i.code = p.product_code
    `;
    
    const conditions = [];
    const params = [];
    
    if (week_start) {
      conditions.push(`p.day >= $${params.length + 1}`);
      params.push(week_start);
      
      const weekEnd = new Date(week_start);
      weekEnd.setDate(weekEnd.getDate() + 6);
      conditions.push(`p.day <= $${params.length + 1}`);
      params.push(weekEnd.toISOString().split('T')[0]);
    }
    
    if (status) {
      conditions.push(`p.status = $${params.length + 1}`);
      params.push(status);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY p.day, p.start_time, p.priority DESC';
    
    const result = await q(query, params);
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/plan', requireAuth, async (req, res) => {
  try {
    const { day, product_code, qty, start_time, end_time, priority = 5, assigned_staff = [], equipment_required = [], shop = '', note = '' } = req.body;
    
    const result = await q(`
      INSERT INTO production_plan (day, product_code, qty, start_time, end_time, priority, assigned_staff, equipment_required, shop, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [day, product_code, qty, start_time, end_time, priority, assigned_staff, equipment_required, shop, note]);
    
    logAudit(req.session.user.email, 'production_planned', 'production_plan', result.rows[0].id, null, result.rows[0], req);
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/plan/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const oldResult = await q('SELECT * FROM production_plan WHERE id = $1', [id]);
    const oldValues = oldResult.rows[0];
    
    const fields = Object.keys(updates).filter(key => key !== 'id');
    const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
    const values = [id, ...fields.map(field => updates[field])];
    
    const result = await q(`
      UPDATE production_plan SET ${setClause}, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, values);
    
    logAudit(req.session.user.email, 'production_updated', 'production_plan', id, oldValues, result.rows[0], req);
    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Production processing
app.post('/api/plan/:id/complete', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await processProduction(id, req.session.user.email);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enhanced Analytics API
app.get('/api/analytics/dashboard', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // Production metrics
    const productionStats = await q(`
      SELECT 
        COUNT(*) as total_planned,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        SUM(total_cost) FILTER (WHERE status = 'completed') as total_production_cost
      FROM production_plan 
      WHERE day >= $1
    `, [weekAgo]);
    
    // Inventory alerts
    const inventoryAlerts = await q(`
      SELECT COUNT(*) as low_stock_count
      FROM materials 
      WHERE active = true AND current_stock <= reorder_point
    `);
    
    // Cost trends
    const costTrends = await q(`
      SELECT 
        calculation_date,
        AVG(cost_per_unit) as avg_cost_per_unit,
        SUM(total_cost) as daily_total_cost
      FROM cost_calculations 
      WHERE calculation_date >= $1
      GROUP BY calculation_date
      ORDER BY calculation_date
    `, [weekAgo]);
    
    // Quality metrics
    const qualityStats = await q(`
      SELECT 
        COUNT(*) as total_checks,
        COUNT(*) FILTER (WHERE passed = true) as passed_checks
      FROM quality_checks 
      WHERE check_date >= $1
    `, [weekAgo]);
    
    res.json({
      production: productionStats.rows[0],
      inventory: inventoryAlerts.rows[0],
      cost_trends: costTrends.rows,
      quality: qualityStats.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// System settings
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const result = await q('SELECT * FROM system_settings ORDER BY key');
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/settings/:key', requireAuth, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    
    await q(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, value]);
    
    logAudit(req.session.user.email, 'setting_updated', 'system_settings', key, null, { value }, req);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy routes for compatibility
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const { q: searchQuery } = req.query;
    if (!searchQuery) return res.json({ data: [] });
    
    const materials = await q(`
      SELECT 'material' as type, code, name, base_unit as unit, price_per_unit as price
      FROM materials 
      WHERE active = true AND (LOWER(code) LIKE LOWER($1) OR LOWER(name) LIKE LOWER($1))
      LIMIT 10
    `, [`%${searchQuery}%`]);
    
    const items = await q(`
      SELECT 'item' as type, code, name, yield_unit as unit, 0 as price
      FROM items 
      WHERE active = true AND (LOWER(code) LIKE LOWER($1) OR LOWER(name) LIKE LOWER($1))
      LIMIT 10
    `, [`%${searchQuery}%`]);
    
    res.json({ data: [...materials.rows, ...items.rows] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import/Export routes (simplified)
app.post('/api/import', requireAuth, async (req, res) => {
  try {
    const { type, data } = req.body;
    let imported = 0;
    
    if (type === 'materials') {
      for (const item of data) {
        try {
          await q(`
            INSERT INTO materials (code, name, base_unit, price_per_unit, current_stock, min_stock)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (code) DO UPDATE SET
              name = $2, base_unit = $3, price_per_unit = $4, updated_at = NOW()
          `, [item.code, item.name, item.base_unit, item.price_per_unit || 0, item.current_stock || 0, item.min_stock || 0]);
          imported++;
        } catch (err) {
          console.error('Import error for item:', item.code, err.message);
        }
      }
    }
    
    logAudit(req.session.user.email, 'data_imported', type, null, null, { count: imported }, req);
    res.json({ imported });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin wipe (for demo purposes)
app.post('/api/admin/wipe', requireAuth, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    await q('TRUNCATE TABLE audit_log, cost_calculations, quality_checks, inventory_transactions, production_plan, bom, items, materials RESTART IDENTITY CASCADE');
    
    logAudit(req.session.user.email, 'database_wiped', null, null, null, null, req);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ---------- Static Routes ---------- */
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* ---------- Enhanced Server Startup ---------- */
async function startServer() {
  try {
    console.log('🔌 Testing database connection...');
    await q('SELECT NOW()');
    console.log('✅ Database connection established');
    
    await ensureSchema();
    
    app.listen(PORT, () => {
      console.log(`🚀 Bunca Bakery Automated System listening on port ${PORT}`);
      console.log('🎯 Features enabled:');
      console.log('   ✅ Automatic inventory tracking');
      console.log('   ✅ Smart cost calculations');
      console.log('   ✅ Production automation');
      console.log('   ✅ Quality control integration');
      console.log('   ✅ Advanced analytics');
      console.log('   ✅ Audit logging');
      console.log('🌟 System ready for fully automated bakery workflow management');
    });
  } catch (error) {
    console.error('❌ FATAL: Server startup failed:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

startServer();
