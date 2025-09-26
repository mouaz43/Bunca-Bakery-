// BUNCA Planner — Fresh Start (no seeding)
// - Postgres schema, sessions, auth
// - Health check
// - Static pages
// - Import API placeholders (we'll add full CRUD next step)

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
    httpOnly: true,
    sameSite: 'lax',
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

/* ---------- Schema (minimal to start) ---------- */
async function ensureSchema() {
  await q('BEGIN');
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      role  TEXT NOT NULL DEFAULT 'admin'
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
      product_code TEXT,
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

/* ---------- Import (Phase 1: basic JSON arrays) ---------- */
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
            m.code, m.name, m.base_unit || 'g',
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
      // accept either grouped or long rows
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
          await q(
            `INSERT INTO bom(product_code,material_code,qty,unit) VALUES($1,$2,$3,$4)`,
            [product_code, ing.material_code, Number(ing.qty), ing.unit || 'g']
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
      return res.status(400).json({ ok: false, error: 'unknown_dataset' });
    }
    await q('COMMIT');
    res.json({ ok: true, inserted: rows.length });
  } catch (e) {
    await q('ROLLBACK');
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ---------- Page routing ---------- */
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* ---------- Boot ---------- */
(async () => {
  await ensureSchema();
  app.listen(PORT, () => console.log(`BUNCA running on :${PORT}`));
})();
