// lib/smartExcel.js
// Heuristic parser to extract Products / Items / BOM / Production / Allocations
// from messy Excel files (any sheet names, extra header rows, German/English,
// vertical or transposed tables, merged cells, etc.)

const XLSX = require('xlsx');

const N = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s%/.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function transpose(a) {
  const rows = a.length;
  const cols = Math.max(...a.map(r => r.length));
  const out = Array.from({ length: cols }, () => Array(rows).fill(''));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < a[r].length; c++) out[c][r] = a[r][c];
  }
  return out;
}

function bestHeaderRow(rows, wantedSet) {
  // Return {rowIndex, hits, mapping} for the row that matches most wanted headers
  let best = { rowIndex: -1, hits: 0, mapping: {} };
  const maxRows = Math.min(rows.length, 25);
  for (let r = 0; r < maxRows; r++) {
    const headerCells = rows[r] || [];
    const mapping = mapHeaders(headerCells, wantedSet);
    const hits = Object.keys(mapping).length;
    if (hits > best.hits) best = { rowIndex: r, hits, mapping };
  }
  return best;
}

function mapHeaders(headerCells, wantedSet) {
  // wantedSet: { canonicalField: [synonyms...] }
  const mapping = {};
  const usedCols = new Set();
  for (const [field, keys] of Object.entries(wantedSet)) {
    const best = { col: -1, score: 0 };
    for (let c = 0; c < headerCells.length; c++) {
      if (usedCols.has(c)) continue;
      const cell = headerCells[c];
      const nc = N(cell);
      if (!nc) continue;
      for (const k of keys) {
        const nk = N(k);
        // simple similarity: exact / includes / starts-with
        let score = 0;
        if (nc === nk) score = 3;
        else if (nc.includes(nk)) score = 2;
        else if (nk.includes(nc) && nc.length >= 3) score = 1.5;
        if (score > best.score) best.col = c, best.score = score;
      }
    }
    if (best.col >= 0) {
      mapping[field] = best.col;
      usedCols.add(best.col);
    }
  }
  return mapping;
}

const wanted = {
  products: {
    code: ['code','produktcode','rohcode','sku','id'],
    name: ['name','produkt','bezeichnung','raw','material','ingredient'],
    unit: ['unit','einheit','purchase unit','einkaufseinheit'],
    base_unit: ['base_unit','basiseinheit','calc unit','rechengrundlage','grund einheit','base'],
    unit_cost: ['unit_cost','preis','cost','kosten','€/einheit','price','cost per unit'],
    pack_size: ['pack_size','gebinde','packung','pack size'],
    pack_unit: ['pack_unit','packeinheit','pack unit'],
    waste_pct: ['waste_pct','waste','verlust','verlust%','abschlag%','schwund%'],
    supplier: ['supplier','lieferant'],
    category: ['category','kategorie','gruppe','warengruppe']
  },
  items: {
    code: ['code','item_code','artikelcode','sku','rezeptcode'],
    name: ['name','item','artikel','rezept','product name','produktname'],
    yield_qty: ['yield','yield_qty','ausbeute','ergibt','output','portionen','ertrag'],
    yield_unit: ['yield_unit','einheit','unit','pcs','stk','stücke'],
    category: ['category','kategorie','gruppe'],
    notes: ['notes','notizen','bemerkungen','beschreibung']
  },
  bom: {
    item_code: ['item_code','item','sku','artikel','rezept','recipe','product'],
    product_code: ['product_code','rohcode','ingredient_code','ingredient','roh','product','material'],
    qty: ['qty','menge','quantity','amount','gramm','kg','g','ml','l'],
    unit: ['unit','einheit','uom']
  },
  production: {
    date: ['date','datum','tag'],
    item_code: ['item_code','item','sku','artikel','rezept','name'],
    total_qty: ['total_qty','qty','target','menge','anzahl','quantity'],
    batch_size: ['batch_size','batch','charge'],
    start_time: ['start_time','time','uhrzeit','start'],
    station: ['station','linie','bereich','area'],
    notes: ['notes','bemerkungen','info','hinweis'],
    status: ['status','zustand']
  },
  allocations: {
    date: ['date','datum'],
    item_code: ['item_code','item','sku','artikel','rezept','name'],
    shop_code: ['shop_code','shop','store','filiale','location'],
    qty: ['qty','menge','quantity','anzahl']
  }
};

function extractTableFromRows(rows, typeKey) {
  const headersWanted = wanted[typeKey];
  // try normal orientation
  let best = bestHeaderRow(rows, headersWanted);
  let orientation = 'rows';
  // try transposed (headers vertically)
  const trans = transpose(rows);
  const bestT = bestHeaderRow(trans, headersWanted);
  if (bestT.hits > best.hits) { best = bestT; orientation = 'cols'; }

  if (best.hits < 2) return { rows: [], headers: {}, orientation };

  const dataRows = [];
  if (orientation === 'rows') {
    for (let r = best.rowIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every(v => (v === null || v === undefined || String(v).trim() === ''))) continue;
      dataRows.push(row);
    }
  } else {
    for (let r = best.rowIndex + 1; r < trans.length; r++) {
      const row = trans[r];
      if (!row || row.every(v => (v === null || v === undefined || String(v).trim() === ''))) continue;
      dataRows.push(row);
    }
  }
  return { rows: dataRows, headers: best.mapping, orientation };
}

function rowsToObjects(tb) {
  const out = [];
  for (const row of tb.rows) {
    const obj = {};
    for (const [field, col] of Object.entries(tb.headers)) {
      obj[field] = row[col];
    }
    out.push(obj);
  }
  return out;
}

function parseSheet(ws) {
  // raw 2D array
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  return matrix;
}

function parseWorkbook(wb) {
  const errors = [];
  const out = { products: [], items: [], bom: [], production: [], allocations: [], errors };

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const raw = parseSheet(ws);
    if (!raw || !raw.length) continue;

    const candidates = [
      ['products', extractTableFromRows(raw, 'products')],
      ['items', extractTableFromRows(raw, 'items')],
      ['bom', extractTableFromRows(raw, 'bom')],
      ['production', extractTableFromRows(raw, 'production')],
      ['allocations', extractTableFromRows(raw, 'allocations')],
    ];

    // choose the "strong" table for this sheet if any has >=3 matched headers (>=2 for allocations)
    let picked = null;
    let bestHits = 0;
    for (const [type, tb] of candidates) {
      const hits = Object.keys(tb.headers || {}).length;
      const threshold = type === 'allocations' ? 2 : 3;
      if (hits >= threshold && hits > bestHits) {
        picked = [type, tb];
        bestHits = hits;
      }
    }

    if (!picked) {
      // No single strong type — but sometimes one sheet contains multiple small tables.
      // We'll add any table that passes threshold, not just the best one.
      for (const [type, tb] of candidates) {
        const hits = Object.keys(tb.headers || {}).length;
        const threshold = type === 'allocations' ? 2 : 3;
        if (hits >= threshold) {
          const objs = rowsToObjects(tb);
          out[type].push(...objs);
        }
      }
      continue;
    }

    const [type, tb] = picked;
    const objs = rowsToObjects(tb);
    out[type].push(...objs);
  }

  // post-filters: drop totally empty rows
  for (const key of ['products','items','bom','production','allocations']) {
    out[key] = out[key].filter(obj => Object.values(obj).some(v => String(v || '').trim() !== ''));
  }

  // De-duplicate by normalized JSON (best-effort)
  function dedupe(arr, keyFields) {
    const seen = new Set();
    return arr.filter(r => {
      const key = keyFields.map(k => N(r[k] || '')).join('|');
      if (!key.replace(/\|/g, '')) return true; // keep if we can't key it
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  out.products = dedupe(out.products, ['code','name']);
  out.items = dedupe(out.items, ['code','name']);
  out.bom = dedupe(out.bom, ['item_code','product_code','qty','unit']);
  out.production = dedupe(out.production, ['date','item_code','total_qty']);
  out.allocations = dedupe(out.allocations, ['date','item_code','shop_code','qty']);

  return out;
}

module.exports = { parseWorkbook };
