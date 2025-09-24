require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const morgan = require('morgan');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const expressLayouts = require('express-ejs-layouts');

const db = require('./db');
const { attachFlash } = require('./middleware/flash');

const app = express();
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

if (isProd) app.set('trust proxy', 1);

// Views + Layouts
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/base');

// Static
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Parsers & Logs
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan(isProd ? 'combined' : 'dev'));

// Sessions
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
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

// Flash + user
app.use(attachFlash());

// Routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const devtoolsRoutes = require('./routes/devtools'); // NEW

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(devtoolsRoutes); // mounted always; endpoint itself checks DEV_TOKEN

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// 404
app.use((req, res) => {
  res.status(404).render('dashboard/placeholder', { title: '404', label: 'Seite nicht gefunden' });
});

// Migrations on boot
async function runMigrations() {
  const file = path.join(__dirname, 'db', 'migrations.sql');
  const sql = fs.readFileSync(file, 'utf8');
  const statements = sql
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db.query(stmt);
  }
  console.log('✅ Migrations applied.');
}

app.listen(PORT, async () => {
  try {
    await runMigrations();
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  } catch (e) {
    console.error('❌ Migration error on startup:', e);
    process.exit(1);
  }
});
