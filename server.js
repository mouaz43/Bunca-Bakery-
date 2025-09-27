// Bunca Bakeryflow — Server
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ============= DB Connection ============= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/* ============= Middleware ============= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bakeryflow-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ============= Schema Setup ============= */
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const admin = await q(`SELECT id FROM users WHERE email='admin@bunca.bakery'`);
  if (admin.rows.length === 0) {
    const hash = await bcrypt.hash('demo123', 10);
    await q(
      `INSERT INTO users (email, password_hash, role) VALUES ('admin@bunca.bakery',$1,'admin')`,
      [hash]
    );
    console.log('Default admin created (admin@bunca.bakery / demo123)');
  }

  await q(`
    CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      base_unit TEXT NOT NULL,
      price_per_unit DECIMAL(10,4) DEFAULT 0,
      current_stock DECIMAL(10,3) DEFAULT 0,
      min_stock DECIMAL(10,3) DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      yield_qty DECIMAL(10,3) DEFAULT 1,
      yield_unit TEXT DEFAULT 'pcs',
      category TEXT DEFAULT 'bakery',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS bom (
      id SERIAL PRIMARY KEY,
      product_code TEXT NOT NULL,
      material_code TEXT NOT NULL,
      qty DECIMAL(10,4) NOT NULL,
      unit TEXT NOT NULL,
      waste_factor DECIMAL(5,4) DEFAULT 0.05
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS production_plan (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      product_code TEXT NOT NULL,
      qty DECIMAL(10,3) NOT NULL,
      status TEXT DEFAULT 'planned',
      shop TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

/* ============= Auth Middleware ============= */
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Authentication required' });
}

/* ============= Routes ============= */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await q(`SELECT * FROM users WHERE email=$1 AND active=true`, [email]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
  const user = result.rows[0];
  if (!(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });

  req.session.user = { id: user.id, email: user.email, role: user.role };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/session', (req, res) => {
  if (req.session.user) res.json({ user: req.session.user });
  else res.status(401).json({ error: 'Not authenticated' });
});

// Example: fetch all materials
app.get('/api/materials', requireAuth, async (_req, res) => {
  const r = await q(`SELECT * FROM materials WHERE active=true ORDER BY name`);
  res.json({ data: r.rows });
});

/* ============= Default Route ============= */
app.get('/', (_req, res) => res.redirect('/login.html'));

/* ============= Start Server ============= */
(async () => {
  await ensureSchema();
  app.listen(PORT, () => console.log(`✅ Bakeryflow running on port ${PORT}`));
})();
