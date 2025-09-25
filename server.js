// server.js
// BUNCA Bakery – single-file backend (Express + Postgres)
// ------------------------------------------------------
// Deps: express, express-session, pg, path
// Env:  DATABASE_URL (Render Postgres), ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET
// Node: >=18

const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');

// ----------- ENV -----------
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';
const NODE_ENV = process.env.NODE_ENV || 'development';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
});

// Tiny SQL helper
async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

// ----------- APP -----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    name: 'sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// ----------- AUTH -----------
const authed = (req) => !!(req.session && req.session.user);
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

app.get('/api/session', (req, res) => {
  res.json({ ok: true, user: authed(req) ? req.session.user : null });
});

app.post('/api/login', async (req, res) => {
  const { email = '', password = '' } = req.body || {};
  // helpful logs (visible in Render logs)
  console.log('[login] attempt', {
    email,
    expectedEmail: ADMIN_EMAIL,
    envEmailSet: !!ADMIN_EMAIL,
    envPassSet: !!ADMIN_PASSWORD,
  });
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.user = { email, role: 'admin' };
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

// ----------- SCHEMA -----------
async function ensureSchema() {
  await q(`
  CREATE TABLE IF NOT EXISTS suppliers (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS products (            -- Rohwaren
    code TEXT PRIMARY KEY,                         -- e.g. WEIZENMEHL
    name TEXT NOT NULL,                            -- e.g. Weizenmehl
    unit TEXT NOT NULL DEFAULT 'g',                -- g|ml|pcs|kg|l
    price_per_unit NUMERIC NOT NULL DEFAULT 0,     -- € per unit above
    supplier_code TEXT REFERENCES suppliers(code) ON DELETE SET NULL,
    note TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS items (               -- Fertige Artikel (recipes belong to items)
    code TEXT PRIMARY KEY,                         -- e.g. MUFFIN_CHOC_78
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    yield_qty NUMERIC NOT NULL DEFAULT 1,          -- batch output quantity
    yield_unit TEXT NOT NULL DEFAULT 'pcs',        -- pcs|g|ml
    note TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS bom (                 -- Rezept-Zutaten (BOM)
    id BIGSERIAL PRIMARY KEY,
    item_code TEXT REFERENCES items(code) ON DELETE CASCADE,
    product_code TEXT REFERENCES products(code) ON DELETE RESTRICT,
    qty NUMERIC NOT NULL,                          -- quantity needed per *batch* (i.e., per items.yield_qty of yield_unit)
    unit TEXT NOT NULL DEFAULT 'g'                 -- unit for qty (g|ml|pcs)
  );
  CREATE INDEX IF NOT EXISTS bom_item_idx ON bom(item_code);

  CREATE TABLE IF NOT EXISTS production_plan (
    id BIGSERIAL PRIMARY KEY,
    day DATE NOT NULL,
    shop TEXT NOT NULL DEFAULT 'Main',
    item_code TEXT REFERENCES items(code) ON DELETE CASCADE,
    qty NUMERIC NOT NULL DEFAULT 0,                 -- how many of item (in item yield unit)
    note TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS plan_day_idx ON production_plan(day);
  `);
}

// ----------- HELPERS -----------
const UMAP = {
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  l: { base: 'ml', factor: 1000 },
  pcs: { base: 'pcs', factor: 1 },
  piece: { base: 'pcs', factor: 1 },
  pieces: { base: 'pcs', factor: 1 },
};
function toBase(qty, unit) {
  const u = (unit || '').toLowerCase();
  const m = UMAP[u];
  if (!m) return { qty, unit }; // unknown → return as-is
  return { qty: Number(qty) * m.factor, unit: m.base };
}
function fromBase(qtyBase, unit) {
  const u = (unit || '').toLowerCase();
  const m = UMAP[u];
  if (!m) return { qty: qtyBase, unit };
  return { qty: Number(qtyBase) / m.factor, unit };
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function euro(n) {
  return round2(n);
}

// Scale a recipe from its base yield→target yield
async function getScaledBOM(itemCode, targetQty) {
  const { rows: items } = await q(`SELECT code, yield_qty, yield_unit FROM items WHERE code=$1`, [itemCode]);
  if (items.length === 0) throw new Error('item_not_found');
  const item = items[0];
  const ratio = Number(targetQty) / Number(item.yield_qty);
  const { rows: lines } = await q(`SELECT product_code, qty, unit FROM bom WHERE item_code=$1 ORDER BY id`, [itemCode]);

  return lines.map((ln) => {
    // scale & normalize to base units
    const scaled = ln.qty * ratio;
    const base = toBase(scaled, ln.unit);
    return { product_code: ln.product_code, qty: round2(base.qty), unit: base.unit };
  });
}

// Sum usage for a list of (item_code, qty) pairs (qty is in item yield unit)
async function computeUsage(pairs /* [{item_code, qty}] */) {
  const out = new Map(); // key: product_code|unitBase → { product_code, unit, qtyBase, price_per_unit }

  for (const p of pairs) {
    const bom = await getScaledBOM(p.item_code, p.qty);
    for (const ln of bom) {
      const key = `${ln.product_code}|${ln.unit}`;
      const cur = out.get(key) || { product_code: ln.product_code, unit: ln.unit, qtyBase: 0, price_per_unit: 0 };
      cur.qtyBase += ln.qty;
      out.set(key, cur);
    }
  }

  // attach prices
  for (const [key, v] of out) {
    const { rows } = await q(`SELECT price_per_unit FROM products WHERE code=$1`, [v.product_code]);
    v.price_per_unit = rows[0]?.price_per_unit || 0;
    out.set(key, v);
  }

  // format result
  const arr = [];
  let totalCost = 0;
  for (const v of out.values()) {
    const cost = v.qtyBase * Number(v.price_per_unit);
    totalCost += cost;
    arr.push({
      product_code: v.product_code,
      unit: v.unit,
      qty: round2(v.qtyBase),
      price_per_unit: euro(v.price_per_unit),
      cost: euro(cost),
    });
  }
  arr.sort((a, b) => (a.product_code > b.product_code ? 1 : -1));
  return { lines: arr, total_cost: euro(totalCost) };
}

// ----------- BASIC PAGES -----------
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ----------- SUPPLIERS -----------
app.get('/api/suppliers', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT * FROM suppliers ORDER BY code`);
  res.json({ ok: true, data: rows });
});

app.post('/api/suppliers', requireAuth, async (req, res) => {
  const { code, name, contact = '' } = req.body || {};
  await q(
    `INSERT INTO suppliers(code,name,contact) VALUES($1,$2,$3)
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, contact=EXCLUDED.contact`,
    [code, name, contact]
  );
  res.json({ ok: true });
});

// ----------- PRODUCTS (Rohwaren) -----------
app.get('/api/products', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT * FROM products ORDER BY code`);
  res.json({ ok: true, data: rows });
});

app.post('/api/products', requireAuth, async (req, res) => {
  const { code, name, unit = 'g', price_per_unit = 0, supplier_code = null, note = '' } = req.body || {};
  await q(
    `INSERT INTO products(code,name,unit,price_per_unit,supplier_code,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE
       SET name=EXCLUDED.name, unit=EXCLUDED.unit, price_per_unit=EXCLUDED.price_per_unit,
           supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
    [code, name, unit, price_per_unit, supplier_code, note]
  );
  res.json({ ok: true });
});

// Bulk price paste: accepts lines like "WEIZENMEHL = 0.0007" OR "Weizenmehl : 0.0007"
app.post('/api/products/prices/bulk', requireAuth, async (req, res) => {
  const { text = '' } = req.body || {};
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let updated = 0;
  for (const line of lines) {
    // try "CODE = price" first
    let m = line.match(/^([A-Za-z0-9_.\- ]+)\s*[:=]\s*([0-9]+(?:[.,][0-9]+)?)$/);
    if (!m) continue;
    let rawKey = m[1].trim();
    const val = Number(m[2].replace(',', '.'));
    // try by exact code, else by name
    const byCode = await q(`UPDATE products SET price_per_unit=$1 WHERE code=$2`, [val, rawKey]);
    if (byCode.rowCount === 0) {
      const byName = await q(`UPDATE products SET price_per_unit=$1 WHERE LOWER(name)=LOWER($2)`, [val, rawKey]);
      if (byName.rowCount > 0) updated += byName.rowCount;
    } else {
      updated += byCode.rowCount;
    }
  }
  res.json({ ok: true, updated });
});

// ----------- ITEMS (finished) -----------
app.get('/api/items', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT * FROM items ORDER BY code`);
  res.json({ ok: true, data: rows });
});

app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category = '', yield_qty = 1, yield_unit = 'pcs', note = '' } = req.body || {};
  await q(
    `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE
       SET name=EXCLUDED.name, category=EXCLUDED.category,
           yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
    [code, name, category, yield_qty, yield_unit, note]
  );
  res.json({ ok: true });
});

app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { rows } = await q(
    `SELECT b.id, b.product_code, p.name AS product_name, b.qty, b.unit
     FROM bom b LEFT JOIN products p ON p.code=b.product_code
     WHERE b.item_code=$1 ORDER BY b.id`,
    [code]
  );
  res.json({ ok: true, data: rows });
});

app.post('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  await q(`DELETE FROM bom WHERE item_code=$1`, [code]); // replace
  for (const ln of lines) {
    const { product_code, qty, unit } = ln;
    await q(`INSERT INTO bom(item_code,product_code,qty,unit) VALUES($1,$2,$3,$4)`, [
      code,
      product_code,
      qty,
      unit || 'g',
    ]);
  }
  res.json({ ok: true });
});

app.get('/api/items/:code/scale', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const target = Number(req.query.target || 0);
    if (!target) return res.status(400).json({ ok: false, error: 'target_required' });
    const lines = await getScaledBOM(code, target);
    res.json({ ok: true, data: lines });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ----------- PRODUCTION PLAN -----------
app.get('/api/plan', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT id, day, shop, item_code, qty, note,
            (SELECT name FROM items i WHERE i.code=pp.item_code) AS item_name
     FROM production_plan pp
     ORDER BY day, shop, item_code`
  );
  res.json({ ok: true, data: rows });
});

app.post('/api/plan', requireAuth, async (req, res) => {
  const list = Array.isArray(req.body?.lines) ? req.body.lines : [];
  // Replace same-day/shop+item if provided id=null → simple upsert by (day,shop,item_code)
  for (const ln of list) {
    const { day, shop = 'Main', item_code, qty = 0, note = '' } = ln;
    await q(
      `INSERT INTO production_plan(day,shop,item_code,qty,note)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [day, shop, item_code, qty, note]
    );
  }
  res.json({ ok: true });
});

// Calculate usage for a date range (inclusive). If none → all rows.
app.get('/api/plan/usage', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to) {
    const { rows: r } = await q(
      `SELECT item_code, SUM(qty) AS qty FROM production_plan WHERE day BETWEEN $1 AND $2 GROUP BY item_code`,
      [from, to]
    );
    rows = r;
  } else {
    const { rows: r } = await q(`SELECT item_code, SUM(qty) AS qty FROM production_plan GROUP BY item_code`);
    rows = r;
  }
  const pairs = rows.map((r) => ({ item_code: r.item_code, qty: Number(r.qty) }));
  const usage = await computeUsage(pairs);
  res.json({ ok: true, ...usage });
});

// ----------- SEED DATA -----------
const SEED = {
  suppliers: [
    { code: 'BACKO', name: 'Backo', contact: '' },
    { code: 'FRESHLY', name: 'Freshly', contact: '' },
    { code: 'METRO', name: 'Metro', contact: '' },
  ],
  // price_per_unit is in € per listed unit (g/ml/pcs)
  products: [
    { code: 'WEIZENMEHL', name: 'Weizenmehl', unit: 'g', price_per_unit: 0.0007, supplier_code: 'BACKO' },
    { code: 'ZUCKER', name: 'Kristallzucker', unit: 'g', price_per_unit: 0.0011, supplier_code: 'BACKO' },
    { code: 'BRAUN_ZUCKER', name: 'Braun Zucker', unit: 'g', price_per_unit: 0.0021, supplier_code: 'BACKO' },
    { code: 'PUDEZUCKER', name: 'Puderzucker', unit: 'g', price_per_unit: 0.0015, supplier_code: 'BACKO' },
    { code: 'VANILLEN', name: 'Vanillenzucker', unit: 'g', price_per_unit: 0.0025, supplier_code: 'BACKO' },
    { code: 'BACKPULVER', name: 'Backpulver Messbecher', unit: 'g', price_per_unit: 0.0055, supplier_code: 'BACKO' },
    { code: 'NATRON', name: 'Natron', unit: 'g', price_per_unit: 0.0060, supplier_code: 'BACKO' },
    { code: 'BUTTER_BLOCK', name: 'Markenbutter Block', unit: 'g', price_per_unit: 0.0090, supplier_code: 'BACKO' },
    { code: 'EIER_VOLL', name: 'Vollei', unit: 'ml', price_per_unit: 0.0048, supplier_code: 'BACKO' },
    { code: 'EIGELB', name: 'Eigelb', unit: 'ml', price_per_unit: 0.0090, supplier_code: 'BACKO' },
    { code: 'ZIMT', name: 'Zimt gemahlen', unit: 'g', price_per_unit: 0.0083, supplier_code: 'BACKO' },
    { code: 'KAKAO', name: 'Kakao', unit: 'g', price_per_unit: 0.0059, supplier_code: 'BACKO' },
    { code: 'HAFERFLOCKEN', name: 'Haferflocken', unit: 'g', price_per_unit: 0.0036, supplier_code: 'BACKO' },
    { code: 'SCHOKO_STREU', name: 'Schokoladenstreusel', unit: 'g', price_per_unit: 0.0130, supplier_code: 'BACKO' },
    { code: 'KUVERT_WEISS', name: 'Kuvertüre Weiß callets', unit: 'g', price_per_unit: 0.0154, supplier_code: 'BACKO' },
    { code: 'KUVERT_DUNKEL', name: 'Kuvertüre Dunkel Block', unit: 'g', price_per_unit: 0.0179, supplier_code: 'BACKO' },
    { code: 'KUVERT_VOLL', name: 'Kuvertüre Vollmilch Block', unit: 'g', price_per_unit: 0.0179, supplier_code: 'BACKO' },
    { code: 'EDELNUSS_MIX', name: 'Edelnuss Mix', unit: 'g', price_per_unit: 0.0142, supplier_code: 'BACKO' },
    { code: 'HASELNUSS_GR', name: 'Haselnussgrieß geröstet 0-2mm', unit: 'g', price_per_unit: 0.0076, supplier_code: 'BACKO' },
    { code: 'MAISSTAERKE', name: 'Maisstärke', unit: 'g', price_per_unit: 0.0017, supplier_code: 'BACKO' },
    { code: 'SAHNE30', name: 'Sahne 30%', unit: 'ml', price_per_unit: 0.0022, supplier_code: 'BACKO' },
    { code: 'MILCH', name: 'Milch', unit: 'ml', price_per_unit: 0.0010, supplier_code: 'BACKO' },
    { code: 'HAFERMILCH', name: 'Hafermilch', unit: 'ml', price_per_unit: 0.0017, supplier_code: 'BACKO' },
    { code: 'ZITRONE', name: 'Zitronen', unit: 'ml', price_per_unit: 0.0024, supplier_code: 'FRESHLY' }, // juice eq.
    { code: 'ZITRONEN_SCHALE', name: 'Zitronen Schale', unit: 'g', price_per_unit: 0.0030, supplier_code: 'FRESHLY' },
    { code: 'BANANEN', name: 'Bananen', unit: 'g', price_per_unit: 0.0011, supplier_code: 'FRESHLY' },
    { code: 'ERDNUSS', name: 'Erdnüsse', unit: 'g', price_per_unit: 0.0079, supplier_code: 'BACKO' },
    { code: 'KOKOS', name: 'Kokos', unit: 'g', price_per_unit: 0.0060, supplier_code: 'BACKO' },
    { code: 'KOKOSOEL', name: 'Kokosöl', unit: 'ml', price_per_unit: 0.0000, supplier_code: 'BACKO' }, // price TBD
    { code: 'ESPRESSO', name: 'Espresso', unit: 'pcs', price_per_unit: 0.0000, supplier_code: 'METRO' }, // TBD
    { code: 'PISTAZIEN', name: 'Pistazien', unit: 'g', price_per_unit: 0.0240, supplier_code: 'BACKO' },
    { code: 'PISTAZIEN_CREME', name: 'Pistazien Creme', unit: 'g', price_per_unit: 0.0260, supplier_code: 'BACKO' },
    { code: 'VANILLE', name: 'Vanille', unit: 'g', price_per_unit: 0.0025, supplier_code: 'BACKO' },
    { code: 'SCHOKO_PACK', name: 'Schokolade Packung', unit: 'pcs', price_per_unit: 0.0000, supplier_code: 'BACKO' }, // TBD
  ],
  items: [
    { code: 'BANANA_BREAD_8', name: 'Banana Bread Loaf', category: 'Kuchen', yield_qty: 8, yield_unit: 'pcs' },
    { code: 'MUFFIN_60', name: '60 Muffins', category: 'Gebäck', yield_qty: 60, yield_unit: 'pcs' },
    { code: 'PASTEIS_15', name: '15 Pasteis', category: 'Gebäck', yield_qty: 15, yield_unit: 'pcs' },
    { code: 'SCHOKONUSS_8', name: 'Schokonuss Kuchen', category: 'Kuchen', yield_qty: 8, yield_unit: 'pcs' },
    { code: 'CARROT_12', name: 'Carrot Cake', category: 'Kuchen', yield_qty: 12, yield_unit: 'pcs' },
    { code: 'PCC_82', name: 'Peanut Caramel Cookie', category: 'Cookies', yield_qty: 82, yield_unit: 'pcs' },
    { code: 'ROTWEIN_2', name: 'Rotwein Kuchen', category: 'Kuchen', yield_qty: 2, yield_unit: 'pcs' },
    { code: 'APFELKUCHEN_15', name: 'Apfelkuchen', category: 'Kuchen', yield_qty: 15, yield_unit: 'pcs' },
    { code: 'CHOC_CHIP_78', name: 'Choc Chip Cookie', category: 'Cookies', yield_qty: 78, yield_unit: 'pcs' },
    { code: 'OATMEAL_110', name: 'Oatmeal Cookie', category: 'Cookies', yield_qty: 110, yield_unit: 'pcs' },
    { code: 'ENERGY_58', name: 'Energy Balls', category: 'Snacks', yield_qty: 58, yield_unit: 'pcs' },
    { code: 'PISTACHIO_108', name: 'Pistachio Cookies', category: 'Cookies', yield_qty: 108, yield_unit: 'pcs' },
  ],
  // qty & unit are per *batch yield* above
  bom: {
    BANANA_BREAD_8: [
      { product_code: 'BUTTER_BLOCK', qty: 115, unit: 'g' },
      { product_code: 'WEIZENMEHL', qty: 225, unit: 'g' },
      { product_code: 'ZUCKER', qty: 150, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 80, unit: 'g' },
      { product_code: 'VANILLEN', qty: 3, unit: 'g' },
      { product_code: 'PUDEZUCKER', qty: 20, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 59, unit: 'ml' },
      { product_code: 'BACKPULVER', qty: 3.5, unit: 'g' },
      { product_code: 'NATRON', qty: 3.5, unit: 'g' },
      { product_code: 'ZIMT', qty: 2, unit: 'g' },
      { product_code: 'BANANEN', qty: 400, unit: 'g' },
      { product_code: 'SCHOKO_STREU', qty: 66.7, unit: 'g' },
    ],
    MUFFIN_60: [
      { product_code: 'WEIZENMEHL', qty: 400, unit: 'g' },
      { product_code: 'BUTTER_BLOCK', qty: 1000, unit: 'g' },
      { product_code: 'ZUCKER', qty: 1000, unit: 'g' },
      { product_code: 'PUDEZUCKER', qty: 600, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 1250, unit: 'ml' },
      { product_code: 'KUVERT_VOLL', qty: 1500, unit: 'g' },
      { product_code: 'HASELNUSS_GR', qty: 1000, unit: 'g' },
    ],
    PASTEIS_15: [
      { product_code: 'ZUCKER', qty: 125, unit: 'g' },
      { product_code: 'VANILLEN', qty: 6, unit: 'g' },
      { product_code: 'MAISSTAERKE', qty: 40, unit: 'g' },
      { product_code: 'EIGELB', qty: 120, unit: 'ml' },
      { product_code: 'ZIMT', qty: 2, unit: 'g' },
      { product_code: 'ZITRONE', qty: 100, unit: 'ml' },
      { product_code: 'SAHNE30', qty: 400, unit: 'ml' },
      { product_code: 'MILCH', qty: 200, unit: 'ml' },
    ],
    SCHOKONUSS_8: [
      { product_code: 'BUTTER_BLOCK', qty: 150, unit: 'g' },
      { product_code: 'WEIZENMEHL', qty: 210, unit: 'g' },
      { product_code: 'ZUCKER', qty: 100, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 1000, unit: 'ml' },
      { product_code: 'BACKPULVER', qty: 16, unit: 'g' },
      { product_code: 'ZIMT', qty: 2, unit: 'g' },
      { product_code: 'SCHOKO_STREU', qty: 130, unit: 'g' },
      { product_code: 'KUVERT_DUNKEL', qty: 200, unit: 'g' },
      { product_code: 'EDELNUSS_MIX', qty: 210, unit: 'g' },
      { product_code: 'HAFERMILCH', qty: 125, unit: 'ml' },
    ],
    CARROT_12: [
      { product_code: 'BUTTER_BLOCK', qty: 650, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 100, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 150, unit: 'ml' },
      { product_code: 'BACKPULVER', qty: 16, unit: 'g' },
      { product_code: 'ZIMT', qty: 2, unit: 'g' },
      { product_code: 'ZITRONE', qty: 100, unit: 'ml' },
      { product_code: 'WEIZENMEHL', qty: 300, unit: 'g' },
      { product_code: 'ZUCKER', qty: 90, unit: 'g' },
      { product_code: 'EDELNUSS_MIX', qty: 30, unit: 'g' },
    ],
    PCC_82: [
      { product_code: 'BUTTER_BLOCK', qty: 2000, unit: 'g' },
      { product_code: 'WEIZENMEHL', qty: 2600, unit: 'g' },
      { product_code: 'ZUCKER', qty: 360, unit: 'g' },
      { product_code: 'KUVERT_WEISS', qty: 400, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 900, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 600, unit: 'ml' },
      { product_code: 'KAKAO', qty: 320, unit: 'g' },
      { product_code: 'KUVERT_VOLL', qty: 400, unit: 'g' },
      { product_code: 'ERDNUSS', qty: 400, unit: 'g' },
    ],
    ROTWEIN_2: [
      { product_code: 'WEIZENMEHL', qty: 660, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 450, unit: 'g' },
      { product_code: 'BUTTER_BLOCK', qty: 450, unit: 'g' },
      { product_code: 'VANILLEN', qty: 6, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 350, unit: 'ml' },
      { product_code: 'BACKPULVER', qty: 24, unit: 'g' },
      { product_code: 'KAKAO', qty: 50, unit: 'g' },
      { product_code: 'ZIMT', qty: 6, unit: 'g' },
      { product_code: 'ZITRONE', qty: 150, unit: 'ml' },
      { product_code: 'KUVERT_DUNKEL', qty: 150, unit: 'g' },
    ],
    APFELKUCHEN_15: [
      { product_code: 'WEIZENMEHL', qty: 300, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 200, unit: 'g' },
      { product_code: 'BUTTER_BLOCK', qty: 250, unit: 'g' },
      { product_code: 'VANILLEN', qty: 6, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 300, unit: 'ml' },
      { product_code: 'BACKPULVER', qty: 16, unit: 'g' },
      { product_code: 'ZIMT', qty: 20, unit: 'g' },
      { product_code: 'ZITRONE', qty: 100, unit: 'ml' },
      { product_code: 'EDELNUSS_MIX', qty: 30, unit: 'g' },
      { product_code: 'MILCH', qty: 130, unit: 'ml' },
    ],
    CHOC_CHIP_78: [
      { product_code: 'WEIZENMEHL', qty: 2700, unit: 'g' },
      { product_code: 'BUTTER_BLOCK', qty: 2000, unit: 'g' },
      { product_code: 'MAISSTAERKE', qty: 100, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 900, unit: 'g' },
      { product_code: 'ZUCKER', qty: 360, unit: 'g' },
      { product_code: 'VANILLEN', qty: 100, unit: 'g' },
      { product_code: 'NATRON', qty: 50, unit: 'g' },
      { product_code: 'SCHOKO_PACK', qty: 12, unit: 'pcs' },
    ],
    OATMEAL_110: [
      { product_code: 'HAFERFLOCKEN', qty: 4000, unit: 'g' },
      { product_code: 'MAISSTAERKE', qty: 200, unit: 'g' },
      { product_code: 'BUTTER_BLOCK', qty: 2000, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 1000, unit: 'g' },
      { product_code: 'ZUCKER', qty: 720, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 400, unit: 'ml' },
      { product_code: 'KUVERT_WEISS', qty: 800, unit: 'g' },
      { product_code: 'ZIMT', qty: 23, unit: 'g' },
      { product_code: 'VANILLEN', qty: 36, unit: 'g' },
      { product_code: 'BACKPULVER', qty: 18, unit: 'g' },
      { product_code: 'EDELNUSS_MIX', qty: 800, unit: 'g' },
    ],
    ENERGY_58: [
      { product_code: 'KAKAO', qty: 250, unit: 'g' },
      { product_code: 'HAFERFLOCKEN', qty: 1500, unit: 'g' },
      { product_code: 'KOKOS', qty: 50, unit: 'g' },
      { product_code: 'KOKOSOEL', qty: 150, unit: 'ml' },
      { product_code: 'ERDNUSS', qty: 500, unit: 'g' },
      { product_code: 'ESPRESSO', qty: 20, unit: 'pcs' },
      // Datteln, Pflaumen  omitted here (add products/cost when you want exact costs)
    ],
    PISTACHIO_108: [
      { product_code: 'BUTTER_BLOCK', qty: 1500, unit: 'g' },
      { product_code: 'WEIZENMEHL', qty: 3400, unit: 'g' },
      { product_code: 'NATRON', qty: 60, unit: 'g' },
      { product_code: 'BRAUN_ZUCKER', qty: 1400, unit: 'g' },
      { product_code: 'VANILLEN', qty: 100, unit: 'g' },
      { product_code: 'EIER_VOLL', qty: 1000, unit: 'ml' },
      { product_code: 'ZITRONEN_SCHALE', qty: 0, unit: 'g' }, // TBD
      { product_code: 'PISTAZIEN', qty: 1000, unit: 'g' },
      { product_code: 'PISTAZIEN_CREME', qty: 1200, unit: 'g' },
      { product_code: 'KUVERT_WEISS', qty: 1000, unit: 'g' },
    ],
  },
};

async function runSeed() {
  // suppliers
  for (const s of SEED.suppliers) {
    await q(
      `INSERT INTO suppliers(code,name,contact) VALUES($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, contact=EXCLUDED.contact`,
      [s.code, s.name, s.contact || '']
    );
  }
  // products
  for (const p of SEED.products) {
    await q(
      `INSERT INTO products(code,name,unit,price_per_unit,supplier_code,note)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE
         SET name=EXCLUDED.name, unit=EXCLUDED.unit, price_per_unit=EXCLUDED.price_per_unit,
             supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
      [p.code, p.name, p.unit, p.price_per_unit ?? 0, p.supplier_code || null, p.note || '']
    );
  }
  // items
  for (const it of SEED.items) {
    await q(
      `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE
         SET name=EXCLUDED.name, category=EXCLUDED.category,
             yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
      [it.code, it.name, it.category, it.yield_qty, it.yield_unit, it.note || '']
    );
    // bom
    const lines = SEED.bom[it.code] || [];
    await q(`DELETE FROM bom WHERE item_code=$1`, [it.code]);
    for (const ln of lines) {
      await q(`INSERT INTO bom(item_code,product_code,qty,unit) VALUES($1,$2,$3,$4)`, [
        it.code,
        ln.product_code,
        ln.qty,
        ln.unit,
      ]);
    }
  }
}

// endpoints to seed
app.post('/api/seed/all', requireAuth, async (req, res) => {
  await runSeed();
  const stats = await Promise.all([
    q(`SELECT COUNT(*) FROM suppliers`),
    q(`SELECT COUNT(*) FROM products`),
    q(`SELECT COUNT(*) FROM items`),
    q(`SELECT COUNT(*) FROM bom`),
  ]);
  res.json({
    ok: true,
    counts: {
      suppliers: Number(stats[0].rows[0].count),
      products: Number(stats[1].rows[0].count),
      items: Number(stats[2].rows[0].count),
      bom: Number(stats[3].rows[0].count),
    },
  });
});

// ----------- HEALTH -----------
app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await q('SELECT 1 as ok');
    res.json({ ok: true, db: rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ----------- STARTUP -----------
(async () => {
  try {
    await ensureSchema();
    console.log('DB schema OK');
    // Optional: auto-seed once if tables are empty
    const { rows: r } = await q(`SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM items) AS i`);
    if (Number(r[0].p) === 0 && Number(r[0].i) === 0) {
      console.log('Seeding initial data…');
      await runSeed();
      console.log('Seed done');
    }
    app.listen(PORT, () => {
      console.log(`BUNCA server listening on :${PORT}`);
      console.log('Admin email present:', !!ADMIN_EMAIL, 'Admin pass present:', !!ADMIN_PASSWORD);
    });
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
