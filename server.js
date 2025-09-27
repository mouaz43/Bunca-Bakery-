// BUNCA Bakeflow — solid server
// - Auth + sessions
// - Schema (no auto seeding)
// - CRUD + import
// - Search, deletes, pricing calc, weekly plan
// - CSV export
// - ADMIN WIPE endpoint to clear demo/old data
// - Sturdy boot to avoid 502s

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
const requireAuth = (req, res, next) =>
  authed(req) ? next() : res.status(401).json({ ok: false, error: 'unauthorized' });
const requireAdmin = (req, res, next) =>
  authed(req) && req.session.user?.email ? next() : res.status(401).json({ ok:false, error:'unauthorized' });
const eqi = (a, b) => String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase();

/* ---------- Health (helps Render avoid 502) ---------- */
app.get('/healthz', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); }
  catch (e) { console.error('healthz failed', e.message); res.status(500).json({ ok: false }); }
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

/* ---------- Units & calc helpers ---------- */
const U = {
  g: { base: 'g', factor: 1 },
  kg:{ base: 'g', factor: 1000 },
  ml:{ base: 'ml', factor: 1 },
  l: { base: 'ml', factor: 1000 },
  pcs:{ base: 'pcs', factor: 1 },
  piece:{ base: 'pcs', factor: 1 },
  pieces:{ base: 'pcs', factor: 1 },
  stk:{ base: 'pcs', factor: 1 },
  'stück':{ base: 'pcs', factor: 1 },
};
const normalizeUnit = (u)=> U[String(u||'').toLowerCase()]?.base || (String(u||'').toLowerCase() || null);
const toBase = (qty, unit)=> {
  const u = String(unit || '').toLowerCase();
  const m = U[u];
  return m ? { qty: Number(qty) * m.factor, unit: m.base } : { qty: Number(qty), unit };
};

async function scaleRecipe(productCode, targetQty) {
  const it = await q(`SELECT yield_qty FROM items WHERE code=$1`, [productCode]);
  if (it.rowCount === 0) throw new Error('item_not_found');
  const factor = Number(targetQty) / (Number(it.rows[0].yield_qty) || 1);

  const lines = await q(
    `SELECT b.material_code, b.qty, b.unit, m.price_per_unit, m.name AS material_name
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1 ORDER BY b.id`, [productCode]
  );

  const out = [];
  for (const r of lines.rows) {
    const base0 = toBase(r.qty, r.unit);
    const baseScaled = { qty: base0.qty * factor, unit: base0.unit };
    const ppu = Number(r.price_per_unit || 0);
    out.push({
      material_code: r.material_code,
      material_name: r.material_name,
      unit: baseScaled.unit,
      qty: Number(baseScaled.qty.toFixed(2)),
      price_per_unit: Number(ppu.toFixed(6)),
      cost: Number((baseScaled.qty * ppu).toFixed(2))
    });
  }
  const total = out.reduce((s,x)=>s+x.cost,0);
  return { lines: out, total_cost: Number(total.toFixed(2)) };
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
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

/* ---------- ADMIN: Wipe data (to kill ghost/demo rows) ---------- */
// POST /api/admin/wipe  { what: 'all' | 'items' | 'materials' | 'plan' }
app.post('/api/admin/wipe', requireAdmin, async (req, res) => {
  const what = String(req.body?.what || 'all');
  try {
    await q('BEGIN');
    if (what === 'all' || what === 'plan') {
      await q(`DELETE FROM production_plan`);
    }
    if (what === 'all' || what === 'items') {
      await q(`DELETE FROM bom`);
      await q(`DELETE FROM items`);
    }
    if (what === 'all' || what === 'materials') {
      await q(`DELETE FROM material_price_history`);
      await q(`DELETE FROM materials`);
    }
    await q('COMMIT');
    res.json({ ok:true, wiped: what });
  } catch (e) {
    await q('ROLLBACK');
    res.status(400).json({ ok:false, error: e.message });
  }
});

/* ---------- Import (JSON arrays) ---------- */
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
    SELECT code, name, base_unit, price_per_unit, pack_qty, pack_unit, pack_price, supplier_code, note
    FROM materials ORDER BY name
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
       name=EXCLUDED.name, base_unit=EXCLUDED.base_unit,
       pack_qty=EXCLUDED.pack_qty, pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
       price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
    [code, name, normalizeUnit(base_unit), pack_qty, pack_unit, pack_price, price_per_unit, supplier_code, note]
  );
  res.json({ ok: true });
});
app.delete('/api/materials/:code', requireAuth, async (req, res) => {
  const r = await q(`DELETE FROM materials WHERE code=$1`, [req.params.code]);
  res.json({ ok: true, deleted: r.rowCount });
});
app.get('/api/materials/search', requireAuth, async (req, res) => {
  const s = `%${String(req.query.q||'').toLowerCase()}%`;
  const { rows } = await q(
    `SELECT code, name, base_unit, price_per_unit
     FROM materials
     WHERE lower(code) LIKE $1 OR lower(name) LIKE $1
     ORDER BY name LIMIT 20`, [s]
  );
  res.json({ ok: true, data: rows });
});

/* ---------- Items & BOM ---------- */
app.get('/api/items', requireAuth, async (_req, res) => {
  const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit,note FROM items ORDER BY name`);
  res.json({ ok: true, data: rows });
});
app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category = '', yield_qty = 1, yield_unit = 'pcs', note = '' } = req.body || {};
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
  await q(`DELETE FROM production_plan WHERE product_code=$1`, [req.params.code]);
  await q(`DELETE FROM bom WHERE product_code=$1`, [req.params.code]);
  const r = await q(`DELETE FROM items WHERE code=$1`, [req.params.code]);
  res.json({ ok: true, deleted: r.rowCount });
});
app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT b.id, b.material_code, m.name AS material_name, b.qty, b.unit
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1 ORDER BY b.id`, [req.params.code]
  );
  res.json({ ok: true, data: rows });
});
app.post('/api/items/:code/bom', requireAuth, async (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  await q(`DELETE FROM bom WHERE product_code=$1`, [req.params.code]);
  for (const L of lines) {
    await q(
      `INSERT INTO bom(product_code,material_code,qty,unit)
       VALUES($1,$2,$3,$4)`,
      [req.params.code, L.material_code, Number(L.qty), normalizeUnit(L.unit || 'g')]
    );
  }
  res.json({ ok: true });
});
app.get('/api/items/:code/bom/priced', requireAuth, async (req, res) => {
  const qty = Number(req.query.qty || 0);
  if (!qty) return res.status(400).json({ ok: false, error: 'qty_required' });
  try { const r = await scaleRecipe(req.params.code, qty); res.json({ ok: true, data: r }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- Calc single line ---------- */
app.post('/api/calc/line', requireAuth, async (req, res) => {
  const { material_code, qty, unit } = req.body || {};
  const base = toBase(Number(qty || 0), unit || 'g');
  const p = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [material_code]);
  const ppu = p.rowCount ? Number(p.rows[0].price_per_unit || 0) : 0;
  const cost = Number(base.qty || 0) * ppu;
  res.json({ ok: true, data: { price_per_unit: Number(ppu.toFixed(6)), cost: Number(cost.toFixed(2)) } });
});

/* ---------- Plan (daily & weekly & calc) ---------- */
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
  let list = req.body?.rows;
  if ((!list || !Array.isArray(list)) && req.body?.date) {
    const { rows } = await q(`SELECT product_code, qty FROM production_plan WHERE day=$1`, [req.body.date]);
    list = rows.map(r => ({ product_code: r.product_code, qty: Number(r.qty) }));
  }
  if (!Array.isArray(list) || list.length === 0)
    return res.json({ ok: true, data: { lines: [], total_cost: 0 } });

  const need = new Map();
  let totalCost = 0;
  for (const row of list) {
    const one = await scaleRecipe(row.product_code, Number(row.qty||0));
    for (const L of one.lines) {
      const key = `${L.material_code}|${L.unit}`;
      const cur = need.get(key) || { ...L };
      if (need.has(key)) { cur.qty = Number((cur.qty + L.qty).toFixed(2)); cur.cost = Number((cur.cost + L.cost).toFixed(2)); }
      need.set(key, cur);
    }
    totalCost = Number((totalCost + one.total_cost).toFixed(2));
  }
  const lines = Array.from(need.values()).sort((a,b)=> (a.material_name||a.material_code).localeCompare(b.material_name||b.material_code));
  res.json({ ok: true, data: { lines, total_cost: totalCost } });
});

/* ---------- CSV Exports ---------- */
function toCSV(rows, cols) {
  const esc = (v)=> {
    const s = v==null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  return [ cols.join(','), ...rows.map(r => cols.map(c=>esc(r[c])).join(',')) ].join('\n');
}
app.get('/api/tools/export/items', requireAuth, async (_req, res) => {
  const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit,note FROM items ORDER BY code`);
  const csv = toCSV(rows, ['code','name','category','yield_qty','yield_unit','note']);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="items.csv"');
  res.send(csv);
});
app.get('/api/tools/export/plan', requireAuth, async (req, res) => {
  const start = req.query.start ? String(req.query.start).slice(0,10) : null;
  if (!start) return res.status(400).send('start required');
  const days = [...Array(7)].map((_,i)=> { const d=new Date(start); d.setDate(new Date(start).getDate()+i); return d.toISOString().slice(0,10); });
  const { rows } = await q(
    `SELECT day, shop, start_time, end_time, product_code, qty, note FROM production_plan
     WHERE day = ANY($1::date[])
     ORDER BY day, start_time NULLS FIRST, id`, [days]
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

/* ---------- Boot (guarded to avoid 502) ---------- */
(async () => {
  try {
    console.log('Bakeflow starting…');
    console.log('DB URL present:', !!DATABASE_URL, 'Admin email set:', !!ADMIN_EMAIL);
    await ensureSchema();
    app.listen(PORT, () => console.log(`Bakeflow listening on :${PORT}`));
  } catch (e) {
    console.error('FATAL boot error:', e);
    process.exit(1);
  }
})();
