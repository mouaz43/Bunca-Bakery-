// server.js — Bakeflow backend (fresh, UI-compatible)
// - Auth via ENV (ADMIN_EMAIL/ADMIN_PASSWORD)
// - Postgres schema + idempotent ensure
// - Materials, Items, BOM, Plan (week API), Calc
// - Materials bulk prices + price history
// - Tools: export (json/csv), backup, restore
// - Users admin (list/upsert/delete) for Tools page
// - Static /public
// - Health

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

/* ---------- DB ---------- */
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

/* ---------- Express ---------- */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
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
      pack_qty NUMERIC, pack_unit TEXT, pack_price NUMERIC,
      supplier_code TEXT, note TEXT
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
      start_time TIME, end_time TIME,
      product_code TEXT,
      qty NUMERIC NOT NULL DEFAULT 0,
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
  await q('COMMIT');
}

/* ---------- Units ---------- */
const U = {
  g: { base: 'g', factor: 1 }, kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 }, l: { base: 'ml', factor: 1000 },
  pcs: { base: 'pcs', factor: 1 }, piece: { base: 'pcs', factor: 1 },
  pieces: { base: 'pcs', factor: 1 }, stk: { base: 'pcs', factor: 1 },
  'stück': { base: 'pcs', factor: 1 },
};
const normalizeUnit = (u) => {
  const k = String(u || '').trim().toLowerCase();
  return U[k]?.base || (k || null);
};
function toBase(qty, unit) {
  const m = U[String(unit||'').toLowerCase()];
  return m ? { qty: Number(qty) * m.factor, unit: m.base } : { qty: Number(qty), unit };
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
  return res.status(401).json({ ok: false, error: 'bad_credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
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

app.get('/api/materials/:code/history', requireAuth, async (req, res) => {
  const code = req.params.code;
  const { rows } = await q(
    `SELECT price_per_unit, changed_at FROM material_price_history
     WHERE material_code=$1 ORDER BY changed_at DESC`, [code]
  );
  res.json({ ok: true, data: rows });
});

app.post('/api/materials', requireAuth, async (req, res) => {
  const {
    code, name, base_unit = 'g',
    pack_qty = null, pack_unit = null, pack_price = null,
    price_per_unit = 0, supplier_code = null, note = ''
  } = req.body || {};
  if (!code || !name) return res.status(400).json({ ok:false, error:'code_name_required' });

  const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [code]);
  if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== Number(price_per_unit)) {
    await q(`INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`, [code, price_per_unit]);
  }
  await q(
    `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name, base_unit=EXCLUDED.base_unit,
       pack_qty=EXCLUDED.pack_qty, pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
       price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code, note=EXCLUDED.note`,
    [code, name, normalizeUnit(base_unit || 'g'),
     pack_qty ?? null, pack_unit ?? null, pack_price ?? null,
     Number(price_per_unit || 0), supplier_code || null, note || '']
  );
  res.json({ ok: true });
});

// Bulk price paste: "CODE | 0.00123" per line
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

/* ---------- Items & BOM ---------- */
app.get('/api/items', requireAuth, async (_req, res) => {
  const { rows } = await q(`SELECT code,name,category,yield_qty,yield_unit,note FROM items ORDER BY name`);
  res.json({ ok: true, data: rows });
});

app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category = '', yield_qty = 1, yield_unit = 'pcs', note = '' } = req.body || {};
  if (!code || !name) return res.status(400).json({ ok:false, error:'code_name_required' });
  await q(
    `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name, category=EXCLUDED.category,
       yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
    [code, name, category, Number(yield_qty || 1), yield_unit || 'pcs', note]
  );
  res.json({ ok: true });
});

app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { rows } = await q(
    `SELECT b.id, b.material_code, m.name AS material_name, b.qty, b.unit
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1 ORDER BY b.id`, [code]
  );
  res.json({ ok: true, data: rows });
});

app.post('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  await q(`DELETE FROM bom WHERE product_code=$1`, [code]);
  for (const L of lines) {
    await q(
      `INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
      [code, L.material_code, Number(L.qty), normalizeUnit(L.unit || 'g')]
    );
  }
  res.json({ ok: true });
});

/* ---------- Calculator ---------- */
async function scaleRecipe(productCode, targetQty) {
  const it = await q(`SELECT yield_qty, yield_unit FROM items WHERE code=$1`, [productCode]);
  if (it.rowCount === 0) throw new Error('item_not_found');
  const yieldQty = Number(it.rows[0].yield_qty) || 1;
  const factor = Number(targetQty) / yieldQty;

  const lines = await q(
    `SELECT b.material_code, b.qty, b.unit, m.price_per_unit, m.name AS material_name
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1 ORDER BY b.id`, [productCode]
  );

  const out = [];
  for (const r of lines.rows) {
    const base0 = toBase(r.qty, r.unit);
    const baseScaled = { qty: base0.qty * factor, unit: base0.unit };
    const lineCost = Number(baseScaled.qty) * Number(r.price_per_unit || 0);
    out.push({
      material_code: r.material_code,
      material_name: r.material_name,
      unit: baseScaled.unit,
      qty: Number(baseScaled.qty.toFixed(2)),
      price_per_unit: Number((r.price_per_unit || 0).toFixed(6)),
      cost: Number(lineCost.toFixed(2)),
    });
  }
  const total = out.reduce((s, x) => s + x.cost, 0);
  return { lines: out, total_cost: Number(total.toFixed(2)) };
}

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

/* ---------- Plan (week-based) ---------- */
function monday(d) { const dt=new Date(d); const day=(dt.getDay()+6)%7; dt.setDate(dt.getDate()-day); dt.setHours(0,0,0,0); return dt; }
function fmtDate(dt){ return dt.toISOString().slice(0,10); }
function plusDays(dt, n){ const x=new Date(dt); x.setDate(x.getDate()+n); return x; }

app.get('/api/plan/week', requireAuth, async (req, res) => {
  const start = req.query.start || fmtDate(monday(new Date()));
  const startDt = new Date(start);
  const end = fmtDate(plusDays(startDt, 7)); // exclusive
  const { rows } = await q(
    `SELECT id, day, shop, start_time, end_time, product_code, qty, note
     FROM production_plan WHERE day >= $1 AND day < $2
     ORDER BY day, start_time NULLS FIRST, id`, [start, end]
  );
  res.json({ ok: true, data: rows });
});

app.post('/api/plan/week/save', requireAuth, async (req, res) => {
  const { start, rows } = req.body || {};
  if (!start || !Array.isArray(rows)) return res.status(400).json({ ok:false, error:'bad_request' });
  const startDt = new Date(start);
  const end = fmtDate(plusDays(startDt, 7)); // exclusive
  await q('BEGIN');
  await q(`DELETE FROM production_plan WHERE day >= $1 AND day < $2`, [start, end]);
  for (const r of rows) {
    await q(
      `INSERT INTO production_plan(day,shop,start_time,end_time,product_code,qty,note)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [r.day, r.shop ?? null, r.start_time ?? null, r.end_time ?? null,
       r.product_code, Number(r.qty || 0), r.note || '']
    );
  }
  await q('COMMIT');
  res.json({ ok: true, inserted: rows.length });
});

app.post('/api/plan/calc', requireAuth, async (req, res) => {
  let list = req.body?.rows;
  if ((!list || !Array.isArray(list)) && req.body?.date) {
    const { rows } = await q(`SELECT product_code, qty FROM production_plan WHERE day=$1`, [req.body.date]);
    list = rows.map(r => ({ product_code: r.product_code, qty: Number(r.qty) }));
  }
  if (!Array.isArray(list) || list.length === 0)
    return res.json({ ok: true, data: { lines: [], total_cost: 0 } });

  // aggregate
  const need = new Map();
  let totalCost = 0;
  for (const r of list) {
    const one = await scaleRecipe(r.product_code, Number(r.qty || 0));
    for (const l of one.lines) {
      const key = `${l.material_code}|${l.unit}`;
      const cur = need.get(key) || { ...l, qty: 0, cost: 0 };
      cur.qty += l.qty; cur.cost += l.cost;
      need.set(key, cur);
    }
    totalCost += one.total_cost;
  }
  const arr = Array.from(need.values())
    .map(x => ({ material_code: x.material_code, material_name: x.material_name,
                 unit: x.unit, qty: Number(x.qty.toFixed(2)),
                 price_per_unit: Number(x.price_per_unit.toFixed(6)),
                 cost: Number(x.cost.toFixed(2)) }))
    .sort((a,b)=> a.material_name.localeCompare(b.material_name));
  res.json({ ok: true, data: { lines: arr, total_cost: Number(totalCost.toFixed(2)) } });
});

/* ---------- Tools: export / backup / restore ---------- */
// CSV helper
function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}

app.get('/api/tools/export/:dataset', requireAuth, async (req, res) => {
  const ds = req.params.dataset;
  const fmt = (req.query.format || 'json').toLowerCase();
  let rows = [];
  if (ds === 'materials') {
    rows = (await q(`SELECT * FROM materials ORDER BY name`)).rows;
  } else if (ds === 'items') {
    rows = (await q(`SELECT * FROM items ORDER BY name`)).rows;
  } else if (ds === 'bom') {
    rows = (await q(`SELECT product_code, material_code, qty, unit FROM bom ORDER BY product_code, id`)).rows;
  } else if (ds === 'plan') {
    const start = req.query.start || fmtDate(monday(new Date()));
    const end = fmtDate(plusDays(new Date(start), 7));
    rows = (await q(`SELECT * FROM production_plan WHERE day >= $1 AND day < $2 ORDER BY day, id`, [start, end])).rows;
  } else {
    return res.status(400).json({ ok:false, error:'unknown_dataset' });
  }

  if (fmt === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${ds}.json"`);
    return res.json(rows);
  } else if (fmt === 'csv' || fmt === 'xlsx') { // "xlsx" falls back to CSV
    const csv = toCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${ds}.csv"`);
    return res.send(csv);
  } else {
    return res.status(400).json({ ok:false, error:'unsupported_format' });
  }
});

app.get('/api/tools/backup', requireAuth, async (_req, res) => {
  const materials = (await q(`SELECT * FROM materials ORDER BY code`)).rows;
  const items     = (await q(`SELECT * FROM items ORDER BY code`)).rows;
  const bom       = (await q(`SELECT product_code, material_code, qty, unit FROM bom ORDER BY product_code,id`)).rows;
  const plan      = (await q(`SELECT * FROM production_plan ORDER BY day,id`)).rows;
  res.setHeader('Content-Disposition', 'attachment; filename="bakeflow-backup.json"');
  res.json({ materials, items, bom, plan });
});

app.post('/api/tools/backup/restore', requireAuth, async (req, res) => {
  const { materials = [], items = [], bom = [], plan = [] } = req.body || {};
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
        [m.code, m.name, normalizeUnit(m.base_unit || 'g'), m.pack_qty ?? null, m.pack_unit ?? null,
         m.pack_price ?? null, Number(m.price_per_unit || 0), m.supplier_code || null, m.note || '']
      );
    }
    for (const it of items) {
      await q(
        `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [it.code, it.name, it.category || '', Number(it.yield_qty || 1), it.yield_unit || 'pcs', it.note || '']
      );
    }
    for (const b of bom) {
      await q(
        `INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
        [b.product_code, b.material_code, Number(b.qty), normalizeUnit(b.unit || 'g')]
      );
    }
    for (const p of plan) {
      await q(
        `INSERT INTO production_plan(day,shop,start_time,end_time,product_code,qty,note)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [p.day || p.date, p.shop ?? null, p.start_time ?? null, p.end_time ?? null,
         p.product_code, Number(p.qty || p.planned_qty || 0), p.note || '']
      );
    }
    await q('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await q('ROLLBACK');
    res.status(400).json({ ok:false, error: e.message });
  }
});

/* ---------- Users (Tools page) ---------- */
app.get('/api/users', requireAuth, async (_req, res) => {
  const { rows } = await q(`SELECT email, role FROM users ORDER BY email`);
  res.json({ ok: true, data: rows });
});

app.post('/api/users', requireAuth, async (req, res) => {
  // NOTE: This does not change login; login still uses ENV admin.
  const { email, role = 'viewer', password = '' } = req.body || {};
  if (!email) return res.status(400).json({ ok:false, error:'email_required' });
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

/* ---------- Root ---------- */
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* ---------- 404 ---------- */
app.use((req, res) => res.status(404).send('Not found'));

/* ---------- Boot ---------- */
(async () => {
  await ensureSchema();
  app.listen(PORT, () => console.log(`Bakeflow running on :${PORT}`));
})();
