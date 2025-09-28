// storage.js
// Flat-file JSON storage with serialized writes + daily snapshots.
// Schema has versioning and light migrations for future changes.

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

// ---- helpers ----
async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
}

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fileExists(p) {
  try { await fsp.access(p, fs.constants.F_OK); return true; }
  catch { return false; }
}

const BASE_STATE = () => ({
  meta: {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSnapshot: null
  },
  settings: {
    shops: ["City", "Berger", "GBW"],
    units: ["kg","g","l","ml","pcs","box"],
    capacity: { // optional hints, not enforced unless you use validations
      ovenBatchMax: null // e.g., 6 batches per hour
    }
  },
  products: [
    // { id, name, group, unit, packSize, package, pricePerUnit, sku, ean, allergens: ["gluten","nuts",...] }
  ],
  recipes: [
    // { id, name, yieldQty, yieldUnit, ingredients: [{ productId, qty, note }], allergens: [] (computed but we can store last calc) }
  ],
  plan: [
    // { id, date: "YYYY-MM-DD", shop: "City", recipeId, quantity: 1 } // quantity = batches
  ],
  leftovers: [
    // { id, date: "YYYY-MM-DD", shop, recipeId, pieces: 0, note: "" }
  ]
});

let writeQueue = Promise.resolve();

async function ensureFile() {
  await ensureDirs();
  if (!(await fileExists(DB_FILE))) {
    const initial = BASE_STATE();
    await fsp.writeFile(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

async function readRaw() {
  await ensureFile();
  const raw = await fsp.readFile(DB_FILE, "utf8");
  return JSON.parse(raw);
}

function migrate(db) {
  // Example migration path:
  if (!db.meta) db.meta = {};
  if (!db.meta.version) db.meta.version = 1;

  if (db.meta.version === 1) {
    // v1 -> v2: add settings, leftovers if missing
    db.settings ||= {
      shops: ["City","Berger","GBW"],
      units: ["kg","g","l","ml","pcs","box"],
      capacity: { ovenBatchMax: null }
    };
    db.leftovers ||= [];
    db.meta.version = 2;
  }

  return db;
}

export async function readDB() {
  const db = migrate(await readRaw());
  // No write here; write happens on mutations
  return db;
}

async function snapshotIfNeeded(next) {
  const today = todayStr();
  if (next.meta.lastSnapshot === today) return;

  const snapPath = path.join(BACKUP_DIR, `db-${today}.json`);
  if (!(await fileExists(snapPath))) {
    await fsp.writeFile(snapPath, JSON.stringify(next, null, 2));
  }
  next.meta.lastSnapshot = today;
}

export function writeDB(mutator) {
  writeQueue = writeQueue.then(async () => {
    const curr = migrate(await readRaw());
    const next = await mutator(structuredClone(curr));
    next.meta ||= {};
    await snapshotIfNeeded(next);
    next.meta.updatedAt = new Date().toISOString();
    await fsp.writeFile(DB_FILE, JSON.stringify(next, null, 2));
    return next;
  });
  return writeQueue;
}

export async function replaceDB(newState) {
  return writeDB(() => newState);
}

export async function listSnapshots() {
  await ensureDirs();
  const files = await fsp.readdir(BACKUP_DIR).catch(() => []);
  return files.filter(f => f.startsWith("db-") && f.endsWith(".json"));
}

export async function readSnapshot(name) {
  const p = path.join(BACKUP_DIR, name);
  const raw = await fsp.readFile(p, "utf8");
  return JSON.parse(raw);
}
