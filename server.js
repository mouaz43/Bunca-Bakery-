// Bunca Bakery — Server (Express + PostgreSQL)
// Endpoints: /api/products, /api/recipes, /api/plan, /api/import/file, /api/session, /api/login, /api/logout

// Load .env locally if available; ignore in production if module is missing
try { require('dotenv').config(); } catch (_) {}

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

/* ========================== Ensure dirs ========================== */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ========================== DB ========================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/* ======================= Middleware ====================== */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'bunca-bakery-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 }
}));

app.use(express.static(path.join(__dirname, 'public')));

/* ======================= File Upload ===================== */
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ].includes(file.mimetype);
    cb(null, ok);
  }
});

/* ======================= Schema ========================== */
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT DEFAULT 'User',
      role TEXT DEFAULT 'user',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      unit_price NUMERIC(12,4) NOT NULL DEFAULT 0,
      group_name TEXT DEFAULT '',
      supplier TEXT DEFAULT '',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS recipes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      yield_qty NUMERIC(12,3) NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs',
      category TEXT DEFAULT 'bakery',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id SERIAL PRIMARY KEY,
      recipe_code TEXT NOT NULL,
      product_code TEXT NOT NULL,
      amount NUMERIC(14,6) NOT NULL DEFAULT 0,
      unit TEXT NOT NULL,
      waste_factor NUMERIC(6,4) NOT NULL DEFAULT 0.00,
      UNIQUE(recipe_code, product_code)
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS production_plan (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      recipe_code TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      shop TEXT DEFAULT '',
      status TEXT DEFAULT 'planned',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const admin = await q(`SELECT 1 FROM users WHERE email='admin@bunca.bakery'`);
  if (admin.rowCount === 0) {
    const hash = await bcrypt.hash('demo123', 10);
    await q(
      `INSERT INTO users(email,password_hash,name,role) VALUES($1,$2,'Admin','admin')`,
      ['admin@bunca.bakery', hash]
    );
    console.log('Default admin user created: admin@bunca.bakery / demo123');
  }
}

/* ======================= Auth Helpers ==================== */
function requireAuth(req, res, next) {
  if (req.session.user?.id) return next();
  res.status(401).json({ error: 'Authentication required' });
}

/* ======================= Auth Routes ===================== */
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await q(`SELECT * FROM users WHERE email=$1 AND active=true`, [email]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    res.json({ success: true, user: req.session.user });
  } catch (e) {
    console.error('Login error', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/session', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.session.user });
});

/* ======================= Products API ==================== */
app.get('/api/products', async (_req, res) => {
  try {
    const r = await q(
      `SELECT id, code, name, unit, unit_price, group_name AS "group", supplier, active, created_at
       FROM products WHERE active=true ORDER BY name`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('Products fetch error', e);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', requireAuth, async (req, res) => {
  try {
    const { code, name, unit = 'kg', unit_price = 0, group = '', supplier = '' } = req.body || {};
    const r = await q(
      `INSERT INTO products(code,name,unit,unit_price,group_name,supplier)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, name, unit, unit_price, group, supplier]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Product create error', e);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/products/:code', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { name, unit, unit_price, group = '', supplier = '', active = true } = req.body || {};
    const r = await q(
      `UPDATE products
         SET name=$1, unit=$2, unit_price=$3, group_name=$4, supplier=$5, active=$6
       WHERE code=$7 RETURNING *`,
      [name, unit, unit_price, group, supplier, active, code]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Product update error', e);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/products/:code', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    await q(`UPDATE products SET active=false WHERE code=$1`, [code]);
    res.json({ success: true });
  } catch (e) {
    console.error('Product delete error', e);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

/* ======================= Recipes API ===================== */
const RECIPE_COST_SQL = `
  SELECT r.code,
         COALESCE(SUM(ri.amount * p.unit_price * (1 + ri.waste_factor)), 0) AS total_batch_cost,
         r.yield_qty,
         CASE WHEN r.yield_qty > 0
              THEN COALESCE(SUM(ri.amount * p.unit_price * (1 + ri.waste_factor)),0) / r.yield_qty
              ELSE 0 END AS unit_cost
  FROM recipes r
  LEFT JOIN recipe_ingredients ri ON r.code = ri.recipe_code
  LEFT JOIN products p ON ri.product_code = p.code
  WHERE r.code = $1 AND r.active = true
  GROUP BY r.code, r.yield_qty
`;

app.get('/api/recipes', async (_req, res) => {
  try {
    const r = await q(
      `SELECT id, code, name, yield_qty, yield_unit, category, active, created_at FROM recipes
       WHERE active=true ORDER BY name`
    );
    const rows = [];
    for (const rec of r.rows) {
      const c = await q(RECIPE_COST_SQL, [rec.code]);
      rows.push({ ...rec, unitCost: Number(c.rows[0]?.unit_cost || 0) });
    }
    res.json(rows);
  } catch (e) {
    console.error('Recipes fetch error', e);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

app.post('/api/recipes', requireAuth, async (req, res) => {
  try {
    const { code, name, yield_qty = 1, yield_unit = 'pcs', category = 'bakery', ingredientsJson } = req.body || {};
    const r = await q(
      `INSERT INTO recipes(code,name,yield_qty,yield_unit,category)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [code || `R_${Date.now()}`, name, yield_qty, yield_unit, category]
    );
    if (ingredientsJson) {
      const ingredients = JSON.parse(ingredientsJson);
      for (const ing of ingredients) {
        await q(
          `INSERT INTO recipe_ingredients(recipe_code,product_code,amount,unit,waste_factor)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (recipe_code, product_code)
           DO UPDATE SET amount=EXCLUDED.amount, unit=EXCLUDED.unit, waste_factor=EXCLUDED.waste_factor`,
          [r.rows[0].code, ing.productId, ing.amount || 0, ing.unit || '', ing.waste_factor || 0]
        );
      }
    }
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Recipe create error', e);
    res.status(500).json({ error: 'Failed to create recipe' });
  }
});

app.put('/api/recipes/:code', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const { name, yield_qty, yield_unit, category, active = true, ingredientsJson } = req.body || {};
    const r = await q(
      `UPDATE recipes SET name=$1, yield_qty=$2, yield_unit=$3, category=$4, active=$5
       WHERE code=$6 RETURNING *`,
      [name, yield_qty, yield_unit, category, active, code]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Recipe not found' });

    if (ingredientsJson) {
      const ingredients = JSON.parse(ingredientsJson);
      for (const ing of ingredients) {
        await q(
          `INSERT INTO recipe_ingredients(recipe_code,product_code,amount,unit,waste_factor)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (recipe_code, product_code)
           DO UPDATE SET amount=EXCLUDED.amount, unit=EXCLUDED.unit, waste_factor=EXCLUDED.waste_factor`,
          [code, ing.productId, ing.amount || 0, ing.unit || '', ing.waste_factor || 0]
        );
      }
      const keep = ingredients.map(i => i.productId);
      if (keep.length) {
        await q(`DELETE FROM recipe_ingredients WHERE recipe_code=$1 AND product_code NOT IN (${keep.map((_,i)=>`$${i+2}`).join(',')})`, [code, ...keep]);
      } else {
        await q(`DELETE FROM recipe_ingredients WHERE recipe_code=$1`, [code]);
      }
    }
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Recipe update error', e);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

app.delete('/api/recipes/:code', requireAuth, async (req, res) => {
  try {
    await q(`UPDATE recipes SET active=false WHERE code=$1`, [req.params.code]);
    res.json({ success: true });
  } catch (e) {
    console.error('Recipe delete error', e);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

app.get('/api/recipes/:code/ingredients', async (req, res) => {
  try {
    const r = await q(
      `SELECT ri.*, p.name AS product_name, p.unit AS product_unit, p.unit_price
       FROM recipe_ingredients ri
       JOIN products p ON p.code = ri.product_code
       WHERE ri.recipe_code=$1
       ORDER BY p.name`,
      [req.params.code]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('Ingredients fetch error', e);
    res.status(500).json({ error: 'Failed to fetch ingredients' });
  }
});

/* ======================= Production Plan ================= */
app.get('/api/plan', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.date) { params.push(req.query.date); where.push(`pp.date = $${params.length}`); }

    const r = await q(
      `SELECT pp.*,
              r.name AS recipe_name,
              r.yield_unit,
              COALESCE(cost.unit_cost, 0) AS unit_cost,
              (pp.quantity * COALESCE(cost.unit_cost, 0)) AS total_cost
       FROM production_plan pp
       JOIN recipes r ON r.code = pp.recipe_code
       LEFT JOIN (
         SELECT r.code,
                CASE WHEN r.yield_qty > 0
                     THEN COALESCE(SUM(ri.amount * p.unit_price * (1 + ri.waste_factor)),0) / r.yield_qty
                     ELSE 0 END AS unit_cost
         FROM recipes r
         LEFT JOIN recipe_ingredients ri ON ri.recipe_code = r.code
         LEFT JOIN products p ON p.code = ri.product_code
         GROUP BY r.code, r.yield_qty
       ) cost ON cost.code = r.code
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pp.date DESC, r.name`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    console.error('Plan fetch error', e);
    res.status(500).json({ error: 'Failed to fetch production plan' });
  }
});

app.post('/api/plan', requireAuth, async (req, res) => {
  try {
    const { date, recipe_code, quantity, shop = '', note = '' } = req.body || {};
    const r = await q(
      `INSERT INTO production_plan(date, recipe_code, quantity, shop, note)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [date, recipe_code, quantity, shop, note]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Plan create error', e);
    res.status(500).json({ error: 'Failed to create plan row' });
  }
});

app.put('/api/plan/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, recipe_code, quantity, shop, status, note } = req.body || {};
    const r = await q(
      `UPDATE production_plan
         SET date=$1, recipe_code=$2, quantity=$3, shop=$4, status=COALESCE($5,status), note=$6
       WHERE id=$7 RETURNING *`,
      [date, recipe_code, quantity, shop, status, note, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Plan row not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Plan update error', e);
    res.status(500).json({ error: 'Failed to update plan row' });
  }
});

app.delete('/api/plan/:id', requireAuth, async (req, res) => {
  try {
    await q(`DELETE FROM production_plan WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('Plan delete error', e);
    res.status(500).json({ error: 'Failed to delete plan row' });
  }
});

/* ======================= Import API ===================== */
app.post('/api/import/file', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const type = req.body.type; // products | recipes | plan
    const rows = parseSpreadsheet(req.file.path);
    let imported = 0;

    if (type === 'products') {
      for (const r of rows) {
        if (!r.code || !r.name) continue;
        await q(`
          INSERT INTO products(code,name,unit,unit_price,group_name,supplier)
          VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT (code) DO UPDATE SET
            name=EXCLUDED.name, unit=EXCLUDED.unit, unit_price=EXCLUDED.unit_price,
            group_name=EXCLUDED.group_name, supplier=EXCLUDED.supplier, active=true
        `, [
          String(r.code).trim(),
          String(r.name).trim(),
          r.unit || r.einheit || 'kg',
          Number(r.unit_price ?? r['price_per_unit'] ?? 0),
          r.group || r.warengruppe || '',
          r.supplier || ''
        ]);
        imported++;
      }
    }

    if (type === 'recipes') {
      for (const r of rows) {
        if (!r.code || !r.name) continue;
        await q(`
          INSERT INTO recipes(code,name,yield_qty,yield_unit,category)
          VALUES($1,$2,$3,$4,$5)
          ON CONFLICT (code) DO UPDATE SET
            name=EXCLUDED.name, yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, category=EXCLUDED.category, active=true
        `, [
          String(r.code).trim(),
          String(r.name).trim(),
          Number(r.yield_qty ?? 1),
          r.yield_unit || 'pcs',
          r.category || 'bakery'
        ]);
        if (r.ingredients_json) {
          const list = JSON.parse(r.ingredients_json);
          for (const ing of list) {
            await q(`
              INSERT INTO recipe_ingredients(recipe_code,product_code,amount,unit,waste_factor)
              VALUES($1,$2,$3,$4,$5)
              ON CONFLICT (recipe_code, product_code)
              DO UPDATE SET amount=EXCLUDED.amount, unit=EXCLUDED.unit, waste_factor=EXCLUDED.waste_factor
            `, [r.code, ing.product_code, Number(ing.amount||0), ing.unit || '', Number(ing.waste_factor||0)]);
          }
        }
        imported++;
      }
    }

    if (type === 'plan') {
      for (const r of rows) {
        if (!r.date || !r.recipe_code) continue;
        await q(`
          INSERT INTO production_plan(date, recipe_code, quantity, shop, note, status)
          VALUES($1,$2,$3,$4,$5,$6)
        `, [r.date, r.recipe_code, Number(r.quantity||0), r.shop || '', r.note || '', r.status || 'planned']);
        imported++;
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, imported });
  } catch (e) {
    console.error('Import error', e);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Import failed' });
  }
});

function parseSpreadsheet(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.SheetNames[0];
    return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
  } catch {
    const csv = fs.readFileSync(filePath, 'utf8');
    const [head, ...lines] = csv.split(/\r?\n/).filter(Boolean);
    const headers = head.split(',').map(h => h.trim());
    return lines.map(line => {
      const cells = line.split(',').map(c => c.trim());
      const row = {};
      headers.forEach((h, i) => row[h] = cells[i] || '');
      return row;
    });
  }
}

/* ======================= Root / Start =================== */
app.get('/', (_req, res) => res.redirect('/login.html'));

async function start() {
  try {
    console.log('Starting Bunca Bakery server...');
    await ensureSchema();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (e) {
    console.error('Startup failed', e);
    process.exit(1);
  }
}
start();
