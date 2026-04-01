'use strict';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is missing');
}

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

const ORDER_STATUS = {
  DRAFT: 'ENTWURF',
  SUBMITTED: 'ABGEGEBEN',
};

const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS);

function normalizeDateInput(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid date');
  }
  return d.toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNonNegative(value) {
  return Math.max(0, toNumber(value, 0));
}

function slugify(text = '') {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildItemCode(name) {
  const base = slugify(name) || `item-${Date.now()}`;
  return base;
}

function calcSuggestedQty(soll, ist) {
  return Math.max(clampNonNegative(soll) - clampNonNegative(ist), 0);
}

async function query(text, params = []) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bakery_items (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'Stk',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bakery_item_shop_settings (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES bakery_items(id) ON DELETE CASCADE,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      soll_bestand NUMERIC(10,2) NOT NULL DEFAULT 0,
      active_for_shop BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (item_id, shop_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bakery_orders (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
      order_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'ENTWURF',
      note TEXT NOT NULL DEFAULT '',
      submitted_at TIMESTAMPTZ NULL,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bakery_orders_status_check CHECK (status IN ('ENTWURF', 'ABGEGEBEN'))
    );
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bakery_orders_shop_date_unique
    ON bakery_orders (shop_id, order_date);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bakery_order_lines (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES bakery_orders(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES bakery_items(id) ON DELETE RESTRICT,
      item_name_snapshot TEXT NOT NULL,
      category_snapshot TEXT NOT NULL DEFAULT '',
      unit_snapshot TEXT NOT NULL DEFAULT 'Stk',
      ist_bestand NUMERIC(10,2) NOT NULL DEFAULT 0,
      soll_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0,
      suggested_qty NUMERIC(10,2) NOT NULL DEFAULT 0,
      ordered_qty NUMERIC(10,2) NOT NULL DEFAULT 0,
      manual_override BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (order_id, item_id)
    );
  `);

  await seedDefaultShops();
}

async function seedDefaultShops() {
  const defaults = [
    { code: 'city', name: 'City', sortOrder: 1 },
    { code: 'berger', name: 'Berger Straße', sortOrder: 2 },
    { code: 'gbw', name: 'Grüneburgweg', sortOrder: 3 },
  ];

  for (const shop of defaults) {
    await query(
      `
      INSERT INTO shops (code, name, sort_order)
      VALUES ($1, $2, $3)
      ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name,
          sort_order = EXCLUDED.sort_order,
          updated_at = NOW();
      `,
      [shop.code, shop.name, shop.sortOrder]
    );
  }
}

async function listShops({ activeOnly = false } = {}) {
  const params = [];
  let where = '';
  if (activeOnly) {
    params.push(true);
    where = `WHERE s.active = $${params.length}`;
  }

  const { rows } = await query(
    `
    SELECT
      s.id,
      s.code,
      s.name,
      s.active,
      s.sort_order AS "sortOrder"
    FROM shops s
    ${where}
    ORDER BY s.sort_order ASC, s.name ASC;
    `,
    params
  );

  return rows;
}

async function getShopById(shopId) {
  const { rows } = await query(
    `
    SELECT
      s.id,
      s.code,
      s.name,
      s.active,
      s.sort_order AS "sortOrder"
    FROM shops s
    WHERE s.id = $1
    LIMIT 1;
    `,
    [shopId]
  );
  return rows[0] || null;
}

async function getShopByCode(code) {
  const { rows } = await query(
    `
    SELECT
      s.id,
      s.code,
      s.name,
      s.active,
      s.sort_order AS "sortOrder"
    FROM shops s
    WHERE s.code = $1
    LIMIT 1;
    `,
    [code]
  );
  return rows[0] || null;
}

async function createShop({ code, name, sortOrder = 0, active = true }) {
  const finalCode = slugify(code || name);
  if (!finalCode) {
    throw new Error('Shop code is required');
  }
  if (!name || !String(name).trim()) {
    throw new Error('Shop name is required');
  }

  const { rows } = await query(
    `
    INSERT INTO shops (code, name, sort_order, active)
    VALUES ($1, $2, $3, $4)
    RETURNING
      id,
      code,
      name,
      active,
      sort_order AS "sortOrder";
    `,
    [finalCode, String(name).trim(), toNumber(sortOrder, 0), !!active]
  );

  return rows[0];
}

async function updateShop(shopId, { name, sortOrder, active }) {
  const current = await getShopById(shopId);
  if (!current) {
    throw new Error('Shop not found');
  }

  const { rows } = await query(
    `
    UPDATE shops
    SET
      name = $2,
      sort_order = $3,
      active = $4,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      code,
      name,
      active,
      sort_order AS "sortOrder";
    `,
    [
      shopId,
      name != null ? String(name).trim() : current.name,
      sortOrder != null ? toNumber(sortOrder, 0) : current.sortOrder,
      active != null ? !!active : current.active,
    ]
  );

  return rows[0];
}

async function listItems({ activeOnly = false, includeShopSettings = false } = {}) {
  const params = [];
  let where = '';
  if (activeOnly) {
    params.push(true);
    where = `WHERE i.active = $${params.length}`;
  }

  const { rows } = await query(
    `
    SELECT
      i.id,
      i.code,
      i.name,
      i.category,
      i.unit,
      i.sort_order AS "sortOrder",
      i.active
    FROM bakery_items i
    ${where}
    ORDER BY
      COALESCE(NULLIF(i.category, ''), 'ZZZ') ASC,
      i.sort_order ASC,
      i.name ASC;
    `,
    params
  );

  if (!includeShopSettings || rows.length === 0) {
    return rows;
  }

  const settings = await listItemShopSettings();
  const settingsMap = new Map();

  for (const setting of settings) {
    const key = setting.itemId;
    if (!settingsMap.has(key)) {
      settingsMap.set(key, []);
    }
    settingsMap.get(key).push(setting);
  }

  return rows.map((item) => ({
    ...item,
    shopSettings: settingsMap.get(item.id) || [],
  }));
}

async function getItemById(itemId) {
  const { rows } = await query(
    `
    SELECT
      i.id,
      i.code,
      i.name,
      i.category,
      i.unit,
      i.sort_order AS "sortOrder",
      i.active
    FROM bakery_items i
    WHERE i.id = $1
    LIMIT 1;
    `,
    [itemId]
  );
  return rows[0] || null;
}

async function createItem({
  name,
  category = '',
  unit = 'Stk',
  sortOrder = 0,
  active = true,
}) {
  if (!name || !String(name).trim()) {
    throw new Error('Item name is required');
  }

  const trimmedName = String(name).trim();
  let code = buildItemCode(trimmedName);
  let suffix = 1;

  while (await itemCodeExists(code)) {
    suffix += 1;
    code = `${buildItemCode(trimmedName)}-${suffix}`;
  }

  const { rows } = await query(
    `
    INSERT INTO bakery_items (code, name, category, unit, sort_order, active)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING
      id,
      code,
      name,
      category,
      unit,
      sort_order AS "sortOrder",
      active;
    `,
    [
      code,
      trimmedName,
      String(category || '').trim(),
      String(unit || 'Stk').trim() || 'Stk',
      toNumber(sortOrder, 0),
      !!active,
    ]
  );

  return rows[0];
}

async function itemCodeExists(code) {
  const { rows } = await query(
    `SELECT 1 FROM bakery_items WHERE code = $1 LIMIT 1;`,
    [code]
  );
  return !!rows[0];
}

async function updateItem(itemId, data = {}) {
  const current = await getItemById(itemId);
  if (!current) {
    throw new Error('Item not found');
  }

  const { rows } = await query(
    `
    UPDATE bakery_items
    SET
      name = $2,
      category = $3,
      unit = $4,
      sort_order = $5,
      active = $6,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      code,
      name,
      category,
      unit,
      sort_order AS "sortOrder",
      active;
    `,
    [
      itemId,
      data.name != null ? String(data.name).trim() : current.name,
      data.category != null ? String(data.category).trim() : current.category,
      data.unit != null ? String(data.unit).trim() || 'Stk' : current.unit,
      data.sortOrder != null ? toNumber(data.sortOrder, 0) : current.sortOrder,
      data.active != null ? !!data.active : current.active,
    ]
  );

  return rows[0];
}

async function setItemActive(itemId, active) {
  return updateItem(itemId, { active: !!active });
}

function parseBulkItems(text = '') {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const results = [];

  for (const line of lines) {
    const parts = line.split(';').map((part) => part.trim());
    if (!parts[0]) continue;

    results.push({
      name: parts[0],
      category: parts[1] || '',
      unit: parts[2] || 'Stk',
      sortOrder: parts[3] ? toNumber(parts[3], 0) : 0,
    });
  }

  return results;
}

async function bulkCreateItems(text) {
  const parsed = parseBulkItems(text);
  if (!parsed.length) {
    return [];
  }

  const created = [];
  for (const row of parsed) {
    created.push(await createItem(row));
  }
  return created;
}

async function listItemShopSettings({ activeItemsOnly = false, activeShopsOnly = false } = {}) {
  const whereParts = [];
  const params = [];

  if (activeItemsOnly) {
    params.push(true);
    whereParts.push(`i.active = $${params.length}`);
  }

  if (activeShopsOnly) {
    params.push(true);
    whereParts.push(`s.active = $${params.length}`);
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const { rows } = await query(
    `
    SELECT
      iss.id,
      iss.item_id AS "itemId",
      iss.shop_id AS "shopId",
      iss.soll_bestand AS "sollBestand",
      iss.active_for_shop AS "activeForShop",
      i.name AS "itemName",
      i.category AS "itemCategory",
      i.unit AS "itemUnit",
      i.sort_order AS "itemSortOrder",
      i.active AS "itemActive",
      s.name AS "shopName",
      s.code AS "shopCode",
      s.sort_order AS "shopSortOrder",
      s.active AS "shopActive"
    FROM bakery_item_shop_settings iss
    INNER JOIN bakery_items i ON i.id = iss.item_id
    INNER JOIN shops s ON s.id = iss.shop_id
    ${where}
    ORDER BY s.sort_order ASC, i.sort_order ASC, i.name ASC;
    `,
    params
  );

  return rows.map((row) => ({
    ...row,
    sollBestand: toNumber(row.sollBestand, 0),
  }));
}

async function getItemShopSetting(itemId, shopId) {
  const { rows } = await query(
    `
    SELECT
      iss.id,
      iss.item_id AS "itemId",
      iss.shop_id AS "shopId",
      iss.soll_bestand AS "sollBestand",
      iss.active_for_shop AS "activeForShop"
    FROM bakery_item_shop_settings iss
    WHERE iss.item_id = $1 AND iss.shop_id = $2
    LIMIT 1;
    `,
    [itemId, shopId]
  );

  if (!rows[0]) return null;

  return {
    ...rows[0],
    sollBestand: toNumber(rows[0].sollBestand, 0),
  };
}

async function upsertItemShopSetting({
  itemId,
  shopId,
  sollBestand = 0,
  activeForShop = true,
}) {
  const { rows } = await query(
    `
    INSERT INTO bakery_item_shop_settings (
      item_id,
      shop_id,
      soll_bestand,
      active_for_shop
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (item_id, shop_id)
    DO UPDATE SET
      soll_bestand = EXCLUDED.soll_bestand,
      active_for_shop = EXCLUDED.active_for_shop,
      updated_at = NOW()
    RETURNING
      id,
      item_id AS "itemId",
      shop_id AS "shopId",
      soll_bestand AS "sollBestand",
      active_for_shop AS "activeForShop";
    `,
    [itemId, shopId, clampNonNegative(sollBestand), !!activeForShop]
  );

  return {
    ...rows[0],
    sollBestand: toNumber(rows[0].sollBestand, 0),
  };
}

async function bulkUpsertItemShopSettings(rows = []) {
  const results = [];
  for (const row of rows) {
    results.push(await upsertItemShopSetting(row));
  }
  return results;
}

async function ensureAllShopSettingsForItem(itemId, defaultSoll = 0) {
  const shops = await listShops();
  const results = [];

  for (const shop of shops) {
    results.push(
      await upsertItemShopSetting({
        itemId,
        shopId: shop.id,
        sollBestand: defaultSoll,
        activeForShop: true,
      })
    );
  }

  return results;
}

async function getOrCreateOrder({
  shopId,
  orderDate = new Date(),
  createdBy = '',
}) {
  const finalDate = normalizeDateInput(orderDate);

  return withTransaction(async (client) => {
    const existing = await client.query(
      `
      SELECT
        o.id,
        o.shop_id AS "shopId",
        o.order_date AS "orderDate",
        o.status,
        o.note,
        o.submitted_at AS "submittedAt",
        o.created_by AS "createdBy",
        o.updated_by AS "updatedBy",
        o.created_at AS "createdAt",
        o.updated_at AS "updatedAt"
      FROM bakery_orders o
      WHERE o.shop_id = $1 AND o.order_date = $2
      LIMIT 1;
      `,
      [shopId, finalDate]
    );

    if (existing.rows[0]) {
      return mapOrderRow(existing.rows[0]);
    }

    const inserted = await client.query(
      `
      INSERT INTO bakery_orders (
        shop_id,
        order_date,
        status,
        note,
        created_by,
        updated_by
      )
      VALUES ($1, $2, $3, '', $4, $4)
      RETURNING
        id,
        shop_id AS "shopId",
        order_date AS "orderDate",
        status,
        note,
        submitted_at AS "submittedAt",
        created_by AS "createdBy",
        updated_by AS "updatedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt";
      `,
      [shopId, finalDate, ORDER_STATUS.DRAFT, String(createdBy || '').trim()]
    );

    return mapOrderRow(inserted.rows[0]);
  });
}

async function getOrderById(orderId) {
  const { rows } = await query(
    `
    SELECT
      o.id,
      o.shop_id AS "shopId",
      o.order_date AS "orderDate",
      o.status,
      o.note,
      o.submitted_at AS "submittedAt",
      o.created_by AS "createdBy",
      o.updated_by AS "updatedBy",
      o.created_at AS "createdAt",
      o.updated_at AS "updatedAt",
      s.name AS "shopName",
      s.code AS "shopCode"
    FROM bakery_orders o
    INNER JOIN shops s ON s.id = o.shop_id
    WHERE o.id = $1
    LIMIT 1;
    `,
    [orderId]
  );

  if (!rows[0]) return null;
  return mapOrderRow(rows[0]);
}

async function getOrderByShopAndDate(shopId, orderDate) {
  const finalDate = normalizeDateInput(orderDate);

  const { rows } = await query(
    `
    SELECT
      o.id,
      o.shop_id AS "shopId",
      o.order_date AS "orderDate",
      o.status,
      o.note,
      o.submitted_at AS "submittedAt",
      o.created_by AS "createdBy",
      o.updated_by AS "updatedBy",
      o.created_at AS "createdAt",
      o.updated_at AS "updatedAt",
      s.name AS "shopName",
      s.code AS "shopCode"
    FROM bakery_orders o
    INNER JOIN shops s ON s.id = o.shop_id
    WHERE o.shop_id = $1 AND o.order_date = $2
    LIMIT 1;
    `,
    [shopId, finalDate]
  );

  if (!rows[0]) return null;
  return mapOrderRow(rows[0]);
}

async function getOrderWithLines(orderId) {
  const order = await getOrderById(orderId);
  if (!order) return null;

  const { rows } = await query(
    `
    SELECT
      l.id,
      l.order_id AS "orderId",
      l.item_id AS "itemId",
      l.item_name_snapshot AS "itemName",
      l.category_snapshot AS "category",
      l.unit_snapshot AS "unit",
      l.ist_bestand AS "istBestand",
      l.soll_snapshot AS "sollBestand",
      l.suggested_qty AS "suggestedQty",
      l.ordered_qty AS "orderedQty",
      l.manual_override AS "manualOverride",
      l.sort_order AS "sortOrder"
    FROM bakery_order_lines l
    WHERE l.order_id = $1
    ORDER BY
      COALESCE(NULLIF(l.category_snapshot, ''), 'ZZZ') ASC,
      l.sort_order ASC,
      l.item_name_snapshot ASC;
    `,
    [orderId]
  );

  order.lines = rows.map(mapOrderLineRow);
  return order;
}

async function getOrderEditorData({ shopId, orderDate = new Date(), createdBy = '' }) {
  const order = await getOrCreateOrder({ shopId, orderDate, createdBy });
  const finalDate = normalizeDateInput(orderDate);

  const itemsResult = await query(
    `
    SELECT
      i.id,
      i.name,
      i.category,
      i.unit,
      i.sort_order AS "sortOrder",
      iss.soll_bestand AS "sollBestand",
      iss.active_for_shop AS "activeForShop"
    FROM bakery_items i
    INNER JOIN bakery_item_shop_settings iss
      ON iss.item_id = i.id
    WHERE
      iss.shop_id = $1
      AND i.active = TRUE
      AND iss.active_for_shop = TRUE
    ORDER BY
      COALESCE(NULLIF(i.category, ''), 'ZZZ') ASC,
      i.sort_order ASC,
      i.name ASC;
    `,
    [shopId]
  );

  const lineRows = await query(
    `
    SELECT
      l.item_id AS "itemId",
      l.ist_bestand AS "istBestand",
      l.soll_snapshot AS "sollBestand",
      l.suggested_qty AS "suggestedQty",
      l.ordered_qty AS "orderedQty",
      l.manual_override AS "manualOverride"
    FROM bakery_order_lines l
    WHERE l.order_id = $1;
    `,
    [order.id]
  );

  const lineMap = new Map(
    lineRows.rows.map((row) => [
      row.itemId,
      {
        istBestand: toNumber(row.istBestand, 0),
        sollBestand: toNumber(row.sollBestand, 0),
        suggestedQty: toNumber(row.suggestedQty, 0),
        orderedQty: toNumber(row.orderedQty, 0),
        manualOverride: !!row.manualOverride,
      },
    ])
  );

  const items = itemsResult.rows.map((item) => {
    const existing = lineMap.get(item.id);
    const sollBestand = existing
      ? toNumber(existing.sollBestand, 0)
      : toNumber(item.sollBestand, 0);
    const istBestand = existing ? toNumber(existing.istBestand, 0) : 0;
    const suggestedQty = existing
      ? toNumber(existing.suggestedQty, 0)
      : calcSuggestedQty(sollBestand, istBestand);
    const orderedQty = existing
      ? toNumber(existing.orderedQty, 0)
      : suggestedQty;

    return {
      itemId: item.id,
      name: item.name,
      category: item.category,
      unit: item.unit,
      sortOrder: toNumber(item.sortOrder, 0),
      sollBestand,
      istBestand,
      suggestedQty,
      orderedQty,
      manualOverride: existing ? !!existing.manualOverride : false,
      orderDate: finalDate,
    };
  });

  return {
    order,
    items,
  };
}

async function saveOrderDraft({
  shopId,
  orderDate = new Date(),
  note = '',
  createdBy = '',
  updatedBy = '',
  lines = [],
}) {
  const finalDate = normalizeDateInput(orderDate);

  return withTransaction(async (client) => {
    let order = await client.query(
      `
      SELECT
        id,
        status
      FROM bakery_orders
      WHERE shop_id = $1 AND order_date = $2
      LIMIT 1;
      `,
      [shopId, finalDate]
    );

    if (!order.rows[0]) {
      const inserted = await client.query(
        `
        INSERT INTO bakery_orders (
          shop_id,
          order_date,
          status,
          note,
          created_by,
          updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, status;
        `,
        [
          shopId,
          finalDate,
          ORDER_STATUS.DRAFT,
          String(note || '').trim(),
          String(createdBy || '').trim(),
          String(updatedBy || createdBy || '').trim(),
        ]
      );
      order = inserted;
    } else {
      if (order.rows[0].status === ORDER_STATUS.SUBMITTED) {
        throw new Error('Submitted orders cannot be changed');
      }

      await client.query(
        `
        UPDATE bakery_orders
        SET
          note = $2,
          updated_by = $3,
          updated_at = NOW()
        WHERE id = $1;
        `,
        [
          order.rows[0].id,
          String(note || '').trim(),
          String(updatedBy || createdBy || '').trim(),
        ]
      );
    }

    const orderId = order.rows[0].id;

    const itemIds = [...new Set(lines.map((line) => toNumber(line.itemId, 0)).filter(Boolean))];
    if (!itemIds.length) {
      const saved = await getOrderWithLines(orderId);
      return saved;
    }

    const itemMeta = await client.query(
      `
      SELECT
        i.id,
        i.name,
        i.category,
        i.unit,
        i.sort_order AS "sortOrder",
        COALESCE(iss.soll_bestand, 0) AS "sollBestand"
      FROM bakery_items i
      LEFT JOIN bakery_item_shop_settings iss
        ON iss.item_id = i.id AND iss.shop_id = $2
      WHERE i.id = ANY($1::int[]);
      `,
      [itemIds, shopId]
    );

    const metaMap = new Map(
      itemMeta.rows.map((row) => [
        row.id,
        {
          itemId: row.id,
          itemName: row.name,
          category: row.category,
          unit: row.unit,
          sortOrder: toNumber(row.sortOrder, 0),
          sollBestand: toNumber(row.sollBestand, 0),
        },
      ])
    );

    for (const line of lines) {
      const itemId = toNumber(line.itemId, 0);
      if (!itemId || !metaMap.has(itemId)) continue;

      const meta = metaMap.get(itemId);
      const istBestand = clampNonNegative(line.istBestand);
      const sollBestand = meta.sollBestand;
      const suggestedQty = calcSuggestedQty(sollBestand, istBestand);

      let orderedQty = line.orderedQty == null || line.orderedQty === ''
        ? suggestedQty
        : clampNonNegative(line.orderedQty);

      const manualOverride = orderedQty !== suggestedQty;

      await client.query(
        `
        INSERT INTO bakery_order_lines (
          order_id,
          item_id,
          item_name_snapshot,
          category_snapshot,
          unit_snapshot,
          ist_bestand,
          soll_snapshot,
          suggested_qty,
          ordered_qty,
          manual_override,
          sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (order_id, item_id)
        DO UPDATE SET
          item_name_snapshot = EXCLUDED.item_name_snapshot,
          category_snapshot = EXCLUDED.category_snapshot,
          unit_snapshot = EXCLUDED.unit_snapshot,
          ist_bestand = EXCLUDED.ist_bestand,
          soll_snapshot = EXCLUDED.soll_snapshot,
          suggested_qty = EXCLUDED.suggested_qty,
          ordered_qty = EXCLUDED.ordered_qty,
          manual_override = EXCLUDED.manual_override,
          sort_order = EXCLUDED.sort_order,
          updated_at = NOW();
        `,
        [
          orderId,
          itemId,
          meta.itemName,
          meta.category,
          meta.unit,
          istBestand,
          sollBestand,
          suggestedQty,
          orderedQty,
          manualOverride,
          meta.sortOrder,
        ]
      );
    }

    return getOrderWithLines(orderId);
  });
}

async function submitOrder({
  shopId,
  orderDate = new Date(),
  note = '',
  createdBy = '',
  updatedBy = '',
  lines = [],
}) {
  const saved = await saveOrderDraft({
    shopId,
    orderDate,
    note,
    createdBy,
    updatedBy,
    lines,
  });

  if (!saved || !saved.id) {
    throw new Error('Could not save order before submit');
  }

  await query(
    `
    UPDATE bakery_orders
    SET
      status = $2,
      submitted_at = NOW(),
      updated_by = $3,
      updated_at = NOW()
    WHERE id = $1;
    `,
    [saved.id, ORDER_STATUS.SUBMITTED, String(updatedBy || createdBy || '').trim()]
  );

  return getOrderWithLines(saved.id);
}

async function reopenOrder(orderId, updatedBy = '') {
  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  await query(
    `
    UPDATE bakery_orders
    SET
      status = $2,
      submitted_at = NULL,
      updated_by = $3,
      updated_at = NOW()
    WHERE id = $1;
    `,
    [orderId, ORDER_STATUS.DRAFT, String(updatedBy || '').trim()]
  );

  return getOrderWithLines(orderId);
}

async function listOrders({
  shopId = null,
  status = null,
  dateFrom = null,
  dateTo = null,
  onlySubmitted = false,
} = {}) {
  const whereParts = [];
  const params = [];

  if (shopId) {
    params.push(shopId);
    whereParts.push(`o.shop_id = $${params.length}`);
  }

  if (onlySubmitted) {
    params.push(ORDER_STATUS.SUBMITTED);
    whereParts.push(`o.status = $${params.length}`);
  } else if (status && ORDER_STATUS_VALUES.includes(status)) {
    params.push(status);
    whereParts.push(`o.status = $${params.length}`);
  }

  if (dateFrom) {
    params.push(normalizeDateInput(dateFrom));
    whereParts.push(`o.order_date >= $${params.length}`);
  }

  if (dateTo) {
    params.push(normalizeDateInput(dateTo));
    whereParts.push(`o.order_date <= $${params.length}`);
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const { rows } = await query(
    `
    SELECT
      o.id,
      o.shop_id AS "shopId",
      o.order_date AS "orderDate",
      o.status,
      o.note,
      o.submitted_at AS "submittedAt",
      o.created_by AS "createdBy",
      o.updated_by AS "updatedBy",
      o.created_at AS "createdAt",
      o.updated_at AS "updatedAt",
      s.name AS "shopName",
      s.code AS "shopCode",
      COUNT(l.id)::int AS "lineCount",
      COALESCE(SUM(l.ordered_qty), 0) AS "totalOrderedQty"
    FROM bakery_orders o
    INNER JOIN shops s ON s.id = o.shop_id
    LEFT JOIN bakery_order_lines l ON l.order_id = o.id
    ${where}
    GROUP BY o.id, s.id
    ORDER BY o.order_date DESC, s.sort_order ASC, s.name ASC;
    `,
    params
  );

  return rows.map((row) => ({
    ...mapOrderRow(row),
    lineCount: toNumber(row.lineCount, 0),
    totalOrderedQty: toNumber(row.totalOrderedQty, 0),
  }));
}

async function getProductionReport({
  orderDate = new Date(),
  onlySubmitted = true,
} = {}) {
  const finalDate = normalizeDateInput(orderDate);
  const params = [finalDate];
  const statusClause = onlySubmitted ? `AND o.status = $2` : '';

  if (onlySubmitted) {
    params.push(ORDER_STATUS.SUBMITTED);
  }

  const { rows } = await query(
    `
    SELECT
      l.item_id AS "itemId",
      l.item_name_snapshot AS "itemName",
      l.category_snapshot AS "category",
      l.unit_snapshot AS "unit",
      MIN(l.sort_order) AS "sortOrder",
      SUM(l.ordered_qty) AS "totalOrderedQty",
      JSON_AGG(
        JSON_BUILD_OBJECT(
          'shopId', o.shop_id,
          'shopName', s.name,
          'shopCode', s.code,
          'orderedQty', l.ordered_qty,
          'istBestand', l.ist_bestand,
          'sollBestand', l.soll_snapshot
        )
        ORDER BY s.sort_order ASC
      ) AS shops
    FROM bakery_order_lines l
    INNER JOIN bakery_orders o ON o.id = l.order_id
    INNER JOIN shops s ON s.id = o.shop_id
    WHERE o.order_date = $1
    ${statusClause}
    GROUP BY
      l.item_id,
      l.item_name_snapshot,
      l.category_snapshot,
      l.unit_snapshot
    ORDER BY
      COALESCE(NULLIF(l.category_snapshot, ''), 'ZZZ') ASC,
      MIN(l.sort_order) ASC,
      l.item_name_snapshot ASC;
    `,
    params
  );

  return {
    orderDate: finalDate,
    items: rows.map((row) => ({
      itemId: row.itemId,
      itemName: row.itemName,
      category: row.category,
      unit: row.unit,
      sortOrder: toNumber(row.sortOrder, 0),
      totalOrderedQty: toNumber(row.totalOrderedQty, 0),
      shops: Array.isArray(row.shops)
        ? row.shops.map((shop) => ({
            ...shop,
            orderedQty: toNumber(shop.orderedQty, 0),
            istBestand: toNumber(shop.istBestand, 0),
            sollBestand: toNumber(shop.sollBestand, 0),
          }))
        : [],
    })),
  };
}

async function getDateRangeReport({
  dateFrom,
  dateTo,
  shopId = null,
  onlySubmitted = true,
} = {}) {
  if (!dateFrom || !dateTo) {
    throw new Error('dateFrom and dateTo are required');
  }

  const params = [normalizeDateInput(dateFrom), normalizeDateInput(dateTo)];
  const whereParts = [
    `o.order_date >= $1`,
    `o.order_date <= $2`,
  ];

  if (onlySubmitted) {
    params.push(ORDER_STATUS.SUBMITTED);
    whereParts.push(`o.status = $${params.length}`);
  }

  if (shopId) {
    params.push(shopId);
    whereParts.push(`o.shop_id = $${params.length}`);
  }

  const { rows } = await query(
    `
    SELECT
      l.item_id AS "itemId",
      l.item_name_snapshot AS "itemName",
      l.category_snapshot AS "category",
      l.unit_snapshot AS "unit",
      MIN(l.sort_order) AS "sortOrder",
      SUM(l.ordered_qty) AS "totalOrderedQty",
      COUNT(DISTINCT o.id)::int AS "orderCount"
    FROM bakery_order_lines l
    INNER JOIN bakery_orders o ON o.id = l.order_id
    WHERE ${whereParts.join(' AND ')}
    GROUP BY
      l.item_id,
      l.item_name_snapshot,
      l.category_snapshot,
      l.unit_snapshot
    ORDER BY
      COALESCE(NULLIF(l.category_snapshot, ''), 'ZZZ') ASC,
      MIN(l.sort_order) ASC,
      l.item_name_snapshot ASC;
    `,
    params
  );

  const totals = await query(
    `
    SELECT
      COUNT(DISTINCT o.id)::int AS "totalOrders",
      COUNT(DISTINCT o.shop_id)::int AS "totalShops",
      COALESCE(SUM(l.ordered_qty), 0) AS "totalOrderedQty"
    FROM bakery_orders o
    LEFT JOIN bakery_order_lines l ON l.order_id = o.id
    WHERE ${whereParts.join(' AND ')};
    `,
    params
  );

  return {
    dateFrom: normalizeDateInput(dateFrom),
    dateTo: normalizeDateInput(dateTo),
    items: rows.map((row) => ({
      itemId: row.itemId,
      itemName: row.itemName,
      category: row.category,
      unit: row.unit,
      sortOrder: toNumber(row.sortOrder, 0),
      totalOrderedQty: toNumber(row.totalOrderedQty, 0),
      orderCount: toNumber(row.orderCount, 0),
    })),
    totals: {
      totalOrders: toNumber(totals.rows[0]?.totalOrders, 0),
      totalShops: toNumber(totals.rows[0]?.totalShops, 0),
      totalOrderedQty: toNumber(totals.rows[0]?.totalOrderedQty, 0),
    },
  };
}

function mapOrderRow(row) {
  return {
    id: row.id,
    shopId: row.shopId,
    shopName: row.shopName,
    shopCode: row.shopCode,
    orderDate: typeof row.orderDate === 'string'
      ? row.orderDate.slice(0, 10)
      : normalizeDateInput(row.orderDate),
    status: row.status,
    note: row.note || '',
    submittedAt: row.submittedAt || null,
    createdBy: row.createdBy || '',
    updatedBy: row.updatedBy || '',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function mapOrderLineRow(row) {
  return {
    id: row.id,
    orderId: row.orderId,
    itemId: row.itemId,
    itemName: row.itemName,
    category: row.category,
    unit: row.unit,
    istBestand: toNumber(row.istBestand, 0),
    sollBestand: toNumber(row.sollBestand, 0),
    suggestedQty: toNumber(row.suggestedQty, 0),
    orderedQty: toNumber(row.orderedQty, 0),
    manualOverride: !!row.manualOverride,
    sortOrder: toNumber(row.sortOrder, 0),
  };
}

module.exports = {
  pool,
  ORDER_STATUS,
  init,

  listShops,
  getShopById,
  getShopByCode,
  createShop,
  updateShop,

  listItems,
  getItemById,
  createItem,
  updateItem,
  setItemActive,
  parseBulkItems,
  bulkCreateItems,

  listItemShopSettings,
  getItemShopSetting,
  upsertItemShopSetting,
  bulkUpsertItemShopSettings,
  ensureAllShopSettingsForItem,

  getOrCreateOrder,
  getOrderById,
  getOrderByShopAndDate,
  getOrderWithLines,
  getOrderEditorData,
  saveOrderDraft,
  submitOrder,
  reopenOrder,
  listOrders,

  getProductionReport,
  getDateRangeReport,

  calcSuggestedQty,
  normalizeDateInput,
};
