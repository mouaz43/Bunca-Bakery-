// server.js — BUNCA Planner (from scratch, minimal & solid)
// - Auth (admin email/password from env, case-insensitive email, trimmed password)
// - Postgres schema with safe migrations (creates + alters if missing)
// - Seed runner from /seed/*.json (idempotent UPSERTs)
// - Production plan: date + optional start/end time + qty
// - Calculator: scales recipes (BOM) to get material usage & cost
// - Simple JSON APIs; static pages in /public (we'll add them next)

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'please-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function q(text, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } catch (err) {
    console.error('[SQL ERROR]', err.message, { text, params });
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Express ----------
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

// ---------- Auth helpers ----------
const authed = (req) => !!(req.session && req.session.user);
const requireAuth = (req, res, next) => (authed(req) ? next() : res.status(401).json({ ok: false, error: 'unauthorized' }));
const eqi = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ---------- Schema & migrations ----------
async function ensureSchema() {
  console.log('[schema] start');

  // base tables
  await q(`CREATE TABLE IF NOT EXISTS suppliers ( code TEXT PRIMARY KEY, name TEXT NOT NULL );`);
  await q(`CREATE TABLE IF NOT EXISTS materials ( code TEXT PRIMARY KEY, name TEXT NOT NULL );`);
  await q(`CREATE TABLE IF NOT EXISTS items ( code TEXT PRIMARY KEY, name TEXT NOT NULL );`);
  await q(`CREATE TABLE IF NOT EXISTS bom ( id BIGSERIAL PRIMARY KEY, product_code TEXT, material_code TEXT, qty NUMERIC NOT NULL, unit TEXT NOT NULL );`);
  await q(`CREATE TABLE IF NOT EXISTS production_plan ( id BIGSERIAL PRIMARY KEY, day DATE NOT NULL, start_time TEXT, end_time TEXT, product_code TEXT, qty NUMERIC NOT NULL DEFAULT 0, note TEXT DEFAULT '' );`);
  await q(`CREATE TABLE IF NOT EXISTS material_price_history ( id BIGSERIAL PRIMARY KEY, material_code TEXT, price_per_unit NUMERIC NOT NULL, recorded_at TIMESTAMP NOT NULL DEFAULT NOW() );`);

  // add missing columns (one ALTER per statement for reliability)
  await q(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact TEXT DEFAULT '';`);

  await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'g';`);
  await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS price_per_unit NUMERIC NOT NULL DEFAULT 0;`);
  await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS supplier_code TEXT;`);
  await q(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';`);

  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS yield_qty NUMERIC NOT NULL DEFAULT 1;`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS yield_unit TEXT NOT NULL DEFAULT 'pcs';`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';`);

  // constraints guarded via DO block
  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='materials_supplier_fk') THEN
        ALTER TABLE materials
          ADD CONSTRAINT materials_supplier_fk
          FOREIGN KEY (supplier_code) REFERENCES suppliers(code) ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='bom_product_fk') THEN
        ALTER TABLE bom
          ADD CONSTRAINT bom_product_fk
          FOREIGN KEY (product_code) REFERENCES items(code) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='bom_material_fk') THEN
        ALTER TABLE bom
          ADD CONSTRAINT bom_material_fk
          FOREIGN KEY (material_code) REFERENCES materials(code) ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='plan_item_fk') THEN
        ALTER TABLE production_plan
          ADD CONSTRAINT plan_item_fk
          FOREIGN KEY (product_code) REFERENCES items(code) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  // indexes
  await q(`CREATE INDEX IF NOT EXISTS idx_bom_product ON bom(product_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_bom_material ON bom(material_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_plan_day ON production_plan(day);`);

  console.log('[schema] complete');
}

// ---------- Units ----------
const U = {
  g: { base: 'g', factor: 1 }, kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 }, l: { base: 'ml', factor: 1000 },
  pcs: { base: 'pcs', factor: 1 }, piece: { base: 'pcs', factor: 1 }, pieces: { base: 'pcs', factor: 1 }
};
function toBase(qty, unit) {
  const u = String(unit || '').toLowerCase();
  const m = U[u];
  return m ? { qty: Number(qty) * m.factor, unit: m.base } : { qty: Number(qty), unit };
}

// ---------- Seed runner ----------
function readSeed(name) {
  const p = path.join(__dirname, 'seed', name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function applySeed() {
  console.log('[seed] applying…');
  const suppliers = readSeed('suppliers.json') || [];
  const materials = readSeed('materials.json') || [];
  const items = readSeed('items.json') || [];
  const bom = readSeed('bom.json') || [];
  const plan = readSeed('plan.json') || [];

  for (const s of suppliers) {
    await q(
      `INSERT INTO suppliers(code,name,contact) VALUES($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, contact=EXCLUDED.contact`,
      [s.code, s.name, s.contact || '']
    );
  }

  for (const m of materials) {
    await q(
      `INSERT INTO materials(code,name,unit,price_per_unit,supplier_code,note)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE
         SET name=EXCLUDED.name, unit=EXCLUDED.unit, price_per_unit=EXCLUDED.price_per_unit,
             supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
      [m.code, m.name, m.unit || 'g', m.price_per_unit ?? 0, m.supplier_code || null, m.note || '']
    );
  }

  for (const it of items) {
    await q(
      `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE
         SET name=EXCLUDED.name, category=EXCLUDED.category, yield_qty=EXCLUDED.yield_qty,
             yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
      [it.code, it.name, it.category || '', it.yield_qty || 1, it.yield_unit || 'pcs', it.note || '']
    );
  }

  // Replace BOM per product
  for (const b of bom) {
    await q(`DELETE FROM bom WHERE product_code=$1`, [b.product_code]);
    for (const ing of b.ingredients || []) {
      await q(
        `INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
        [b.product_code, ing.material_code, Number(ing.qty), ing.unit || 'g']
      );
    }
  }

  // Optional: plan
  for (const p of plan) {
    await q(
      `INSERT INTO production_plan(day,start_time,end_time,product_code,qty,note)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [p.date, p.start_time || null, p.end_time || null, p.product_code, Number(p.planned_qty || 0), p.note || '']
    );
  }

  console.log('[seed] done');
  return {
    suppliers: suppliers.length,
    materials: materials.length,
    items: items.length,
    bom: bom.length,
    plan: plan.length
  };
}

// ---------- Calculator ----------
async function scaleRecipe(productCode, targetQty) {
  // get yield
  const it = await q(`SELECT yield_qty, yield_unit FROM items WHERE code=$1`, [productCode]);
  if (it.rowCount === 0) throw new Error('item_not_found');
  const yieldQty = Number(it.rows[0].yield_qty) || 1;

  const factor = Number(targetQty) / yieldQty;
  const lines = await q(
    `SELECT b.material_code, b.qty, b.unit, m.unit AS m_unit, m.price_per_unit, m.name AS material_name
     FROM bom b
     JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1
     ORDER BY b.id`,
    [productCode]
  );

  const scaled = [];
  for (const r of lines.rows) {
    // normalize to material base unit for safe cost math
    const base0 = toBase(r.qty, r.unit);
    const baseScaled = { qty: base0.qty * factor, unit: base0.unit };

    // Cost uses material.price_per_unit per material.base unit (we assume r.unit matches m.unit base after toBase)
    const lineCost = Number(baseScaled.qty) * Number(r.price_per_unit || 0);

    scaled.push({
      material_code: r.material_code,
      material_name: r.material_name,
      unit: baseScaled.unit,           // g/ml/pcs
      qty: Number(baseScaled.qty.toFixed(2)),
      price_per_unit: Number((r.price_per_unit || 0).toFixed(6)),
      cost: Number(lineCost.toFixed(2))
    });
  }

  const total = scaled.reduce((s, x) => s + x.cost, 0);
  return { lines: scaled, total_cost: Number(total.toFixed(2)) };
}

async function calcForPlanRows(rows) {
  // rows: [{ product_code, qty }]
  const need = new Map(); // key=material_code|unit
  let totalCost = 0;

  for (const r of rows) {
    const one = await scaleRecipe(r.product_code, r.qty);
    for (const l of one.lines) {
      const key = `${l.material_code}|${l.unit}`;
      const cur = need.get(key) || { material_code: l.material_code, material_name: l.material_name, unit: l.unit, qty: 0, price_per_unit: l.price_per_unit, cost: 0 };
      cur.qty += l.qty;
      cur.cost += l.cost;
      need.set(key, cur);
    }
    totalCost += one.total_cost;
  }

  const arr = Array.from(need.values()).map(x => ({
    material_code: x.material_code,
    material_name: x.material_name,
    unit: x.unit,
    qty: Number(x.qty.toFixed(2)),
    price_per_unit: Number(x.price_per_unit.toFixed(6)),
    cost: Number(x.cost.toFixed(2))
  })).sort((a,b)=>a.material_name.localeCompare(b.material_name));

  return { lines: arr, total_cost: Number(totalCost.toFixed(2)) };
}

// ---------- Routes: pages ----------
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---------- Routes: auth ----------
app.get('/api/session', (req, res) => res.json({ ok: true, user: authed(req) ? req.session.user : null }));

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim();
  const pass = String(req.body?.password || '').trim();
  const expEmail = String(ADMIN_EMAIL || '').trim();
  const expPass = String(ADMIN_PASSWORD || '').trim();

  console.log('[login] attempt', { email, expectedEmail: expEmail, envEmailSet: !!expEmail, envPassSet: !!expPass });

  if (expEmail && expPass && eqi(email, expEmail) && pass === expPass) {
    req.session.user = { email: expEmail, role: 'admin' };
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'bad_credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

// ---------- Routes: admin / seed ----------
app.post('/api/admin/seed/apply', requireAuth, async (req, res) => {
  try {
    const r = await applySeed();
    res.json({ ok: true, counts: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Routes: materials ----------
app.get('/api/materials', requireAuth, async (req, res) => {
  const { rows } = await q(`
    SELECT m.code, m.name, m.unit, m.price_per_unit, m.supplier_code, m.note, s.name AS supplier_name
    FROM materials m
    LEFT JOIN suppliers s ON s.code = m.supplier_code
    ORDER BY m.name
  `);
  res.json({ ok: true, data: rows });
});

app.post('/api/materials', requireAuth, async (req, res) => {
  const { code, name, unit='g', price_per_unit=0, supplier_code=null, note='' } = req.body || {};
  // record price change
  const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [code]);
  if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== Number(price_per_unit)) {
    await q(`INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`, [code, price_per_unit]);
  }
  await q(
    `INSERT INTO materials(code,name,unit,price_per_unit,supplier_code,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE
     SET name=EXCLUDED.name, unit=EXCLUDED.unit, price_per_unit=EXCLUDED.price_per_unit,
         supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
    [code, name, unit, price_per_unit, supplier_code, note]
  );
  res.json({ ok: true });
});

// Bulk prices: accepts "CODE | 0.00123" lines
app.post('/api/materials/bulk-prices', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '');
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  let updated = 0;
  for (const L of lines) {
    const m = L.match(/^([^|]+)\|\s*([0-9]+(?:[.,][0-9]+)?)$/);
    if (!m) continue;
    const code = m[1].trim();
    const val = Number(m[2].replace(',', '.'));
    const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [code]);
    if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== val) {
      await q(`INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`, [code, val]);
    }
    const r = await q(`UPDATE materials SET price_per_unit=$1 WHERE code=$2`, [val, code]);
    updated += r.rowCount;
  }
  res.json({ ok: true, updated });
});

// ---------- Routes: items & recipes ----------
app.get('/api/items', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit,note FROM items ORDER BY name`);
  res.json({ ok: true, data: rows });
});

app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category='', yield_qty=1, yield_unit='pcs', note='' } = req.body || {};
  await q(
    `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE
     SET name=EXCLUDED.name, category=EXCLUDED.category, yield_qty=EXCLUDED.yield_qty,
         yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
    [code, name, category, yield_qty, yield_unit, note]
  );
  res.json({ ok: true });
});

app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { rows } = await q(`
    SELECT b.id, b.material_code, m.name AS material_name, b.qty, b.unit
    FROM bom b
    JOIN materials m ON m.code=b.material_code
    WHERE b.product_code=$1
    ORDER BY b.id
  `,[code]);
  res.json({ ok: true, data: rows });
});

app.post('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  await q(`DELETE FROM bom WHERE product_code=$1`, [code]);
  for (const L of lines) {
    await q(`INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
      [code, L.material_code, Number(L.qty), L.unit || 'g']);
  }
  res.json({ ok: true });
});

// Scale preview (for UI yield changes)
app.get('/api/items/:code/scale', requireAuth, async (req, res) => {
  const code = req.params.code;
  const qty = Number(req.query.qty || 0);
  if (!qty) return res.status(400).json({ ok: false, error: 'qty_required' });
  try {
    const r = await scaleRecipe(code, qty);
    res.json({ ok: true, data: r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- Routes: plan ----------
app.get('/api/plan', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.json({ ok: true, data: [] });
  const { rows } = await q(`
    SELECT id, day, start_time, end_time, product_code, qty, note,
           (SELECT name FROM items i WHERE i.code=pp.product_code) AS product_name,
           (SELECT yield_qty FROM items i WHERE i.code=pp.product_code) AS yield_qty,
           (SELECT yield_unit FROM items i WHERE i.code=pp.product_code) AS yield_unit
    FROM production_plan pp
    WHERE day=$1
    ORDER BY start_time NULLS FIRST, id
  `,[date]);
  res.json({ ok: true, data: rows });
});

app.post('/api/plan/save', requireAuth, async (req, res) => {
  const { date, rows } = req.body || {};
  if (!date || !Array.isArray(rows)) return res.status(400).json({ ok:false, error:'bad_request' });
  await q(`DELETE FROM production_plan WHERE day=$1`, [date]);
  for (const r of rows) {
    await q(
      `INSERT INTO production_plan(day,start_time,end_time,product_code,qty,note)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [date, r.start_time || null, r.end_time || null, r.product_code, Number(r.qty || 0), r.note || '']
    );
  }
  res.json({ ok: true });
});

// Calculate materials for arbitrary rows (or for a date if provided)
app.post('/api/plan/calc', requireAuth, async (req, res) => {
  let list = req.body?.rows;
  if ((!list || !Array.isArray(list)) && req.body?.date) {
    const { rows } = await q(`SELECT product_code, qty FROM production_plan WHERE day=$1`, [req.body.date]);
    list = rows.map(r => ({ product_code: r.product_code, qty: Number(r.qty) }));
  }
  if (!Array.isArray(list) || list.length === 0) return res.json({ ok:true, data: { lines: [], total_cost: 0 } });
  const result = await calcForPlanRows(list.map(r => ({ product_code: r.product_code, qty: Number(r.qty) })));
  res.json({ ok: true, data: result });
});

// ---------- 404 fallback ----------
app.use((req, res) => {
  const file = path.join(__dirname, 'public', '404.html');
  if (fs.existsSync(file)) return res.status(404).sendFile(file);
  res.status(404).send('Not found');
});

// ---------- Boot ----------
(async () => {
  try {
    console.log('Starting BUNCA…');
    console.log('Has DB URL:', !!DATABASE_URL, 'Admin email set:', !!ADMIN_EMAIL);

    await ensureSchema();

    // Optional: auto-apply seed if tables are empty
    const c1 = await q(`SELECT (SELECT COUNT(*) FROM materials)::int AS m, (SELECT COUNT(*) FROM items)::int AS i`);
    if (c1.rows[0].m === 0 && c1.rows[0].i === 0) {
      console.log('[seed] first-boot apply');
      await applySeed().catch(e => console.warn('seed failed (ok to continue):', e.message));
    }

    app.listen(PORT, () => console.log(`Listening on :${PORT}`));
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
