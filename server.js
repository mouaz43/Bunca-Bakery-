// server.js — BUNCA Planner (DB-backed, manual import; NO file seeding)
//
// - Auth via env ADMIN_EMAIL / ADMIN_PASSWORD
// - Postgres schema migrations are idempotent
// - Import endpoints: /api/import/materials|items|bom|plan  (JSON arrays)
// - Materials/items/bom/plan CRUD & calculators
// - Static pages served from /public
// - Health check for Render

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

/* ---------- DB ---------- */
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

/* ---------- Express ---------- */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
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
      secure: NODE_ENV === 'production' ? 'auto' : false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Helpers ---------- */
const authed = (req) => !!(req.session && req.session.user);
const requireAuth = (req, res, next) =>
  authed(req) ? next() : res.status(401).json({ ok: false, error: 'unauthorized' });
const eqi = (a, b) =>
  String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/* ---------- HEALTH ---------- */
app.get('/healthz', async (_req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* ---------- SCHEMA ---------- */
async function ensureSchema() {
  await q('BEGIN');

  await q(`
    CREATE TABLE IF NOT EXISTS suppliers (
      code    TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      contact TEXT,
      phone   TEXT,
      email   TEXT,
      note    TEXT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS materials (
      code           TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      base_unit      TEXT NOT NULL DEFAULT 'g',
      price_per_unit NUMERIC NOT NULL DEFAULT 0,
      pack_qty       NUMERIC,
      pack_unit      TEXT,
      pack_price     NUMERIC,
      supplier_code  TEXT REFERENCES suppliers(code) ON DELETE SET NULL,
      note           TEXT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS items (
      code       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT,
      yield_qty  NUMERIC NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs',
      note       TEXT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS bom (
      id            SERIAL PRIMARY KEY,
      product_code  TEXT,
      material_code TEXT,
      qty           NUMERIC NOT NULL,
      unit          TEXT NOT NULL
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS production_plan (
      id           SERIAL PRIMARY KEY,
      day          DATE NOT NULL,
      start_time   TIME,
      end_time     TIME,
      product_code TEXT,
      qty          NUMERIC NOT NULL DEFAULT 0,
      note         TEXT
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS material_price_history (
      id             SERIAL PRIMARY KEY,
      material_code  TEXT NOT NULL,
      price_per_unit NUMERIC NOT NULL,
      changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // FKs (guarded)
  await q(`ALTER TABLE IF EXISTS bom DROP CONSTRAINT IF EXISTS bom_product_fk;`);
  await q(`ALTER TABLE IF EXISTS bom DROP CONSTRAINT IF EXISTS bom_material_fk;`);
  await q(`ALTER TABLE IF EXISTS production_plan DROP CONSTRAINT IF EXISTS plan_item_fk;`);

  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='bom_product_fk'
      ) THEN
        ALTER TABLE bom
          ADD CONSTRAINT bom_product_fk
          FOREIGN KEY (product_code) REFERENCES items(code) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='bom_material_fk'
      ) THEN
        ALTER TABLE bom
          ADD CONSTRAINT bom_material_fk
          FOREIGN KEY (material_code) REFERENCES materials(code) ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='plan_item_fk'
      ) THEN
        ALTER TABLE production_plan
          ADD CONSTRAINT plan_item_fk
          FOREIGN KEY (product_code) REFERENCES items(code) ON DELETE CASCADE;
      END IF;
    END$$;
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_bom_product ON bom(product_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_bom_material ON bom(material_code);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_plan_day  ON production_plan(day);`);

  await q('COMMIT');
  console.log('[schema] OK');
}

/* ---------- Units ---------- */
const U = {
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  l: { base: 'ml', factor: 1000 },
  pcs: { base: 'pcs', factor: 1 },
  piece: { base: 'pcs', factor: 1 },
  pieces: { base: 'pcs', factor: 1 },
  stk: { base: 'pcs', factor: 1 },
  stück: { base: 'pcs', factor: 1 },
};
function toBase(qty, unit) {
  const u = String(unit || '').toLowerCase();
  const m = U[u];
  return m ? { qty: Number(qty) * m.factor, unit: m.base } : { qty: Number(qty), unit };
}
function normalizeUnit(u) {
  const k = String(u || '').toLowerCase().trim();
  return U[k]?.base || (k || null);
}

/* ---------- Auth ---------- */
app.get('/api/session', (req, res) =>
  res.json({ ok: true, user: authed(req) ? req.session.user : null })
);

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim();
  const pass = String(req.body?.password || '').trim();
  const expEmail = String(ADMIN_EMAIL || '').trim();
  const expPass = String(ADMIN_PASSWORD || '').trim();

  if (expEmail && expPass && eqi(email, expEmail) && pass === expPass) {
    req.session.user = { email: expEmail, role: 'admin' };
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

/* ---------- IMPORT (manual, JSON arrays) ---------- */
// These are the new endpoints you’ll call from the importer UI.
app.post('/api/import/materials', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body?.materials || [];
    let up = 0;
    for (const m of list) {
      const base_unit = normalizeUnit(m.base_unit || m.unit || 'g');
      const price_per_unit = Number(m.price_per_unit ?? 0);
      const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [m.code]);
      if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== price_per_unit) {
        await q(
          `INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`,
          [m.code, price_per_unit]
        );
      }
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
        [
          m.code,
          m.name,
          base_unit,
          m.pack_qty ?? null,
          m.pack_unit ?? null,
          m.pack_price ?? null,
          price_per_unit,
          m.supplier_code || null,
          m.note || '',
        ]
      );
      up++;
    }
    res.json({ ok: true, upserted: up });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/import/items', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body?.items || [];
    let up = 0;
    for (const it of list) {
      await q(
        `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET
           name=EXCLUDED.name, category=EXCLUDED.category,
           yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
        [
          it.code,
          it.name,
          it.category || '',
          Number(it.yield_qty || 1),
          it.yield_unit || 'pcs',
          it.note || '',
        ]
      );
      up++;
    }
    res.json({ ok: true, upserted: up });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/import/bom', requireAuth, async (req, res) => {
  try {
    // Accept either long rows or grouped {product_code, ingredients:[...]}
    const body = Array.isArray(req.body) ? req.body : req.body?.bom || [];
    let replaced = 0,
      inserted = 0;

    const grouped = new Map();
    for (const row of body) {
      if (row.ingredients) {
        // already grouped shape
        grouped.set(row.product_code, row.ingredients);
      } else {
        // long-row shape
        const key = row.product_code;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push({
          material_code: row.material_code,
          qty: Number(row.qty),
          unit: normalizeUnit(row.unit || 'g'),
        });
      }
    }

    for (const [product_code, ingredients] of grouped.entries()) {
      await q(`DELETE FROM bom WHERE product_code=$1`, [product_code]);
      replaced++;
      for (const ing of ingredients || []) {
        await q(
          `INSERT INTO bom(product_code,material_code,qty,unit)
           VALUES($1,$2,$3,$4)`,
          [product_code, ing.material_code, Number(ing.qty), normalizeUnit(ing.unit || 'g')]
        );
        inserted++;
      }
    }
    res.json({ ok: true, replaced_products: replaced, inserted_rows: inserted });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/import/plan', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body?.plan || [];
    let ins = 0;
    for (const p of list) {
      await q(
        `INSERT INTO production_plan(day,start_time,end_time,product_code,qty,note)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          p.date || p.day, // accept both
          p.start_time || null,
          p.end_time || null,
          p.product_code,
          Number(p.planned_qty ?? p.qty ?? 0),
          p.note || '',
        ]
      );
      ins++;
    }
    res.json({ ok: true, inserted: ins });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ---------- READ APIs ---------- */
app.get('/api/materials', requireAuth, async (_req, res) => {
  const { rows } = await q(`
    SELECT m.code, m.name, m.base_unit, m.price_per_unit,
           m.pack_qty, m.pack_unit, m.pack_price,
           m.supplier_code, m.note, s.name AS supplier_name
    FROM materials m
    LEFT JOIN suppliers s ON s.code = m.supplier_code
    ORDER BY m.name
  `);
  res.json({ ok: true, data: rows });
});

app.post('/api/materials', requireAuth, async (req, res) => {
  const {
    code,
    name,
    base_unit = 'g',
    price_per_unit = 0,
    pack_qty = null,
    pack_unit = null,
    pack_price = null,
    supplier_code = null,
    note = '',
  } = req.body || {};

  const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [code]);
  if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== Number(price_per_unit)) {
    await q(
      `INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`,
      [code, price_per_unit]
    );
  }

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
    [code, name, base_unit, pack_qty, pack_unit, pack_price, price_per_unit, supplier_code, note]
  );
  res.json({ ok: true });
});

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
    [code, name, category, yield_qty, yield_unit, note]
  );
  res.json({ ok: true });
});

app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { rows } = await q(
    `
    SELECT b.id, b.material_code, m.name AS material_name, b.qty, b.unit
    FROM bom b
    JOIN materials m ON m.code=b.material_code
    WHERE b.product_code=$1
    ORDER BY b.id
  `,
    [code]
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

/* ---------- Plan ---------- */
app.get('/api/plan', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.json({ ok: true, data: [] });
  const { rows } = await q(
    `
    SELECT id, day, start_time, end_time, product_code, qty, note,
           (SELECT name FROM items i WHERE i.code=pp.product_code) AS product_name,
           (SELECT yield_qty FROM items i WHERE i.code=pp.product_code) AS yield_qty,
           (SELECT yield_unit FROM items i WHERE i.code=pp.product_code) AS yield_unit
    FROM production_plan pp
    WHERE day=$1
    ORDER BY start_time NULLS FIRST, id
  `,
    [date]
  );
  res.json({ ok: true, data: rows });
});

app.post('/api/plan/save', requireAuth, async (req, res) => {
  const { date, rows } = req.body || {};
  if (!date || !Array.isArray(rows))
    return res.status(400).json({ ok: false, error: 'bad_request' });
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
  try {
    console.log('Starting BUNCA…');
    console.log('Has DB URL:', !!DATABASE_URL, 'Admin email set:', !!ADMIN_EMAIL);
    await ensureSchema();
    app.listen(PORT, () => console.log(`Listening on :${PORT}`));
  } catch (e) {
    console.error('Startup error (fatal):', e);
    process.exit(1);
  }
})();
