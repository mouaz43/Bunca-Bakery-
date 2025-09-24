// routes/prices_import.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');

router.use(ensureAuthenticated, ensureAdmin);

function normalizeNum(s) {
  if (s == null) return null;
  // remove € and spaces
  s = String(s).replace(/€/g, '').trim();
  // convert German decimals "1.234,56" -> "1234.56"
  s = s.replace(/\./g, '').replace(/,/g, '.');
  // allow formulas like "55.47/3"
  try {
    // only numbers, dot, slash
    if (/^[0-9.]+(?:\/[0-9.]+)?$/.test(s)) {
      if (s.includes('/')) {
        const [a, b] = s.split('/').map(Number);
        if (isFinite(a) && isFinite(b) && b !== 0) return a / b;
      }
    }
  } catch {}
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeUnitToken(s) {
  if (!s) return '';
  s = ('' + s).toLowerCase();
  if (s.includes('kg')) return 'per_kg';
  if (s.includes('kilogram')) return 'per_kg';
  if (s.includes('/kg')) return 'per_kg';

  if (s.includes('l/') || s.includes('/l') || s.includes('liter') || s.includes('litre')) return 'per_l';

  if (s.includes('g')) return 'per_g';
  if (s.includes('ml')) return 'per_ml';
  if (s.includes('stk') || s.includes('stück') || s.includes('pcs') || s.includes('piece')) return 'per_pcs';

  return ''; // unknown, we’ll try to infer from product base_unit
}

function toBase(cost, unitToken, product) {
  // We store €/base_unit; product.base_unit is g/ml/pcs
  // Convert from typical spreadsheet entries (€/kg or €/l)
  if (!Number.isFinite(cost)) return null;
  const base = product.base_unit; // "g", "ml", "pcs"
  const unit = unitToken;

  if (unit === 'per_kg') {
    if (base === 'g') return cost / 1000;       // €/kg -> €/g
    if (base === 'ml') return cost / 1000;      // sometimes l for liquid but product base is ml
    if (base === 'pcs') return cost;            // unusual, but keep as-is
  }
  if (unit === 'per_l') {
    if (base === 'ml') return cost / 1000;      // €/l -> €/ml
    if (base === 'g') return cost / 1000;       // treat like density 1 if necessary
    if (base === 'pcs') return cost;
  }
  if (unit === 'per_g') {
    if (base === 'g') return cost;
    if (base === 'ml') return cost;             // assume density ~1 unless you later override
    if (base === 'pcs') return cost;
  }
  if (unit === 'per_ml') {
    if (base === 'ml') return cost;
    if (base === 'g') return cost;
    if (base === 'pcs') return cost;
  }
  if (unit === 'per_pcs' || unit === '') {
    // If unit unknown, assume already per base unit; most safe default
    return cost;
  }
  return cost;
}

// simple alias map name -> code to help fuzzy matching
const NAME_TO_CODE = new Map([
  ['weizenmehl','WEIZENMEHL'],
  ['kristallzucker','ZUCKER'],
  ['zucker','ZUCKER'],
  ['braun zucker','ROHRZUCKER'],
  ['rohrzucker','ROHRZUCKER'],
  ['puderzucker','PUDERZUCKER'],
  ['vanillenzucker','VANILLEZUCKER'],
  ['backpulver','BACKPULVER'],
  ['natron','NATRON'],
  ['maisstärke','MAISSTAERKE'],
  ['kakao','KAKAO'],
  ['markenbutter block','BUTTER'],
  ['butter','BUTTER'],
  ['backmargarine','BACKMARGARINE'],
  ['kokosöl','KOKOSOEL'],
  ['kokosraspel','KOKOSRASPEL'],
  ['kuvertüre weiß','KUVERTUERE_WEISS'],
  ['kuvertuere weiss','KUVERTUERE_WEISS'],
  ['kuvertüre vollmilch','KUVERTUERE_VOLLMILCH'],
  ['kuvertuere vollmilch','KUVERTUERE_VOLLMILCH'],
  ['kuvertüre dunkel','KUVERTUERE_DUNKEL'],
  ['kuvertuere dunkel','KUVERTUERE_DUNKEL'],
  ['bananen überreif','BANANEN_UEBERREIF'],
  ['apfel boskoop','APFEL_BOSKOOP'],
  ['karotten stifte','KAROTTEN_STIFTE'],
  ['schokoladenstreusel','SCHOKOLADENSTREUSEL'],
  ['haselnussgrieß geröstet 0–2mm','HASELNUSSGRIESS_0_2MM'],
  ['haselnussgriess geröstet 0-2mm','HASELNUSSGRIESS_0_2MM'],
  ['mandelgrieß fein','MANDELGRIESS_FEIN'],
  ['mandelgriess fein','MANDELGRIESS_FEIN'],
  ['mandeln gehobelt','MANDELN_GEHOBELT'],
  ['walnusskerne','WALNUSSKERNE'],
  ['walnüsse','WALNUSSKERNE'],
  ['erdnüsse','ERDNUESSE'],
  ['edelnuss mix','EDELNUSS_MIX'],
  ['pistazien','PISTAZIEN'],
  ['pistazien creme','PISTAZIEN_CREME'],
  ['haferflocken','HAFERFLOCKEN'],
  ['datteln gehackt 5–7mm','DATTELN_GEHACKT_5_7MM'],
  ['datteln gehackt 5-7mm','DATTELN_GEHACKT_5_7MM'],
  ['pflaumen getrocknet 5–7mm','PFLAUMEN_GETR_5_7MM'],
  ['pflaumen getrocknet 5-7mm','PFLAUMEN_GETR_5_7MM'],
  ['blätterteig','BLAETTERTEIG'],
  ['schokolade packung','SCHOKOLADE_PACKUNG'],
  ['vollei (flüssig)','VOLLEI'],
  ['vollei','VOLLEI'],
  ['eigelb (flüssig)','EIGELB_FLUESSIG'],
  ['eigelb flüssig','EIGELB_FLUESSIG'],
  ['eiersatz (flüssig)','EIERSATZ'],
  ['milch','MILCH'],
  ['sahne 30%','SAHNE_30'],
  ['hafermilch','HAFERMILCH'],
  ['zitronensaft','ZITRONENSAFT'],
  ['zitronen schale','ZITRONEN_SCHALE'],
  ['espresso','ESPRESSO'],
  ['rotwein','ROTWEIN'],
  // Freshly special (from your list)
  ['minze','MINZE'] // if you add this code later
]);

function findProductByName(products, name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  const alias = NAME_TO_CODE.get(key);
  if (alias) return products.find(p => p.code === alias) || null;

  // try startsWith / contains
  let hit = products.find(p => p.name.toLowerCase() === key);
  if (hit) return hit;
  hit = products.find(p => key.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(key));
  return hit || null;
}

router.get('/admin/prices-import', async (req, res) => {
  const { rows: products } = await db.query(
    'SELECT code, name, base_unit, unit_cost FROM products ORDER BY name ASC'
  );
  res.render('admin/prices_import', { title: 'Preise aus Excel einfügen', products });
});

router.post('/admin/prices-import', async (req, res) => {
  const text = (req.body.raw || '').trim();
  if (!text) {
    setFlash(req, 'error', 'Bitte Daten einfügen.');
    return res.redirect('/admin/prices-import');
  }
  const { rows: products } = await db.query(
    'SELECT code, name, base_unit, unit_cost FROM products'
  );

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const updates = [];
  const errors = [];

  for (const line of lines) {
    // split by comma/semicolon/tab
    const parts = line.split(/\t|;|,/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) {
      errors.push({ line, reason: 'Zu wenig Spalten' });
      continue;
    }

    let code = null;
    let product = null;
    let priceRaw = null;
    let unitToken = '';

    // Pattern A: CODE, price
    if (/^[A-Z0-9_]+$/.test(parts[0])) {
      code = parts[0];
      product = products.find(p => p.code === code);
      if (!product) {
        errors.push({ line, reason: `Unbekannter Code ${code}` });
        continue;
      }
      priceRaw = normalizeNum(parts[1]);
      unitToken = normalizeUnitToken(parts[2] || '');
    } else {
      // Pattern B: NAME, price[, unit text]
      const name = parts[0];
      product = findProductByName(products, name);
      if (!product) {
        errors.push({ line, reason: `Produktname nicht gefunden: ${name}` });
        continue;
      }
      code = product.code;
      priceRaw = normalizeNum(parts[1]);
      unitToken = normalizeUnitToken((parts[2] || ''));
    }

    if (!Number.isFinite(priceRaw)) {
      errors.push({ line, reason: 'Preis nicht erkannt' });
      continue;
    }

    const priceBase = toBase(priceRaw, unitToken, product);
    if (!Number.isFinite(priceBase)) {
      errors.push({ line, reason: 'Konnte nicht auf Basis-Einheit umrechnen' });
      continue;
    }

    updates.push({ code, price: Number(priceBase) });
  }

  if (updates.length) {
    const client = db;
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        await client.query(
          'UPDATE products SET unit_cost = $2 WHERE code = $1',
          [u.code, u.price]
        );
      }
      await client.query('COMMIT');
      setFlash(req, 'ok', `Aktualisiert: ${updates.length}. Fehler: ${errors.length}.`);
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch {}
      setFlash(req, 'error', `DB Fehler: ${e.message}`);
    }
  } else {
    setFlash(req, 'error', `Keine gültigen Zeilen. Fehler: ${errors.length}.`);
  }

  // store debug in session to show on next page
  req.session.__price_import_debug = { updates, errors };
  res.redirect('/admin/prices-import');
});

module.exports = router;
