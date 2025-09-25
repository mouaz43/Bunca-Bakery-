// BUNCA Bakery Planner - minimal build
// - ONE server file (this file) + static HTML
// - Postgres schema + code seeding
// - Auth via ADMIN_EMAIL / ADMIN_PASSWORD env
// - Connected flows: Recipes(BOM) → Production → Raw-material usage
// - Simple bulk price importer

const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);

// ----------------- ENV -----------------
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const DATABASE_URL = process.env.DATABASE_URL;

// ----------------- DB ------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('render')
    ? { rejectUnauthorized: false }
    : false
});

async function q(sql, params) {
  const c = await pool.connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

// ----------------- MIDDLEWARE ----------
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------- AUTH HELPERS --------
function authed(req) { return !!(req.session && req.session.user); }
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ----------------- SCHEMA --------------
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS suppliers(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_unit TEXT NOT NULL,        -- g | ml | pcs
      unit_cost NUMERIC,              -- cost per base unit
      supplier_code TEXT REFERENCES suppliers(code),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS items(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      yield_qty NUMERIC NOT NULL,
      yield_unit TEXT NOT NULL,       -- pcs, tray, etc
      notes TEXT,
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS bom(
      item_code TEXT REFERENCES items(code) ON DELETE CASCADE,
      product_code TEXT REFERENCES products(code) ON DELETE CASCADE,
      qty NUMERIC NOT NULL,           -- quantity in 'unit'
      unit TEXT NOT NULL,             -- g | ml | pcs
      PRIMARY KEY(item_code, product_code)
    );

    CREATE TABLE IF NOT EXISTS shops(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS production_plans(
      id SERIAL PRIMARY KEY,
      plan_date DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE
    );

    CREATE TABLE IF NOT EXISTS production_lines(
      plan_id INTEGER REFERENCES production_plans(id) ON DELETE CASCADE,
      item_code TEXT REFERENCES items(code) ON DELETE CASCADE,
      total_qty NUMERIC NOT NULL,
      PRIMARY KEY(plan_id, item_code)
    );

    CREATE TABLE IF NOT EXISTS production_shop_lines(
      plan_id INTEGER REFERENCES production_plans(id) ON DELETE CASCADE,
      item_code TEXT REFERENCES items(code) ON DELETE CASCADE,
      shop_code TEXT REFERENCES shops(code) ON DELETE CASCADE,
      qty NUMERIC NOT NULL,
      PRIMARY KEY(plan_id, item_code, shop_code)
    );
  `);
}

// ----------------- SEED DATA -----------
const suppliersSeed = [
  { code: 'BACKO', name: 'Backo' },
  { code: 'FRESH', name: 'Freshly' },
  { code: 'OTHER', name: 'Other' }
];

// Base units: g for weight, ml for liquids, pcs for piece
const productsSeed = [
  // dry & fats
  { code:'WEIZENMEHL',      name:'Weizenmehl',           base_unit:'g', supplier:'BACKO', cost:0.0007 },
  { code:'ZUCKER',          name:'Zucker',               base_unit:'g', supplier:'BACKO', cost:0.0011 },
  { code:'ROHRZUCKER',      name:'Braun Zucker',         base_unit:'g', supplier:'BACKO', cost:0.0021 },
  { code:'PUDERZUCKER',     name:'Puderzucker',          base_unit:'g', supplier:'BACKO', cost:0.0015 },
  { code:'VANILLEZUCKER',   name:'Vanillenzucker',       base_unit:'g', supplier:'BACKO', cost:0.0025 },
  { code:'BACKPULVER',      name:'Backpulver',           base_unit:'g', supplier:'BACKO', cost:0.0055 },
  { code:'NATRON',          name:'Natron',               base_unit:'g', supplier:'BACKO', cost:0.0040 },
  { code:'MAISSTAERKE',     name:'Maisstärke',           base_unit:'g', supplier:'BACKO', cost:0.0017 },
  { code:'ZIMT_GEMAHLEN',   name:'Zimt gemahlen',        base_unit:'g', supplier:'BACKO', cost:0.0083 },
  { code:'KAKAO',           name:'Kakao',                base_unit:'g', supplier:'BACKO', cost:0.0059 },
  { code:'BUTTER',          name:'Markenbutter Block',   base_unit:'g', supplier:'BACKO', cost:0.0090 },
  { code:'BACKMARGARINE',   name:'Backmargarine',        base_unit:'g', supplier:'BACKO', cost:0.0023 },
  { code:'KOKOSOEL',        name:'Kokosöl',              base_unit:'ml',supplier:'BACKO', cost:0.0009 },
  { code:'KOKOSRASPEL',     name:'Kokosraspel',          base_unit:'g', supplier:'BACKO', cost:null },

  // couvertures & choc
  { code:'KUVERTUERE_WEISS',    name:'Kuvertüre Weiß callets',    base_unit:'g', supplier:'BACKO', cost:0.0154 },
  { code:'KUVERTUERE_VOLLMILCH',name:'Kuvertüre Vollmilch Block', base_unit:'g', supplier:'BACKO', cost:0.0179 },
  { code:'KUVERTUERE_DUNKEL',   name:'Kuvertüre Dunkel Block',    base_unit:'g', supplier:'BACKO', cost:0.0179 },
  { code:'SCHOKO_STREUSEL',     name:'Schokoladenstreusel',       base_unit:'g', supplier:'BACKO', cost:0.0130 },
  { code:'SCHOKO_PACKUNG',      name:'Schokolade Packung',        base_unit:'pcs',supplier:'BACKO', cost:null },

  // nuts & mixes
  { code:'HASELNUSS_GR_0_2', name:'Haselnussgrieß Geröstet 0-2mm', base_unit:'g', supplier:'BACKO', cost:0.0076 },
  { code:'MANDELGRIESS_FEIN', name:'Mandelgrieß Fein',             base_unit:'g', supplier:'BACKO', cost:null },
  { code:'MANDELN_GEHOBELT',  name:'Mandeln gehobelt',             base_unit:'g', supplier:'BACKO', cost:0.0070 },
  { code:'WALNUSSKERNE',      name:'Walnusskerne',                  base_unit:'g', supplier:'BACKO', cost:0.0163 },
  { code:'ERDNUESSE',         name:'Erdnüsse',                      base_unit:'g', supplier:'BACKO', cost:0.0079 },
  { code:'EDELNUSS_MIX',      name:'Edelnuss Mix',                  base_unit:'g', supplier:'BACKO', cost:0.0142 },
  { code:'PISTAZIEN',         name:'Pistazien',                     base_unit:'g', supplier:'BACKO', cost:null },
  { code:'PISTAZIEN_CREME',   name:'Pistazien Creme',               base_unit:'g', supplier:'BACKO', cost:null },

  // grains & fruits
  { code:'HAFERFLOCKEN',  name:'Haferflocken',          base_unit:'g', supplier:'BACKO', cost:0.0036 },
  { code:'DATTELN_5_7',   name:'Datteln gehackt 5-7mm', base_unit:'g', supplier:'BACKO', cost:0.0039 },
  { code:'PFLAUMEN_5_7',  name:'Pflaumen getrocknet 5-7mm', base_unit:'g', supplier:'BACKO', cost:0.0092 },

  // liquids / dairy / eggs
  { code:'VOLLEI',     name:'Vollei',      base_unit:'ml', supplier:'BACKO', cost:0.0048 },
  { code:'EIGELB',     name:'Eigelb',      base_unit:'ml', supplier:'BACKO', cost:0.0090 },
  { code:'EIERSATZ',   name:'Eiersatz',    base_unit:'ml', supplier:'BACKO', cost:0.0009 },
  { code:'MILCH',      name:'Milch',       base_unit:'ml', supplier:'BACKO', cost:0.0010 },
  { code:'SAHNE_30',   name:'Sahne 30%',   base_unit:'ml', supplier:'BACKO', cost:0.0022 },
  { code:'HAFERMILCH', name:'Hafermilch',  base_unit:'ml', supplier:'BACKO', cost:0.0017 },

  // pastry / sheets
  { code:'BLAETTERTEIG', name:'Blätterteig', base_unit:'pcs', supplier:'BACKO', cost:0.39 },

  // citrus / fruit fresh
  { code:'BANANEN', name:'Bananen überreif', base_unit:'g', supplier:'FRESH', cost:0.0011 },
  { code:'APFEL_BOSKOOP', name:'Apfel Boskoop', base_unit:'g', supplier:'FRESH', cost:0.0092 },
  { code:'ZITRONENSAFT', name:'Zitronensaft', base_unit:'ml', supplier:'FRESH', cost:0.0024 },
  { code:'ZITRONEN_SCHALE', name:'Zitronenschale', base_unit:'g', supplier:'FRESH', cost:null },
  { code:'AEFEL', name:'Äpfel', base_unit:'g', supplier:'FRESH', cost:0.0092 },

  // beverages
  { code:'ESPRESSO', name:'Espresso', base_unit:'g', supplier:'OTHER', cost:null },
  { code:'ROTWEIN',  name:'Rotwein',  base_unit:'ml', supplier:'OTHER', cost:0.0020 }
];

const itemsSeed = [
  { code:'BANANA_BREAD_8',        name:'Banana Bread Loaf',     category:'Cake',    yield_qty:8,   yield_unit:'pcs' },
  { code:'MUFFINS_60',            name:'Muffins (Schoko)',      category:'Gebäck',  yield_qty:60,  yield_unit:'pcs' },
  { code:'PASTEIS_15',            name:'Pasteis',               category:'Pastry',  yield_qty:15,  yield_unit:'pcs' },
  { code:'SCHOKONUSS_8',          name:'Schokonuss Kuchen',     category:'Cake',    yield_qty:8,   yield_unit:'pcs' },
  { code:'CARROT_12',             name:'Carrot Cake',           category:'Cake',    yield_qty:12,  yield_unit:'pcs' },
  { code:'PEANUT_CARAMEL_82',     name:'Peanut Caramel Cookie', category:'Cookies', yield_qty:82,  yield_unit:'pcs' },
  { code:'ROTWEIN_2',             name:'Rotwein Kuchen',        category:'Cake',    yield_qty:2,   yield_unit:'pcs' },
  { code:'APFEL_15',              name:'Apfelkuchen',           category:'Cake',    yield_qty:15,  yield_unit:'pcs' },
  { code:'CHOC_CHIP_78',          name:'Choc Chip Cookie',      category:'Cookies', yield_qty:78,  yield_unit:'pcs' },
  { code:'OATMEAL_110',           name:'Oatmeal Cookie',        category:'Cookies', yield_qty:110, yield_unit:'pcs' },
  { code:'ENERGY_BALLS_58',       name:'Energy Balls',          category:'Snack',   yield_qty:58,  yield_unit:'pcs' },
  { code:'PISTACHIO_108',         name:'Pistachio Cookies',     category:'Cookies', yield_qty:108, yield_unit:'pcs' }
];

// qty with unit in g/ml/pcs (screenshots approximated)
const bomSeed = [
  // Banana Bread 8
  ['BANANA_BREAD_8','BUTTER',115,'g'],
  ['BANANA_BREAD_8','WEIZENMEHL',225,'g'],
  ['BANANA_BREAD_8','ZUCKER',150,'g'],
  ['BANANA_BREAD_8','ROHRZUCKER',80,'g'],
  ['BANANA_BREAD_8','VANILLEZUCKER',3,'g'],
  ['BANANA_BREAD_8','PUDERZUCKER',20,'g'],
  ['BANANA_BREAD_8','VOLLEI',59,'ml'],
  ['BANANA_BREAD_8','BACKPULVER',3.5,'g'],
  ['BANANA_BREAD_8','NATRON',3.5,'g'],
  ['BANANA_BREAD_8','ZIMT_GEMAHLEN',2,'g'],
  ['BANANA_BREAD_8','BANANEN',400,'g'],
  ['BANANA_BREAD_8','SCHOKO_STREUSEL',66.7,'g'],

  // 60 Muffins
  ['MUFFINS_60','WEIZENMEHL',400,'g'],
  ['MUFFINS_60','BUTTER',1000,'g'],
  ['MUFFINS_60','ZUCKER',1000,'g'],
  ['MUFFINS_60','PUDERZUCKER',600,'g'],
  ['MUFFINS_60','VOLLEI',1250,'ml'],
  ['MUFFINS_60','KUVERTUERE_VOLLMILCH',1500,'g'],
  ['MUFFINS_60','HASELNUSS_GR_0_2',1000,'g'],

  // 15 Pasteis
  ['PASTEIS_15','ZUCKER',125,'g'],
  ['PASTEIS_15','VANILLEZUCKER',6,'g'],
  ['PASTEIS_15','MAISSTAERKE',40,'g'],
  ['PASTEIS_15','BLAETTERTEIG',1,'pcs'],
  ['PASTEIS_15','EIGELB',120,'ml'],
  ['PASTEIS_15','ZIMT_GEMAHLEN',2,'g'],
  ['PASTEIS_15','ZITRONENSAFT',100,'ml'],
  ['PASTEIS_15','SAHNE_30',400,'ml'],
  ['PASTEIS_15','MILCH',200,'ml'],

  // Schokonuss Kuchen 8
  ['SCHOKONUSS_8','BACKMARGARINE',150,'g'],
  ['SCHOKONUSS_8','WEIZENMEHL',210,'g'],
  ['SCHOKONUSS_8','ZUCKER',100,'g'],
  ['SCHOKONUSS_8','EIERSATZ',1000,'ml'],
  ['SCHOKONUSS_8','BACKPULVER',16,'g'],
  ['SCHOKONUSS_8','ZIMT_GEMAHLEN',2,'g'],
  ['SCHOKONUSS_8','SCHOKO_STREUSEL',130,'g'],
  ['SCHOKONUSS_8','KUVERTUERE_DUNKEL',200,'g'],
  ['SCHOKONUSS_8','EDELNUSS_MIX',210,'g'],
  ['SCHOKONUSS_8','HAFERMILCH',125,'ml'],

  // Carrot 12
  ['CARROT_12','BUTTER',650,'g'],
  ['CARROT_12','ROHRZUCKER',100,'g'],
  ['CARROT_12','VOLLEI',150,'ml'],
  ['CARROT_12','BACKPULVER',16,'g'],
  ['CARROT_12','ZIMT_GEMAHLEN',2,'g'],
  ['CARROT_12','ZITRONENSAFT',100,'ml'],
  ['CARROT_12','AEFEL',0,'g'],              // placeholder (we leave carrots as raw 'AEFEL' not ideal; update as needed)
  ['CARROT_12','MANDELGRIESS_FEIN',200,'g'],
  ['CARROT_12','MANDELN_GEHOBELT',50,'g'],
  ['CARROT_12','MILCH',130,'ml'],
  ['CARROT_12','WALNUSSKERNE',30,'g'],

  // Peanut Caramel Cookie 82
  ['PEANUT_CARAMEL_82','BUTTER',2000,'g'],
  ['PEANUT_CARAMEL_82','WEIZENMEHL',2600,'g'],
  ['PEANUT_CARAMEL_82','ZUCKER',360,'g'],
  ['PEANUT_CARAMEL_82','KUVERTUERE_WEISS',400,'g'],
  ['PEANUT_CARAMEL_82','ROHRZUCKER',900,'g'],
  ['PEANUT_CARAMEL_82','VOLLEI',600,'ml'],
  ['PEANUT_CARAMEL_82','KAKAO',320,'g'],
  ['PEANUT_CARAMEL_82','KUVERTUERE_VOLLMILCH',400,'g'],
  ['PEANUT_CARAMEL_82','ERDNUESSE',400,'g'],

  // Rotwein 2
  ['ROTWEIN_2','WEIZENMEHL',660,'g'],
  ['ROTWEIN_2','ROHRZUCKER',450,'g'],
  ['ROTWEIN_2','BACKMARGARINE',450,'g'],
  ['ROTWEIN_2','VANILLEZUCKER',6,'g'],
  ['ROTWEIN_2','VOLLEI',350,'ml'],
  ['ROTWEIN_2','BACKPULVER',24,'g'],
  ['ROTWEIN_2','KAKAO',50,'g'],
  ['ROTWEIN_2','ZIMT_GEMAHLEN',6,'g'],
  ['ROTWEIN_2','ZITRONENSAFT',150,'ml'],
  ['ROTWEIN_2','KUVERTUERE_DUNKEL',150,'g'],
  ['ROTWEIN_2','ROTWEIN',190,'ml'],

  // Apfel 15
  ['APFEL_15','WEIZENMEHL',300,'g'],
  ['APFEL_15','ROHRZUCKER',200,'g'],
  ['APFEL_15','BACKMARGARINE',250,'g'],
  ['APFEL_15','VANILLEZUCKER',6,'g'],
  ['APFEL_15','VOLLEI',300,'ml'],
  ['APFEL_15','BACKPULVER',16,'g'],
  ['APFEL_15','ZIMT_GEMAHLEN',20,'g'],
  ['APFEL_15','ZITRONENSAFT',100,'ml'],
  ['APFEL_15','AEFEL',800,'g'],
  ['APFEL_15','MANDELGRIESS_FEIN',120,'g'],
  ['APFEL_15','MANDELN_GEHOBELT',50,'g'],
  ['APFEL_15','MILCH',130,'ml'],
  ['APFEL_15','WALNUSSKERNE',30,'g'],

  // Choc Chip 78
  ['CHOC_CHIP_78','WEIZENMEHL',2700,'g'],
  ['CHOC_CHIP_78','BACKMARGARINE',2000,'g'],
  ['CHOC_CHIP_78','MAISSTAERKE',100,'g'],
  ['CHOC_CHIP_78','ROHRZUCKER',900,'g'],
  ['CHOC_CHIP_78','ZUCKER',360,'g'],
  ['CHOC_CHIP_78','VANILLEZUCKER',100,'g'],
  ['CHOC_CHIP_78','NATRON',50,'g'],
  ['CHOC_CHIP_78','SCHOKO_PACKUNG',12,'pcs'],

  // Oatmeal 110
  ['OATMEAL_110','HAFERFLOCKEN',4000,'g'],
  ['OATMEAL_110','MAISSTAERKE',200,'g'],
  ['OATMEAL_110','BUTTER',2000,'g'],
  ['OATMEAL_110','ROHRZUCKER',1000,'g'],
  ['OATMEAL_110','ZUCKER',720,'g'],
  ['OATMEAL_110','VOLLEI',400,'ml'],
  ['OATMEAL_110','KUVERTUERE_WEISS',800,'g'],
  ['OATMEAL_110','ZIMT_GEMAHLEN',23,'g'],
  ['OATMEAL_110','VANILLEZUCKER',36,'g'],
  ['OATMEAL_110','BACKPULVER',18,'g'],
  ['OATMEAL_110','EDELNUSS_MIX',800,'g'],

  // Energy Balls 58
  ['ENERGY_BALLS_58','KAKAO',250,'g'],
  ['ENERGY_BALLS_58','HAFERFLOCKEN',1500,'g'],
  ['ENERGY_BALLS_58','DATTELN_5_7',800,'g'],
  ['ENERGY_BALLS_58','PFLAUMEN_5_7',400,'g'],
  ['ENERGY_BALLS_58','WALNUSSKERNE',500,'g'],
  ['ENERGY_BALLS_58','KOKOSOEL',150,'ml'],
  ['ENERGY_BALLS_58','KOKOSRASPEL',50,'g'],
  ['ENERGY_BALLS_58','ESPRESSO',20,'g'],

  // Pistachio 108
  ['PISTACHIO_108','BUTTER',1500,'g'],
  ['PISTACHIO_108','WEIZENMEHL',3400,'g'],
  ['PISTACHIO_108','NATRON',60,'g'],
  ['PISTACHIO_108','ROHRZUCKER',1400,'g'],
  ['PISTACHIO_108','VANILLEZUCKER',100,'g'],
  ['PISTACHIO_108','VOLLEI',1000,'ml'],
  ['PISTACHIO_108','ZITRONEN_SCHALE',10,'g'],
  ['PISTACHIO_108','PISTAZIEN',1000,'g'],
  ['PISTACHIO_108','PISTAZIEN_CREME',1200,'g'],
  ['PISTACHIO_108','KUVERTUERE_WEISS',1000,'g']
];

const shopsSeed = [
  { code:'CITY',  name:'City' },
  { code:'BERGER',name:'Berger' },
  { code:'GBW',   name:'GBW' }
];

// ----------------- SEED LOGIC ----------
async function seedAll({ wipe = false } = {}) {
  await ensureSchema();

  if (wipe) {
    await q(`TRUNCATE production_shop_lines, production_lines, production_plans, bom, items, products, suppliers, shops RESTART IDENTITY CASCADE`);
  }

  for (const s of suppliersSeed) {
    await q(`INSERT INTO suppliers(code,name) VALUES($1,$2)
             ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name`, [s.code, s.name]);
  }
  for (const p of productsSeed) {
    await q(`INSERT INTO products(code,name,base_unit,unit_cost,supplier_code)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, base_unit=EXCLUDED.base_unit,
               unit_cost=EXCLUDED.unit_cost, supplier_code=EXCLUDED.supplier_code`,
      [p.code, p.name, p.base_unit, p.cost, p.supplier]);
  }
  for (const i of itemsSeed) {
    await q(`INSERT INTO items(code,name,category,yield_qty,yield_unit)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category,
               yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit`,
      [i.code, i.name, i.category, i.yield_qty, i.yield_unit]);
  }
  for (const row of bomSeed) {
    const [item, prod, qty, unit] = row;
    await q(`INSERT INTO bom(item_code,product_code,qty,unit)
             VALUES($1,$2,$3,$4)
             ON CONFLICT (item_code,product_code) DO UPDATE SET qty=EXCLUDED.qty, unit=EXCLUDED.unit`,
      [item, prod, qty, unit]);
  }
  for (const s of shopsSeed) {
    await q(`INSERT INTO shops(code,name) VALUES($1,$2)
             ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name`, [s.code, s.name]);
  }
}

// ----------------- UNIT CONVERT --------
function convert(qty, from, to) {
  if (from === to) return qty;
  const key = `${from}->${to}`;
  switch (key) {
    case 'kg->g': return qty * 1000;
    case 'g->kg': return qty / 1000;
    case 'l->ml': return qty * 1000;
    case 'ml->l': return qty / 1000;
    default: return qty; // keep as-is for pcs or unknown; we keep base in g/ml/pcs
  }
}

// ----------------- ROUTES --------------
// health
app.get('/healthz', (req, res) => res.send('ok'));

// root -> login or dashboard
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ===== AUTH =====
app.get('/api/session', (req, res) => {
  return res.json({ ok: true, user: authed(req) ? req.session.user : null });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const expectedEmail = String(ADMIN_EMAIL || '').trim();
  const expectedPass  = String(ADMIN_PASSWORD || '').trim();

  // TEMP debug (no password printed)
  console.log('[login] attempt', {
    email,
    expectedEmail,
    envEmailSet: !!expectedEmail,
    envPassSet: !!expectedPass
  });

  if (email && password && email === expectedEmail && password === expectedPass) {
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

// SEED endpoints (admin)
app.post('/api/seed/full', requireAuth, async (req, res) => {
  try {
    const wipe = String(req.query.wipe || '').toLowerCase() === 'true';
    await seedAll({ wipe });
    const counts = await q(`
      SELECT
        (SELECT COUNT(*) FROM suppliers) AS suppliers,
        (SELECT COUNT(*) FROM products)  AS products,
        (SELECT COUNT(*) FROM items)     AS items,
        (SELECT COUNT(*) FROM bom)       AS bom,
        (SELECT COUNT(*) FROM shops)     AS shops
    `);
    res.json({ ok:true, wipe, stats: counts.rows[0] });
  } catch (e) {
    console.error('seed error', e);
    res.status(500).json({ ok:false, error:'seed_failed' });
  }
});

// PRODUCTS
app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const { rows } = await q(`SELECT code,name,base_unit,COALESCE(unit_cost,0) unit_cost,supplier_code FROM products ORDER BY name`);
    res.json({ ok:true, products: rows });
  } catch (e) {
    console.error(e); res.status(500).json({ ok:false, error:'db_error' });
  }
});

// Bulk price import: expects "CODE, price" per line
app.post('/api/products/bulk-prices', requireAuth, async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok:false, error:'missing_text' });
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let applied = 0;
    for (const line of lines) {
      const [codeRaw, priceRaw] = line.split(/,|;|\t/);
      if (!codeRaw || !priceRaw) continue;
      const code = codeRaw.trim();
      const price = Number(String(priceRaw).replace(/[€\s]/g,'').replace(',','.'));
      if (!Number.isFinite(price)) continue;
      await q(`UPDATE products SET unit_cost=$2 WHERE code=$1`, [code, price]);
      applied++;
    }
    res.json({ ok:true, applied });
  } catch (e) {
    console.error(e); res.status(500).json({ ok:false, error:'db_error' });
  }
});

// ITEMS / RECIPES
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit FROM items ORDER BY category,name`);
    res.json({ ok:true, items: rows });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error:'db_error' }); }
});

app.get('/api/items/:code/bom', requireAuth, async (req,res)=>{
  try {
    const { code } = req.params;
    const item = (await q(`SELECT code,name,yield_qty,yield_unit FROM items WHERE code=$1`,[code])).rows[0];
    if (!item) return res.status(404).json({ ok:false, error:'not_found' });
    const bom = (await q(`
      SELECT b.product_code as code, p.name, b.qty, b.unit, p.base_unit, p.unit_cost
      FROM bom b JOIN products p ON p.code=b.product_code
      WHERE b.item_code=$1
      ORDER BY p.name
    `,[code])).rows;
    res.json({ ok:true, item, bom });
  } catch(e){ console.error(e); res.status(500).json({ ok:false, error:'db_error' }); }
});

// Scale BOM for an output (pieces)
app.get('/api/calc/bom', requireAuth, async (req,res)=>{
  try {
    const itemCode = req.query.item;
    const output = Number(req.query.output || 0);
    if (!itemCode || !Number.isFinite(output) || output<=0) return res.status(400).json({ ok:false, error:'bad_params' });

    const item = (await q(`SELECT code,name,yield_qty,yield_unit FROM items WHERE code=$1`,[itemCode])).rows[0];
    if (!item) return res.status(404).json({ ok:false, error:'not_found' });
    const bom = (await q(`
      SELECT b.product_code as code, p.name, b.qty, b.unit, p.base_unit, COALESCE(p.unit_cost,0) unit_cost
      FROM bom b JOIN products p ON p.code=b.product_code
      WHERE b.item_code=$1
    `,[itemCode])).rows;

    const factor = output / Number(item.yield_qty);
    const lines = bom.map(r=>{
      const qtyScaled = r.qty * factor;
      const qtyBase = convert(qtyScaled, r.unit, r.base_unit);
      const costTotal = qtyBase * Number(r.unit_cost || 0);
      return {
        product_code: r.code,
        product_name: r.name,
        qty: Number(qtyScaled),
        unit: r.unit,
        base_qty: Number(qtyBase),
        base_unit: r.base_unit,
        unit_cost: Number(r.unit_cost || 0),
        cost_total: Number(costTotal)
      };
    });
    const totalCost = lines.reduce((s,l)=>s + l.cost_total, 0);
    res.json({ ok:true, item, output, lines, totalCost });
  } catch(e){ console.error(e); res.status(500).json({ ok:false, error:'db_error' }); }
});

// SHOPS
app.get('/api/shops', requireAuth, async (req,res)=>{
  const { rows } = await q(`SELECT code,name FROM shops ORDER BY name`);
  res.json({ ok:true, shops: rows });
});

// PRODUCTION
// Save current plan (today). Body: { lines:[{item_code,total_qty, shops:{CITY:10,...}}] }
app.post('/api/production/save', requireAuth, async (req,res)=>{
  try{
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ ok:false, error:'no_lines' });

    const plan = await q(`INSERT INTO production_plans(plan_date) VALUES (CURRENT_DATE)
                          ON CONFLICT(plan_date) DO UPDATE SET plan_date=EXCLUDED.plan_date
                          RETURNING id`);
    const planId = plan.rows[0].id;

    // Upsert lines + shop lines
    for (const ln of lines) {
      const total = Number(ln.total_qty || 0);
      if (!ln.item_code || !Number.isFinite(total) || total<0) continue;

      await q(`INSERT INTO production_lines(plan_id,item_code,total_qty)
               VALUES ($1,$2,$3)
               ON CONFLICT(plan_id,item_code) DO UPDATE SET total_qty=EXCLUDED.total_qty`,
        [planId, ln.item_code, total]);

      if (ln.shops && typeof ln.shops === 'object') {
        // Clear first
        await q(`DELETE FROM production_shop_lines WHERE plan_id=$1 AND item_code=$2`, [planId, ln.item_code]);
        for (const [shop, qtyRaw] of Object.entries(ln.shops)) {
          const qty = Number(qtyRaw || 0);
          if (qty>0) {
            await q(`INSERT INTO production_shop_lines(plan_id,item_code,shop_code,qty)
                     VALUES ($1,$2,$3,$4)`, [planId, ln.item_code, shop, qty]);
          }
        }
      }
    }
    res.json({ ok:true, plan_id: planId });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'db_error' }); }
});

// Compute raw material usage for today's plan
app.get('/api/production/usage', requireAuth, async (req,res)=>{
  try{
    const plan = await q(`SELECT id FROM production_plans WHERE plan_date=CURRENT_DATE`);
    if (!plan.rowCount) return res.json({ ok:true, usage: [] });
    const planId = plan.rows[0].id;

    const lines = (await q(`
      SELECT l.item_code, l.total_qty, it.yield_qty
      FROM production_lines l JOIN items it ON it.code=l.item_code
      WHERE l.plan_id=$1
    `,[planId])).rows;

    if (!lines.length) return res.json({ ok:true, usage: [] });

    // Load BOMs for involved items
    const itemCodes = lines.map(l=>l.item_code);
    const bomRows = (await q(`
      SELECT b.item_code, b.product_code, b.qty, b.unit, p.base_unit, p.name, COALESCE(p.unit_cost,0) unit_cost
      FROM bom b JOIN products p ON p.code=b.product_code
      WHERE b.item_code = ANY($1)
    `,[itemCodes])).rows;

    // Aggregate usage
    const usageMap = new Map(); // product_code -> {name, base_qty, base_unit, cost}
    for (const ln of lines) {
      const factor = Number(ln.total_qty) / Number(ln.yield_qty);
      const boms = bomRows.filter(r=>r.item_code === ln.item_code);
      for (const r of boms) {
        const qtyScaled = Number(r.qty) * factor;
        const qtyBase = convert(qtyScaled, r.unit, r.base_unit);
        const key = r.product_code;
        if (!usageMap.has(key)) {
          usageMap.set(key, { product_code: key, product_name: r.name, base_unit: r.base_unit, base_qty: 0, unit_cost: Number(r.unit_cost) });
        }
        usageMap.get(key).base_qty += qtyBase;
      }
    }

    const usage = Array.from(usageMap.values()).map(u => ({
      ...u,
      cost_total: u.base_qty * (u.unit_cost || 0)
    })).sort((a,b)=> a.product_name.localeCompare(b.product_name));

    res.json({ ok:true, usage, total_cost: usage.reduce((s,u)=>s+u.cost_total,0) });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'db_error' }); }
});

// HTML fallbacks (auth-gated where needed)
app.get('/login', (req,res)=> res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/dashboard', (req,res)=> authed(req) ? res.sendFile(path.join(__dirname,'public','dashboard.html')) : res.redirect('/login'));
app.get('/products',  (req,res)=> authed(req) ? res.sendFile(path.join(__dirname,'public','products.html'))  : res.redirect('/login'));
app.get('/recipes',   (req,res)=> authed(req) ? res.sendFile(path.join(__dirname,'public','recipes.html'))   : res.redirect('/login'));
app.get('/production',(req,res)=> authed(req) ? res.sendFile(path.join(__dirname,'public','production.html')): res.redirect('/login'));

// ----------------- STARTUP ------------
(async ()=>{
  await ensureSchema();
  // You can auto-seed on boot if you want:
  // await seedAll({ wipe: false });
  app.listen(PORT, ()=> console.log(`BUNCA minimal running on :${PORT}`));
})();
