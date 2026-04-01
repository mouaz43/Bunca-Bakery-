'use strict';

const express = require('express');
const store = require('../data/store');

const router = express.Router();

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'ja'].includes(normalized);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getUserIdentity(req) {
  return (
    req.session?.user?.email ||
    req.session?.user?.name ||
    req.session?.admin?.email ||
    req.session?.admin?.name ||
    'System'
  );
}

function redirectWithMessage(res, basePath, params = {}) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }

  const query = search.toString();
  return res.redirect(query ? `${basePath}?${query}` : basePath);
}

function normalizeLinesPayload(body) {
  const itemIds = Array.isArray(body.itemId) ? body.itemId : [body.itemId];
  const istValues = Array.isArray(body.istBestand) ? body.istBestand : [body.istBestand];
  const orderedValues = Array.isArray(body.orderedQty) ? body.orderedQty : [body.orderedQty];

  const lines = [];

  for (let i = 0; i < itemIds.length; i += 1) {
    const itemId = toNumber(itemIds[i], 0);
    if (!itemId) continue;

    lines.push({
      itemId,
      istBestand: istValues[i] ?? '',
      orderedQty: orderedValues[i] ?? '',
    });
  }

  return lines;
}

function parseShopSollUpdates(body) {
  const updates = [];
  const payloadKeys = Object.keys(body);

  for (const key of payloadKeys) {
    const match = key.match(/^soll_(\d+)_(\d+)$/);
    if (!match) continue;

    const itemId = Number(match[1]);
    const shopId = Number(match[2]);

    if (!Number.isFinite(itemId) || !Number.isFinite(shopId)) continue;

    const sollBestand = toNumber(body[key], 0);
    const activeForShop = parseBoolean(body[`active_${itemId}_${shopId}`]);

    updates.push({
      itemId,
      shopId,
      sollBestand: Math.max(0, sollBestand),
      activeForShop,
    });
  }

  return updates;
}

router.post('/bakery/items/create', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || '').trim();
    const unit = String(req.body.unit || 'Stk').trim() || 'Stk';
    const sortOrder = toNumber(req.body.sortOrder, 0);
    const active = parseBoolean(req.body.active);

    if (!name) {
      return redirectWithMessage(res, '/bakery/items', {
        error: 'Artikelname fehlt.',
      });
    }

    const item = await store.createItem({
      name,
      category,
      unit,
      sortOrder,
      active,
    });

    await store.ensureAllShopSettingsForItem(item.id, 0);

    return redirectWithMessage(res, '/bakery/items', {
      success: `Artikel "${name}" wurde angelegt.`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bakery/items/bulk-create', async (req, res, next) => {
  try {
    const bulkText = String(req.body.bulkText || '').trim();

    if (!bulkText) {
      return redirectWithMessage(res, '/bakery/items', {
        error: 'Bulk Text fehlt.',
      });
    }

    const created = await store.bulkCreateItems(bulkText);

    for (const item of created) {
      await store.ensureAllShopSettingsForItem(item.id, 0);
    }

    return redirectWithMessage(res, '/bakery/items', {
      success: `${created.length} Artikel wurden angelegt.`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bakery/items/:id/update', async (req, res, next) => {
  try {
    const itemId = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || '').trim();
    const unit = String(req.body.unit || 'Stk').trim() || 'Stk';
    const sortOrder = toNumber(req.body.sortOrder, 0);
    const active = parseBoolean(req.body.active);

    if (!itemId) {
      return redirectWithMessage(res, '/bakery/items', {
        error: 'Ungültige Artikel-ID.',
      });
    }

    if (!name) {
      return redirectWithMessage(res, '/bakery/items', {
        error: 'Artikelname fehlt.',
      });
    }

    await store.updateItem(itemId, {
      name,
      category,
      unit,
      sortOrder,
      active,
    });

    return redirectWithMessage(res, '/bakery/items', {
      success: `Artikel "${name}" wurde aktualisiert.`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bakery/items/:id/toggle', async (req, res, next) => {
  try {
    const itemId = Number(req.params.id);
    if (!itemId) {
      return redirectWithMessage(res, '/bakery/items', {
        error: 'Ungültige Artikel-ID.',
      });
    }

    const current = await store.getItemById(itemId);
    if (!current) {
      return redirectWithMessage(res, '/bakery/items', {
        error: 'Artikel nicht gefunden.',
      });
    }

    await store.setItemActive(itemId, !current.active);

    return redirectWithMessage(res, '/bakery/items', {
      success: `Artikel "${current.name}" wurde ${current.active ? 'deaktiviert' : 'aktiviert'}.`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bakery/items/shop-settings/save', async (req, res, next) => {
  try {
    const updates = parseShopSollUpdates(req.body);

    if (!updates.length) {
      return redirectWithMessage(res, '/bakery/items', {
        error: 'Keine Shop-Einstellungen gefunden.',
      });
    }

    await store.bulkUpsertItemShopSettings(updates);

    return redirectWithMessage(res, '/bakery/items', {
      success: 'SOLL Bestand und Shop-Aktivierung wurden gespeichert.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bakery/order/save', async (req, res, next) => {
  try {
    const shopId = toNumber(req.body.shopId, 0);
    const orderDate = String(req.body.orderDate || today());
    const note = String(req.body.note || '').trim();
    const lines = normalizeLinesPayload(req.body);

    if (!shopId) {
      return redirectWithMessage(res, '/bakery/order', {
        error: 'Bitte Shop auswählen.',
        date: orderDate,
      });
    }

    await store.saveOrderDraft({
      shopId,
      orderDate,
      note,
      createdBy: getUserIdentity(req),
      updatedBy: getUserIdentity(req),
      lines,
    });

    return redirectWithMessage(res, '/bakery/order', {
      success: 'Bestellung wurde als Entwurf gespeichert.',
      shopId,
      date: orderDate,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bakery/order/submit', async (req, res, next) => {
  try {
    const shopId = toNumber(req.body.shopId, 0);
    const orderDate = String(req.body.orderDate || today());
    const note = String(req.body.note || '').trim();
    const lines = normalizeLinesPayload(req.body);

    if (!shopId) {
      return redirectWithMessage(res, '/bakery/order', {
        error: 'Bitte Shop auswählen.',
        date: orderDate,
      });
    }

    await store.submitOrder({
      shopId,
      orderDate,
      note,
      createdBy: getUserIdentity(req),
      updatedBy: getUserIdentity(req),
      lines,
    });

    return redirectWithMessage(res, '/bakery/order', {
      success: 'Bestellung wurde abgegeben.',
      shopId,
      date: orderDate,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/bakery/orders/:id/reopen', async (req, res, next) => {
  try {
    const orderId = toNumber(req.params.id, 0);

    if (!orderId) {
      return redirectWithMessage(res, '/bakery/orders', {
        error: 'Ungültige Bestell-ID.',
      });
    }

    const order = await store.reopenOrder(orderId, getUserIdentity(req));

    return redirectWithMessage(res, '/bakery/order', {
      success: 'Bestellung wurde wieder geöffnet.',
      shopId: order.shopId,
      date: order.orderDate,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
