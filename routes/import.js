// routes/import.js
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');
const smartExcel = require('../lib/smartExcel');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

router.use(ensureAuthenticated, ensureAdmin);

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(String(v).replace(',', '.')));
const str = (v) => (v === null || v === undefined ? null : String(v).trim());
const yes = (v) => String(v || '').toLowerCase() === 'true' || v === true || v === 'on';

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

  // ✨ Smart parse of any workbook (messy sheets welcome)
  const parsed = smartExcel.parseWorkbook(wb);
  const products = parsed.products;
  const items = parsed.items;
  const bom = parsed.bom;
  const production = parsed.production;
  const allocations = parsed.allocations;
  const parseErrors = parsed.errors;

  const errors = [...parseErrors];
  const info = { products: products.length, items: items.length, bom: bom.length, production: production.length, allocations: allocations.length };

  // Validate minimums
  if (!products.length && !items.length && !bom.length && !production.length && !allocations.length) {
    errors.push('Keine erkennbaren Tabellen gefunden. Bitte prüfe, ob die Datei Inhalte hat.');
  }

  // DB transaction
  try {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert Products
      for (const r of products) {
        const vals = {
          code: str(r.code),
          name: str(r.name),
          category: str(r.category),
          unit: str(r.unit),
          base_unit: str(r.base_unit) || str(r.base) || str(r.calc_unit),
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
      }

      // Upsert Items
      for (const r of items) {
        const vals = {
          code: str(r.code) || str(r.item_code),
          name: str(r.name) || str(r.item_name),
          category: str(r.category),
          yield_qty: num(r.yield_qty) ?? num(r.yield) ?? num(r.output_qty) ?? num(r.ergibt),
          yield_unit: str(r.yield_unit) || str(r.unit) || str(r.einheit),
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
      }

      // Build indizes by code AND by name (for messy BOMs)
      const productsByCode = new Map();
      const productsByName = new Map();
      const itemsByCode = new Map();
      const itemsByName = new Map();
      if (doCommit) {
        const { rows: pr } = await client.query('SELECT id, code, LOWER(name) AS name FROM products');
        pr.forEach(p => { productsByCode.set(p.code.toLowerCase(), p.id); if (p.name) productsByName.set(p.name.toLowerCase(), p.id); });
        const { rows: it } = await client.query('SELECT id, code, LOWER(name) AS name FROM items');
        it.forEach(i => { itemsByCode.set(i.code.toLowerCase(), i.id); if (i.name) itemsByName.set(i.name.toLowerCase(), i.id); });
      }

      // Optionally clear BOM for items present in this upload
      if (doCommit && replaceBOM && bom.length) {
        const touchedCodes = Array.from(new Set(bom.map(b => (str(b.item_code) || str(b.item) || str(b.item_name) || '').toLowerCase()).filter(Boolean)));
        if (touchedCodes.length) {
          const ids = [];
          for (const codeOrName of touchedCodes) {
            let id = itemsByCode.get(codeOrName) || itemsByName.get(codeOrName);
            if (id) ids.push(id);
          }
          if (ids.length) {
            await client.query('DELETE FROM recipe_items WHERE item_id = ANY($1::int[])', [ids]);
          }
        }
      }

      // Insert BOM
      for (const r of bom) {
        const itemKey = (str(r.item_code) || str(r.item) || str(r.item_name) || '').toLowerCase();
        const prodKey = (str(r.product_code) || str(r.ingredient_code) || str(r.product) || str(r.ingredient) || '').toLowerCase();
        const qty = num(r.qty ?? r.menge ?? r.quantity);
        const unit = str(r.unit ?? r.einheit);

        if (!itemKey || !prodKey || !qty || !unit) {
          errors.push(`BOM: ungültige Zeile: ${JSON.stringify(r)}`);
          continue;
        }

        if (doCommit) {
          const item_id = itemsByCode.get(itemKey) || itemsByName.get(itemKey);
          const product_id = productsByCode.get(prodKey) || productsByName.get(prodKey);
          if (!item_id) { errors.push(`BOM: Item nicht gefunden (Code/Name): "${itemKey}"`); continue; }
          if (!product_id) { errors.push(`BOM: Produkt nicht gefunden (Code/Name): "${prodKey}"`); continue; }
          await client.query(
            'INSERT INTO recipe_items (item_id, product_id, qty, unit) VALUES ($1,$2,$3,$4)',
            [item_id, product_id, qty, unit]
          );
        }
      }

      // Production days
      for (const r of production) {
        const date = str(r.date) || str(r.datum);
        const itemKey = (str(r.item_code) || str(r.item) || str(r.item_name) || '').toLowerCase();
        const total_qty = num(r.total_qty ?? r.qty ?? r.menge);
        const batch_size = num(r.batch_size ?? r.batch ?? r.charge);
        const start_time = str(r.start_time ?? r.time ?? r.uhrzeit);
        const station = str(r.station ?? r.area ?? r.linie);
        const notes = str(r.notes ?? r.remarks ?? r.info);
        const status = str(r.status) || 'planned';
        if (!date || !itemKey || !total_qty) {
          errors.push(`Production: ungültige Zeile: ${JSON.stringify(r)}`);
          continue;
        }
        if (doCommit) {
          const { rows: it } = await client.query(
            'SELECT id FROM items WHERE LOWER(code)=$1 OR LOWER(name)=$1',
            [itemKey]
          );
          if (!it.length) { errors.push(`Production: Item nicht gefunden: ${itemKey}`); continue; }
          await client.query(
            `INSERT INTO production_days (date,item_id,total_qty,batch_size,start_time,station,notes,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [date, it[0].id, total_qty, batch_size, start_time, station, notes, status]
          );
        }
      }

      // Allocations
      const shopIds = new Map();
      if (doCommit) {
        const { rows: sh } = await client.query('SELECT id, code FROM shops');
        sh.forEach(s => shopIds.set(s.code.toLowerCase(), s.id));
      }
      for (const r of allocations) {
        const date = str(r.date) || str(r.datum);
        const itemKey = (str(r.item_code) || str(r.item) || str(r.item_name) || '').toLowerCase();
        const shop_code = (str(r.shop_code) || str(r.shop) || str(r.store) || str(r.filiale) || '').toLowerCase();
        const qty = num(r.qty ?? r.menge);
        if (!date || !itemKey || !shop_code || !qty) {
          errors.push(`Allocations: ungültige Zeile: ${JSON.stringify(r)}`);
          continue;
        }
        if (doCommit) {
          const { rows: pd } = await client.query(
            `SELECT pd.id
             FROM production_days pd
             JOIN items i ON i.id = pd.item_id
             WHERE pd.date=$1 AND (LOWER(i.code)=$2 OR LOWER(i.name)=$2)
             ORDER BY pd.id DESC LIMIT 1`,
            [date, itemKey]
          );
          if (!pd.length) { errors.push(`Allocations: Keine Production für ${itemKey} am ${date}`); continue; }
          const shop_id = shopIds.get(shop_code);
          if (!shop_id) { errors.push(`Allocations: unbekannter Shop-Code: ${shop_code}`); continue; }
          await client.query(
            'INSERT INTO allocations (production_day_id, shop_id, qty) VALUES ($1,$2,$3)',
            [pd[0].id, shop_id, qty]
          );
        }
      }

      if (doCommit && errors.length === 0) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
    } catch (e) {
      console.error('Import TX error:', e);
      errors.push('Transaktionsfehler: ' + e.message);
      try { await client.query('ROLLBACK'); } catch {}
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
