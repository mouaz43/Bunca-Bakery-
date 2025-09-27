const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Quick database query function
async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } catch (error) {
    console.error('Database error:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'bunca-bakery-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 12 // 12 hours
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// File upload configuration
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
    cb(null, allowedTypes.includes(file.mimetype));
  }
});

// Database schema setup
async function ensureSchema() {
  try {
    console.log('Setting up database schema...');
    
    // Materials table
    await q(`CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      base_unit TEXT NOT NULL,
      price_per_unit DECIMAL(10,4) NOT NULL DEFAULT 0,
      current_stock DECIMAL(10,3) DEFAULT 0,
      min_stock DECIMAL(10,3) DEFAULT 0,
      supplier TEXT DEFAULT '',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Items table
    await q(`CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      yield_qty DECIMAL(10,3) NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs',
      category TEXT DEFAULT 'bakery',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // BOM table
    await q(`CREATE TABLE IF NOT EXISTS bom (
      id SERIAL PRIMARY KEY,
      product_code TEXT NOT NULL,
      material_code TEXT NOT NULL,
      qty DECIMAL(10,4) NOT NULL,
      unit TEXT NOT NULL,
      waste_factor DECIMAL(5,4) DEFAULT 0.05
    )`);

    // Production plan table
    await q(`CREATE TABLE IF NOT EXISTS production_plan (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      product_code TEXT NOT NULL,
      qty DECIMAL(10,3) NOT NULL,
      status TEXT DEFAULT 'planned',
      shop TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Users table for authentication
    await q(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Create default admin user if not exists
    const adminExists = await q(`SELECT id FROM users WHERE email = 'admin@bunca.bakery'`);
    if (adminExists.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('demo123', 10);
      await q(`INSERT INTO users (email, password_hash, name, role) 
               VALUES ('admin@bunca.bakery', $1, 'Admin User', 'admin')`, 
               [hashedPassword]);
      console.log('Default admin user created');
    }

    console.log('Database schema ready');
  } catch (error) {
    console.error('Schema setup failed:', error.message);
    throw error;
  }
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
}

// API Routes

// Authentication
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await q('SELECT * FROM users WHERE email = $1 AND active = true', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    };

    res.json({ success: true, user: req.session.user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Materials API
app.get('/api/materials', async (req, res) => {
  try {
    const result = await q(`
      SELECT m.*, 
             COALESCE(SUM(CASE WHEN pp.status = 'planned' THEN bom.qty * pp.qty END), 0) as planned_usage
      FROM materials m
      LEFT JOIN bom ON m.code = bom.material_code
      LEFT JOIN production_plan pp ON bom.product_code = pp.product_code
      WHERE m.active = true
      GROUP BY m.id, m.code, m.name, m.base_unit, m.price_per_unit, m.current_stock, m.min_stock, m.supplier, m.active, m.created_at
      ORDER BY m.name
    `);
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Materials fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch materials' });
  }
});

app.post('/api/materials', requireAuth, async (req, res) => {
  try {
    const { code, name, base_unit, price_per_unit, current_stock, min_stock, supplier } = req.body;
    
    const result = await q(`
      INSERT INTO materials (code, name, base_unit, price_per_unit, current_stock, min_stock, supplier)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [code, name, base_unit, price_per_unit || 0, current_stock || 0, min_stock || 0, supplier || '']);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Material creation error:', error);
    res.status(500).json({ error: 'Failed to create material' });
  }
});

app.put('/api/materials/:code', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { name, base_unit, price_per_unit, current_stock, min_stock, supplier } = req.body;
    
    const result = await q(`
      UPDATE materials 
      SET name = $1, base_unit = $2, price_per_unit = $3, current_stock = $4, min_stock = $5, supplier = $6
      WHERE code = $7 AND active = true
      RETURNING *
    `, [name, base_unit, price_per_unit, current_stock, min_stock, supplier, code]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Material update error:', error);
    res.status(500).json({ error: 'Failed to update material' });
  }
});

app.delete('/api/materials/:code', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    
    await q('UPDATE materials SET active = false WHERE code = $1', [code]);
    res.json({ success: true });
  } catch (error) {
    console.error('Material deletion error:', error);
    res.status(500).json({ error: 'Failed to delete material' });
  }
});

// Items API
app.get('/api/items', async (req, res) => {
  try {
    const result = await q(`
      SELECT i.*,
             COUNT(bom.id) as ingredient_count,
             COALESCE(SUM(bom.qty * m.price_per_unit * (1 + bom.waste_factor)), 0) as cost_per_unit
      FROM items i
      LEFT JOIN bom ON i.code = bom.product_code
      LEFT JOIN materials m ON bom.material_code = m.code
      WHERE i.active = true
      GROUP BY i.id, i.code, i.name, i.yield_qty, i.yield_unit, i.category, i.active, i.created_at
      ORDER BY i.name
    `);
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Items fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

app.post('/api/items', requireAuth, async (req, res) => {
  try {
    const { code, name, yield_qty, yield_unit, category } = req.body;
    
    const result = await q(`
      INSERT INTO items (code, name, yield_qty, yield_unit, category)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [code, name, yield_qty || 1, yield_unit || 'pcs', category || 'bakery']);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Item creation error:', error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// BOM API
app.get('/api/bom/:productCode', async (req, res) => {
  try {
    const { productCode } = req.params;
    
    const result = await q(`
      SELECT bom.*, m.name as material_name, m.base_unit, m.price_per_unit,
             (bom.qty * m.price_per_unit * (1 + bom.waste_factor)) as line_cost
      FROM bom
      JOIN materials m ON bom.material_code = m.code
      WHERE bom.product_code = $1 AND m.active = true
      ORDER BY m.name
    `, [productCode]);
    
    res.json({ data: result.rows });
  } catch (error) {
    console.error('BOM fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch BOM' });
  }
});

app.post('/api/bom', requireAuth, async (req, res) => {
  try {
    const { product_code, material_code, qty, unit, waste_factor } = req.body;
    
    const result = await q(`
      INSERT INTO bom (product_code, material_code, qty, unit, waste_factor)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (product_code, material_code) 
      DO UPDATE SET qty = $3, unit = $4, waste_factor = $5
      RETURNING *
    `, [product_code, material_code, qty, unit, waste_factor || 0.05]);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('BOM creation error:', error);
    res.status(500).json({ error: 'Failed to create BOM entry' });
  }
});

// Production Plan API
app.get('/api/plan', async (req, res) => {
  try {
    const { date } = req.query;
    let whereClause = 'WHERE 1=1';
    let params = [];
    
    if (date) {
      whereClause += ' AND pp.day = $1';
      params.push(date);
    }
    
    const result = await q(`
      SELECT pp.*, i.name as product_name, i.yield_unit,
             COALESCE(SUM(bom.qty * m.price_per_unit * (1 + bom.waste_factor)), 0) as cost_per_unit,
             (pp.qty * COALESCE(SUM(bom.qty * m.price_per_unit * (1 + bom.waste_factor)), 0)) as total_cost
      FROM production_plan pp
      JOIN items i ON pp.product_code = i.code
      LEFT JOIN bom ON i.code = bom.product_code
      LEFT JOIN materials m ON bom.material_code = m.code
      ${whereClause}
      GROUP BY pp.id, pp.day, pp.product_code, pp.qty, pp.status, pp.shop, pp.note, pp.created_at, i.name, i.yield_unit
      ORDER BY pp.day DESC, i.name
    `, params);
    
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Production plan fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch production plan' });
  }
});

app.post('/api/plan', requireAuth, async (req, res) => {
  try {
    const { day, product_code, qty, shop, note } = req.body;
    
    const result = await q(`
      INSERT INTO production_plan (day, product_code, qty, shop, note)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [day, product_code, qty, shop || '', note || '']);
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Production plan creation error:', error);
    res.status(500).json({ error: 'Failed to create production plan' });
  }
});

// File import API
app.post('/api/import/materials', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let data = [];
    
    if (req.file.mimetype.includes('sheet') || req.file.mimetype.includes('excel')) {
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    } else if (req.file.mimetype.includes('csv')) {
      const csvData = fs.readFileSync(req.file.path, 'utf8');
      const lines = csvData.split('\n');
      const headers = lines[0].split(',').map(h => h.trim());
      
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) {
          const values = lines[i].split(',').map(v => v.trim());
          const row = {};
          headers.forEach((header, index) => {
            row[header] = values[index] || '';
          });
          data.push(row);
        }
      }
    }

    let imported = 0;
    for (const row of data) {
      try {
        if (row.code && row.name) {
          await q(`
            INSERT INTO materials (code, name, base_unit, price_per_unit, current_stock, min_stock, supplier)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (code) DO UPDATE SET
              name = $2, base_unit = $3, price_per_unit = $4, 
              current_stock = $5, min_stock = $6, supplier = $7
          `, [
            row.code,
            row.name,
            row.base_unit || 'kg',
            parseFloat(row.price_per_unit) || 0,
            parseFloat(row.current_stock) || 0,
            parseFloat(row.min_stock) || 0,
            row.supplier || ''
          ]);
          imported++;
        }
      } catch (error) {
        console.error('Row import error:', error);
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({ success: true, imported });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Import failed' });
  }
});

// Dashboard analytics
app.get('/api/analytics', async (req, res) => {
  try {
    const [materials, items, plans, lowStock] = await Promise.all([
      q('SELECT COUNT(*) as count FROM materials WHERE active = true'),
      q('SELECT COUNT(*) as count FROM items WHERE active = true'),
      q('SELECT COUNT(*) as count FROM production_plan WHERE day >= CURRENT_DATE'),
      q('SELECT COUNT(*) as count FROM materials WHERE active = true AND current_stock <= min_stock')
    ]);

    res.json({
      materials_count: parseInt(materials.rows[0].count),
      items_count: parseInt(items.rows[0].count),
      plans_count: parseInt(plans.rows[0].count),
      low_stock_count: parseInt(lowStock.rows[0].count)
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Default route
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// Start server
async function startServer() {
  try {
    console.log('Bunca Bakery - Starting server...');
    await ensureSchema();
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log('Database connected and schema ready');
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

startServer();
