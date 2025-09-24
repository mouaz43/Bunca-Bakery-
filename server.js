require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const morgan = require('morgan');
const db = require('./db');
const fs = require('fs');

const { attachFlash } = require('./middleware/flash');

// App
const app = express();
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

// Trust proxy for secure cookies on Render
if (isProd) app.set('trust proxy', 1);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Logger
app.use(morgan(isProd ? 'combined' : 'dev'));

// Sessions (stored in Postgres)
app.use(
  session({
    store: new pgSession({
      pool: db.pool,
      createTableIfMissing: true
    }),
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,         // secure cookies in production
      maxAge: 1000 * 60 * 60 * 8 // 8 hours
    }
  })
);

// Flash + user locals
app.use(attachFlash());

// Routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
app.use(authRoutes);
app.use(dashboardRoutes);

// Home redirect
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// 404
app.use((req, res) => {
  res.status(404).render('dashboard/placeholder', { title: '404', label: 'Seite nicht gefunden' });
});

// Boot: run migrations once on start (simple runner)
async function runMigrations() {
  const file = path.join(__dirname, 'db', 'migrations.sql');
  const sql = fs.readFileSync(file, 'utf8');
  // naive split on semicolons (ok for our simple DDL)
  const statements = sql
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    await db.query(stmt);
  }
  console.log('Migrations applied.');
}

app.listen(PORT, async () => {
  try {
    await runMigrations();
    console.log(`Server running on http://localhost:${PORT}`);
  } catch (e) {
    console.error('Migration error on startup:', e);
    process.exit(1);
  }
});
