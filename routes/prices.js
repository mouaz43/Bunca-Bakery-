// routes/prices.js
const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');

const router = express.Router();
router.use(ensureAuthenticated, ensureAdmin);

/**
 * GET /admin/prices — textarea to paste CODE,PRICE lines
 */
router.get('/admin/prices', async (req, res) => {
  res.render('admin/prices', { title: 'Bulk-Preise setzen' });
});

/**
 * POST /admin/prices — updates products.unit_cost
 * Accepts lines like:
 *   WEIZENMEHL,0.85
 *   ZUCKER 1,25
 *   ORANGENSAFT\t1.90
 */
router.post('/admin/prices', async (req, res) => {
  const text = String(req.body.text || '');
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  let ok = 0, bad = 0;
  for (const line of lines) {
    // split by comma, semicolon, tab or spaces
    const parts = line.split(/[,;\t ]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) { bad++; continue; }
    const code = parts[0].toUpperCase();
    const raw = parts.slice(1).join(' ');
    // allow decimal comma
    const price = Number(String(raw).replace(',', '.').replace(/[^0-9.\-]/g, ''));
    if (!code || !isFinite(price)) { bad++; continue; }
    try {
      const { rowCount } = await db.query('UPDATE products SET unit_cost=$1, updated_at=NOW() WHERE code=$2', [price, code]);
      if (rowCount) ok++; else bad++;
    } catch (e) {
      console.error('price update error:', e);
      bad++;
    }
  }

  setFlash(req, ok ? 'ok' : 'error', `Preise aktualisiert: ${ok} ok, ${bad} fehlerhaft.`);
  res.redirect('/admin/prices');
});

module.exports = router;
