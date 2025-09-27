// Enhanced Bunca Bakery Server - Fully Automated Workflow System
// Features: Inventory tracking, automated calculations, quality control, advanced analytics

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'PLEASE_SET_ME';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

/* ---------- Enhanced Database Connection with Connection Pooling ---------- */
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
    const result = await client.query(text, params);
    return result;
  } finally { 
    client.release(); 
  }
}

/* ---------- Express Configuration ---------- */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
  name: 'bunca_sid',
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

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Enhanced Helper Functions ---------- */
const authed = (req) => !!(req.session && req.session.user);
const requireAuth = (req, res, next) =>
  authed(req) ? next() : res.status(401).json({ ok: false, error: 'unauthorized' });
const requireAdmin = (req, res, next) =>
  authed(req) && req.session.user?.role === 'admin' ? next() : res.status(401).json({ ok: false, error: 'admin_required' });

const eqi = (a, b) => String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase();

// Enhanced logging
const log = {
  info: (msg, data = {}) => console.log(`[INFO] ${msg}`, data),
  warn: (msg, data = {}) => console.warn(`[WARN] ${msg}`, data),
  error: (msg, error = {}) => console.error(`[ERROR] ${msg}`, error),
  audit: async (userId, action, details = {}) => {
    try {
      await q(`INSERT INTO audit_log (user_id, action, details, timestamp) VALUES ($1, $2, $3, NOW())`,
        [userId, action, JSON.stringify(details)]);
    } catch (e) {
      console.error('Audit log failed:', e);
    }
  }
};

/* ---------- Health Check ---------- */
app.get('/healthz', async (_req, res) => {
  try { 
    await q('SELECT 1'); 
    res.json({ ok: true, timestamp: new Date().toISOString(), version: '2.0.0' }); 
  } catch (e) { 
    log.error('Health check failed', e);
    res.status(500).json({ ok: false, error: 'database_unavailable' }); 
  }
});

/* ---------- Enhanced Database Schema ---------- */
async function ensureSchema() {
  try {
    await q('BEGIN');
    
    // Core tables with enhancements
    await q(`CREATE TABLE IF NOT EXISTS materials (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_unit TEXT NOT NULL DEFAULT 'g',
      price_per_unit NUMERIC NOT NULL DEFAULT 0,
      pack_qty NUMERIC, 
      pack_unit TEXT, 
      pack_price NUMERIC,
      supplier_code TEXT, 
      note TEXT,
      -- Enhanced inventory fields
      current_stock NUMERIC DEFAULT 0,
      min_stock NUMERIC DEFAULT 0,
      max_stock NUMERIC DEFAULT 0,
      reorder_point NUMERIC DEFAULT 0,
      lead_time_days INTEGER DEFAULT 7,
      storage_location TEXT,
      expiry_tracking BOOLEAN DEFAULT false,
      allergen_info TEXT,
      nutritional_data JSONB,
      cost_center TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS items (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      yield_qty NUMERIC NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs',
      note TEXT,
      -- Enhanced product fields
      selling_price NUMERIC DEFAULT 0,
      target_margin NUMERIC DEFAULT 0.3,
      production_time_minutes INTEGER DEFAULT 60,
      shelf_life_hours INTEGER DEFAULT 24,
      storage_temp_min NUMERIC,
      storage_temp_max NUMERIC,
      allergen_info TEXT,
      nutritional_data JSONB,
      recipe_version INTEGER DEFAULT 1,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS bom (
      id SERIAL PRIMARY KEY,
      product_code TEXT REFERENCES items(code) ON DELETE CASCADE,
      material_code TEXT REFERENCES materials(code) ON DELETE CASCADE,
      qty NUMERIC NOT NULL,
      unit TEXT NOT NULL,
      -- Enhanced BOM fields
      waste_factor NUMERIC DEFAULT 0.05,
      preparation_loss NUMERIC DEFAULT 0,
      is_optional BOOLEAN DEFAULT false,
      substitute_materials TEXT[],
      processing_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS production_plan (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      shop TEXT,
      start_time TIME, 
      end_time TIME,
      product_code TEXT REFERENCES items(code) ON DELETE CASCADE,
      qty NUMERIC NOT NULL DEFAULT 0,
      note TEXT,
      -- Enhanced production fields
      priority INTEGER DEFAULT 5,
      assigned_staff TEXT[],
      equipment_required TEXT[],
      status TEXT DEFAULT 'planned',
      actual_start_time TIMESTAMPTZ,
      actual_end_time TIMESTAMPTZ,
      actual_qty NUMERIC,
      quality_check_passed BOOLEAN,
      batch_number TEXT,
      temperature_log JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    // New enhanced tables
    await q(`CREATE TABLE IF NOT EXISTS inventory_transactions (
      id SERIAL PRIMARY KEY,
      material_code TEXT REFERENCES materials(code) ON DELETE CASCADE,
      transaction_type TEXT NOT NULL, -- 'in', 'out', 'adjustment', 'waste'
      quantity NUMERIC NOT NULL,
      unit TEXT NOT NULL,
      reference_type TEXT, -- 'purchase', 'production', 'adjustment', 'waste'
      reference_id TEXT,
      batch_number TEXT,
      expiry_date DATE,
      cost_per_unit NUMERIC,
      total_cost NUMERIC,
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      contact_person TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      payment_terms TEXT,
      lead_time_days INTEGER DEFAULT 7,
      minimum_order NUMERIC DEFAULT 0,
      delivery_schedule TEXT,
      quality_rating NUMERIC DEFAULT 5.0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id SERIAL PRIMARY KEY,
      po_number TEXT UNIQUE NOT NULL,
      supplier_id INTEGER REFERENCES suppliers(id),
      status TEXT DEFAULT 'draft', -- 'draft', 'sent', 'confirmed', 'delivered', 'cancelled'
      order_date DATE DEFAULT CURRENT_DATE,
      expected_delivery DATE,
      actual_delivery DATE,
      total_amount NUMERIC DEFAULT 0,
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS purchase_order_items (
      id SERIAL PRIMARY KEY,
      po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
      material_code TEXT REFERENCES materials(code),
      quantity NUMERIC NOT NULL,
      unit TEXT NOT NULL,
      unit_price NUMERIC NOT NULL,
      total_price NUMERIC NOT NULL,
      received_quantity NUMERIC DEFAULT 0,
      quality_approved BOOLEAN DEFAULT false
    );`);

    await q(`CREATE TABLE IF NOT EXISTS quality_checks (
      id SERIAL PRIMARY KEY,
      check_type TEXT NOT NULL, -- 'material_receipt', 'production_batch', 'finished_product'
      reference_id TEXT NOT NULL,
      batch_number TEXT,
      check_date TIMESTAMPTZ DEFAULT NOW(),
      checked_by TEXT,
      temperature NUMERIC,
      ph_level NUMERIC,
      moisture_content NUMERIC,
      visual_inspection TEXT,
      taste_test TEXT,
      texture_test TEXT,
      passed BOOLEAN NOT NULL,
      notes TEXT,
      corrective_actions TEXT
    );`);

    await q(`CREATE TABLE IF NOT EXISTS equipment (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT, -- 'oven', 'mixer', 'scale', 'refrigerator'
      capacity NUMERIC,
      capacity_unit TEXT,
      status TEXT DEFAULT 'available', -- 'available', 'in_use', 'maintenance', 'broken'
      location TEXT,
      maintenance_schedule TEXT,
      last_maintenance DATE,
      next_maintenance DATE,
      energy_consumption_kwh NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      employee_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT, -- 'baker', 'assistant', 'manager', 'quality_control'
      hourly_rate NUMERIC DEFAULT 0,
      skills TEXT[],
      certifications TEXT[],
      shift_start TIME,
      shift_end TIME,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS cost_centers (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT, -- 'production', 'overhead', 'utilities', 'labor'
      hourly_rate NUMERIC DEFAULT 0,
      fixed_cost_per_day NUMERIC DEFAULT 0,
      allocation_method TEXT DEFAULT 'time_based', -- 'time_based', 'quantity_based', 'fixed'
      active BOOLEAN DEFAULT true
    );`);

    await q(`CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      details JSONB,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );`);

    await q(`CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);

    // Enhanced price history with more details
    await q(`CREATE TABLE IF NOT EXISTS material_price_history (
      id SERIAL PRIMARY KEY,
      material_code TEXT NOT NULL REFERENCES materials(code) ON DELETE CASCADE,
      price_per_unit NUMERIC NOT NULL,
      supplier_id INTEGER REFERENCES suppliers(id),
      purchase_order_id INTEGER REFERENCES purchase_orders(id),
      effective_date DATE DEFAULT CURRENT_DATE,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      changed_by TEXT,
      reason TEXT
    );`);

    // Add missing columns to existing tables (migration-safe)
    try {
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS reorder_point DECIMAL(10,3) DEFAULT 0;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS supplier_id INTEGER;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS shelf_life_hours INTEGER DEFAULT 24;`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
      await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
    } catch (e) {
      console.log('[INFO] Materials table columns already exist or migration not needed');
    }

    try {
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT;`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS allergens TEXT[];`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS shelf_life_hours INTEGER DEFAULT 24;`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
      await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
    } catch (e) {
      console.log('[INFO] Items table columns already exist or migration not needed');
    }

    try {
      await q(`ALTER TABLE bom ADD COLUMN IF NOT EXISTS waste_factor DECIMAL(5,4) DEFAULT 0.05;`);
      await q(`ALTER TABLE bom ADD COLUMN IF NOT EXISTS notes TEXT;`);
    } catch (e) {
      console.log('[INFO] BOM table columns already exist or migration not needed');
    }

    try {
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'planned';`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 5;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS start_time TIME;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS end_time TIME;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS assigned_staff TEXT[];`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS equipment_required TEXT[];`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS shop TEXT;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS note TEXT;`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
      await q(`ALTER TABLE production_plan ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
    } catch (e) {
      console.log('[INFO] Production plan table columns already exist or migration not needed');
    }

    // Create indexes for performance (only after columns exist)
    try {
      await q(`CREATE INDEX IF NOT EXISTS idx_materials_active ON materials(active) WHERE active = true;`);
      await q(`CREATE INDEX IF NOT EXISTS idx_items_active ON items(active) WHERE active = true;`);
    } catch (e) {
      console.log('[INFO] Indexes already exist or columns not ready');
    }
    await q(`CREATE INDEX IF NOT EXISTS idx_production_plan_day ON production_plan(day);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_production_plan_status ON production_plan(status);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_material ON inventory_transactions(material_code);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_date ON inventory_transactions(created_at);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);`);

    // Insert default system settings
    await q(`INSERT INTO system_settings (key, value, description) VALUES 
      ('default_waste_factor', '0.05', 'Default waste factor for recipes (5%)'),
      ('auto_reorder_enabled', 'true', 'Enable automatic reorder point notifications'),
      ('quality_check_required', 'true', 'Require quality checks for all production'),
      ('cost_calculation_method', 'fifo', 'Cost calculation method: fifo, lifo, average'),
      ('default_shelf_life_hours', '24', 'Default shelf life for baked goods'),
      ('temperature_monitoring', 'true', 'Enable temperature monitoring and logging')
    ON CONFLICT (key) DO NOTHING;`);

    await q('COMMIT');
    log.info('Enhanced database schema created successfully');
  } catch (e) {
    await q('ROLLBACK');
    log.error('Schema creation failed', e);
    throw e;
  }
}

/* ---------- Enhanced Unit Conversion System ---------- */
const UNITS = {
  // Weight
  g: { base: 'g', factor: 1, type: 'weight' },
  kg: { base: 'g', factor: 1000, type: 'weight' },
  lb: { base: 'g', factor: 453.592, type: 'weight' },
  oz: { base: 'g', factor: 28.3495, type: 'weight' },
  
  // Volume
  ml: { base: 'ml', factor: 1, type: 'volume' },
  l: { base: 'ml', factor: 1000, type: 'volume' },
  cup: { base: 'ml', factor: 240, type: 'volume' },
  tbsp: { base: 'ml', factor: 15, type: 'volume' },
  tsp: { base: 'ml', factor: 5, type: 'volume' },
  
  // Count
  pcs: { base: 'pcs', factor: 1, type: 'count' },
  piece: { base: 'pcs', factor: 1, type: 'count' },
  pieces: { base: 'pcs', factor: 1, type: 'count' },
  stk: { base: 'pcs', factor: 1, type: 'count' },
  dozen: { base: 'pcs', factor: 12, type: 'count' }
};

const normalizeUnit = (u) => UNITS[String(u||'').toLowerCase()]?.base || (String(u||'').toLowerCase() || null);

const toBase = (qty, unit) => {
  const u = String(unit || '').toLowerCase();
  const unitInfo = UNITS[u];
  return unitInfo ? 
    { qty: Number(qty) * unitInfo.factor, unit: unitInfo.base } : 
    { qty: Number(qty), unit };
};

const canConvert = (fromUnit, toUnit) => {
  const from = UNITS[String(fromUnit||'').toLowerCase()];
  const to = UNITS[String(toUnit||'').toLowerCase()];
  return from && to && from.type === to.type;
};

/* ---------- Enhanced Recipe Scaling with Waste Factors ---------- */
async function scaleRecipe(productCode, targetQty, options = {}) {
  const { includeWaste = true, costMethod = 'current' } = options;
  
  const item = await q(`SELECT yield_qty, production_time_minutes FROM items WHERE code=$1 AND active=true`, [productCode]);
  if (item.rowCount === 0) throw new Error('item_not_found');
  
  const baseYield = Number(item.rows[0].yield_qty) || 1;
  const scaleFactor = Number(targetQty) / baseYield;
  
  const bomQuery = `
    SELECT b.material_code, b.qty, b.unit, b.waste_factor, b.preparation_loss,
           m.price_per_unit, m.name AS material_name, m.current_stock,
           m.allergen_info, m.nutritional_data
    FROM bom b 
    JOIN materials m ON m.code = b.material_code 
    WHERE b.product_code = $1 AND m.active = true
    ORDER BY b.id
  `;
  
  const bomLines = await q(bomQuery, [productCode]);
  
  const result = {
    lines: [],
    total_cost: 0,
    total_time_minutes: (Number(item.rows[0].production_time_minutes) || 60) * scaleFactor,
    allergens: new Set(),
    nutritional_totals: {},
    stock_warnings: []
  };
  
  for (const row of bomLines.rows) {
    const baseQty = toBase(row.qty, row.unit);
    const wasteFactor = includeWaste ? (Number(row.waste_factor) || 0.05) : 0;
    const prepLoss = includeWaste ? (Number(row.preparation_loss) || 0) : 0;
    
    const adjustedQty = baseQty.qty * scaleFactor * (1 + wasteFactor + prepLoss);
    const pricePerUnit = Number(row.price_per_unit || 0);
    const lineCost = adjustedQty * pricePerUnit;
    
    // Check stock availability
    const currentStock = Number(row.current_stock || 0);
    const stockNeeded = toBase(adjustedQty, baseQty.unit);
    
    if (currentStock < stockNeeded.qty) {
      result.stock_warnings.push({
        material_code: row.material_code,
        material_name: row.material_name,
        needed: stockNeeded.qty,
        available: currentStock,
        shortage: stockNeeded.qty - currentStock
      });
    }
    
    // Collect allergens
    if (row.allergen_info) {
      row.allergen_info.split(',').forEach(allergen => 
        result.allergens.add(allergen.trim())
      );
    }
    
    result.lines.push({
      material_code: row.material_code,
      material_name: row.material_name,
      qty: Number(adjustedQty.toFixed(3)),
      unit: baseQty.unit,
      price_per_unit: Number(pricePerUnit.toFixed(6)),
      cost: Number(lineCost.toFixed(2)),
      waste_factor: wasteFactor,
      stock_available: currentStock,
      stock_sufficient: currentStock >= stockNeeded.qty
    });
    
    result.total_cost += lineCost;
  }
  
  result.total_cost = Number(result.total_cost.toFixed(2));
  result.allergens = Array.from(result.allergens);
  
  return result;
}

/* ---------- Inventory Management Functions ---------- */
async function updateInventory(materialCode, quantity, unit, transactionType, reference = {}) {
  const baseQty = toBase(quantity, unit);
  
  // Record transaction
  await q(`
    INSERT INTO inventory_transactions 
    (material_code, transaction_type, quantity, unit, reference_type, reference_id, 
     batch_number, expiry_date, cost_per_unit, total_cost, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [
    materialCode, transactionType, baseQty.qty, baseQty.unit,
    reference.type || null, reference.id || null, reference.batch || null,
    reference.expiry || null, reference.costPerUnit || null, 
    reference.totalCost || null, reference.notes || null, reference.userId || 'system'
  ]);
  
  // Update current stock
  const multiplier = transactionType === 'in' ? 1 : -1;
  await q(`
    UPDATE materials 
    SET current_stock = current_stock + $1, updated_at = NOW()
    WHERE code = $2
  `, [baseQty.qty * multiplier, materialCode]);
  
  // Check reorder point
  const stockCheck = await q(`
    SELECT current_stock, reorder_point, min_stock, name 
    FROM materials 
    WHERE code = $1
  `, [materialCode]);
  
  if (stockCheck.rowCount > 0) {
    const { current_stock, reorder_point, min_stock, name } = stockCheck.rows[0];
    
    if (current_stock <= reorder_point) {
      // Create reorder notification (could be enhanced with actual PO creation)
      log.warn(`Reorder point reached for ${name} (${materialCode})`, {
        current_stock, reorder_point, min_stock
      });
    }
  }
}

/* ---------- Cost Calculation Functions ---------- */
async function calculateProductionCosts(planRows, options = {}) {
  const { includeLabor = true, includeOverhead = true, method = 'current' } = options;
  
  const materialCosts = new Map();
  const laborCosts = new Map();
  const overheadCosts = new Map();
  
  let totalMaterialCost = 0;
  let totalLaborCost = 0;
  let totalOverheadCost = 0;
  
  for (const row of planRows) {
    const recipe = await scaleRecipe(row.product_code, Number(row.qty || 0));
    
    // Material costs
    for (const line of recipe.lines) {
      const key = `${line.material_code}|${line.unit}`;
      const existing = materialCosts.get(key) || { ...line, qty: 0, cost: 0 };
      existing.qty += line.qty;
      existing.cost += line.cost;
      materialCosts.set(key, existing);
    }
    totalMaterialCost += recipe.total_cost;
    
    // Labor costs (if enabled)
    if (includeLabor) {
      const laborCost = await calculateLaborCost(row.product_code, row.qty, row.start_time, row.end_time);
      totalLaborCost += laborCost;
    }
    
    // Overhead costs (if enabled)
    if (includeOverhead) {
      const overheadCost = await calculateOverheadCost(row.product_code, row.qty, recipe.total_time_minutes);
      totalOverheadCost += overheadCost;
    }
  }
  
  return {
    material_lines: Array.from(materialCosts.values()),
    total_material_cost: Number(totalMaterialCost.toFixed(2)),
    total_labor_cost: Number(totalLaborCost.toFixed(2)),
    total_overhead_cost: Number(totalOverheadCost.toFixed(2)),
    grand_total: Number((totalMaterialCost + totalLaborCost + totalOverheadCost).toFixed(2))
  };
}

async function calculateLaborCost(productCode, quantity, startTime, endTime) {
  // Simplified labor cost calculation
  // In a real system, this would consider actual staff assignments and rates
  const baseRate = 25; // €25/hour base rate
  const productionTime = 1; // 1 hour per batch (would be calculated from recipe)
  return baseRate * productionTime * (quantity / 10); // Assuming 10 units per batch
}

async function calculateOverheadCost(productCode, quantity, timeMinutes) {
  // Simplified overhead calculation
  const overheadRate = 0.15; // 15% of material cost
  const recipe = await scaleRecipe(productCode, quantity);
  return recipe.total_cost * overheadRate;
}

/* ---------- Authentication with Enhanced Security ---------- */
app.get('/api/session', (req, res) => {
  const user = authed(req) ? req.session.user : null;
  res.json({ 
    ok: true, 
    user,
    server_time: new Date().toISOString(),
    session_expires: req.session.cookie.expires
  });
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '').trim();
  
  try {
    if (ADMIN_EMAIL && ADMIN_PASSWORD && eqi(email, ADMIN_EMAIL)) {
      const isValid = await bcrypt.compare(password, ADMIN_PASSWORD) || password === ADMIN_PASSWORD;
      if (isValid) {
        req.session.user = { 
          email, 
          role: 'admin',
          login_time: new Date().toISOString()
        };
        await log.audit(email, 'login', { success: true });
        return res.json({ ok: true });
      }
    }
    
    await log.audit(email, 'login', { success: false, reason: 'invalid_credentials' });
    res.status(401).json({ ok: false, error: 'invalid_credentials' });
  } catch (e) {
    log.error('Login error', e);
    res.status(500).json({ ok: false, error: 'login_failed' });
  }
});

app.post('/api/logout', async (req, res) => {
  const user = req.session?.user;
  if (user) {
    await log.audit(user.email, 'logout', {});
  }
  req.session.destroy(() => { 
    res.clearCookie('bunca_sid'); 
    res.json({ ok: true }); 
  });
});

/* ---------- Enhanced Materials API ---------- */
app.get('/api/materials', requireAuth, async (req, res) => {
  try {
    const { active = 'true', search = '', category = '' } = req.query;
    
    let query = `
      SELECT m.*, s.name as supplier_name,
             CASE WHEN m.current_stock <= m.reorder_point THEN true ELSE false END as needs_reorder
      FROM materials m
      LEFT JOIN suppliers s ON s.code = m.supplier_code
      WHERE 1=1
    `;
    const params = [];
    
    if (active === 'true') {
      query += ` AND m.active = true`;
    }
    
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      query += ` AND (LOWER(m.code) LIKE $${params.length} OR LOWER(m.name) LIKE $${params.length})`;
    }
    
    query += ` ORDER BY m.name`;
    
    const { rows } = await q(query, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    log.error('Materials fetch failed', e);
    res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

app.post('/api/materials', requireAuth, async (req, res) => {
  try {
    const {
      code, name, base_unit = 'g', price_per_unit = 0,
      pack_qty = null, pack_unit = null, pack_price = null,
      supplier_code = null, note = '', current_stock = 0,
      min_stock = 0, max_stock = 0, reorder_point = 0,
      lead_time_days = 7, storage_location = '',
      expiry_tracking = false, allergen_info = '',
      cost_center = ''
    } = req.body || {};
    
    if (!code || !name) {
      return res.status(400).json({ ok: false, error: 'code_and_name_required' });
    }
    
    await q(`
      INSERT INTO materials(
        code, name, base_unit, price_per_unit, pack_qty, pack_unit, pack_price,
        supplier_code, note, current_stock, min_stock, max_stock, reorder_point,
        lead_time_days, storage_location, expiry_tracking, allergen_info, cost_center
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (code) DO UPDATE SET
        name=EXCLUDED.name, base_unit=EXCLUDED.base_unit,
        price_per_unit=EXCLUDED.price_per_unit, pack_qty=EXCLUDED.pack_qty,
        pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
        supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note,
        current_stock=EXCLUDED.current_stock, min_stock=EXCLUDED.min_stock,
        max_stock=EXCLUDED.max_stock, reorder_point=EXCLUDED.reorder_point,
        lead_time_days=EXCLUDED.lead_time_days, storage_location=EXCLUDED.storage_location,
        expiry_tracking=EXCLUDED.expiry_tracking, allergen_info=EXCLUDED.allergen_info,
        cost_center=EXCLUDED.cost_center, updated_at=NOW()
    `, [
      code, name, normalizeUnit(base_unit), price_per_unit, pack_qty, pack_unit, pack_price,
      supplier_code, note, current_stock, min_stock, max_stock, reorder_point,
      lead_time_days, storage_location, expiry_tracking, allergen_info, cost_center
    ]);
    
    await log.audit(req.session.user.email, 'material_upsert', { code, name });
    res.json({ ok: true });
  } catch (e) {
    log.error('Material save failed', e);
    res.status(500).json({ ok: false, error: 'save_failed' });
  }
});

// Inventory adjustment endpoint
app.post('/api/materials/:code/adjust-stock', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { quantity, reason = 'manual_adjustment', notes = '' } = req.body;
    
    if (!quantity && quantity !== 0) {
      return res.status(400).json({ ok: false, error: 'quantity_required' });
    }
    
    const material = await q(`SELECT * FROM materials WHERE code = $1`, [code]);
    if (material.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'material_not_found' });
    }
    
    const currentStock = Number(material.rows[0].current_stock);
    const adjustment = Number(quantity) - currentStock;
    
    if (adjustment !== 0) {
      await updateInventory(
        code, 
        Math.abs(adjustment), 
        material.rows[0].base_unit,
        adjustment > 0 ? 'in' : 'out',
        {
          type: 'adjustment',
          notes: `${reason}: ${notes}`,
          userId: req.session.user.email
        }
      );
    }
    
    await log.audit(req.session.user.email, 'stock_adjustment', { 
      code, from: currentStock, to: quantity, reason 
    });
    
    res.json({ ok: true, adjustment });
  } catch (e) {
    log.error('Stock adjustment failed', e);
    res.status(500).json({ ok: false, error: 'adjustment_failed' });
  }
});

/* ---------- Enhanced Items API ---------- */
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const { active = 'true', category = '', search = '' } = req.query;
    
    let query = `
      SELECT i.*, 
             COUNT(b.id) as bom_lines,
             CASE WHEN COUNT(b.id) > 0 THEN true ELSE false END as has_recipe
      FROM items i
      LEFT JOIN bom b ON b.product_code = i.code
      WHERE 1=1
    `;
    const params = [];
    
    if (active === 'true') {
      query += ` AND i.active = true`;
    }
    
    if (category) {
      params.push(category);
      query += ` AND i.category = $${params.length}`;
    }
    
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      query += ` AND (LOWER(i.code) LIKE $${params.length} OR LOWER(i.name) LIKE $${params.length})`;
    }
    
    query += ` GROUP BY i.code ORDER BY i.name`;
    
    const { rows } = await q(query, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    log.error('Items fetch failed', e);
    res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

app.post('/api/items', requireAuth, async (req, res) => {
  try {
    const { 
      code, name, category = '', yield_qty = 1, yield_unit = 'pcs', 
      note = '', selling_price = 0, target_margin = 0.3,
      production_time_minutes = 60, shelf_life_hours = 24,
      storage_temp_min = null, storage_temp_max = null,
      allergen_info = ''
    } = req.body || {};
    
    if (!code || !name) {
      return res.status(400).json({ ok: false, error: 'code_and_name_required' });
    }
    
    await q(`
      INSERT INTO items(
        code, name, category, yield_qty, yield_unit, note,
        selling_price, target_margin, production_time_minutes, shelf_life_hours,
        storage_temp_min, storage_temp_max, allergen_info
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (code) DO UPDATE SET
        name=EXCLUDED.name, category=EXCLUDED.category,
        yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit,
        note=EXCLUDED.note, selling_price=EXCLUDED.selling_price,
        target_margin=EXCLUDED.target_margin, production_time_minutes=EXCLUDED.production_time_minutes,
        shelf_life_hours=EXCLUDED.shelf_life_hours, storage_temp_min=EXCLUDED.storage_temp_min,
        storage_temp_max=EXCLUDED.storage_temp_max, allergen_info=EXCLUDED.allergen_info,
        updated_at=NOW()
    `, [
      code, name, category, Number(yield_qty), yield_unit, note,
      Number(selling_price), Number(target_margin), Number(production_time_minutes),
      Number(shelf_life_hours), storage_temp_min, storage_temp_max, allergen_info
    ]);
    
    await log.audit(req.session.user.email, 'item_upsert', { code, name });
    res.json({ ok: true });
  } catch (e) {
    log.error('Item save failed', e);
    res.status(500).json({ ok: false, error: 'save_failed' });
  }
});

/* ---------- Enhanced Recipe/BOM API ---------- */
app.get('/api/items/:code/bom/priced', requireAuth, async (req, res) => {
  try {
    const qty = Number(req.query.qty || 1);
    const includeWaste = req.query.include_waste !== 'false';
    
    if (!qty || qty <= 0) {
      return res.status(400).json({ ok: false, error: 'valid_qty_required' });
    }
    
    const result = await scaleRecipe(req.params.code, qty, { includeWaste });
    res.json({ ok: true, data: result });
  } catch (e) {
    if (e.message === 'item_not_found') {
      res.status(404).json({ ok: false, error: 'item_not_found' });
    } else {
      log.error('Recipe pricing failed', e);
      res.status(500).json({ ok: false, error: 'calculation_failed' });
    }
  }
});

/* ---------- Enhanced Production Planning API ---------- */
app.get('/api/plan', requireAuth, async (req, res) => {
  try {
    const { date, week_start, status = 'all' } = req.query;
    
    let query = `
      SELECT pp.*, i.name AS product_name, i.production_time_minutes,
             i.shelf_life_hours, i.allergen_info
      FROM production_plan pp
      LEFT JOIN items i ON i.code = pp.product_code
      WHERE 1=1
    `;
    const params = [];
    
    if (date) {
      params.push(date);
      query += ` AND pp.day = $${params.length}`;
    } else if (week_start) {
      params.push(week_start);
      params.push(week_start);
      query += ` AND pp.day >= $${params.length-1}::date AND pp.day < $${params.length}::date + INTERVAL '7 days'`;
    }
    
    if (status !== 'all') {
      params.push(status);
      query += ` AND pp.status = $${params.length}`;
    }
    
    query += ` ORDER BY pp.day, pp.start_time NULLS FIRST, pp.priority DESC, pp.id`;
    
    const { rows } = await q(query, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    log.error('Production plan fetch failed', e);
    res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

app.post('/api/plan/calc', requireAuth, async (req, res) => {
  try {
    let planRows = req.body?.rows;
    const includeLabor = req.body?.include_labor !== false;
    const includeOverhead = req.body?.include_overhead !== false;
    
    if ((!planRows || !Array.isArray(planRows)) && req.body?.date) {
      const { rows } = await q(`
        SELECT product_code, qty, start_time, end_time 
        FROM production_plan 
        WHERE day = $1 AND status != 'cancelled'
      `, [req.body.date]);
      planRows = rows;
    }
    
    if (!Array.isArray(planRows) || planRows.length === 0) {
      return res.json({ 
        ok: true, 
        data: { 
          material_lines: [], 
          total_material_cost: 0,
          total_labor_cost: 0,
          total_overhead_cost: 0,
          grand_total: 0
        } 
      });
    }
    
    const result = await calculateProductionCosts(planRows, { includeLabor, includeOverhead });
    res.json({ ok: true, data: result });
  } catch (e) {
    log.error('Production cost calculation failed', e);
    res.status(500).json({ ok: false, error: 'calculation_failed' });
  }
});

// Production execution endpoints
app.post('/api/plan/:id/start', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { staff = [], equipment = [], notes = '' } = req.body;
    
    await q(`
      UPDATE production_plan 
      SET status = 'in_progress', 
          actual_start_time = NOW(),
          assigned_staff = $1,
          equipment_required = $2,
          note = COALESCE(note || ' | ', '') || $3,
          updated_at = NOW()
      WHERE id = $4 AND status = 'planned'
    `, [staff, equipment, `Started: ${notes}`, id]);
    
    await log.audit(req.session.user.email, 'production_started', { id, staff, equipment });
    res.json({ ok: true });
  } catch (e) {
    log.error('Production start failed', e);
    res.status(500).json({ ok: false, error: 'start_failed' });
  }
});

app.post('/api/plan/:id/complete', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      actual_qty, quality_passed = true, batch_number = '', 
      temperature_log = {}, notes = '' 
    } = req.body;
    
    // Get production plan details
    const plan = await q(`SELECT * FROM production_plan WHERE id = $1`, [id]);
    if (plan.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'plan_not_found' });
    }
    
    const planData = plan.rows[0];
    const finalQty = actual_qty || planData.qty;
    
    // Update production plan
    await q(`
      UPDATE production_plan 
      SET status = 'completed',
          actual_end_time = NOW(),
          actual_qty = $1,
          quality_check_passed = $2,
          batch_number = $3,
          temperature_log = $4,
          note = COALESCE(note || ' | ', '') || $5,
          updated_at = NOW()
      WHERE id = $6
    `, [finalQty, quality_passed, batch_number, JSON.stringify(temperature_log), `Completed: ${notes}`, id]);
    
    // Deduct materials from inventory
    if (quality_passed) {
      const recipe = await scaleRecipe(planData.product_code, finalQty);
      for (const line of recipe.lines) {
        await updateInventory(
          line.material_code,
          line.qty,
          line.unit,
          'out',
          {
            type: 'production',
            id: id,
            batch: batch_number,
            userId: req.session.user.email
          }
        );
      }
    }
    
    await log.audit(req.session.user.email, 'production_completed', { 
      id, actual_qty: finalQty, quality_passed, batch_number 
    });
    
    res.json({ ok: true });
  } catch (e) {
    log.error('Production completion failed', e);
    res.status(500).json({ ok: false, error: 'completion_failed' });
  }
});

/* ---------- Analytics and Reporting API ---------- */
app.get('/api/analytics/dashboard', requireAuth, async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    switch (period) {
      case '1d': startDate.setDate(endDate.getDate() - 1); break;
      case '7d': startDate.setDate(endDate.getDate() - 7); break;
      case '30d': startDate.setDate(endDate.getDate() - 30); break;
      case '90d': startDate.setDate(endDate.getDate() - 90); break;
      default: startDate.setDate(endDate.getDate() - 7);
    }
    
    // Production statistics
    const productionStats = await q(`
      SELECT 
        COUNT(*) as total_batches,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_batches,
        SUM(CASE WHEN status = 'completed' THEN actual_qty ELSE 0 END) as total_production,
        AVG(CASE WHEN status = 'completed' AND actual_qty > 0 THEN actual_qty ELSE NULL END) as avg_batch_size
      FROM production_plan 
      WHERE day >= $1 AND day <= $2
    `, [startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]);
    
    // Material usage
    const materialUsage = await q(`
      SELECT 
        m.name,
        m.code,
        SUM(it.quantity) as total_used,
        m.base_unit,
        SUM(it.total_cost) as total_cost
      FROM inventory_transactions it
      JOIN materials m ON m.code = it.material_code
      WHERE it.transaction_type = 'out' 
        AND it.reference_type = 'production'
        AND it.created_at >= $1
      GROUP BY m.code, m.name, m.base_unit
      ORDER BY total_cost DESC
      LIMIT 10
    `, [startDate]);
    
    // Low stock alerts
    const lowStock = await q(`
      SELECT code, name, current_stock, reorder_point, base_unit
      FROM materials 
      WHERE active = true AND current_stock <= reorder_point
      ORDER BY (current_stock / NULLIF(reorder_point, 0)) ASC
      LIMIT 10
    `);
    
    // Quality metrics
    const qualityStats = await q(`
      SELECT 
        COUNT(*) as total_checks,
        SUM(CASE WHEN passed THEN 1 ELSE 0 END) as passed_checks,
        ROUND(AVG(CASE WHEN passed THEN 1.0 ELSE 0.0 END) * 100, 2) as pass_rate
      FROM quality_checks 
      WHERE check_date >= $1
    `, [startDate]);
    
    res.json({
      ok: true,
      data: {
        period,
        production: productionStats.rows[0],
        material_usage: materialUsage.rows,
        low_stock_alerts: lowStock.rows,
        quality: qualityStats.rows[0]
      }
    });
  } catch (e) {
    log.error('Analytics dashboard failed', e);
    res.status(500).json({ ok: false, error: 'analytics_failed' });
  }
});

/* ---------- System Settings API ---------- */
app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const { rows } = await q(`SELECT * FROM system_settings ORDER BY key`);
    res.json({ ok: true, data: rows });
  } catch (e) {
    log.error('Settings fetch failed', e);
    res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  try {
    const settings = req.body.settings || {};
    
    for (const [key, value] of Object.entries(settings)) {
      await q(`
        INSERT INTO system_settings (key, value, updated_at) 
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET 
          value = EXCLUDED.value, 
          updated_at = EXCLUDED.updated_at
      `, [key, String(value)]);
    }
    
    await log.audit(req.session.user.email, 'settings_updated', settings);
    res.json({ ok: true });
  } catch (e) {
    log.error('Settings update failed', e);
    res.status(500).json({ ok: false, error: 'update_failed' });
  }
});

/* ---------- Enhanced Import/Export ---------- */
app.post('/api/import/:dataset', requireAuth, async (req, res) => {
  try {
    const dataset = req.params.dataset;
    const rows = Array.isArray(req.body) ? req.body : [];
    
    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'no_data_provided' });
    }
    
    await q('BEGIN');
    let imported = 0;
    
    switch (dataset) {
      case 'materials':
        for (const row of rows) {
          await q(`
            INSERT INTO materials(
              code, name, base_unit, price_per_unit, pack_qty, pack_unit, pack_price,
              supplier_code, note, current_stock, min_stock, reorder_point
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT (code) DO UPDATE SET
              name=EXCLUDED.name, base_unit=EXCLUDED.base_unit,
              price_per_unit=EXCLUDED.price_per_unit, updated_at=NOW()
          `, [
            row.code, row.name, normalizeUnit(row.base_unit || 'g'),
            Number(row.price_per_unit || 0), row.pack_qty || null,
            row.pack_unit || null, row.pack_price || null,
            row.supplier_code || null, row.note || '',
            Number(row.current_stock || 0), Number(row.min_stock || 0),
            Number(row.reorder_point || 0)
          ]);
          imported++;
        }
        break;
        
      case 'items':
        for (const row of rows) {
          await q(`
            INSERT INTO items(
              code, name, category, yield_qty, yield_unit, note,
              selling_price, production_time_minutes
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (code) DO UPDATE SET
              name=EXCLUDED.name, category=EXCLUDED.category,
              yield_qty=EXCLUDED.yield_qty, updated_at=NOW()
          `, [
            row.code, row.name, row.category || '',
            Number(row.yield_qty || 1), row.yield_unit || 'pcs',
            row.note || '', Number(row.selling_price || 0),
            Number(row.production_time_minutes || 60)
          ]);
          imported++;
        }
        break;
        
      default:
        await q('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'unknown_dataset' });
    }
    
    await q('COMMIT');
    await log.audit(req.session.user.email, 'data_import', { dataset, imported });
    res.json({ ok: true, imported });
  } catch (e) {
    await q('ROLLBACK');
    log.error('Import failed', e);
    res.status(500).json({ ok: false, error: 'import_failed' });
  }
});

/* ---------- Static Routes ---------- */
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use((req, res) => {
  const file = path.join(__dirname, 'public', '404.html');
  if (fs.existsSync(file)) return res.status(404).sendFile(file);
  res.status(404).json({ ok: false, error: 'not_found' });
});

/* ---------- Enhanced Error Handling ---------- */
app.use((err, req, res, next) => {
  log.error('Unhandled error', err);
  res.status(500).json({ 
    ok: false, 
    error: 'internal_server_error',
    message: NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

/* ---------- Graceful Shutdown ---------- */
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});

/* ---------- Enhanced Boot Process ---------- */
(async () => {
  try {
    log.info('Bunca Bakery Enhanced System starting...');
    log.info('Environment', { 
      node_env: NODE_ENV,
      has_db: !!DATABASE_URL,
      has_admin: !!ADMIN_EMAIL,
      port: PORT
    });
    
    // Test database connection
    await q('SELECT NOW()');
    log.info('Database connection established');
    
    // Ensure schema
    await ensureSchema();
    log.info('Database schema verified');
    
    // Start server
    app.listen(PORT, () => {
      log.info(`Bunca Bakery Enhanced System listening on port ${PORT}`);
      log.info('System ready for fully automated bakery workflow management');
    });
  } catch (e) {
    log.error('FATAL: Boot process failed', e);
    process.exit(1);
  }
})();
