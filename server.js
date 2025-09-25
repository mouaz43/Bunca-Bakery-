// server.js — BUNCA Planner (single-file server)
// -------------------------------------------------------------
// Goals:
// - Minimal Express server (no framework) that stays simple.
// - Auth via ADMIN_EMAIL / ADMIN_PASSWORD from env (trim/sanitize).
// - Optional compression (safe fallback if module isn't installed).
// - Auto-create Postgres schema (idempotent).
// - CRUD APIs: suppliers, products (Rohwaren), items (finished goods),
//   BOM (recipe ingredients), production planning.
// - Bulk price update API.
// - Sync logic: compute raw-material usage and cost for planned production.
// - Built-in JSON SEED you can trigger any time (admin only).
// - Serve static UI from /public (login.html, dashboard.html, etc.).
//
// This file is intentionally verbose and heavily commented so it's easy
// to search, read, and tweak in one place. No extra folders required.
//
// -------------------------------------------------------------

// ---------- Imports & setup ----------
const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');

// Optional compression (safe fallback if not installed).
let compression = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  compression = require('compression');
} catch (e) {
  // Provide a no-op middleware so we don't crash if 'compression' is not installed.
  compression = () => (req, res, next) => next();
}

// ---------- Environment ----------
const {
  PORT = 10000,
  NODE_ENV = 'production',
  DATABASE_URL = '',
  PGSSLMODE = '',
  SESSION_SECRET = 'bunca-secret-change-me',
  ADMIN_EMAIL = '',
  ADMIN_PASSWORD = '',
} = process.env;

// ---------- Express app ----------
const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
  },
}));

// Serve static files (login.html, dashboard.html, etc) from /public
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DB ----------
const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});
async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// ---------- Helpers ----------
const nowIso = () => new Date().toISOString();
const toStr = (v) => (v === null || v === undefined ? '' : String(v));
const trimLower = (v) => toStr(v).trim().toLowerCase();
const trim = (v) => toStr(v).trim();

function authed(req) {
  return !!(req.session && req.session.user);
}
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// Units: normalize grams/ml/piece
// We keep units as entered, but offer helpers when you want to do math.
const MASS_UNITS = new Set(['g', 'kg']);
const VOL_UNITS = new Set(['ml', 'l']);
const COUNT_UNITS = new Set(['pcs', 'piece', 'pieces', 'st', 'stk', 'stück']);

// Convert value to base unit (g or ml) if mass/volume, else leave as-is.
function toBaseUnit(value, unit) {
  const v = Number(value) || 0;
  const u = trimLower(unit);
  if (u === 'kg') return { value: v * 1000, unit: 'g' };
  if (u === 'l' || u === 'lt' || u === 'liter') return { value: v * 1000, unit: 'ml' };
  if (u === 'g' || u === 'ml') return { value: v, unit: u };
  // for piece count or unknown we don't convert
  return { value: v, unit: u || 'pcs' };
}

function parseNumberFlexible(x) {
  if (typeof x === 'number') return x;
  if (typeof x !== 'string') return Number(x) || 0;
  // normalize comma decimals "12,34" -> "12.34", strip currency or spaces
  const cleaned = x.replace(/[^\d,.-]/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function log(...args) {
  console.log('[BUNCA]', nowIso(), ...args);
}

// ---------- Schema ----------
async function ensureSchema() {
  // Suppliers (optional link for products)
  await q(`
    CREATE TABLE IF NOT EXISTS suppliers (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  // Rohwaren / Products: name + base unit + price per base unit (e.g., €/g or €/ml or €/pcs)
  await q(`
    CREATE TABLE IF NOT EXISTS products (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'g',
      price_per_unit NUMERIC NOT NULL DEFAULT 0,
      supplier_code TEXT REFERENCES suppliers(code) ON DELETE SET NULL
    );
  `);

  // Finished items: yield of a batch
  await q(`
    CREATE TABLE IF NOT EXISTS items (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Gebäck',
      yield_qty NUMERIC NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs',
      notes TEXT
    );
  `);

  // BOM: ingredients per item per batch
  await q(`
    CREATE TABLE IF NOT EXISTS bom (
      item_code TEXT NOT NULL REFERENCES items(code) ON DELETE CASCADE,
      product_code TEXT NOT NULL REFERENCES products(code) ON DELETE RESTRICT,
      qty NUMERIC NOT NULL,
      unit TEXT NOT NULL DEFAULT 'g',
      PRIMARY KEY (item_code, product_code)
    );
  `);

  // Production plan: how many items to produce (count, not batches)
  await q(`
    CREATE TABLE IF NOT EXISTS production (
      id SERIAL PRIMARY KEY,
      item_code TEXT NOT NULL REFERENCES items(code) ON DELETE RESTRICT,
      planned_qty NUMERIC NOT NULL,
      planned_unit TEXT NOT NULL DEFAULT 'pcs',
      plan_date DATE NOT NULL DEFAULT CURRENT_DATE
    );
  `);

  // Simple indexes (performance helpers)
  await q(`CREATE INDEX IF NOT EXISTS idx_bom_item ON bom(item_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_prod_item_date ON production(item_code, plan_date);`);

  log('Schema ensured.');
}

// ---------- Seed Data (you can adjust freely) ----------
// This is a minimal initial set matching several screenshots you shared.
// Edit or expand these freely; seeding is idempotent (UPSERT).
const SEED = {
  suppliers: [
    { code: 'BACKO', name: 'Backo' },
    { code: 'FRESHLY', name: 'Freshly' },
    { code: 'DEFAULT', name: 'Default Supplier' },
  ],
  products: [
    // code, name, unit, price_per_unit (per g/ml/pcs), supplier_code
    { code: 'WEIZENMEHL', name: 'Weizenmehl', unit: 'g', price_per_unit: 0.0007, supplier_code: 'BACKO' },
    { code: 'ZUCKER', name: 'Kristallzucker', unit: 'g', price_per_unit: 0.0011, supplier_code: 'BACKO' },
    { code: 'BRAUN_ZUCKER', name: 'Braun Zucker', unit: 'g', price_per_unit: 0.0021, supplier_code: 'BACKO' },
    { code: 'VANILLENZUCKER', name: 'Vanillenzucker', unit: 'g', price_per_unit: 0.0025, supplier_code: 'BACKO' },
    { code: 'PUDEERZUCKER', name: 'Puderzucker', unit: 'g', price_per_unit: 0.0015, supplier_code: 'BACKO' },
    { code: 'BACKPULVER', name: 'Backpulver Messbecher', unit: 'g', price_per_unit: 0.0055, supplier_code: 'BACKO' },
    { code: 'NATRON', name: 'Natron', unit: 'g', price_per_unit: 0.0040, supplier_code: 'BACKO' },
    { code: 'EIER', name: 'Vollei', unit: 'ml', price_per_unit: 0.0048, supplier_code: 'FRESHLY' },
    { code: 'BUTTER', name: 'Markenbutter Block', unit: 'g', price_per_unit: 0.0090, supplier_code: 'BACKO' },
    { code: 'BACKMARGARINE', name: 'Backmargarine', unit: 'g', price_per_unit: 0.0023, supplier_code: 'BACKO' },
    { code: 'KOKOSFLOCKEN', name: 'Kokos', unit: 'g', price_per_unit: 0.0090, supplier_code: 'BACKO' },
    { code: 'KOKOSOEL', name: 'Kokosöl', unit: 'ml', price_per_unit: 0.0090, supplier_code: 'BACKO' },
    { code: 'ESPRESSO', name: 'Espresso', unit: 'g', price_per_unit: 0.0120, supplier_code: 'BACKO' },
    { code: 'HAFFERFLOCKEN', name: 'Haferflocken', unit: 'g', price_per_unit: 0.0036, supplier_code: 'BACKO' },
    { code: 'PFlaumen_TROCKEN', name: 'Pflaumen getrocknet 5-7mm', unit: 'g', price_per_unit: 0.0092, supplier_code: 'FRESHLY' },
    { code: 'DATTELN', name: 'Datteln gehackt 5-7mm', unit: 'g', price_per_unit: 0.0039, supplier_code: 'FRESHLY' },
    { code: 'WALNUSS', name: 'Walnüsse', unit: 'g', price_per_unit: 0.0163, supplier_code: 'BACKO' },
    { code: 'KAKAO', name: 'Kakao', unit: 'g', price_per_unit: 0.0065, supplier_code: 'BACKO' },
    { code: 'ZIMT', name: 'Zimt gemahlen', unit: 'g', price_per_unit: 0.0083, supplier_code: 'BACKO' },
    { code: 'ZITRONEN', name: 'Zitronen', unit: 'ml', price_per_unit: 0.0024, supplier_code: 'FRESHLY' },
    { code: 'KUVERTUR_WEISS', name: 'Kuvertüre Weiß callets', unit: 'g', price_per_unit: 0.0154, supplier_code: 'BACKO' },
    { code: 'KUVERTUR_DUNKEL', name: 'Kuvertüre Dunkel Block', unit: 'g', price_per_unit: 0.0179, supplier_code: 'BACKO' },
    { code: 'ERDNUESSE', name: 'Erdnüsse', unit: 'g', price_per_unit: 0.0079, supplier_code: 'BACKO' },
    { code: 'PISTAZIEN', name: 'Pistazien', unit: 'g', price_per_unit: 0.039, supplier_code: 'BACKO' },
    { code: 'PISTAZIEN_CREME', name: 'Pistazien Creme', unit: 'g', price_per_unit: 0.050, supplier_code: 'BACKO' },
    { code: 'SAHNE_30', name: 'Sahne 30%', unit: 'ml', price_per_unit: 0.0022, supplier_code: 'FRESHLY' },
    { code: 'MILCH', name: 'Milch', unit: 'ml', price_per_unit: 0.0010, supplier_code: 'FRESHLY' },
    // Add more as needed...
  ],
  items: [
    // yield_qty is the pieces per batch
    { code: 'CHOC_CHIP_COOKIE_78', name: 'Choc Chip Cookie', category: 'Cookies', yield_qty: 78, yield_unit: 'pcs', notes: '' },
    { code: 'OATMEAL_COOKIE_110', name: 'Oatmeal Cookie', category: 'Cookies', yield_qty: 110, yield_unit: 'pcs', notes: '' },
    { code: 'PEANUT_CARAMEL_COOKIE_82', name: 'Peanut Caramel Cookie', category: 'Cookies', yield_qty: 82, yield_unit: 'pcs', notes: '' },
    { code: 'PISTACHIO_COOKIE_108', name: 'Pistachio Cookies', category: 'Cookies', yield_qty: 108, yield_unit: 'pcs', notes: '' },
    { code: 'ENERGY_BALLS_58', name: 'Energy Balls', category: 'Snack', yield_qty: 58, yield_unit: 'pcs', notes: '' },
  ],
  // BOM per item (qty + unit for a single batch as seen in screenshots)
  bom: [
    // Oatmeal cookie (110 Stück)
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'HAFFERFLOCKEN', qty: 4000, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'KUVERTUR_WEISS', qty: 800, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'BUTTER', qty: 2000, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'BRAUN_ZUCKER', qty: 1000, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'ZUCKER', qty: 720, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'EIER', qty: 400, unit: 'ml' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'ZIMT', qty: 23, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'VANILLENZUCKER', qty: 36, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'BACKPULVER', qty: 18, unit: 'g' },
    { item_code: 'OATMEAL_COOKIE_110', product_code: 'WALNUSS', qty: 800, unit: 'g' },

    // Choc Chip Cookie (78 Stück)
    { item_code: 'CHOC_CHIP_COOKIE_78', product_code: 'WEIZENMEHL', qty: 2700, unit: 'g' },
    { item_code: 'CHOC_CHIP_COOKIE_78', product_code: 'BACKMARGARINE', qty: 2000, unit: 'g' },
    { item_code: 'CHOC_CHIP_COOKIE_78', product_code: 'ZUCKER', qty: 360, unit: 'g' },
    { item_code: 'CHOC_CHIP_COOKIE_78', product_code: 'BRAUN_ZUCKER', qty: 900, unit: 'g' },
    { item_code: 'CHOC_CHIP_COOKIE_78', product_code: 'VANILLENZUCKER', qty: 100, unit: 'g' },
    { item_code: 'CHOC_CHIP_COOKIE_78', product_code: 'NATRON', qty: 50, unit: 'g' },
    // chocolate pieces were "12 piece" in sheet; treat as product-per-piece if you add it later.

    // Peanut Caramel Cookie (82 Stück)
    { item_code: 'PEANUT_CARAMEL_COOKIE_82', product_code: 'BUTTER', qty: 2000, unit: 'g' },
    { item_code: 'PEANUT_CARAMEL_COOKIE_82', product_code: 'WEIZENMEHL', qty: 2600, unit: 'g' },
    { item_code: 'PEANUT_CARAMEL_COOKIE_82', product_code: 'ZUCKER', qty: 360, unit: 'g' },
    { item_code: 'PEANUT_CARAMEL_COOKIE_82', product_code: 'KUVERTUR_WEISS', qty: 400, unit: 'g' },
    { item_code: 'PEANUT_CARAMEL_COOKIE_82', product_code: 'BRAUN_ZUCKER', qty: 900, unit: 'g' },
    { item_code: 'PEANUT_CARAMEL_COOKIE_82', product_code: 'EIER', qty: 600, unit: 'ml' },
    { item_code: 'PEANUT_CARAMEL_COOKIE_82', product_code: 'ERDNUESSE', qty: 400, unit: 'g' },
    // add "KAKAO", "KOKOS", etc if needed per your final recipe.

    // Pistachio Cookies (108 Stück)
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'BUTTER', qty: 1500, unit: 'g' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'WEIZENMEHL', qty: 3400, unit: 'g' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'NATRON', qty: 60, unit: 'g' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'BRAUN_ZUCKER', qty: 1400, unit: 'g' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'VANILLENZUCKER', qty: 100, unit: 'g' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'EIER', qty: 1000, unit: 'ml' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'PISTAZIEN', qty: 1000, unit: 'g' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'PISTAZIEN_CREME', qty: 1200, unit: 'g' },
    { item_code: 'PISTACHIO_COOKIE_108', product_code: 'KUVERTUR_WEISS', qty: 1000, unit: 'g' },

    // Energy Balls (58 Stück)
    { item_code: 'ENERGY_BALLS_58', product_code: 'KAKAO', qty: 250, unit: 'g' },
    { item_code: 'ENERGY_BALLS_58', product_code: 'HAFFERFLOCKEN', qty: 1500, unit: 'g' },
    { item_code: 'ENERGY_BALLS_58', product_code: 'DATTELN', qty: 800, unit: 'g' },
    { item_code: 'ENERGY_BALLS_58', product_code: 'PFlaumen_TROCKEN', qty: 400, unit: 'g' },
    { item_code: 'ENERGY_BALLS_58', product_code: 'WALNUSS', qty: 500, unit: 'g' },
    { item_code: 'ENERGY_BALLS_58', product_code: 'KOKOSOEL', qty: 150, unit: 'ml' },
    { item_code: 'ENERGY_BALLS_58', product_code: 'KOKOSFLOCKEN', qty: 50, unit: 'g' },
    { item_code: 'ENERGY_BALLS_58', product_code: 'ESPRESSO', qty: 20, unit: 'g' },
  ],
  // optional initial production plan
  production: [
    { item_code: 'OATMEAL_COOKIE_110', planned_qty: 220, planned_unit: 'pcs' }, // 2 batches
    { item_code: 'CHOC_CHIP_COOKIE_78', planned_qty: 78, planned_unit: 'pcs' },
  ]
};

// ---------- Seeding ----------
async function upsertSuppliers(list) {
  if (!Array.isArray(list)) return;
  for (const s of list) {
    await q(`
      INSERT INTO suppliers (code, name)
      VALUES ($1, $2)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
    `, [trim(s.code), trim(s.name)]);
  }
}

async function upsertProducts(list) {
  if (!Array.isArray(list)) return;
  for (const p of list) {
    const code = trim(p.code);
    const name = trim(p.name);
    const unit = trimLower(p.unit) || 'g';
    const price = parseNumberFlexible(p.price_per_unit);
    const supplier = p.supplier_code ? trim(p.supplier_code) : null;

    await q(`
      INSERT INTO products (code, name, unit, price_per_unit, supplier_code)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (code)
      DO UPDATE SET name=EXCLUDED.name, unit=EXCLUDED.unit, price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code;
    `, [code, name, unit, price, supplier]);
  }
}

async function upsertItems(list) {
  if (!Array.isArray(list)) return;
  for (const it of list) {
    const code = trim(it.code);
    const name = trim(it.name);
    const category = trim(it.category) || 'Gebäck';
    const yield_qty = parseNumberFlexible(it.yield_qty) || 1;
    const yield_unit = trimLower(it.yield_unit) || 'pcs';
    const notes = toStr(it.notes) || null;

    await q(`
      INSERT INTO items (code, name, category, yield_qty, yield_unit, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (code)
      DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, notes=EXCLUDED.notes;
    `, [code, name, category, yield_qty, yield_unit, notes]);
  }
}

async function upsertBOM(list) {
  if (!Array.isArray(list)) return;
  for (const b of list) {
    const item = trim(b.item_code);
    const prod = trim(b.product_code);
    const qty = parseNumberFlexible(b.qty);
    const unit = trimLower(b.unit) || 'g';
    await q(`
      INSERT INTO bom (item_code, product_code, qty, unit)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (item_code, product_code)
      DO UPDATE SET qty=EXCLUDED.qty, unit=EXCLUDED.unit;
    `, [item, prod, qty, unit]);
  }
}

async function upsertProduction(list) {
  if (!Array.isArray(list)) return;
  for (const pr of list) {
    const item = trim(pr.item_code);
    const qty = parseNumberFlexible(pr.planned_qty);
    const unit = trimLower(pr.planned_unit) || 'pcs';
    const date = pr.plan_date ? trim(pr.plan_date) : null;
    await q(`
      INSERT INTO production (item_code, planned_qty, planned_unit, plan_date)
      VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE));
    `, [item, qty, unit, date]);
  }
}

async function runSeed() {
  await upsertSuppliers(SEED.suppliers);
  await upsertProducts(SEED.products);
  await upsertItems(SEED.items);
  await upsertBOM(SEED.bom);
  await upsertProduction(SEED.production);
  return { ok: true };
}

// ---------- Pages ----------
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => {
  if (authed(req)) return res.redirect('/');
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---------- Auth ----------
app.get('/api/session', (req, res) => {
  res.json({ ok: true, user: authed(req) ? req.session.user : null });
});

app.post('/api/login', (req, res) => {
  const rawEmail = toStr(req.body?.email);
  const rawPass = toStr(req.body?.password);

  const candidateEmail = trimLower(rawEmail);
  const candidatePass = trim(rawPass);
  const expectedEmail = trimLower(ADMIN_EMAIL);
  const expectedPass = trim(ADMIN_PASSWORD);

  console.log('[login] attempt', {
    email: candidateEmail,
    expectedEmail,
    envEmailSet: !!expectedEmail,
    envPassSet: !!expectedPass
  });

  if (candidateEmail === expectedEmail && candidatePass === expectedPass) {
    req.session.user = { email: candidateEmail, role: 'admin' };
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'bad_credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

// ---------- Admin: seed ----------
app.post('/api/admin/seed', requireAuth, async (req, res) => {
  try {
    const stats = await runSeed();
    res.json({ ok: true, stats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'seed_failed' });
  }
});

// ---------- CRUD: Suppliers ----------
app.get('/api/suppliers', requireAuth, async (req, res) => {
  const r = await q(`SELECT * FROM suppliers ORDER BY code;`);
  res.json({ ok: true, rows: r.rows });
});
app.post('/api/suppliers', requireAuth, async (req, res) => {
  const { code, name } = req.body || {};
  await q(`
    INSERT INTO suppliers (code, name)
    VALUES ($1, $2)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
  `, [trim(code), trim(name)]);
  res.json({ ok: true });
});

// ---------- CRUD: Products (Rohwaren) ----------
app.get('/api/products', requireAuth, async (req, res) => {
  const r = await q(`
    SELECT p.*, COALESCE(s.name, '') AS supplier_name
    FROM products p
    LEFT JOIN suppliers s ON s.code = p.supplier_code
    ORDER BY p.code;
  `);
  res.json({ ok: true, rows: r.rows });
});

app.post('/api/products', requireAuth, async (req, res) => {
  const { code, name, unit, price_per_unit, supplier_code } = req.body || {};
  await q(`
    INSERT INTO products (code, name, unit, price_per_unit, supplier_code)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (code)
    DO UPDATE SET name=EXCLUDED.name, unit=EXCLUDED.unit, price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code;
  `, [trim(code), trim(name), trimLower(unit || 'g'), parseNumberFlexible(price_per_unit), supplier_code ? trim(supplier_code) : null]);
  res.json({ ok: true });
});

// Bulk price updater: [{ code, price_per_unit }]
app.post('/api/products/bulk-prices', requireAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  for (const it of items) {
    await q(`
      UPDATE products SET price_per_unit = $2
      WHERE code = $1;
    `, [trim(it.code), parseNumberFlexible(it.price_per_unit)]);
  }
  res.json({ ok: true, updated: items.length });
});

// ---------- CRUD: Items (finished goods) ----------
app.get('/api/items', requireAuth, async (req, res) => {
  const r = await q(`SELECT * FROM items ORDER BY code;`);
  res.json({ ok: true, rows: r.rows });
});

app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category, yield_qty, yield_unit, notes } = req.body || {};
  await q(`
    INSERT INTO items (code, name, category, yield_qty, yield_unit, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (code)
    DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, notes=EXCLUDED.notes;
  `, [trim(code), trim(name), trim(category || 'Gebäck'), parseNumberFlexible(yield_qty) || 1, trimLower(yield_unit || 'pcs'), toStr(notes) || null]);
  res.json({ ok: true });
});

// ---------- BOM (recipe ingredients) ----------
app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const code = trim(req.params.code);
  const r = await q(`
    SELECT b.product_code, p.name AS product_name, b.qty, b.unit, p.unit AS product_base_unit, p.price_per_unit
    FROM bom b
    JOIN products p ON p.code = b.product_code
    WHERE b.item_code = $1
    ORDER BY b.product_code;
  `, [code]);
  res.json({ ok: true, rows: r.rows });
});

app.post('/api/items/:code/bom', requireAuth, async (req, res) => {
  const code = trim(req.params.code);
  const { product_code, qty, unit } = req.body || {};
  await q(`
    INSERT INTO bom (item_code, product_code, qty, unit)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (item_code, product_code)
    DO UPDATE SET qty=EXCLUDED.qty, unit=EXCLUDED.unit;
  `, [code, trim(product_code), parseNumberFlexible(qty), trimLower(unit || 'g')]);
  res.json({ ok: true });
});

app.delete('/api/items/:code/bom/:product', requireAuth, async (req, res) => {
  const item = trim(req.params.code);
  const prod = trim(req.params.product);
  await q(`DELETE FROM bom WHERE item_code=$1 AND product_code=$2;`, [item, prod]);
  res.json({ ok: true });
});

// ---------- Production ----------
app.get('/api/production', requireAuth, async (req, res) => {
  const r = await q(`
    SELECT * FROM production
    ORDER BY plan_date DESC, id DESC;
  `);
  res.json({ ok: true, rows: r.rows });
});

app.post('/api/production', requireAuth, async (req, res) => {
  const { item_code, planned_qty, planned_unit, plan_date } = req.body || {};
  await q(`
    INSERT INTO production (item_code, planned_qty, planned_unit, plan_date)
    VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE));
  `, [trim(item_code), parseNumberFlexible(planned_qty), trimLower(planned_unit || 'pcs'), plan_date ? trim(plan_date) : null]);
  res.json({ ok: true });
});

// ---------- Usage & Costs ----------
// Compute total raw material usage and cost for all current production rows.
// If you want per-date, pass ?date=YYYY-MM-DD (optional).
app.get('/api/plan
