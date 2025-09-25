// server.js — BUNCA Planner (simple, single-file server)
// Features in this version:
// - Auth via ADMIN_EMAIL / ADMIN_PASSWORD (from Render)
// - Postgres schema (suppliers, products [rohwaren], items [finished], recipes [BOM], production)
// - Seed all data from local JSON (db/seed/*.json) via /admin/seed
// - Production calculator: aggregate raw-material needs + cost for any plan
// - Minimal HTML pages served from /public

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

// ----- ENV -----
const {
  DATABASE_URL,
  NODE_ENV,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  SESSION_SECRET = 'change-this-session-secret'
} = process.env;

const isProd = NODE_ENV === 'production';

// ----- DB -----
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
});

async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

// ----- APP -----
const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ===== AUTH HELPERS =====
function authed(req) { return !!(req.session && req.session.user); }
function requireAuth(req, res, next) { if (authed(req)) return next(); return res.status(401).send('Unauthorized'); }

// ===== SCHEMA =====
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS suppliers(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  // products = raw materials (Rohwaren)
  await q(`
    CREATE TABLE IF NOT EXISTS products(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit_base TEXT NOT NULL CHECK (unit_base IN ('g','ml','pcs')),
      price_per_base NUMERIC NOT NULL DEFAULT 0, -- EUR per base unit (g / ml / pcs)
      supplier_code TEXT REFERENCES suppliers(code) ON DELETE SET NULL
    );
  `);

  // items = finished articles (with yield)
  await q(`
    CREATE TABLE IF NOT EXISTS items(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      yield_qty NUMERIC NOT NULL,
      yield_unit TEXT NOT NULL CHECK (yield_unit IN ('pcs','g','ml'))
    );
  `);

  // recipes = BOM lines (normalized to product base units)
  await q(`
    CREATE TABLE IF NOT EXISTS recipes(
      id SERIAL PRIMARY KEY,
      item_code TEXT NOT NULL REFERENCES items(code) ON DELETE CASCADE,
      product_code TEXT NOT NULL REFERENCES products(code) ON DELETE RESTRICT,
      qty_base NUMERIC NOT NULL CHECK (qty_base >= 0) -- quantity in product.unit_base
    );
  `);

  // production plan (date + item + target qty in item.yield_unit)
  await q(`
    CREATE TABLE IF NOT EXISTS production(
      id SERIAL PRIMARY KEY,
      plan_date DATE NOT NULL,
      item_code TEXT NOT NULL REFERENCES items(code) ON DELETE CASCADE,
      qty NUMERIC NOT NULL CHECK (qty >= 0)
    );
  `);

  // indexes
  await q(`CREATE INDEX IF NOT EXISTS idx_recipes_item ON recipes(item_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_production_date ON production(plan_date);`);
}

// ===== UNITS =====
function toBaseQty(qty, unit) {
  // convert to base (g/ml/pcs)
  if (unit === 'kg') return qty * 1000;
  if (unit === 'g') return qty;
  if (unit === 'l') return qty * 1000;
  if (unit === 'ml') return qty;
  if (unit === 'pcs' || unit === 'piece' || unit === 'pieces') return qty;
  // fallback: treat as g
  return qty;
}

// Pretty print helpers
function fmtUnit(unit) { return unit; }
function fmtQty(unit, qtyBase) {
  // if grams or ml, show kg/l when big:
  if (unit === 'g') return qtyBase >= 1000 ? (qtyBase/1000).toFixed(3) + ' kg' : qtyBase + ' g';
  if (unit === 'ml') return qtyBase >= 1000 ? (qtyBase/1000).toFixed(3) + ' l' : qtyBase + ' ml';
  if (unit === 'pcs') return qtyBase + ' pcs';
  return qtyBase + ' ' + unit;
}

// ===== AUTH ROUTES =====
app.get('/api/session', (req, res) => {
  res.json({ ok: true, user: authed(req) ? req.session.user : null });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const expectedEmail = String(ADMIN_EMAIL || '').trim();
  const expectedPass  = String(ADMIN_PASSWORD || '').trim();

  console.log('[login] attempt', {
    email,
    expectedEmail,
    envEmailSet: !!expectedEmail,
    envPassSet: !!expectedPass
  });

  if (
    email && password &&
    email.toLowerCase().trim() === expectedEmail.toLowerCase().trim() &&
    password === expectedPass
  ) {
    req.session.user = { email, role: 'admin' };
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'bad_credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

// ===== BASIC PAGES =====
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/production', requireAuth, (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'production.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ===== CRUD APIs (minimal) =====

// Products (Rohwaren)
app.get('/api/products', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT code,name,unit_base,price_per_base,supplier_code FROM products ORDER BY name;`);
  res.json({ ok: true, data: rows });
});

// Items
app.get('/api/items', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit FROM items ORDER BY name;`);
  res.json({ ok: true, data: rows });
});

// Recipe (BOM) for an item
app.get('/api/recipes/:itemCode', requireAuth, async (req, res) => {
  const item = req.params.itemCode;
  const { rows } = await q(`
    SELECT r.id, r.product_code, p.name as product_name, r.qty_base, p.unit_base
    FROM recipes r
    JOIN products p ON p.code = r.product_code
    WHERE r.item_code = $1
    ORDER BY p.name;
  `, [item]);
  res.json({ ok: true, data: rows });
});

// Production list (simple)
app.get('/api/production', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.json({ ok: true, data: [] });
  const { rows } = await q(`
    SELECT id, plan_date, item_code, qty FROM production
    WHERE plan_date = $1
    ORDER BY id;
  `, [date]);
  res.json({ ok: true, data: rows });
});

app.post('/api/production', requireAuth, async (req, res) => {
  const { plan_date, lines } = req.body || {};
  if (!plan_date || !Array.isArray(lines)) return res.status(400).json({ ok:false, error: 'bad_request' });
  await q(`DELETE FROM production WHERE plan_date = $1`, [plan_date]);
  for (const L of lines) {
    if (!L.item_code || !L.qty) continue;
    await q(`INSERT INTO production(plan_date,item_code,qty) VALUES($1,$2,$3)`, [plan_date, L.item_code, Number(L.qty)]);
  }
  res.json({ ok: true });
});

// ===== CALCULATOR =====
// POST /api/calc/requirements  { lines: [{item_code, qty}] }
// returns aggregated raw needs & cost
app.post('/api/calc/requirements', requireAuth, async (req, res) => {
  const { lines } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0) return res.json({ ok: true, data: { rows: [], total_cost: 0 } });

  // Load all needed items & recipes
  const itemCodes = [...new Set(lines.map(l => l.item_code))];
  const itemsRes = await q(`SELECT code, yield_qty, yield_unit FROM items WHERE code = ANY($1)`, [itemCodes]);
  const itemsMap = {};
  for (const it of itemsRes.rows) itemsMap[it.code] = it;

  const recRes = await q(`
    SELECT r.item_code, r.product_code, r.qty_base, p.name as product_name, p.unit_base, p.price_per_base
    FROM recipes r
    JOIN products p ON p.code = r.product_code
    WHERE r.item_code = ANY($1)
  `, [itemCodes]);

  // Aggregate
  const agg = {}; // by product_code
  for (const L of lines) {
    const it = itemsMap[L.item_code];
    if (!it) continue;
    const factor = Number(L.qty) / Number(it.yield_qty); // scale from batch yield to requested qty
    for (const R of recRes.rows.filter(r => r.item_code === L.item_code)) {
      const need = Number(R.qty_base) * factor;
      if (!agg[R.product_code]) {
        agg[R.product_code] = {
          product_code: R.product_code,
          product_name: R.product_name,
          unit_base: R.unit_base,
          qty_base: 0,
          cost: 0,
          price_per_base: Number(R.price_per_base)
        };
      }
      agg[R.product_code].qty_base += need;
    }
  }

  // Compute cost
  let totalCost = 0;
  for (const k of Object.keys(agg)) {
    const row = agg[k];
    row.cost = (row.qty_base * row.price_per_base);
    totalCost += row.cost;
  }

  // Build rows pretty
  const rows = Object.values(agg)
    .sort((a,b) => a.product_name.localeCompare(b.product_name))
    .map(r => ({
      product_code: r.product_code,
      product_name: r.product_name,
      unit_base: r.unit_base,
      qty_base: Number(r.qty_base.toFixed(2)),
      qty_pretty: fmtQty(r.unit_base, Math.round(r.qty_base*100)/100),
      price_per_base: Number(r.price_per_base.toFixed(6)),
      cost: Number(r.cost.toFixed(2))
    }));

  res.json({ ok: true, data: { rows, total_cost: Number(totalCost.toFixed(2)) } });
});

// ===== SEEDING =====
app.post('/api/seed/full', requireAuth, async (req, res) => {
  // Load JSON files
  const base = p => path.join(__dirname, 'db', 'seed', p);
  try {
    const suppliers = []; // reserved if you want to add later
    const rohwaren = JSON.parse(fs.readFileSync(base('rohwaren.json'), 'utf8'));
    const items = JSON.parse(fs.readFileSync(base('items.json'), 'utf8'));
    const recipes = JSON.parse(fs.readFileSync(base('recipes.json'), 'utf8'));

    // Wipe + insert (idempotent by upsert)
    await ensureSchema();

    // Suppliers (optional)
    for (const S of suppliers) {
      await q(`
        INSERT INTO suppliers(code,name) VALUES($1,$2)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      `,[S.code, S.name]);
    }

    // Products
    for (const P of rohwaren) {
      // Expect fields: code,name,unit_base,price_per_base
      await q(`
        INSERT INTO products(code,name,unit_base,price_per_base,supplier_code)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (code) DO UPDATE
        SET name=EXCLUDED.name, unit_base=EXCLUDED.unit_base, price_per_base=EXCLUDED.price_per_base, supplier_code=EXCLUDED.supplier_code
      `,[P.code, P.name, P.unit_base, Number(P.price_per_base), P.supplier_code || null]);
    }

    // Items
    for (const I of items) {
      await q(`
        INSERT INTO items(code,name,category,yield_qty,yield_unit)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (code) DO UPDATE
        SET name=EXCLUDED.name, category=EXCLUDED.category, yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit
      `,[I.code, I.name, I.category || null, Number(I.yield_qty), I.yield_unit || 'pcs']);
    }

    // Recipes — clear first then insert
    await q(`DELETE FROM recipes`);
    for (const R of recipes) {
      // fields: item_code, product_code, qty, unit
      const { item_code, product_code, qty, unit } = R;
      // Fetch product unit_base to normalize
      const pr = await q(`SELECT unit_base FROM products WHERE code=$1`, [product_code]);
      if (pr.rowCount === 0) continue;
      const baseUnit = pr.rows[0].unit_base;

      // convert qty to product.base
      let qtyBase = 0;
      if ((baseUnit === 'g' && (unit === 'g' || unit === 'kg')) ||
          (baseUnit === 'ml' && (unit === 'ml' || unit === 'l')) ||
          (baseUnit === 'pcs' && (unit === 'pcs' || unit === 'piece' || unit === 'pieces'))) {
        qtyBase = toBaseQty(Number(qty), unit);
      } else {
        // If unit mismatch (e.g., ml vs g), we just take the number directly (advanced mapping could be added)
        qtyBase = Number(qty);
      }

      await q(`
        INSERT INTO recipes(item_code,product_code,qty_base)
        VALUES($1,$2,$3)
      `,[item_code, product_code, qtyBase]);
    }

    res.json({ ok: true, counts: { rohwaren: rohwaren.length, items: items.length, recipes: recipes.length }});
  } catch (e) {
    console.error('Seed error', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ===== STARTUP =====
const PORT = process.env.PORT || 3000;
ensureSchema().then(() => {
  app.listen(PORT, () => console.log(`BUNCA Planner running on :${PORT}`));
});
