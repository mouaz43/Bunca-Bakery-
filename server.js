// server.js
// Express web service implementing smart workflow for Bunca Bakeflow.
// Now also serves the static frontend from /public.

import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { readDB, writeDB, replaceDB, listSnapshots, readSnapshot } from "./storage.js";

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// resolve paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- middleware ----
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

// serve static frontend (hash-based SPA, so no special fallback needed)
app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

function ok(res, data) { return res.json({ ok: true, data }); }
function bad(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next(); // open install for dev
  const key = req.header("x-admin-key");
  if (key && key === ADMIN_KEY) return next();
  return bad(res, "Unauthorized", 401);
}

function findProduct(db, id) { return db.products.find(p => p.id === id); }
function findRecipe(db, id)  { return db.recipes.find(r => r.id === id); }

// cost calculator for a recipe batch
function calcRecipeCost(db, recipe) {
  const items = (recipe.ingredients || []).map(ing => {
    const p = findProduct(db, ing.productId);
    if (!p) return { productMissing: true, productId: ing.productId, qty: ing.qty, cost: 0 };
    const cost = (Number(p.pricePerUnit) || 0) * (Number(ing.qty) || 0);
    return { product: p, productId: p.id, qty: ing.qty, unit: p.unit, cost };
  });
  const total = items.reduce((s, x) => s + (x.cost || 0), 0);
  const perPiece = recipe.yieldQty ? total / recipe.yieldQty : null;
  return { total, perPiece, items };
}

function scaleIngredients(recipe, factor = 1) {
  return (recipe.ingredients || []).map(ing => ({
    productId: ing.productId,
    qty: (Number(ing.qty) || 0) * factor,
    note: ing.note || ""
  }));
}

function computeAllergens(db, recipe) {
  const set = new Set();
  (recipe.ingredients || []).forEach(ing => {
    const p = findProduct(db, ing.productId);
    (p?.allergens || []).forEach(a => set.add(a));
  });
  return Array.from(set);
}

/* -------------------- Health & Meta -------------------- */
app.get("/health", async (_req, res) => {
  try {
    const db = await readDB();
    ok(res, {
      status: "healthy",
      version: db.meta?.version || null,
      updatedAt: db.meta?.updatedAt || null,
      shops: db.settings?.shops || []
    });
  } catch (e) {
    bad(res, `Unhealthy: ${e.message}`, 500);
  }
});

app.get("/metrics", async (_req, res) => {
  const db = await readDB();
  ok(res, {
    counts: {
      products: db.products.length,
      recipes: db.recipes.length,
      plan: db.plan.length,
      leftovers: db.leftovers.length
    },
    updatedAt: db.meta.updatedAt,
    lastSnapshot: db.meta.lastSnapshot
  });
});

/* -------------------- Settings -------------------- */
app.get("/settings", async (_req, res) => {
  const db = await readDB();
  ok(res, db.settings);
});

app.put("/settings", requireAdmin, async (req, res) => {
  const updates = req.body || {};
  await writeDB(db => {
    db.settings = { ...db.settings, ...updates };
    return db;
  });
  ok(res, true);
});

/* -------------------- Import / Export / Backups -------------------- */
app.get("/export", requireAdmin, async (_req, res) => {
  const db = await readDB();
  ok(res, db);
});

app.post("/import", requireAdmin, async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object") return bad(res, "Invalid payload");
  await replaceDB(incoming);
  ok(res, true);
});

app.get("/backups", requireAdmin, async (_req, res) => {
  ok(res, await listSnapshots());
});

app.get("/backups/:name", requireAdmin, async (req, res) => {
  const data = await readSnapshot(req.params.name).catch(e => ({ __error: e.message }));
  if (data.__error) return bad(res, data.__error, 404);
  ok(res, data);
});

/* -------------------- Products -------------------- */
app.get("/products", async (_req, res) => {
  const db = await readDB();
  ok(res, db.products);
});

app.post("/products", requireAdmin, async (req, res) => {
  const { name, group = "", unit = "", packSize = null, package: pkg = "", pricePerUnit = null, sku = "", ean = "", allergens = [] } = req.body || {};
  if (!name) return bad(res, "name is required");
  const item = { id: nanoid(), name, group, unit, packSize, package: pkg, pricePerUnit, sku, ean, allergens };
  await writeDB(db => { db.products.push(item); return db; });
  ok(res, item);
});

app.put("/products/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const updates = req.body || {};
  const result = await writeDB(db => {
    const i = db.products.findIndex(p => p.id === id);
    if (i === -1) throw new Error("Not found");
    db.products[i] = { ...db.products[i], ...updates, id };
    return db;
  }).catch(e => ({ __error: e.message }));
  if (result.__error) return bad(res, result.__error, 404);
  ok(res, true);
});

app.delete("/products/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  await writeDB(db => {
    db.products = db.products.filter(p => p.id !== id);
    db.recipes = db.recipes.map(r => ({
      ...r,
      ingredients: (r.ingredients || []).filter(i => i.productId !== id)
    }));
    return db;
  });
  ok(res, true);
});

/* -------------------- Recipes -------------------- */
app.get("/recipes", async (_req, res) => {
  const db = await readDB();
  ok(res, db.recipes);
});

app.post("/recipes", requireAdmin, async (req, res) => {
  const { name, yieldQty = 1, yieldUnit = "pcs", ingredients = [] } = req.body || {};
  if (!name) return bad(res, "name is required");
  const rec = { id: nanoid(), name, yieldQty, yieldUnit, ingredients };
  await writeDB(db => {
    rec.allergens = computeAllergens(db, rec);
    db.recipes.push(rec);
    return db;
  });
  ok(res, rec);
});

app.put("/recipes/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const updates = req.body || {};
  const r = await writeDB(db => {
    const idx = db.recipes.findIndex(r => r.id === id);
    if (idx === -1) throw new Error("Not found");
    const merged = { ...db.recipes[idx], ...updates, id };
    merged.allergens = computeAllergens(db, merged);
    db.recipes[idx] = merged;
    return db;
  }).catch(err => ({ __error: err.message }));
  if (r.__error) return bad(res, r.__error, 404);
  ok(res, true);
});

app.delete("/recipes/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  await writeDB(db => {
    db.recipes = db.recipes.filter(r => r.id !== id);
    db.plan = db.plan.filter(p => p.recipeId !== id);
    return db;
  });
  ok(res, true);
});

app.get("/recipes/:id/cost", async (req, res) => {
  const db = await readDB();
  const rec = findRecipe(db, req.params.id);
  if (!rec) return bad(res, "Not found", 404);
  ok(res, calcRecipeCost(db, rec));
});

/* -------------------- Plan -------------------- */
app.get("/plan", async (req, res) => {
  const { dateFrom, dateTo, shop } = req.query || {};
  const db = await readDB();
  let rows = db.plan;
  if (shop) rows = rows.filter(r => r.shop === shop);
  if (dateFrom) rows = rows.filter(r => r.date >= dateFrom);
  if (dateTo) rows = rows.filter(r => r.date <= dateTo);
  ok(res, rows);
});

app.post("/plan", requireAdmin, async (req, res) => {
  const { date, shop, recipeId, quantity = 1 } = req.body || {};
  if (!date || !shop || !recipeId) return bad(res, "date, shop, recipeId required");
  const row = { id: nanoid(), date, shop, recipeId, quantity: Number(quantity) };
  await writeDB(db => { db.plan.push(row); return db; });
  ok(res, row);
});

app.put("/plan/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const u = await writeDB(db => {
    const idx = db.plan.findIndex(p => p.id === id);
    if (idx === -1) throw new Error("Not found");
    db.plan[idx] = { ...db.plan[idx], ...req.body, id };
    return db;
  }).catch(err => ({ __error: err.message }));
  if (u.__error) return bad(res, u.__error, 404);
  ok(res, true);
});

app.delete("/plan/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  await writeDB(db => {
    db.plan = db.plan.filter(p => p.id !== id);
    return db;
  });
  ok(res, true);
});

/* -------------------- Smart helpers -------------------- */
app.get("/plan/validate", async (req, res) => {
  const { date, shop } = req.query || {};
  const db = await readDB();
  const rows = db.plan.filter(r => (!date || r.date === date) && (!shop || r.shop === shop));
  const issues = [];

  for (const r of rows) {
    const recipe = findRecipe(db, r.recipeId);
    if (!recipe) {
      issues.push({ type: "missing-recipe", planId: r.id, recipeId: r.recipeId });
      continue;
    }
    for (const ing of recipe.ingredients || []) {
      const p = findProduct(db, ing.productId);
      if (!p) {
        issues.push({ type: "missing-product", planId: r.id, recipeId: r.recipeId, productId: ing.productId });
      }
    }
  }

  if (db.settings?.capacity?.ovenBatchMax && date && shop) {
    const totalBatches = rows.reduce((s, r) => s + (r.quantity || 0), 0);
    if (totalBatches > db.settings.capacity.ovenBatchMax) {
      issues.push({ type: "capacity-exceeded", date, shop, limit: db.settings.capacity.ovenBatchMax, value: totalBatches });
    }
  }

  ok(res, { count: issues.length, issues });
});

app.get("/plan/summary", async (req, res) => {
  const { dateFrom, dateTo, shop } = req.query || {};
  const db = await readDB();

  let rows = db.plan;
  if (shop) rows = rows.filter(r => r.shop === shop);
  if (dateFrom) rows = rows.filter(r => r.date >= dateFrom);
  if (dateTo) rows = rows.filter(r => r.date <= dateTo);

  const agg = new Map();
  const detail = [];

  for (const r of rows) {
    const recipe = findRecipe(db, r.recipeId);
    if (!recipe) continue;
    const factor = Number(r.quantity || 1);
    const scaled = scaleIngredients(recipe, factor);

    for (const ing of scaled) {
      const p = findProduct(db, ing.productId);
      if (!p) continue;
      const key = p.id;
      const current = agg.get(key) || { product: p, qty: 0, unit: p.unit, cost: 0 };
      const addQty = Number(ing.qty) || 0;
      current.qty += addQty;
      current.cost += (Number(p.pricePerUnit) || 0) * addQty;
      agg.set(key, current);

      detail.push({ planId: r.id, date: r.date, shop: r.shop, recipeId: recipe.id, recipeName: recipe.name, productId: p.id, productName: p.name, qty: addQty, unit: p.unit });
    }
  }

  const totals = Array.from(agg.values()).map(v => ({
    productId: v.product.id,
    productName: v.product.name,
    group: v.product.group || "",
    unit: v.unit,
    qty: v.qty,
    estCost: v.cost
  }));

  const costTotal = totals.reduce((s, t) => s + (t.estCost || 0), 0);

  ok(res, { range: { dateFrom, dateTo, shop }, totals, costTotal, detail });
});

app.get("/ready-sheet", async (req, res) => {
  const { date, shop } = req.query || {};
  if (!date || !shop) return bad(res, "date and shop required");
  const db = await readDB();
  const rows = db.plan.filter(r => r.date === date && r.shop === shop);

  const items = [];
  for (const r of rows) {
    const recipe = findRecipe(db, r.recipeId);
    if (!recipe) continue;
    const factor = Number(r.quantity || 1);
    const scaled = scaleIngredients(recipe, factor);
    const ingredients = scaled.map(ing => {
      const p = findProduct(db, ing.productId);
      if (!p) return { productMissing: true, productId: ing.productId, qty: ing.qty };
      return { productId: p.id, name: p.name, qty: ing.qty, unit: p.unit };
    });
    const cost = calcRecipeCost(db, recipe);
    items.push({
      planId: r.id,
      recipeId: recipe.id,
      recipeName: recipe.name,
      batches: factor,
      yieldPerBatch: recipe.yieldQty,
      totalPieces: recipe.yieldQty ? recipe.yieldQty * factor : null,
      ingredients,
      batchCost: cost.total,
      estCost: cost.total * factor
    });
  }

  ok(res, { date, shop, items });
});

/* -------------------- Leftovers & Suggestions -------------------- */
app.post("/leftovers", async (req, res) => {
  const { date, shop, recipeId, pieces = 0, note = "" } = req.body || {};
  if (!date || !shop || !recipeId) return bad(res, "date, shop, recipeId required");
  const row = { id: nanoid(), date, shop, recipeId, pieces: Number(pieces || 0), note };
  await writeDB(db => { db.leftovers.push(row); return db; });
  ok(res, row);
});

app.get("/leftovers", async (req, res) => {
  const { dateFrom, dateTo, shop, recipeId } = req.query || {};
  const db = await readDB();
  let rows = db.leftovers;
  if (shop) rows = rows.filter(r => r.shop === shop);
  if (recipeId) rows = rows.filter(r => r.recipeId === recipeId);
  if (dateFrom) rows = rows.filter(r => r.date >= dateFrom);
  if (dateTo) rows = rows.filter(r => r.date <= dateTo);
  ok(res, rows);
});

app.get("/plan/suggest-next", async (req, res) => {
  const { date, shop } = req.query || {};
  if (!date || !shop) return bad(res, "date and shop required");
  const db = await readDB();

  const prevDate = new Date(date);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevStr = prevDate.toISOString().slice(0, 10);

  const todayRows = db.plan.filter(r => r.date === date && r.shop === shop);
  const leftovers = db.leftovers.filter(l => l.date === prevStr && l.shop === shop);

  const suggestions = [];
  for (const row of todayRows) {
    const recipe = findRecipe(db, row.recipeId);
    if (!recipe || !recipe.yieldQty) {
      suggestions.push({ planId: row.id, recipeId: row.recipeId, suggestedQuantity: row.quantity, reason: "no-yield-or-missing-recipe" });
      continue;
    }
    const lo = leftovers.find(x => x.recipeId === row.recipeId);
    if (!lo || !lo.pieces) {
      suggestions.push({ planId: row.id, recipeId: row.recipeId, suggestedQuantity: row.quantity, reason: "no-leftover" });
      continue;
    }
    const reduceBatches = lo.pieces / recipe.yieldQty;
    const suggested = Math.max(0, Math.round((row.quantity - reduceBatches) * 100) / 100);
    suggestions.push({ planId: row.id, recipeId: row.recipeId, prevLeftoverPieces: lo.pieces, currentQuantity: row.quantity, suggestedQuantity: suggested, reason: "leftover-adjust" });
  }

  ok(res, { date, shop, suggestions });
});

/* -------------------- Start -------------------- */
const server = app.listen(PORT, () => {
  console.log(`Bunca Bakeflow API + Frontend listening on :${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
