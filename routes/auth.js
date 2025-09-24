const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { ensureGuest } = require('../middleware/auth');
const { setFlash } = require('../middleware/flash');

const router = express.Router();

router.get('/login', ensureGuest, (req, res) => {
  res.render('auth/login', { title: 'Login' });
});

router.post('/login', ensureGuest, async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    const password = req.body.password || '';
    if (!email || !password) {
      setFlash(req, 'error', 'Bitte E-Mail und Passwort eingeben.');
      return res.redirect('/login');
    }

    const { rows } = await db.query('SELECT id, email, password_hash, role, recipe_access FROM users WHERE email=$1', [email]);
    if (rows.length === 0) {
      setFlash(req, 'error', 'Benutzer nicht gefunden.');
      return res.redirect('/login');
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      setFlash(req, 'error', 'Falsches Passwort.');
      return res.redirect('/login');
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      recipe_access: user.recipe_access
    };
    res.redirect('/');
  } catch (e) {
    console.error('Login error', e);
    setFlash(req, 'error', 'Unerwarteter Fehler beim Login.');
    res.redirect('/login');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.redirect('/login');
  });
});

module.exports = router;
