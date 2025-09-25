// src/server.js (only the relevant middlewares + routes section shown)
const express = require('express');
const session = require('express-session');
const path = require('path');

const { ensureAuthenticated } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');           // your existing file
const productsRoutes = require('./routes/products');     // “Rohwaren”
const itemsRoutes = require('./routes/items');           // “Artikel & Rezepte”
const importRoutes = require('./routes/import');         // Excel/CSV
const itemsScaleRoutes = require('./routes/items_scale');// previously added
const pricesImportRoutes = require('./routes/prices_import'); // previously added

const app = express();

// trust proxy for secure cookies on Render
app.set('trust proxy', 1);

// body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// sessions
app.use(session({
  name: 'sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// static
app.use('/public', express.static(path.join(__dirname, 'public')));

// Views already configured elsewhere (ejs etc.)

// HEALTH (no auth)
app.get('/healthz', (req, res) => res.send('ok'));

// AUTH routes (no guard)
app.use(authRoutes);

// PUBLIC landing -> redirect appropriately
app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  return res.redirect('/login');
});

// PROTECTED sections
app.use('/admin', ensureAuthenticated, adminRoutes);
app.use('/products', ensureAuthenticated, productsRoutes);
app.use('/items', ensureAuthenticated, itemsRoutes);
app.use('/import', ensureAuthenticated, importRoutes);
app.use(itemsScaleRoutes);          // these routes themselves check admin
app.use(pricesImportRoutes);        // these routes themselves check admin

// Dashboard (protected)
app.get('/dashboard', ensureAuthenticated, async (req, res) => {
  res.render('dashboard', { title: 'Dashboard' });
});

// 404
app.use((req, res) => res.status(404).render('404', { title: '404' }));

module.exports = app;
