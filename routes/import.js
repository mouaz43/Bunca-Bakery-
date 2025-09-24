// routes/import.js
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

router.use(ensureAuthenticated, ensureAdmin);

/** Helpers */
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v).trim());
const yes = (v) => String(v || '').toLowerCase() === 'true' || v === true || v === 'on';

/** Upper-case safe header map */
function toRows(sheet) {
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return json.map((row) => {
    const mapped = {};
    for (const k of Object.keys(row)) {
      mapped[k.toLowerCase()] = row[k];
    }
    return mapped;
  });
}

router.get('/admin/import', (_req, res) => {
  res.render('admin/import', { title: 'Import (Excel/CSV)' });
});

router.post('/admin/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    setFlash(req, 'error', 'Bitte Datei auswählen.');
    return res.redirect('/admin/import');
  }

  const replaceBOM = yes(req.body.replace_bom);
  const doCommit = req.body.action === 'import';

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    console.error('XLSX parse error:', e);
    setFlash(req, 'error', 'Datei konnte nicht gelesen werden (XLSX/CSV?).');
    return res.redirect('/admin/import');
  }

  // Recognized sheets (case-insensitive)
  const sheets = {};
  for (const name of wb.SheetNames) {
    sheets[name.toLowerCase()] = wb.Sheets[name];
  }

  const products = sheets['products'] ? toRows(sheets['products']) : [];
  const items = sheets['items'] ? toRows(sheets['items']) : [];
  const bom = sheets['bom'] ? toRows(sheets['bom']) : [];
  const production = sheets['production'] ? toRows(sheets['production']) : [];
  const allocations = sheets['allocations'] ? toRows(sheets['allocations']) : [];

  const errors = [];
  const info = { products: 0, items: 0, bom: 0, production: 0, allocations: 0 };

  // Validate minimum headers
  function requireCols(rows, cols, label) {
    if (!rows.length) return;
    for (const c of cols) {
      if (!(c in rows[0])) {
        errors.push(`${label}: Spalte "${c}" fehlt.`);
      }
    }
  }

  requireCols(products, ['code','name','unit','base_unit','unit_cost'], 'Products');
  requireCols(items, ['code','name','yield_qty','yield_unit'], 'Items');
  requireCols(bom, ['item_code','product_code','qty','unit'], 'BOM');
  if (production.length) requireCols(production, ['date','item_code','total_qty'], 'Production');
  if (allocations.length) requireCols(allocations, ['date','item_code','shop_code','qty'], 'Allocations');

  // Map codes to IDs after upserts
  const itemIdByCode = new Map();
  const productIdByCode = new Map();
  const shopIdByCode = new Map();

  try {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Products upsert
      for (const r of products) {
        const vals = {
          code: str(r.code),
          name: str(r.name),
          category: str(r.category),
          unit: str(r.unit),
          base_unit: str(r.base_unit),
          unit_cost: num(r.unit_cost) ?? 0,
          pack_size: num(r.pack_size),
          pack_unit: str(r.pack_unit),
          waste_pct: num(r.waste_pct) ?? 0,
          supplier: str(r.supplier)
        };
        if (!vals.code || !vals.name || !vals.unit || !vals.base_unit) {
          errors.push(`Products: ungültige Zeile (Code/Name/Unit/Base erforderlich): ${JSON.stringify(r)}`);
          continue;
        }
        if (doCommit) {
          await client.query(
            `INSERT INTO products (code,name,category,unit,base_unit,unit_cost,pack_size,pack_unit,waste_pct,supplier)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (code) DO UPDATE
             SET name=EXCLUDED.name, category=EXCLUDED.category, unit=EXCLUDED.unit, base_unit=EXCLUDED.base_unit,
                 unit_cost=EXCLUDED.unit_cost, pack_size=EXCLUDED.pack_size, pack_unit=EXCLUDED.pack_unit,
                 waste_pct=EXCLUDED.waste_pct, supplier=EXCLUDED.supplier, updated_at=NOW()`,
            [vals.code, vals.name, vals.category, vals.unit, vals.base_unit, vals.unit_cost, vals.pack_size, vals.pack_unit, vals.waste_pct, vals.supplier]
          );
        }
        info.products++;
      }

      // Items upsert
      for (const r of items) {
        const vals = {
          code: str(r.code),
          name: str(r.name),
          category: str(r.category),
          yield_qty: num(r.yield_qty),
          yield_unit: str(r.yield_unit),
          notes: str(r.notes)
        };
        if (!vals.code || !vals.name || !vals.yield_qty || !vals.yield_unit) {
          errors.push(`Items: ungültige Zeile: ${JSON.stringify(r)}`);
          continue;
        }
        if (doCommit) {
          await client.query(
            `INSERT INTO items (code,name,category,yield_qty,yield_unit,notes)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (code) DO UPDATE
             SET name=EXCLUDED.name, category=EXCLUDED.category, yield_qty=EXCLUDED.yield_qty,
                 yield_unit=EXCLUDED.yield_unit, notes=EXCLUDED.notes`,
            [vals.code, vals.name, vals.category, vals.yield_qty, vals.yield_unit, vals.notes]
          );
        }
        info.items++;
      }

      // Build code→id maps (after upserts, select fresh)
      if (doCommit) {
        const { rows: pr } = await client.query('SELECT id, code FROM products');
        pr.forEach(p => productIdByCode.set(p.code, p.id));
        const { rows: it } = await client.query('SELECT id, code FROM items');
        it.forEach(i => itemIdByCode.set(i.code, i.id));
        const { rows: sh } = await client.query('SELECT id, code FROM shops');
        sh.forEach(s => shopIdByCode.set(s.code, s.id));
      }

      // BOM handling
      const touchedItemCodes = new Set();
      for (const r of bom) {
        const item_code = str(r.item_code);
        const product_code = str(r.product_code);
        const qty = num(r.qty);
        const unit = str(r.unit);
        if (!item_code || !product_code || !qty || !unit) {
          errors.push(`BOM: ungültige Zeile: ${JSON.stringify(r)}`);
          continue;
        }
        touchedItemCodes.add(item_code);
      }

      if (doCommit && replaceBOM && touchedItemCodes.size > 0) {
        // clear existing BOM for items present in this file
        const codes = Array.from(touchedItemCodes);
        const { rows: ids } = await client.query(
          'SELECT id FROM items WHERE code = ANY($1::text[])',
          [codes]
        );
        const itemIds = ids.map(r => r.id);
        if (itemIds.length) {
          await client.query('DELETE FROM recipe_items WHERE item_id = ANY($1::int[])', [itemIds]);
        }
      }

      for (const r of bom) {
        const item_code = str(r.item_code);
        const product_code = str(r.product_code);
        const qty = num(r.qty);
        const unit = str(r.unit);
        if (!item_code || !product_code || !qty || !unit) continue;

        if (doCommit) {
          const item_id = itemIdByCode.get(item_code);
          const product_id = productIdByCode.get(product_code);
          if (!item_id) { errors.push(`BOM: Item-Code nicht gefunden: ${item_code}`); continue; }
          if (!product_id) { errors.push(`BOM: Produkt-Code nicht gefunden: ${product_code}`); continue; }
          await client.query(
            'INSERT INTO recipe_items (item_id, product_id, qty, unit) VALUES ($1,$2,$3,$4)',
            [item_id, product_id, qty, unit]
          );
        }
        info.bom++;
      }

      // Production days (optional)
      for (const r of production) {
        const date = str(r.date);
        const item_code = str(r.item_code);
        const total_qty = num(r.total_qty);
        const batch_size = num(r.batch_size);
        const start_time = str(r.start_time);
        const station = str(r.station);
        const notes = str(r.notes);
        const status = str(r.status) || 'planned';
        if (!date || !item_code || !total_qty) {
          errors.push(`Production: ungültige Zeile: ${JSON.stringify(r)}`);
          continue;
        }
        if (doCommit) {
          const { rows: it } = await client.query('SELECT id FROM items WHERE code=$1', [item_code]);
          if (!it.length) { errors.push(`Production: Item-Code nicht gefunden: ${item_code}`); continue; }
          await client.query(
            `INSERT INTO production_days (date,item_id,total_qty,batch_size,start_time,station,notes,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [date, it[0].id, total_qty, batch_size, start_time, station, notes, status]
          );
        }
        info.production++;
      }

      // Allocations (optional)
      for (const r of allocations) {
        const date = str(r.date);
        const item_code = str(r.item_code);
        const shop_code = str(r.shop_code);
        const qty = num(r.qty);
        if (!date || !item_code || !shop_code || !qty) {
          errors.push(`Allocations: ungültige Zeile: ${JSON.stringify(r)}`);
          continue;
        }
        if (doCommit) {
          const { rows: pd } = await client.query(
            `SELECT pd.id
             FROM production_days pd
             JOIN items i ON i.id = pd.item_id
             WHERE pd.date=$1 AND i.code=$2
             ORDER BY pd.id DESC LIMIT 1`,
            [date, item_code]
          );
          if (!pd.length) { errors.push(`Allocations: Keine Production für ${item_code} am ${date}`); continue; }
          const shop_id = shopIdByCode.get(shop_code);
          if (!shop_id) { errors.push(`Allocations: Shop-Code nicht gefunden: ${shop_code}`); continue; }
          await client.query(
            'INSERT INTO allocations (production_day_id, shop_id, qty) VALUES ($1,$2,$3)',
            [pd[0].id, shop_id, qty]
          );
        }
        info.allocations++;
      }

      if (doCommit && errors.length === 0) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }

    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Import TX error:', e);
      errors.push('Transaktionsfehler: ' + e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('DB connect error:', e);
    errors.push('DB Verbindung fehlgeschlagen: ' + e.message);
  }

  res.render('admin/import_result', {
    title: doCommit ? 'Import Ergebnis' : 'Dry-Run Ergebnis',
    info, errors, committed: doCommit && errors.length === 0
  });
});

module.exports = router;
