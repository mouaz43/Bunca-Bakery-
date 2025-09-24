const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');

const router = express.Router();
router.use(ensureAuthenticated, ensureAdmin);

/* ---------- Admin Home ---------- */
router.get('/admin', async (req, res) => {
  const [{ rows: c1 }, { rows: c2 }, { rows: c3 }] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS c FROM products'),
    db.query('SELECT COUNT(*)::int AS c FROM items'),
    db.query('SELECT COUNT(*)::int AS c FROM recipe_items')
  ]);
  res.render('admin/index', {
    title: 'Admin',
    counts: { products: c1[0].c, items: c2[0].c, bom: c3[0].c }
  });
});

/* ---------- Products (Rohwaren) ---------- */
router.get('/admin/products', async (req, res) => {
  const { rows: units } = await db.query('SELECT code FROM units ORDER BY code');
  const { rows: products } = await db.query(
    'SELECT id, code, name, category, unit, base_unit, unit_cost, pack_size, pack_unit, waste_pct, supplier FROM products ORDER BY name'
  );
  res.render('admin/products', { title: 'Rohwaren', units, products });
});

router.post('/admin/products', async (req, res) => {
  const { code, name, category, unit, base_unit, unit_cost, pack_size, pack_unit, waste_pct, supplier } = req.body;

  if (!code || !name || !unit || !base_unit) {
    setFlash(req, 'error', 'Bitte Code, Name, Unit und Base Unit ausfüllen.');
    return res.redirect('/admin/products');
  }

  try {
    await db.query(
      `INSERT INTO products (code, name, category, unit, base_unit, unit_cost, pack_size, pack_unit, waste_pct, supplier)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),$7,$8,COALESCE($9,0),$10)`,
      [code.trim(), name.trim(), category || null, unit, base_unit, unit_cost || 0, pack_size || null, pack_unit || null, waste_pct || 0, supplier || null]
    );
    setFlash(req, 'ok', 'Produkt angelegt.');
  } catch (e) {
    console.error('Create product error:', e);
    setFlash(req, 'error', 'Fehler beim Anlegen (Code evtl. doppelt?).');
  }
  res.redirect('/admin/products');
});

router.get('/admin/products/:id/edit', async (req, res) => {
  const id = req.params.id;
  const { rows: units } = await db.query('SELECT code FROM units ORDER BY code');
  const { rows } = await db.query('SELECT * FROM products WHERE id=$1', [id]);
  if (!rows.length) return res.status(404).render('dashboard/placeholder', { title: '404', label: 'Produkt nicht gefunden' });
  res.render('admin/product_edit', { title: 'Produkt bearbeiten', units, p: rows[0] });
});

router.post('/admin/products/:id', async (req, res) => {
  const id = req.params.id;
  const { code, name, category, unit, base_unit, unit_cost, pack_size, pack_unit, waste_pct, supplier } = req.body;
  try {
    await db.query(
      `UPDATE products SET code=$1, name=$2, category=$3, unit=$4, base_unit=$5, unit_cost=COALESCE($6,0),
       pack_size=$7, pack_unit=$8, waste_pct=COALESCE($9,0), supplier=$10, updated_at=NOW() WHERE id=$11`,
      [code.trim(), name.trim(), category || null, unit, base_unit, unit_cost || 0, pack_size || null, pack_unit || null, waste_pct || 0, supplier || null, id]
    );
    setFlash(req, 'ok', 'Produkt gespeichert.');
  } catch (e) {
    console.error('Update product error:', e);
    setFlash(req, 'error', 'Fehler beim Speichern.');
  }
  res.redirect('/admin/products/' + id + '/edit');
});

router.post('/admin/products/:id/delete', async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM products WHERE id=$1', [id]);
    setFlash(req, 'ok', 'Produkt gelöscht.');
  } catch (e) {
    console.error('Delete product error:', e);
    setFlash(req, 'error', 'Löschen nicht möglich (wird evtl. in Rezepten verwendet).');
  }
  res.redirect('/admin/products');
});

/* ---------- Items (Finished goods / Recipes) ---------- */
router.get('/admin/items', async (req, res) => {
  const { rows: items } = await db.query(
    'SELECT id, code, name, category, yield_qty, yield_unit, image_url FROM items ORDER BY name'
  );
  const { rows: units } = await db.query('SELECT code FROM units ORDER BY code');
  res.render('admin/items', { title: 'Artikel/Rezepte', items, units });
});

router.post('/admin/items', async (req, res) => {
  const { code, name, category, yield_qty, yield_unit, notes } = req.body;
  if (!code || !name || !yield_qty || !yield_unit) {
    setFlash(req, 'error', 'Bitte Code, Name, Yield und Einheit ausfüllen.');
    return res.redirect('/admin/items');
  }
  try {
    await db.query(
      `INSERT INTO items (code, name, category, yield_qty, yield_unit, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [code.trim(), name.trim(), category || null, yield_qty, yield_unit, notes || null]
    );
    setFlash(req, 'ok', 'Artikel/Rezept angelegt.');
  } catch (e) {
    console.error('Create item error:', e);
    setFlash(req, 'error', 'Fehler beim Anlegen (Code evtl. doppelt?).');
  }
  res.redirect('/admin/items');
});

router.get('/admin/items/:id/edit', async (req, res) => {
  const id = req.params.id;
  const { rows: units } = await db.query('SELECT code FROM units ORDER BY code');
  const { rows: items } = await db.query('SELECT * FROM items WHERE id=$1', [id]);
  if (!items.length) return res.status(404).render('dashboard/placeholder', { title: '404', label: 'Artikel nicht gefunden' });
  const item = items[0];

  const { rows: bom } = await db.query(
    `SELECT ri.id, ri.qty, ri.unit, p.code AS product_code, p.name AS product_name
     FROM recipe_items ri
     JOIN products p ON p.id = ri.product_id
     WHERE ri.item_id=$1
     ORDER BY p.name`, [id]
  );

  res.render('admin/item_edit', { title: 'Rezept bearbeiten', item, bom, units });
});

router.post('/admin/items/:id', async (req, res) => {
  const id = req.params.id;
  const { code, name, category, yield_qty, yield_unit, notes } = req.body;
  try {
    await db.query(
      `UPDATE items SET code=$1, name=$2, category=$3, yield_qty=$4, yield_unit=$5, notes=$6 WHERE id=$7`,
      [code.trim(), name.trim(), category || null, yield_qty, yield_unit, notes || null, id]
    );
    setFlash(req, 'ok', 'Rezept gespeichert.');
  } catch (e) {
    console.error('Update item error:', e);
    setFlash(req, 'error', 'Fehler beim Speichern.');
  }
  res.redirect(`/admin/items/${id}/edit`);
});

router.post('/admin/items/:id/bom', async (req, res) => {
  const id = req.params.id;
  const { product_code, qty, unit } = req.body;
  try {
    const { rows: prod } = await db.query('SELECT id FROM products WHERE code=$1', [product_code.trim()]);
    if (!prod.length) {
      setFlash(req, 'error', `Produktcode nicht gefunden: ${product_code}`);
      return res.redirect(`/admin/items/${id}/edit`);
    }
    await db.query(
      `INSERT INTO recipe_items (item_id, product_id, qty, unit) VALUES ($1,$2,$3,$4)`,
      [id, prod[0].id, qty, unit]
    );
    setFlash(req, 'ok', 'Zutat hinzugefügt.');
  } catch (e) {
    console.error('Add BOM error:', e);
    setFlash(req, 'error', 'Fehler beim Hinzufügen.');
  }
  res.redirect(`/admin/items/${id}/edit`);
});

router.post('/admin/items/:id/bom/:rid/delete', async (req, res) => {
  const id = req.params.id;
  const rid = req.params.rid;
  try {
    await db.query('DELETE FROM recipe_items WHERE id=$1 AND item_id=$2', [rid, id]);
    setFlash(req, 'ok', 'Zutat entfernt.');
  } catch (e) {
    console.error('Delete BOM error:', e);
    setFlash(req, 'error', 'Fehler beim Entfernen.');
  }
  res.redirect(`/admin/items/${id}/edit`);
});

module.exports = router;
