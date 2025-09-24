// db/seed_from_files.js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const db = require('./index');

function readJSON(p) {
  try {
    const abs = path.join(__dirname, 'seed_data', p);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('JSON parse error for', p, e);
    return null;
  }
}

async function ensureTables() {
  // Only create optional suppliers table; other tables already exist from migrations.sql
  await db.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      contact_json JSONB,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function seedFromFiles({ replaceBOM = false } = {}) {
  await ensureTables();

  const suppliers = readJSON('suppliers.json') || [];
  const products  = readJSON('products.json')  || [];
  const items     = readJSON('items.json')     || [];
  const bom       = readJSON('bom.json')       || [];
  const production= readJSON('production.json')|| [];

  const result = { suppliers: 0, products: 0, items: 0, bom: 0, production: 0, clearedBOMItems: 0 };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Suppliers (optional)
    for (const s of suppliers) {
      if (!s.code || !s.name) continue;
      await client.query(
        `INSERT INTO suppliers (code, name, contact_json, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, contact_json=EXCLUDED.contact_json, note=EXCLUDED.note, updated_at=NOW()`,
        [s.code.trim(), s.name.trim(), s.contact_json || null, s.note || null]
      );
      result.suppliers++;
    }

    // Products
    for (const p of products) {
      if (!p.code || !p.name || !p.unit || !p.base_unit) continue;
      await client.query(
        `INSERT INTO products (code, name, category, unit, base_unit, unit_cost, pack_size, pack_unit, waste_pct, supplier)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),$7,$8,COALESCE($9,0),$10)
         ON CONFLICT (code) DO UPDATE SET
           name=EXCLUDED.name, category=EXCLUDED.category, unit=EXCLUDED.unit, base_unit=EXCLUDED.base_unit,
           unit_cost=EXCLUDED.unit_cost, pack_size=EXCLUDED.pack_size, pack_unit=EXCLUDED.pack_unit,
           waste_pct=EXCLUDED.waste_pct, supplier=EXCLUDED.supplier, updated_at=NOW()`,
        [
          p.code.trim(), p.name.trim(), p.category || null, p.unit, p.base_unit,
          p.unit_cost ?? 0, p.pack_size ?? null, p.pack_unit ?? null, p.waste_pct ?? 0,
          p.supplier || null
        ]
      );
      result.products++;
    }

    // Items
    for (const it of items) {
      if (!it.code || !it.name || !it.yield_qty || !it.yield_unit) continue;
      await client.query(
        `INSERT INTO items (code, name, category, yield_qty, yield_unit, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET
           name=EXCLUDED.name, category=EXCLUDED.category, yield_qty=EXCLUDED.yield_qty,
           yield_unit=EXCLUDED.yield_unit, notes=EXCLUDED.notes`,
        [it.code.trim(), it.name.trim(), it.category || null, it.yield_qty, it.yield_unit, it.notes || null]
      );
      result.items++;
    }

    // Build code maps
    const { rows: pr } = await client.query('SELECT id, code FROM products');
    const { rows: ir } = await client.query('SELECT id, code FROM items');
    const productIdByCode = new Map(pr.map(r => [r.code, r.id]));
    const itemIdByCode    = new Map(ir.map(r => [r.code, r.id]));

    // Optional: clear BOM for items present in file
    if (replaceBOM && bom.length) {
      const codes = Array.from(new Set(bom.map(b => (b.item_code || '').trim()).filter(Boolean)));
      if (codes.length) {
        const { rows: ids } = await client.query('SELECT id FROM items WHERE code = ANY($1::text[])', [codes]);
        const itemIds = ids.map(r => r.id);
        if (itemIds.length) {
          await client.query('DELETE FROM recipe_items WHERE item_id = ANY($1::int[])', [itemIds]);
          result.clearedBOMItems = itemIds.length;
        }
      }
    }

    // BOM insert
    for (const r of bom) {
      const iid = itemIdByCode.get((r.item_code || '').trim());
      const pid = productIdByCode.get((r.product_code || '').trim());
      if (!iid || !pid || !r.qty || !r.unit) continue;
      await client.query(
        'INSERT INTO recipe_items (item_id, product_id, qty, unit) VALUES ($1,$2,$3,$4)',
        [iid, pid, r.qty, r.unit]
      );
      result.bom++;
    }

    // Production plan
    for (const pd of production) {
      const iid = itemIdByCode.get((pd.item_code || '').trim());
      if (!iid || !pd.date || !pd.total_qty) continue;
      await client.query(
        `INSERT INTO production_days (date, item_id, total_qty, batch_size, start_time, station, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [pd.date, iid, pd.total_qty, pd.batch_size || null, pd.start_time || null, pd.station || null, pd.notes || null, pd.status || 'planned']
      );
      result.production++;
    }

    await client.query('COMMIT');
    return { ok: true, result };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('seedFromFiles error:', e);
    return { ok: false, error: e.message, result };
  } finally {
    client.release();
  }
}

module.exports = seedFromFiles;

// CLI usage: node db/seed_from_files.js --replace-bom
if (require.main === module) {
  const replace = process.argv.includes('--replace-bom');
  seedFromFiles({ replaceBOM: replace }).then(r => {
    console.log('Seed-from-files:', r);
    process.exit(r.ok ? 0 : 1);
  });
}
