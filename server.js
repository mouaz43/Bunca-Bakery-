// BUNCA Planner — Phase 4: Items & Recipes (BOM + Scale)

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

/* ---------- Units ---------- */
const U = {
  g: { base: 'g', factor: 1 }, kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 }, l: { base: 'ml', factor: 1000 },
  pcs: { base: 'pcs', factor: 1 }, piece: { base: 'pcs', factor: 1 },
  pieces: { base: 'pcs', factor: 1 }, stk: { base: 'pcs', factor: 1 },
  'stück': { base: 'pcs', factor: 1 }
};
function normalizeUnit(u) {
  const k = String(u || '').trim().toLowerCase();
  return U[k]?.base || (k || null);
}
function toBase(qty, unit) {
  const u = String(unit || '').toLowerCase();
  const m = U[u];
  return m ? { qty: Number(qty) * m.factor, unit: m.base } : { qty: Number(qty), unit };
}

/* ---------- Health ---------- */
app.get('/healthz', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

/* ---------- Schema ---------- */
async function ensureSchema() {
  try {
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

    await q('COMMIT');
    console.log('[schema] ensured');
  } catch (e) {
    console.error('[schema] failed:', e.message);
    await q('ROLLBACK').catch(()=>{});
  }
}

/* ---------- Auth ---------- */
app.get('/api/session', (req, res) =>
  res.json({ ok: true, user: authed(req) ? req.session.user : null })
);

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim();
  const pass  = String(req.body?.password || '').trim();
  console.log('[login attempt]', {
    providedEmail: email,
    expectedEmail: ADMIN_EMAIL,
    envEmailSet: !!ADMIN_EMAIL,
    envPassSet: !!ADMIN_PASSWORD
  });
  if (ADMIN_EMAIL && ADMIN_PASSWORD && eqi(email, ADMIN_EMAIL) && pass === ADMIN_PASSWORD) {
    req.session.user = { email: ADMIN_EMAIL, role: 'admin' };
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'bad_credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid'); res.json({ ok: true });
  });
});

/* ---------- Import (kept from Phase 2 for materials) ---------- */
app.post('/api/import/:dataset', requireAuth, async (req, res) => {
  const ds = req.params.dataset;
  const rows = Array.isArray(req.body) ? req.body : [];
  try {
    await q('BEGIN');

    if (ds === 'materials') {
      for (const m of rows) {
        const code = m.code?.trim();
        if (!code) continue;
        const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [code]);
        const nextPPU = Number(m.price_per_unit ?? 0);
        if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== nextPPU) {
          await q(
            `INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`,
            [code, nextPPU]
          );
        }
        await q(
          `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (code) DO UPDATE SET
             name=EXCLUDED.name, base_unit=EXCLUDED.base_unit, pack_qty=EXCLUDED.pack_qty,
             pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
             price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code,
             note=EXCLUDED.note`,
          [
            code, m.name, normalizeUnit(m.base_unit || 'g'),
            m.pack_qty ?? null, m.pack_unit ?? null, m.pack_price ?? null,
            nextPPU, m.supplier_code ?? null, m.note ?? ''
          ]
        );
      }
    }

    await q('COMMIT');
    res.json({ ok: true, inserted: rows.length });
  } catch (e) {
    await q('ROLLBACK');
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ---------- MATERIALS ---------- */
app.get('/api/materials', requireAuth, async (_req, res) => {
  const { rows } = await q(`
    SELECT code, name, base_unit, price_per_unit, pack_qty, pack_unit, pack_price, supplier_code, note
    FROM materials
    ORDER BY name
  `);
  res.json({ ok: true, data: rows });
});

app.post('/api/materials', requireAuth, async (req, res) => {
  const {
    code, name, base_unit = 'g', price_per_unit = 0,
    pack_qty = null, pack_unit = null, pack_price = null,
    supplier_code = null, note = ''
  } = req.body || {};
  if (!code || !name) return res.status(400).json({ ok:false, error:'code_and_name_required' });

  const prev = await q(`SELECT price_per_unit FROM materials WHERE code=$1`, [code]);
  if (prev.rowCount && Number(prev.rows[0].price_per_unit) !== Number(price_per_unit)) {
    await q(
      `INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`,
      [code, Number(price_per_unit)]
    );
  }

  await q(
    `INSERT INTO materials(code,name,base_unit,pack_qty,pack_unit,pack_price,price_per_unit,supplier_code,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name, base_unit=EXCLUDED.base_unit, pack_qty=EXCLUDED.pack_qty,
       pack_unit=EXCLUDED.pack_unit, pack_price=EXCLUDED.pack_price,
       price_per_unit=EXCLUDED.price_per_unit, supplier_code=EXCLUDED.supplier_code,
       note=EXCLUDED.note`,
    [code, name, normalizeUnit(base_unit), pack_qty, pack_unit, pack_price, Number(price_per_unit), supplier_code, note]
  );
  res.json({ ok: true });
});

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
      await q(
        `INSERT INTO material_price_history(material_code, price_per_unit) VALUES($1,$2)`,
        [code, val]
      );
    }
    const r = await q(`UPDATE materials SET price_per_unit=$1 WHERE code=$2`, [val, code]);
    updated += r.rowCount;
  }
  res.json({ ok: true, updated });
});

app.get('/api/materials/:code/history', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT price_per_unit, changed_at
     FROM material_price_history
     WHERE material_code=$1
     ORDER BY changed_at DESC
     LIMIT 50`,
    [req.params.code]
  );
  res.json({ ok: true, data: rows });
});

/* ---------- ITEMS & BOM ---------- */
// Items list
app.get('/api/items', requireAuth, async (_req, res) => {
  const { rows } = await q(
    `SELECT code, name, category, yield_qty, yield_unit, note FROM items ORDER BY name`
  );
  res.json({ ok: true, data: rows });
});

// Upsert item
app.post('/api/items', requireAuth, async (req, res) => {
  const { code, name, category = '', yield_qty = 1, yield_unit = 'pcs', note = '' } =
    req.body || {};
  if (!code || !name) return res.status(400).json({ ok:false, error:'code_and_name_required' });
  await q(
    `INSERT INTO items(code,name,category,yield_qty,yield_unit,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name, category=EXCLUDED.category,
       yield_qty=EXCLUDED.yield_qty, yield_unit=EXCLUDED.yield_unit, note=EXCLUDED.note`,
    [code, name, category, Number(yield_qty || 1), yield_unit, note]
  );
  res.json({ ok: true });
});

// Get BOM for item
app.get('/api/items/:code/bom', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { rows } = await q(
    `
    SELECT b.id, b.material_code, m.name AS material_name, b.qty, b.unit
    FROM bom b
    JOIN materials m ON m.code=b.material_code
    WHERE b.product_code=$1
    ORDER BY b.id
  `, [code]);
  res.json({ ok: true, data: rows });
});

// Save BOM for item
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

// Scale & cost preview
app.get('/api/items/:code/scale', requireAuth, async (req, res) => {
  const code = req.params.code;
  const qty = Number(req.query.qty || 0);
  if (!qty) return res.status(400).json({ ok: false, error: 'qty_required' });

  // get item yield
  const it = await q(`SELECT yield_qty, yield_unit FROM items WHERE code=$1`, [code]);
  if (it.rowCount === 0) return res.status(404).json({ ok:false, error:'item_not_found' });
  const yieldQty = Number(it.rows[0].yield_qty) || 1;

  // get BOM
  const bom = await q(
    `SELECT b.material_code, b.qty, b.unit, m.price_per_unit, m.name AS material_name
     FROM bom b JOIN materials m ON m.code=b.material_code
     WHERE b.product_code=$1 ORDER BY b.id`, [code]);

  const factor = qty / yieldQty;
  const lines = [];
  for (const r of bom.rows) {
    const base0 = toBase(r.qty, r.unit);
    const scaledQty = base0.qty * factor; // in base unit
    const cost = scaledQty * Number(r.price_per_unit || 0);
    lines.push({
      material_code: r.material_code,
      material_name: r.material_name,
      unit: base0.unit,
      qty: Number(scaledQty.toFixed(2)),
      price_per_unit: Number((r.price_per_unit || 0).toFixed(6)),
      cost: Number(cost.toFixed(2))
    });
  }
  const total = lines.reduce((s,x)=>s+x.cost,0);
  res.json({ ok:true, data:{ lines, total_cost: Number(total.toFixed(2)) } });
});

/* ---------- Pages ---------- */
app.get('/', (req, res) => {
  if (authed(req)) return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* ---------- Boot ---------- */
(async () => {
  await ensureSchema();
  console.log('ENV check:', {
    NODE_ENV,
    hasDB: !!DATABASE_URL,
    hasAdminEmail: !!ADMIN_EMAIL,
    hasAdminPass: !!ADMIN_PASSWORD,
    hasSessionSecret: !!SESSION_SECRET
  });
  app.listen(PORT, () => console.log(`BUNCA running on :${PORT}`));
})();
