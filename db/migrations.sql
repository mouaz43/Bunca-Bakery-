-- Enable uuid if needed later
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', -- 'admin' | 'staff' | 'viewer'
  recipe_access BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- SHOPS
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

-- SETTINGS (key/value as JSON)
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value_json JSONB NOT NULL
);

-- UNITS (for conversions; base ratios)
CREATE TABLE IF NOT EXISTS units (
  code TEXT PRIMARY KEY,         -- e.g., g, kg, ml, l, pcs
  label TEXT NOT NULL,
  ratio_to_base NUMERIC NOT NULL -- relative to that unit's base family, e.g., kg -> g = 1000
);

-- PRODUCTS (Rohwaren)
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL,         -- purchasing unit (e.g., kg)
  base_unit TEXT NOT NULL,    -- calculation base (e.g., g)
  unit_cost NUMERIC NOT NULL DEFAULT 0, -- cost per purchasing unit
  pack_size NUMERIC,
  pack_unit TEXT,
  waste_pct NUMERIC NOT NULL DEFAULT 0,
  supplier TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ITEMS (finished goods / recipes)
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  yield_qty NUMERIC NOT NULL,
  yield_unit TEXT NOT NULL,     -- e.g., pcs
  image_url TEXT,
  notes TEXT
);

-- RECIPE BOM (ingredients for each item)
CREATE TABLE IF NOT EXISTS recipe_items (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty NUMERIC NOT NULL,
  unit TEXT NOT NULL            -- unit as entered in recipe (convert via units table)
);

-- STATIONS (optional; for print grouping)
CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- PRODUCTION DAYS (what to produce)
CREATE TABLE IF NOT EXISTS production_days (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  total_qty NUMERIC NOT NULL,
  batch_size NUMERIC,
  start_time TIME,
  station TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'planned' -- planned | in_progress | done
);

-- ALLOCATIONS (split per shop)
CREATE TABLE IF NOT EXISTS allocations (
  id SERIAL PRIMARY KEY,
  production_day_id INTEGER NOT NULL REFERENCES production_days(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  qty NUMERIC NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_production_days_date ON production_days(date);
CREATE INDEX IF NOT EXISTS idx_recipe_items_item ON recipe_items(item_id);
CREATE INDEX IF NOT EXISTS idx_allocations_pd ON allocations(production_day_id);
