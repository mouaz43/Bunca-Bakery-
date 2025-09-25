// server.js — BUNCA Planner (single-file server)
// Minimal Express + Postgres + Sessions + Static pages
// Fixes: login fails due to whitespace/case — now trims & normalizes

const express = require('express');
const path = require('path');
const compression = require('compression');
const session = require('express-session');
const { Pool } = require('pg');

const {
  PORT = 10000,
  NODE_ENV = 'production',
  DATABASE_URL = '',
  SESSION_SECRET = 'change-me-please',
  ADMIN_EMAIL = '',
  ADMIN_PASSWORD = '',
} = process.env;

const app = express();

// --------- DB ----------
const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false },
});
async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// --------- APP MIDDLEWARE ----------
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
  },
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// --------- AUTH HELPERS ----------
function authed(req) {
  return !!(req.session && req.session.user);
}
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// --------- SCHEMA ----------
async function ensureSchema() {
  // Keep the tables simple; expand as you go
  await q(`
    CREATE TABLE IF NOT EXISTS suppliers (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS products (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'g',
      price_per_unit NUMERIC NOT NULL DEFAULT 0
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS items (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Misc',
      yield_qty NUMERIC NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'pcs',
      notes TEXT
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS bom (
      item_code TEXT NOT NULL REFERENCES items(code) ON DELETE CASCADE,
      product_code TEXT NOT NULL REFERENCES products(code) ON DELETE RESTRICT,
      qty NUMERIC NOT NULL,
      unit TEXT NOT NULL DEFAULT 'g',
      PRIMARY KEY (item_code, product_code)
    );
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS production (
      id SERIAL PRIMARY KEY,
      item_code TEXT NOT NULL REFERENCES items(code) ON DELETE RESTRICT,
      planned_qty NUMERIC NOT NULL,
      planned_unit TEXT NOT NULL DEFAULT 'pcs',
      plan_date DATE NOT NULL DEFAULT CURRENT_DATE
    );
  `);
}

// --------- ROUTES (pages) ----------
app.get('/', (req, res) => {
  if (authed(req)) {
    return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => {
  if (authed(req)) return res.redirect('/');
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --------- AUTH API ----------
app.get('/api/session', (req, res) =>
  res.json({ ok: true, user: authed(req) ? req.session.user : null }));

app.post('/api/login', (req, res) => {
  // Normalize everything to avoid whitespace/case mismatches
  const rawEmail = String(req.body?.email ?? '');
  const rawPass  = String(req.body?.password ?? '');

  const candidateEmail = rawEmail.trim().toLowerCase();
  const candidatePass  = rawPass.trim();

  const expectedEmail = String(ADMIN_EMAIL || '').trim().toLowerCase();
  const expectedPass  = String(ADMIN_PASSWORD || '').trim();

  // Helpful logs for debugging (no password values)
  console.log('[login] attempt', {
    email: candidateEmail,
    expectedEmail,
    envEmailSet: !!expectedEmail,
    envPassSet: !!expectedPass
  });

  if (candidateEmail === expectedEmail && candidatePass === expectedPass) {
    req.session.user = { email: candidateEmail, role: 'admin' };
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

// --------- SIMPLE API EXAMPLES (keep endpoints stable) ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Example protected route you may already call from the UI:
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

// (Optional) Example: compute material needs for a planned production day
// Keeps parity with your earlier “sync” idea
app.get('/api/plan/usage', requireAuth, async (req, res) => {
  // sums usage = SUM((planned_qty / items.yield_qty) * bom.qty) per product
  try {
    const result = await q(`
      SELECT b.product_code,
             p.name AS product_name,
             p.unit AS product_unit,
             SUM( (pr.planned_qty / NULLIF(i.yield_qty, 0)) * b.qty ) AS total_qty
      FROM production pr
      JOIN items i ON i.code = pr.item_code
      JOIN bom b ON b.item_code = pr.item_code
      JOIN products p ON p.code = b.product_code
      GROUP BY b.product_code, p.name, p.unit
      ORDER BY b.product_code;
    `);
    res.json({ ok: true, rows: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'calc_failed' });
  }
});

// --------- 404 fallback for unknown routes (static) ----------
app.use((req, res) => {
  const file = path.join(__dirname, 'public', '404.html');
  res.status(404).sendFile(file);
});

// --------- STARTUP ----------
(async () => {
  try {
    console.log('Starting BUNCA server...');
    console.log('NODE_ENV:', NODE_ENV);
    console.log('Has DB URL:', !!DATABASE_URL);
    console.log('Has SESSION_SECRET:', !!SESSION_SECRET);
    console.log('Admin email set:', !!ADMIN_EMAIL);
    console.log('Admin pass set:', !!ADMIN_PASSWORD);

    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`Server listening on :${PORT}`);
    });
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
})();
