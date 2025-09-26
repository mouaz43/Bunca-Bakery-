// Bakeflow — cohesive backend (final, comprehensive)
// Sessions, Units, Materials CRUD (+history, search, bulk, pack→€/base),
// Items CRUD, BOM CRUD + validation, Costing (line & full BOM),
// Plan (day/week + delete + aggregate usage/cost),
// Tools (export/backup/restore), Generic Import,
// Users admin, Static pages, Health.

const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'PLEASE_SET_ME';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

/* ================= DB ================= */
const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
});
async function q(text, params = []) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  catch (e) { console.error('[SQL]', e.message, { text, params }); throw e; }
  finally { client.release(); }
}

/* =============== Express =============== */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production' ? 'auto' : false,
    maxAge: 1000 * 60 * 60 * 8, // 8h
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ============== Helpers ============== */
const authed = (req) => !!(req.session && req.session.user);
const requireAuth = (req, res, next) =>
  authed(req) ? next() : res.status(401).json({ ok: false, error: 'unauthorized' });
const eqi = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/* ============== Health ============== */
app.get('/healthz', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

/* ============== Schema (idempotent) ============== */
async function ensureSchema() {
  await q('BEGIN');

  await q(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      role  TEXT NOT NULL DEFAULT 'admin',
      password TEXT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS materials (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_unit TEXT NOT NULL DEFAULT 'g',
      price_per_unit NUMERIC NOT NULL DEFAULT 0,
      pack_qty NUMERIC,
      pack_unit TEXT,
      pack_price NUMERIC,
      supplier_code TEXT,
      note TEXT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS material_price_history (
      id SERIAL PRIMARY KEY,
      material_code TEXT NOT NULL,
      price_per_unit NUMERIC NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS items (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      yield_qty NUMERIC NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs',
      note TEXT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS bom (
      id SERIAL PRIMARY KEY,
      product_code  TEXT,
      material_code TEXT,
      qty NUMERIC NOT NULL,
      unit TEXT NOT NULL
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS production_plan (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      shop TEXT,
      start_time TIME,
      end_time TIME,
      product_code TEXT,
      qty NUMERIC NOT NULL DEFAULT 0,
      note TEXT
    );
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_bom_product  ON bom(product_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_bom_material ON bom(material_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_plan_day     ON production_plan(day);`);

  await q('COMMIT');
}

/* ============== Units & Conversion ============== */
const U = {
  g: { base: 'g', factor: 1 }, kg: { base: 'g', factor: 1000 },
  ml:{ base: 'ml',factor: 1 }, l:  { base: 'ml',factor: 1000 },
  pcs:{base:'pcs',factor:1}, piece:{base:'pcs',factor:1}, pieces:{base:'pcs',factor:1},
  stk:{base:'pcs',factor:1}, 'stück':{base:'pcs',factor:1},
};
const normalizeUnit = (u) => {
  const k = String(u || '').trim().toLowerCase();
  return U[k]?.base || (k || null);
};
function toBase(qty, unit) {
  const m = U[String(unit || '').toLowerCase()];
  return m ? { qty: Number(qty) * m.factor, unit: m.base } : { qty: Number(qty), unit };
}
function packToBaseQty(pack_qty, pack_unit, base_unit) {
  if (pack_qty == null || !pack_unit) return null;
  const pu = String(pack_unit).toLowerCase().trim();
  const m = U[pu]; if (!m) return null;
  const bu = normalizeUnit(base_unit || 'g');
  if (m.base !== bu) return null;
  return Number(pack_qty) * m.factor;
}
function calcPPUFromPack({ pack_qty, pack_unit, pack_price, base_unit }) {
  if (pack_price == null) return null;
  const baseQty = packToBaseQty(pack_qty, pack_unit, base_unit);
  if (!baseQty || baseQty <= 0) return null;
  return Number(pack_price) / Number(baseQty);
}

/* expose units map for UI */
app.get('/api/units', requireAuth, (_req, res) => {
  res.json({
    ok: true,
    data: {
      families: { g: 'g/kg', ml: 'ml/l', pcs: 'pieces' },
      units: Object.entries(U).map(([unit, v]) => ({ unit, base: v.base, factor: v.factor })),
    },
  });
});

/* ============== Auth ============== */
app.get('/api/session', (req, res) =>
  res.json({ ok: true, user: authed(req) ? req.session.user : null })
);
app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim();
  const pass  = String(req.body?.password || '').trim();
  if (ADMIN_EMAIL && ADMIN_PASSWORD && eqi(email, ADMIN_EMAIL) && pass === ADMIN_PASSWORD) {
    req.session.user = { email: ADMIN_EMAIL, role: 'admin' };
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'bad_credentials' });
});
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

/* ============== Materials (Rohwaren) ============== */
// list
app.get('/api/materials', requireAuth, async (_req, res) => {
  const { rows } = await q(
    `SELECT code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note
     FROM materials ORDER BY name`
  );
  res.json({ ok: true, data: rows });
});
// get one
app.get('/api/materials/:code', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT * FROM materials WHERE code=$1`, [req.params.code]);
  if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, data: rows[0] });
});
// search (autocomplete)
app.get('/api/materials/search', requireAuth, async (req, res) => {
  const qstr = String(req.query.q || '').trim();
  if (!qstr) return res.json({ ok: true, data: [] });
  const like = `%${qstr.replace(/[%_]/g, m => '\\' + m)}%`;
  const { rows } = await q(
    `SELECT code,name,base_unit,price_per_unit
     FROM materials WHERE code ILIKE $1 OR name ILIKE $1
     ORDER BY name LIMIT 50`, [like]
  );
  res.json({ ok: true, data: rows });
});
// price history
app.get('/api/materials/:code/history', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT price_per_unit, changed_at
     FROM material_price_history
     WHERE material_code=$1
     ORDER BY changed_at DESC`, [req.params.code]
  );
  res.json({ ok: true, data: rows });
});
// upsert
app.post('/api/materials', requireAuth, async (req, res) => {
  const {
    code, name, base_unit='g',
    pack_qty=null, pack_unit=null, pack_price=null,
    price_per_unit=null,
    supplier_code=null, note=''
  } = req.body || {};
  if (!code || !name) return res.status(400).json({ ok: false, error: 'code_name_required' });

  const bu = normalizeUnit(base_unit || 'g');
  let ppu = (price_per_unit == null || price_per_unit === '')
    ? calcPPUFromPack({ pack_qty, pack_unit, pack_price, base_unit: bu })
    : Number(price_per_unit);
  if (ppu == null) ppu = 0;

  const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [code]);
  if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== Number(ppu)) {
    await q(`INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`, [code, ppu]);
  }

  await q(
    `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name, base_unit=EXCLUDED.base_unit,
       pack_qty=EXCLUDED.pack_qty, pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
       price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
    [code, name, bu, pack_qty ?? null, pack_unit ?? null, pack_price ?? null, ppu, supplier_code || null, note || '']
  );
  res.json({ ok: true });
});
// delete (blocked if used)
app.delete('/api/materials/:code', requireAuth, async (req, res) => {
  const used = await q(`SELECT 1 FROM bom WHERE material_code=$1 LIMIT 1`, [req.params.code]);
  if (used.rowCount) return res.status(400).json({ ok: false, error: 'in_use_in_bom' });
  const r = await q(`DELETE FROM materials WHERE code=$1`, [req.params.code]);
  res.json({ ok: true, deleted: r.rowCount });
});
// bulk prices
app.post('/api/materials/bulk-prices', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '');
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
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

/* ============== Items & BOM ============== */
// items list
app.get('/api/items', requireAuth, async (_req, res) => {
  const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit,note FROM items ORDER BY name`);
  res.json({ ok: true, data: rows });
});
// upsert item
app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category='', yield_qty=1, yield_unit='pcs', note='' } = req.body || {};
  if (!code || !name) return res.status(400).json({ ok: false, error: 'code_name_required' });
  await q(
    `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name, category=EXCLUDED.category,
       yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
    [code, name, category, Number(yield_qty||1), yield_unit||'pcs', note]
  );
  res.json({ ok: true });
});
// delete item (+ its BOM)
app.delete('/api/items/:code', requireAuth, async (req, res) => {
  await q(`DELETE FROM bom WHERE product_code=$1`, [req.params.code]);
  const r = await q(`DELETE FROM items WHERE code=$1`, [req.params.code]);
  res.json({ ok: true, deleted: r.rowCount });
});
// get BOM
app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT b.id, b.material_code, m.name AS material_name, b.qty, b.unit
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1 ORDER BY b.id`, [req.params.code]
  );
  res.json({ ok: true, data: rows });
});
// replace BOM (validates materials)
app.post('/api/items/:code/bom', requireAuth, async (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  await q('BEGIN');
  await q(`DELETE FROM bom WHERE product_code=$1`, [req.params.code]);
  for (const L of lines) {
    const m = await q(`SELECT 1 FROM materials WHERE code=$1`, [L.material_code]);
    if (!m.rowCount) { await q('ROLLBACK'); return res.status(400).json({ ok: false, error: `material_not_found:${L.material_code}` }); }
    await q(
      `INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
      [req.params.code, L.material_code, Number(L.qty), normalizeUnit(L.unit || 'g')]
    );
  }
  await q('COMMIT');
  res.json({ ok: true });
});

/* ============== Costing ============== */
// single ingredient live cost
app.post('/api/calc/line', requireAuth, async (req, res) => {
  const { material_code, qty, unit } = req.body || {};
  if (!material_code || !qty) return res.status(400).json({ ok: false, error: 'bad_request' });
  const m = await q(`SELECT price_per_unit, name FROM materials WHERE code=$1`, [material_code]);
  if (!m.rowCount) return res.status(404).json({ ok: false, error: 'material_not_found' });
  const base = toBase(qty, unit || 'g');
  const cost = Number(base.qty) * Number(m.rows[0].price_per_unit || 0);
  res.json({ ok: true, data: {
    material_code,
    material_name: m.rows[0].name,
    unit: base.unit,
    qty: Number(base.qty.toFixed(2)),
    price_per_unit: Number((m.rows[0].price_per_unit || 0).toFixed(6)),
    cost: Number(cost.toFixed(2)),
  }});
});
async function scaleRecipe(productCode, targetQty) {
  const it = await q(`SELECT yield_qty FROM items WHERE code=$1`, [productCode]);
  if (!it.rowCount) throw new Error('item_not_found');
  const factor = Number(targetQty) / Number(it.rows[0].yield_qty || 1);
  const rows = (await q(
    `SELECT b.material_code, b.qty, b.unit, m.price_per_unit, m.name AS material_name
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1 ORDER BY b.id`, [productCode]
  )).rows;
  const out = rows.map(r => {
    const base0 = toBase(r.qty, r.unit);
    const scaled = base0.qty * factor;
    const cost = scaled * Number(r.price_per_unit || 0);
    return {
      material_code: r.material_code,
      material_name: r.material_name,
      unit: base0.unit,
      qty: Number(scaled.toFixed(2)),
      price_per_unit: Number((r.price_per_unit || 0).toFixed(6)),
      cost: Number(cost.toFixed(2)),
    };
  });
  const total = out.reduce((s, x) => s + x.cost, 0);
  return { lines: out, total_cost: Number(total.toFixed(2)) };
}
// priced BOM for item at target qty
app.get('/api/items/:code/bom/priced', requireAuth, async (req, res) => {
  const qty = Number(req.query.qty || 0);
  if (!qty) return res.status(400).json({ ok: false, error: 'qty_required' });
  try { const r = await scaleRecipe(req.params.code, qty); res.json({ ok: true, data: r }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ============== Plan (day/week) ============== */
function monday(d) { const dt=new Date(d); const day=(dt.getDay()+6)%7; dt.setDate(dt.getDate()-day); dt.setHours(0,0,0,0); return dt; }
function fmtDate(dt){ return dt.toISOString().slice(0,10); }
function plusDays(dt,n){ const x=new Date(dt); x.setDate(x.getDate()+n); return x; }

app.get('/api/plan/day', requireAuth, async (req, res) => {
  const date = req.query.date;
  if (!date) return res.json({ ok: true, data: [] });
  const { rows } = await q(
    `SELECT id,day,shop,start_time,end_time,product_code,qty,note
     FROM production_plan WHERE day=$1
     ORDER BY start_time NULLS FIRST, id`, [date]
  );
  res.json({ ok: true, data: rows });
});
app.post('/api/plan/day/save', requireAuth, async (req, res) => {
  const { date, rows } = req.body || {};
  if (!date || !Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'bad_request' });
  await q('BEGIN');
  await q(`DELETE FROM production_plan WHERE day=$1`, [date]);
  for (const r of rows) {
    await q(
      `INSERT INTO production_plan(day,shop,start_time,end_time,product_code,qty,note)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [date, r.shop ?? null, r.start_time ?? null, r.end_time ?? null, r.product_code, Number(r.qty || 0), r.note || '']
    );
  }
  await q('COMMIT'); res.json({ ok: true });
});
app.delete('/api/plan/:id', requireAuth, async (req, res) => {
  const r = await q(`DELETE FROM production_plan WHERE id=$1`, [req.params.id]);
  res.json({ ok: true, deleted: r.rowCount });
});
app.get('/api/plan/week', requireAuth, async (req, res) => {
  const start = req.query.start || fmtDate(monday(new Date()));
  const end = fmtDate(plusDays(new Date(start), 7));
  const { rows } = await q(
    `SELECT id,day,shop,start_time,end_time,product_code,qty,note
     FROM production_plan WHERE day >= $1 AND day < $2
     ORDER BY day, start_time NULLS FIRST, id`, [start, end]
  );
  res.json({ ok: true, data: rows });
});
app.post('/api/plan/week/save', requireAuth, async (req, res) => {
  const { start, rows } = req.body || {};
  if (!start || !Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'bad_request' });
  const end = fmtDate(plusDays(new Date(start), 7));
  await q('BEGIN');
  await q(`DELETE FROM production_plan WHERE day >= $1 AND day < $2`, [start, end]);
  for (const r of rows) {
    await q(
      `INSERT INTO production_plan(day,shop,start_time,end_time,product_code,qty,note)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [r.day, r.shop ?? null, r.start_time ?? null, r.end_time ?? null, r.product_code, Number(r.qty || 0), r.note || '']
    );
  }
  await q('COMMIT'); res.json({ ok: true, inserted: rows.length });
});
// aggregate usage & cost (custom rows OR date OR week_start)
app.post('/api/plan/calc', requireAuth, async (req, res) => {
  let list = req.body?.rows;

  if ((!list || !Array.isArray(list)) && req.body?.date) {
    const { rows } = await q(`SELECT product_code, qty FROM production_plan WHERE day=$1`, [req.body.date]);
    list = rows.map(r => ({ product_code: r.product_code, qty: Number(r.qty) }));
  }
  if ((!list || !Array.isArray(list)) && req.body?.week_start) {
    const s = req.body.week_start;
    const e = fmtDate(plusDays(new Date(s), 7));
    const { rows } = await q(`SELECT product_code, qty FROM production_plan WHERE day >= $1 AND day < $2`, [s, e]);
    list = rows.map(r => ({ product_code: r.product_code, qty: Number(r.qty) }));
  }
  if (!Array.isArray(list) || list.length === 0)
    return res.json({ ok: true, data: { lines: [], total_cost: 0 } });

  const need = new Map(); let totalCost = 0;
  for (const r of list) {
    const one = await scaleRecipe(r.product_code, Number(r.qty || 0));
    for (const l of one.lines) {
      const key = `${l.material_code}|${l.unit}`;
      const cur = need.get(key) || { ...l, qty: 0, cost: 0 };
      cur.qty += l.qty; cur.cost += l.cost; need.set(key, cur);
    }
    totalCost += one.total_cost;
  }
  const arr = Array.from(need.values()).map(x => ({
    material_code: x.material_code,
    material_name: x.material_name,
    unit: x.unit,
    qty: Number(x.qty.toFixed(2)),
    price_per_unit: Number(x.price_per_unit.toFixed(6)),
    cost: Number(x.cost.toFixed(2)),
  })).sort((a,b)=>a.material_name.localeCompare(b.material_name));

  res.json({ ok: true, data: { lines: arr, total_cost: Number(totalCost.toFixed(2)) } });
});

/* ============== Tools: Export / Backup / Restore ============== */
function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}
app.get('/api/tools/export/:dataset', requireAuth, async (req, res) => {
  const ds = req.params.dataset;
  const fmt = (req.query.format || 'json').toLowerCase();
  let rows = [];
  if (ds === 'materials') rows = (await q(`SELECT * FROM materials ORDER BY name`)).rows;
  else if (ds === 'items') rows = (await q(`SELECT * FROM items ORDER BY name`)).rows;
  else if (ds === 'bom') rows = (await q(`SELECT product_code,material_code,qty,unit FROM bom ORDER BY product_code,id`)).rows;
  else if (ds === 'plan') {
    const start = req.query.start || fmtDate(monday(new Date()));
    const end = fmtDate(plusDays(new Date(start), 7));
    rows = (await q(`SELECT * FROM production_plan WHERE day >= $1 AND day < $2 ORDER BY day,id`, [start, end])).rows;
  } else return res.status(400).json({ ok: false, error: 'unknown_dataset' });

  if (fmt === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${ds}.json"`);
    return res.json(rows);
  }
  if (fmt === 'csv' || fmt === 'xlsx') {
    const csv = toCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${ds}.csv"`);
    return res.send(csv);
  }
  res.status(400).json({ ok: false, error: 'unsupported_format' });
});
app.get('/api/tools/backup', requireAuth, async (_req, res) => {
  const materials = (await q(`SELECT * FROM materials ORDER BY code`)).rows;
  const items     = (await q(`SELECT * FROM items ORDER BY code`)).rows;
  const bom       = (await q(`SELECT product_code,material_code,qty,unit FROM bom ORDER BY product_code,id`)).rows;
  const plan      = (await q(`SELECT * FROM production_plan ORDER BY day,id`)).rows;
  res.setHeader('Content-Disposition', 'attachment; filename="bakeflow-backup.json"');
  res.json({ materials, items, bom, plan });
});
app.post('/api/tools/backup/restore', requireAuth, async (req, res) => {
  const { materials=[], items=[], bom=[], plan=[] } = req.body || {};
  await q('BEGIN');
  try {
    await q('DELETE FROM bom');
    await q('DELETE FROM production_plan');
    await q('DELETE FROM items');
    await q('DELETE FROM materials');
    for (const m of materials) {
      await q(
        `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.code, m.name, normalizeUnit(m.base_unit||'g'), m.pack_qty??null, m.pack_unit??null, m.pack_price??null,
         Number(m.price_per_unit||0), m.supplier_code||null, m.note||'']
      );
    }
    for (const it of items) {
      await q(
        `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [it.code, it.name, it.category||'', Number(it.yield_qty||1), it.yield_unit||'pcs', it.note||'']
      );
    }
    for (const b of bom) {
      await q(
        `INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
        [b.product_code, b.material_code, Number(b.qty), normalizeUnit(b.unit||'g')]
      );
    }
    for (const p of plan) {
      await q(
        `INSERT INTO production_plan(day,shop,start_time,end_time,product_code,qty,note)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [p.day||p.date, p.shop??null, p.start_time??null, p.end_time??null, p.product_code,
         Number(p.qty||p.planned_qty||0), p.note||'']
      );
    }
    await q('COMMIT'); res.json({ ok: true });
  } catch (e) {
    await q('ROLLBACK'); res.status(400).json({ ok: false, error: e.message });
  }
});

/* ============== Generic Import ============== */
// Accepts JSON arrays (Content-Type: application/json)
// POST /api/import/materials  body: [{...},...]
// POST /api/import/items      body: [{...},...]
// POST /api/import/bom        body: [{product_code, ingredients:[{material_code,qty,unit}]}, ...] OR long-form rows
// POST /api/import/plan       body: [{date|day, shop?, start_time?, end_time?, product_code, qty, note?}, ...]
app.post('/api/import/:dataset', requireAuth, async (req, res) => {
  const ds = req.params.dataset;
  const rows = Array.isArray(req.body) ? req.body : [];
  if (!rows.length) return res.status(400).json({ ok: false, error: 'empty_payload' });
  await q('BEGIN');
  try {
    if (ds === 'materials') {
      for (const m of rows) {
        const bu = normalizeUnit(m.base_unit || 'g');
        let ppu = (m.price_per_unit == null || m.price_per_unit === '')
          ? calcPPUFromPack({ pack_qty:m.pack_qty, pack_unit:m.pack_unit, pack_price:m.pack_price, base_unit:bu })
          : Number(m.price_per_unit);
        if (ppu == null) ppu = 0;
        const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [m.code]);
        if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== Number(ppu)) {
          await q(`INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`, [m.code, ppu]);
        }
        await q(
          `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (code) DO UPDATE SET
             name=EXCLUDED.name, base_unit=EXCLUDED.base_unit,
             pack_qty=EXCLUDED.pack_qty, pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
             price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
          [m.code, m.name, bu, m.pack_qty ?? null, m.pack_unit ?? null, m.pack_price ?? null, ppu, m.supplier_code || null, m.note || '']
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
          [it.code, it.name, it.category || '', Number(it.yield_qty || 1), it.yield_unit || 'pcs', it.note || '']
        );
      }
    } else if (ds === 'bom') {
      // supports grouped or long-form
      const grouped = new Map();
      for (const r of rows) {
        if (r.ingredients) grouped.set(r.product_code, r.ingredients);
        else {
          const arr = grouped.get(r.product_code) || [];
          arr.push({ material_code: r.material_code, qty: Number(r.qty), unit: r.unit || 'g' });
          grouped.set(r.product_code, arr);
        }
      }
      for (const [product_code, ings] of grouped.entries()) {
        await q(`DELETE FROM bom WHERE product_code=$1`, [product_code]);
        for (const ing of ings) {
          const exists = await q(`SELECT 1 FROM materials WHERE code=$1`, [ing.material_code]);
          if (!exists.rowCount) throw new Error(`material_not_found:${ing.material_code}`);
          await q(
            `INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
            [product_code, ing.material_code, Number(ing.qty), normalizeUnit(ing.unit || 'g')]
          );
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
      throw new Error('unknown_dataset');
    }
    await q('COMMIT');
    res.json({ ok: true, inserted: rows.length });
  } catch (e) {
    await q('ROLLBACK');
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ============== Users ============== */
app.get('/api/users', requireAuth, async (_req, res) => {
  const { rows } = await q(`SELECT email, role FROM users ORDER BY email`);
  res.json({ ok: true, data: rows });
});
app.post('/api/users', requireAuth, async (req, res) => {
  const { email, role='viewer', password='' } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'email_required' });
  await q(
    `INSERT INTO users(email, role, password) VALUES($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET role=EXCLUDED.role, password=EXCLUDED.password`,
    [email.trim(), role, password]
  );
  res.json({ ok: true });
});
app.delete('/api/users/:email', requireAuth, async (req, res) => {
  await q(`DELETE FROM users WHERE email=$1`, [req.params.email]);
  res.json({ ok: true });
});

/* ============== Root & 404 ============== */
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.use((_req, res) => res.status(404).send('Not found'));

/* ============== Boot ============== */
(async () => {
  console.log('Starting Bakeflow…');
  console.log('DB URL:', !!DATABASE_URL, 'Admin email set:', !!ADMIN_EMAIL);
  await ensureSchema();
  app.listen(PORT, () => console.log(`Listening on :${PORT}`));
})();
