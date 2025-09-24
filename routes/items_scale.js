// routes/items_scale.js
const express = require('express');
const router = express.Router();

const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');

// We assume a db helper that exposes db.query(sql, params)
const db = require('../db');

router.use(ensureAuthenticated, ensureAdmin);

/**
 * GET /items/:code/scale
 * Small page to scale the BOM of a recipe to a new yield.
 */
router.get('/items/:code/scale', async (req, res) => {
  const code = req.params.code;
  const { rows } = await db.query(
    `SELECT code, name, category, yield_qty, yield_unit
       FROM items
      WHERE code = $1`,
    [code]
  );
  const item = rows[0];
  if (!item) {
    setFlash(req, 'error', `Rezept nicht gefunden: ${code}`);
    return res.redirect('/items');
  }
  res.render('items/scale', { title: `Yield skalieren – ${item.name}`, item });
});

/**
 * POST /items/:code/scale
 * Persistently scales all BOM rows by factor = new_yield / old_yield,
 * and updates the recipe's yield to the new value.
 */
router.post('/items/:code/scale', async (req, res) => {
  const code = req.params.code;
  const newYield = Number(req.body.new_yield);

  if (!Number.isFinite(newYield) || newYield <= 0) {
    setFlash(req, 'error', 'Bitte eine gültige Ziel-Yield angeben.');
    return res.redirect(`/items/${encodeURIComponent(code)}/scale`);
  }

  const client = db; // uses same interface as db.query

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT yield_qty::numeric AS yield_qty
         FROM items
        WHERE code = $1
        FOR UPDATE`,
      [code]
    );
    const item = rows[0];
    if (!item) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', `Rezept nicht gefunden: ${code}`);
      return res.redirect('/items');
    }

    const oldYield = Number(item.yield_qty);
    if (!Number.isFinite(oldYield) || oldYield <= 0) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', 'Aktueller Yield ist ungültig oder 0. Bitte zuerst korrekt setzen.');
      return res.redirect(`/items/${encodeURIComponent(code)}/scale`);
    }

    const factor = newYield / oldYield;

    // Scale all BOM qty with 3-decimal rounding (good for g/ml). pcs will also round to 3 decimals (no harm).
    await client.query(
      `UPDATE bom
          SET qty = ROUND( (qty::numeric * $2::numeric), 3 )
        WHERE item_code = $1`,
      [code, factor]
    );

    await client.query(
      `UPDATE items
          SET yield_qty = $2
        WHERE code = $1`,
      [code, newYield]
    );

    await client.query('COMMIT');
    setFlash(req, 'ok', `BOM skaliert. Neuer Yield: ${newYield} (Faktor ${factor.toFixed(4)})`);
    return res.redirect(`/items/${encodeURIComponent(code)}/edit`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Scale BOM error', err);
    setFlash(req, 'error', `Fehler beim Skalieren: ${err.message}`);
    return res.redirect(`/items/${encodeURIComponent(code)}/scale`);
  }
});

module.exports = router;
