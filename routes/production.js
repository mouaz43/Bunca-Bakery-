// routes/production.js
const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { setFlash } = require('../middleware/flash');

const router = express.Router();

// simple unit conversion map -> base units
const FACTOR = {
  'kg->g': 1000, 'g->g': 1,
  'l->ml': 1000, 'ml->ml': 1,
  'pcs->pcs': 1,
};
function factor(from, to) {
  const key = `${from}->${to}`;
  return FACTOR[key] ?? null; // if null, cannot convert
}

// GET /production?date=YYYY-MM-DD
router.get('/production', ensureAuthenticated, async (req, res) => {
  const date = req.query.date || dayjs().format('YYYY-MM-DD');

  // list all items for dropdown
  const { rows: items } = await db.query(
    'SELECT id, code, name, yield_qty, yield_unit FROM items ORDER BY name'
  );

  // the plan for that day
  const { rows: plan } = await db.query(
    `SELECT pd.*, i.code AS item_code, i.name AS item_name, i.yield_qty, i.yield_unit
     FROM production_days pd
     JOIN items i ON i.id = pd.item_id
     WHERE pd.date = $1
     ORDER BY COALESCE(pd.start_time,'23:59'), i.name`, [date]
  );

  // compute usage and costs
  let usage = []; // [{product_id, code, name, base_unit, need_base, need_purchase, unit_cost, cost}]
  let totals = { cost: 0 };

  if (plan.length) {
    const itemIds = plan.map(p => p.item_id);
    const { rows: bom } = await db.query(
      `SELECT ri.item_id, ri.qty, ri.unit,
              p.id AS product_id, p.code, p.name, p.unit AS purchase_unit, p.base_unit, p.unit_cost
       FROM recipe_items ri
       JOIN products p ON p.id = ri.product_id
       WHERE ri.item_id = ANY($1::int[])`,
      [itemIds]
    );

    // group BOM by item
    const bomByItem = new Map();
    for (const r of bom) {
      if (!bomByItem.has(r.item_id)) bomByItem.set(r.item_id, []);
      bomByItem.get(r.item_id).push(r);
    }

    // sum usage per product
    const useByProd = new Map();

    for (const row of plan) {
      const scale = row.total_qty / Number(row.yield_qty || 1);
      const lines = bomByItem.get(row.item_id) || [];
      for (const li of lines) {
        const f = factor(li.unit, li.base_unit);
        if (!f) continue; // skip if unknown conversion
        const needBase = li.qty * scale * f; // in product base_unit
        const cur = useByProd.get(li.product_id) || {
          product_id: li.product_id,
          code: li.code,
          name: li.name,
          base_unit: li.base_unit,
          purchase_unit: li.purchase_unit,
          unit_cost: Number(li.unit_cost || 0),
          need_base: 0
        };
        cur.need_base += needBase;
        useByProd.set(li.product_id, cur);
      }
    }

    // finalize usage rows with cost
    usage = Array.from(useByProd.values()).map(u => {
      const fToPurchase = factor(u.purchase_unit, u.base_unit);
      let need_purchase = null;
      if (fToPurchase) need_purchase = u.need_base / fToPurchase; // quantity in purchase unit
      const costPerBase = fToPurchase ? (u.unit_cost / fToPurchase) : 0; // € per base unit
      const cost = u.need_base * costPerBase;
      totals.cost += cost;
      return {
        ...u,
        need_purchase,
        cost
      };
    });

    // sort by code
    usage.sort((a,b) => a.code.localeCompare(b.code));
  }

  res.render('production/index', {
    title: 'Production Plan',
    date, items, plan, usage, totals
  });
});

// POST /production/add
router.post('/production/add', ensureAuthenticated, async (req, res) => {
  const { date, item_id, total_qty, batch_size, start_time, station, notes } = req.body;
  if (!date || !item_id || !total_qty) {
    setFlash(req, 'error', 'Bitte Datum, Artikel und Menge ausfüllen.');
    return res.redirect('/production?date=' + encodeURIComponent(date || ''));
  }
  try {
    await db.query(
      `INSERT INTO production_days (date,item_id,total_qty,batch_size,start_time,station,notes,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'planned')`,
      [date, item_id, Number(total_qty), batch_size || null, start_time || null, station || null, notes || null]
    );
    setFlash(req, 'ok', 'Eintrag hinzugefügt.');
  } catch (e) {
    console.error('add production error:', e);
    setFlash(req, 'error', 'Fehler beim Hinzufügen.');
  }
  res.redirect('/production?date=' + encodeURIComponent(date));
});

// POST /production/:id/delete
router.post('/production/:id/delete', ensureAuthenticated, async (req, res) => {
  const id = req.params.id;
  const date = req.body.date || dayjs().format('YYYY-MM-DD');
  try {
    await db.query('DELETE FROM production_days WHERE id=$1', [id]);
    setFlash(req, 'ok', 'Eintrag gelöscht.');
  } catch (e) {
    console.error('delete production error:', e);
    setFlash(req, 'error', 'Löschen fehlgeschlagen.');
  }
  res.redirect('/production?date=' + encodeURIComponent(date));
});

module.exports = router;
