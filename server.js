// BUNCA Planner — Fresh Start (Login Debug Enabled)

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
  try {
    await q('BEGIN');
    await q(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        role  TEXT NOT NULL DEFAULT 'admin'
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

  // Debug log
  console.log('[login attempt]', {
    providedEmail: email,
    providedPass: pass,
    expectedEmail: ADMIN_EMAIL,
    expectedPass: ADMIN_PASSWORD,
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

/* ---------- Import placeholder ---------- */
app.post('/api/import/:dataset', requireAuth, async (req, res) => {
  res.json({ ok: true, dataset: req.params.dataset, rows: req.body?.length || 0 });
});

/* ---------- Page routing ---------- */
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
