// src/routes/auth.js
const express = require('express');
const router = express.Router();
const { ensureGuest } = require('../middleware/auth');
const { setFlash } = require('../middleware/flash');

// Simple env-based admin; you can later swap to DB users.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bunca.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

router.get('/login', ensureGuest, (req, res) => {
  res.render('auth/login', {
    title: 'Login',
    next: req.query.next || ''
  });
});

router.post('/login', async (req, res) => {
  try {
    const { email, password, next } = req.body;
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      req.session.user = { id: ADMIN_EMAIL, role: 'admin', name: 'Admin' };
      return res.redirect(next || '/dashboard');
    }
    setFlash(req, 'error', 'Falsche Zugangsdaten.');
    return res.redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  } catch (err) {
    console.error('Login error', err);
    setFlash(req, 'error', 'Login fehlgeschlagen.');
    return res.redirect('/login');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;
