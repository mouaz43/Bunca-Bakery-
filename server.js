// Bakeflow Server — fresh, wired for the new UI
// - Sessions, Auth
// - Postgres schema
// - CRUD & import
// - Search, deletes
// - Recipe pricing, line calc
// - Week plan load/save
// - CSV exports
// - Static pages + health

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

/* ---------- DB ---------- */
const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});
async function q(text, params = []) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

/* ---------- Express ---------- */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, sameSite: 'lax',
    secure: NODE_ENV === 'production' ? 'auto' : false,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Helpers ---------- */
const authed = (req) => !!(req.session && req.session.user);
const requireAuth = (req, res, next) => authed(req)
  ? next()
  : res.status(401).json({ ok: false, error: 'unauthorized' });
const eqi = (a, b) => String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase();

/* ---------- Health ---------- */
app.get('/healthz', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

/* ---------- Schema ---------- */
async function ensureSchema() {
  await q('BEGIN');
  await q(`CREATE TABLE IF NOT EXISTS materials (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_unit TEXT NOT NULL DEFAULT 'g',
    price_per_unit NUMERIC NOT NULL DEFAULT 0,
    pack_qty NUMERIC, pack_unit TEXT, pack_price NUMERIC,
    supplier_code TEXT, note TEXT
  );`);
  await q(`CREATE TABLE IF NOT EXISTS items (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    yield_qty NUMERIC NOT NULL DEFAULT 1,
    yield_unit TEXT NOT NULL DEFAULT 'pcs',
    note TEXT
  );`);
  await q(`CREATE TABLE IF NOT EXISTS bom (
    id SERIAL PRIMARY KEY,
    product_code TEXT,
    material_code TEXT,
    qty NUMERIC NOT NULL,
    unit TEXT NOT NULL
  );`);
  await q(`CREATE TABLE IF NOT EXISTS production_plan (
    id SERIAL PRIMARY KEY,
    day DATE NOT NULL,
    shop TEXT,
    start_time TIME, end_time TIME,
    product_code TEXT,
    qty NUMERIC NOT NULL DEFAULT 0,
    note TEXT
  );`);
  await q(`CREATE TABLE IF NOT EXISTS material_price_history (
    id SERIAL PRIMARY KEY,
    material_code TEXT NOT NULL,
    price_per_unit NUMERIC NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
  await q('COMMIT');
}

/* ---------- Units & pricing helpers ---------- */
const U = {
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  l:  { base: 'ml', factor: 1000 },
  pcs:{ base: 'pcs', factor: 1 },
  piece:{ base: 'pcs', factor: 1 },
  pieces:{ base: 'pcs', factor: 1 },
  stk:{ base: 'pcs', factor: 1 },
  'stück':{ base: 'pcs', factor: 1 },
};
function normalizeUnit(u) {
  const k = String(u || '').toLowerCase().trim();
  return U[k]?.base || (k || null);
}
function toBase(qty, unit) {
  const u = String(unit || '').toLowerCase();
  const m = U[u];
  return m ? { qty: Number(qty) * m.factor, unit: m.base } : { qty: Number(qty), unit };
}
async function pricePerBase(material_code) {
  const r = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [material_code]);
  if (!r.rowCount) return 0;
  return Number(r.rows[0].price_per_unit || 0);
}
async function scaleRecipe(productCode, targetQty) {
  const it = await q(`SELECT yield_qty, yield_unit FROM items WHERE code=$1`, [productCode]);
  if (it.rowCount === 0) throw new Error('item_not_found');
  const yieldQty = Number(it.rows[0].yield_qty) || 1;
  const factor = Number(targetQty) / yieldQty;

  const lines = await q(
    `SELECT b.material_code, b.qty, b.unit, m.price_per_unit, m.name AS material_name
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1
     ORDER BY b.id`, [productCode]
  );
  const scaled = [];
  for (const r of lines.rows) {
    const base0 = toBase(r.qty, r.unit);
    const baseScaled = { qty: base0.qty * factor, unit: base0.unit };
    const ppu = Number(r.price_per_unit || 0);
    const lineCost = Number(baseScaled.qty) * ppu;
    scaled.push({
      material_code: r.material_code,
      material_name: r.material_name,
      unit: baseScaled.unit,
      qty: Number(baseScaled.qty.toFixed(2)),
      price_per_unit: Number(ppu.toFixed(6)),
      cost: Number(lineCost.toFixed(2)),
    });
  }
  const total = scaled.reduce((s, x) => s + x.cost, 0);
  return { lines: scaled, total_cost: Number(total.toFixed(2)) };
}

/* ---------- Auth ---------- */
app.get('/api/session', (req, res) =>
  res.json({ ok: true, user: authed(req) ? req.session.user : null })
);

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim();
  const pass  = String(req.body?.password || '').trim();
  if (ADMIN_EMAIL && ADMIN_PASSWORD && eqi(email, ADMIN_EMAIL) && pass === ADMIN_PASSWORD) {
    req.session.user = { email, role: 'admin' };
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'bad_credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid'); res.json({ ok: true });
  });
});

/* ---------- Import (Phase 1: JSON arrays) ---------- */
app.post('/api/import/:dataset', requireAuth, async (req, res) => {
  const ds = req.params.dataset;
  const rows = Array.isArray(req.body) ? req.body : [];
  try {
    await q('BEGIN');
    if (ds === 'materials') {
      for (const m of rows) {
        await q(
          `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (code) DO UPDATE SET
            name=EXCLUDED.name, base_unit=EXCLUDED.base_unit, pack_qty=EXCLUDED.pack_qty,
            pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
            price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code,
            note=EXCLUDED.note`,
          [
            m.code, m.name, normalizeUnit(m.base_unit || 'g'),
            m.pack_qty ?? null, m.pack_unit ?? null, m.pack_price ?? null,
            Number(m.price_per_unit ?? 0), m.supplier_code ?? null, m.note ?? ''
          ]
        );
      }
    } else if (ds === 'items') {
      for (const it of rows) {
        await q(
          `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (code) DO UPDATE SET
            name=EXCLUDED.name, category=EXCLUDED.category,
            yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
          [it.code, it.name, it.category ?? '', Number(it.yield_qty ?? 1), it.yield_unit || 'pcs', it.note ?? '']
        );
      }
    } else if (ds === 'bom') {
      // accept long rows
      const grouped = new Map();
      for (const r of rows) {
        const arr = grouped.get(r.product_code) || [];
        arr.push({ material_code: r.material_code, qty: Number(r.qty), unit: normalizeUnit(r.unit || 'g') });
        grouped.set(r.product_code, arr);
      }
      for (const [product_code, ings] of grouped.entries()) {
        await q(`DELETE FROM bom WHERE product_code=$1`, [product_code]);
        for (const ing of ings) {
          await q(`INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
            [product_code, ing.material_code, Number(ing.qty), ing.unit]);
        }
      }
    } else if (ds === 'plan') {
      for (const p of rows) {
        await q(
          `INSERT INTO production_plan(day,shop,start_time,end_time,product_code,qty,note)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [p.date || p.day, p.shop ?? null, p.start_time ?? null, p.end_time ?? null,
           p.product_code, Number(p.qty ?? p.planned_qty ?? 0), p.note ?? '']
        );
      }
    } else {
      return res.status(400).json({ ok: false, error: 'unknown_dataset' });
    }
    await q('COMMIT');
    res.json({ ok: true, inserted: rows.length });
  } catch (e) {
    await q('ROLLBACK');
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ---------- Materials ---------- */
app.get('/api/materials', requireAuth, async (_req, res) => {
  const { rows } = await q(`
    SELECT m.code, m.name, m.base_unit, m.price_per_unit,
           m.pack_qty, m.pack_unit, m.pack_price,
           m.supplier_code, m.note
    FROM materials m
    ORDER BY m.name
  `);
  res.json({ ok: true, data: rows });
});
app.post('/api/materials', requireAuth, async (req, res) => {
  const {
    code, name, base_unit = 'g',
    price_per_unit = 0, pack_qty = null, pack_unit = null, pack_price = null,
    supplier_code = null, note = '',
  } = req.body || {};
  await q(
    `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name,
       base_unit=EXCLUDED.base_unit,
       pack_qty=EXCLUDED.pack_qty,
       pack_unit=EXCLUDED.pack_unit,
       pack_price=EXCLUDED.pack_price,
       price_per_unit=EXCLUDED.price_per_unit,
       supplier_code=EXCLUDED.supplier_code,
       note=EXCLUDED.note`,
    [code, name, normalizeUnit(base_unit), pack_qty, pack_unit, pack_price, price_per_unit, supplier_code, note]
  );
  res.json({ ok: true });
});
app.delete('/api/materials/:code', requireAuth, async (req, res) => {
  const r = await q(`DELETE FROM materials WHERE code=$1`, [req.params.code]);
  res.json({ ok: true, deleted: r.rowCount });
});
// search for autocomplete
app.get('/api/materials/search', requireAuth, async (req, res) => {
  const qstr = `%${String(req.query.q||'').toLowerCase()}%`;
  const { rows } = await q(
    `SELECT code, name, base_unit, price_per_unit
     FROM materials
     WHERE lower(code) LIKE $1 OR lower(name) LIKE $1
     ORDER BY name LIMIT 20`, [qstr]
  );
  res.json({ ok: true, data: rows });
});

/* ---------- Items & BOM ---------- */
app.get('/api/items', requireAuth, async (_req, res) => {
  const { rows } = await q(
    `SELECT code,name,category,yield_qty,yield_unit,note FROM items ORDER BY name`
  );
  res.json({ ok: true, data: rows });
});
app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category = '', yield_qty = 1, yield_unit = 'pcs', note = '' } =
    req.body || {};
  await q(
    `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name, category=EXCLUDED.category,
       yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
    [code, name, category, Number(yield_qty), yield_unit, note]
  );
  res.json({ ok: true });
});
app.delete('/api/items/:code', requireAuth, async (req, res) => {
  // Delete plan rows and bom referencing the item, then the item
  await q(`DELETE FROM production_plan WHERE product_code=$1`, [req.params.code]);
  await q(`DELETE FROM bom WHERE product_code=$1`, [req.params.code]);
  const r = await q(`DELETE FROM items WHERE code=$1`, [req.params.code]);
  res.json({ ok: true, deleted: r.rowCount });
});
app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { rows } = await q(
    `SELECT b.id, b.material_code, m.name AS material_name, b.qty, b.unit
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1
     ORDER BY b.id`, [code]
  );
  res.json({ ok: true, data: rows });
});
app.post('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  await q(`DELETE FROM bom WHERE product_code=$1`, [code]);
  for (const L of lines) {
    await q(
      `INSERT INTO bom(product_code,material_code,qty,unit)
       VALUES($1,$2,$3,$4)`,
      [code, L.material_code, Number(L.qty), normalizeUnit(L.unit || 'g')]
    );
  }
  res.json({ ok: true });
});
// priced preview for a qty
app.get('/api/items/:code/bom/priced', requireAuth, async (req, res) => {
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

/* ---------- Line calculator (for BOM row live cost) ---------- */
app.post('/api/calc/line', requireAuth, async (req, res) => {
  const { material_code, qty, unit } = req.body || {};
  const base = toBase(Number(qty || 0), unit || 'g');
  const ppu = await pricePerBase(material_code);
  const cost = Number(base.qty || 0) * Number(ppu || 0);
  res.json({ ok: true, data: { price_per_unit: Number(ppu.toFixed(6)), cost: Number(cost.toFixed(2)) } });
});

/* ---------- Plan (daily, weekly, calc) ---------- */
app.get('/api/plan', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.json({ ok: true, data: [] });
  const { rows } = await q(
    `SELECT id, day, start_time, end_time, product_code, qty, shop, note,
            (SELECT name FROM items i WHERE i.code=pp.product_code) AS product_name
     FROM production_plan pp
     WHERE day=$1
     ORDER BY start_time NULLS FIRST, id`, [date]
  );
  res.json({ ok: true, data: rows });
});
app.post('/api/plan/calc', requireAuth, async (req, res) => {
  // either rows: [{product_code, qty}] OR week_start/date in body
  let list = req.body?.rows;
  if ((!list || !Array.isArray(list)) && req.body?.date) {
    const { rows } = await q(`SELECT product_code, qty FROM production_plan WHERE day=$1`, [req.body.date]);
    list = rows.map(r => ({ product_code: r.product_code, qty: Number(r.qty) }));
  }
  if ((!list || !Array.isArray(list)) && req.body?.week_start) {
    const start = req.body.week_start;
    const days = [...Array(7)].map((_,i)=> {
      const d = new Date(start); d.setDate(new Date(start).getDate()+i);
      return d.toISOString().slice(0,10);
    });
    const rows = (await Promise.all(days.map(d => q(`SELECT product_code, qty FROM production_plan WHERE day=$1`, [d]))))
      .flatMap(r => r.rows);
    list = rows.map(r => ({ product_code: r.product_code, qty: Number(r.qty) }));
  }
  if (!Array.isArray(list) || list.length === 0)
    return res.json({ ok: true, data: { lines: [], total_cost: 0 } });

  // accumulate per material
  const need = new Map(); // key=material_code|unit (unit=base)
  let totalCost = 0;
  for (const row of list) {
    const one = await scaleRecipe(row.product_code, row.qty);
    for (const L of one.lines) {
      const key = `${L.material_code}|${L.unit}`;
      const cur = need.get(key) || { ...L };
      if (need.has(key)) {
        cur.qty = Number((cur.qty + L.qty).toFixed(2));
        cur.cost = Number((cur.cost + L.cost).toFixed(2));
      }
      need.set(key, cur);
    }
    totalCost = Number((totalCost + one.total_cost).toFixed(2));
  }
  const lines = Array.from(need.values()).sort((a,b)=> (a.material_name||a.material_code).localeCompare(b.material_name||b.material_code));
  res.json({ ok: true, data: { lines, total_cost: totalCost } });
});

// week load: returns all rows for 7 days starting at ?start=YYYY-MM-DD
app.get('/api/plan/week', requireAuth, async (req, res) => {
  const start = String(req.query.start||'').slice(0,10);
  if (!start) return res.json({ ok: true, data: [] });
  const dates = [...Array(7)].map((_,i)=> {
    const d = new Date(start); d.setDate(new Date(start).getDate()+i);
    return d.toISOString().slice(0,10);
  });
  const { rows } = await q(
    `SELECT id, day, start_time, end_time, product_code, qty, shop, note,
            (SELECT name FROM items i WHERE i.code=pp.product_code) AS product_name
     FROM production_plan pp
     WHERE day = ANY($1::date[])
     ORDER BY day, start_time NULLS FIRST, id`, [dates]
  );
  res.json({ ok: true, data: rows });
});

// week save: replaces rows within that week range with provided list (day inside range)
app.post('/api/plan/week/save', requireAuth, async (req, res) => {
  const start = String(req.body?.start||'').slice(0,10);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!start) return res.status(400).json({ ok:false, error:'start_required' });

  const days = [...Array(7)].map((_,i)=> {
    const d = new Date(start); d.setDate(new Date(start).getDate()+i);
    return d.toISOString().slice(0,10);
  });

  try{
    await q('BEGIN');
    await q(`DELETE FROM production_plan WHERE day = ANY($1::date[])`, [days]);
    for (const r of rows) {
      if (!days.includes(String(r.day).slice(0,10))) continue; // ignore out of range
      await q(
        `INSERT INTO production_plan(day,shop,start_time,end_time,product_code,qty,note)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [r.day, r.shop||null, r.start_time||null, r.end_time||null, r.product_code, Number(r.qty||0), r.note||'']
      );
    }
    await q('COMMIT');
    res.json({ ok: true });
  } catch(e){
    await q('ROLLBACK');
    res.status(400).json({ ok:false, error:e.message });
  }
});

/* ---------- CSV Exports ---------- */
function toCSV(rows, cols) {
  const esc = (v)=> {
    const s = v==null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  return [ cols.join(','), ...rows.map(r => cols.map(c=>esc(r[c])).join(',')) ].join('\n');
}
app.get('/api/tools/export/items', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit,note FROM items ORDER BY code`);
  const csv = toCSV(rows, ['code','name','category','yield_qty','yield_unit','note']);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="items.csv"');
  res.send(csv);
});
app.get('/api/tools/export/plan', requireAuth, async (req, res) => {
  const start = req.query.start ? String(req.query.start).slice(0,10) : null;
  if (!start) return res.status(400).send('start required');
  const dates = [...Array(7)].map((_,i)=> {
    const d = new Date(start); d.setDate(new Date(start).getDate()+i);
    return d.toISOString().slice(0,10);
  });
  const { rows } = await q(
    `SELECT day, shop, start_time, end_time, product_code, qty, note FROM production_plan
     WHERE day = ANY($1::date[])
     ORDER BY day, start_time NULLS FIRST, id`, [dates]
  );
  const csv = toCSV(rows, ['day','shop','start_time','end_time','product_code','qty','note']);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="plan-week.csv"');
  res.send(csv);
});

/* ---------- Pages ---------- */
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* ---------- 404 ---------- */
app.use((req, res) => {
  const file = path.join(__dirname, 'public', '404.html');
  if (fs.existsSync(file)) return res.status(404).sendFile(file);
  res.status(404).send('Not found');
});

/* ---------- Boot ---------- */
(async () => {
  await ensureSchema();
  app.listen(PORT, () => console.log(`Bakeflow running on :${PORT}`));
})();
